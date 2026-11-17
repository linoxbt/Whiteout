/**
 * whiteout: the host CLI (spec section 11, "Host"). Every command prints the
 * transaction digest and the next command to run.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import {
  DEFAULT_DURATION_MS,
  DEFAULT_MAX_PLAYERS,
  DEFAULT_RESOLVE_WINDOW_MS,
  DealerKind,
  ExplorerStatus,
  GameStatus,
  SessionKey,
  TILE_KIND_NAMES,
  applyEvents,
  decryptTiles,
  emptyTrail,
  fromHex,
  getExplorers,
  isEnded,
  listGameEvents,
  makeSealClient,
  readAllTiles,
  storeBlob,
  storeQuilt,
  thawFile,
  tx,
  verifyThaw,
  type Tile,
} from '@whiteout/core';
import { ceremonyDeal, checkDealFile, requestEnclaveDeal, tilesOf, type DealFile } from './dealer.js';
import {
  confirmTyped,
  ctxFor,
  exec,
  gameCtx,
  loadEnv,
  loadRecord,
  next,
  parseDuration,
  saveRecord,
  writeJson,
  type Env,
  type GlobalOpts,
} from './env.js';

const program = new Command()
  .name('whiteout')
  .description('Host a Whiteout hunt: create, deal, open, settle and thaw.')
  .option('-n, --network <network>', 'testnet or mainnet', 'testnet')
  .option('--deploy <file>', 'deployment file (default deploy/<network>.json)')
  .option('--state-dir <dir>', 'local state directory (default ./.whiteout)');

const env = (needSigner = true): Env => loadEnv(program.opts<GlobalOpts>(), needSigner);

/** Storage epochs covering the game plus 30 days (spec section 8). */
function epochsFor(e: Env, durationMs: number): number {
  const epochMs = e.cfg.network === 'mainnet' ? 14 * 86_400_000 : 86_400_000;
  return Math.ceil((durationMs + 30 * 86_400_000) / epochMs) + 1;
}

// ---------------------------------------------------------------------------

program
  .command('create')
  .description('Create a hunt in LOBBY and receive its HostCap (FR1)')
  .requiredOption('--well <address>', 'Lofi Foundation well-fund address')
  .option('--coin <type>', 'stake coin type', '0x2::sui::SUI')
  .option('--stake <baseUnits>', 'entry stake in base units of the coin (0 for ceremony hunts)', '0')
  .option('--players <n>', 'max players (1-128)', String(DEFAULT_MAX_PLAYERS))
  .option('--duration <d>', 'hunt length, e.g. 2h (1h-72h)', `${DEFAULT_DURATION_MS}ms`)
  .option('--window <d>', 'resolve window, e.g. 300s (120s-3600s)', `${DEFAULT_RESOLVE_WINDOW_MS}ms`)
  .option('--confirm-well <last6>', 'last 6 characters of the well-fund address, to skip the prompt')
  .action(async (o) => {
    const e = env();
    await assertImmutable(e);
    const well = String(o.well).toLowerCase();
    console.log(`Well fund: ${well}`);
    await confirmTyped('Retype the last 6 characters of the well-fund address: ', well.slice(-6), o.confirmWell);
    const ctx = ctxFor(e, o.coin);
    const r = await exec(
      e,
      tx.createLobby(ctx, {
        entryStake: BigInt(o.stake),
        maxPlayers: Number(o.players),
        durationMs: parseDuration(o.duration),
        resolveWindowMs: parseDuration(o.window),
        wellFund: well,
        host: e.address,
      }),
    );
    const game = r.created.find((c) => c.type.includes('::game::Game<'));
    const cap = r.created.find((c) => c.type.endsWith('::game::HostCap'));
    if (!game || !cap) throw new Error('could not find the new Game and HostCap in the effects');
    saveRecord(e, { gameId: game.id, capId: cap.id, coinType: o.coin, network: e.cfg.network });
    console.log(`Digest:  ${r.digest}\nGame:    ${game.id}\nHostCap: ${cap.id}`);
    next(`whiteout deposit-prize --game ${game.id} --prize <objectId>`);
  });

program
  .command('deposit-prize')
  .description('Deposit the single prize object (FR2)')
  .requiredOption('--game <id>')
  .requiredOption('--prize <objectId>', 'an object you own with key + store')
  .action(async (o) => {
    const e = env();
    const rec = loadRecord(e, o.game);
    const { object } = await e.client.core.getObject({ objectId: o.prize });
    const r = await exec(e, tx.depositPrize(ctxFor(e, rec.coinType), { gameId: o.game, capId: rec.capId, prizeId: o.prize, prizeType: object.type }));
    saveRecord(e, { ...rec, prizeId: o.prize, prizeType: object.type });
    console.log(`Digest: ${r.digest}\nPrize ${o.prize} (${object.type}) is in escrow.`);
    next(`whiteout deal --game ${o.game} --enclave-url <url>   (or --ceremony for a zero-stake hunt)`);
  });

program
  .command('deal')
  .description('Get the sealed map, check it, and upload the tiles as one Walrus Quilt. Does not open the hunt.')
  .requiredOption('--game <id>')
  .option('--enclave-url <url>', 'dealer enclave base URL (spec section 12)')
  .option('--enclave-id <id>', 'registered Enclave<DEALER> object (default: deploy file)')
  .option('--ceremony', 'deal locally: host-dealt, zero-stake hunts only (MD5)')
  .option('--publisher <url>', 'Walrus publisher (default: network config)')
  .option('--epochs <n>', 'Walrus storage epochs (default: duration + 30 days)')
  .action(async (o) => {
    const e = env();
    const rec = loadRecord(e, o.game);
    const { game } = await gameCtx(e, o.game);
    if (game.status !== GameStatus.LOBBY) throw new Error('The hunt is not in LOBBY.');
    if (!game.hasPrize) throw new Error('Deposit the prize first.');
    let d: DealFile;
    if (o.ceremony) {
      if (game.entryStake !== 0n) throw new Error('Ceremony hunts must have zero entry stake (MD5).');
      console.log('Dealing locally (ceremony). This hunt will be labelled host-dealt.');
      d = await ceremonyDeal(e, o.game);
      checkDealFile(e, d);
    } else {
      const enclaveId = o.enclaveId ?? e.deploy.dealerEnclaveId;
      if (!o.enclaveUrl || !enclaveId) throw new Error('Pass --enclave-url and --enclave-id (or --ceremony).');
      console.log(`Requesting a deal from ${o.enclaveUrl} ...`);
      d = await requestEnclaveDeal(e, o.game, o.enclaveUrl, enclaveId);
    }
    const dealFile = join(e.stateDir, o.game, 'deal.json');
    writeJson(dealFile, d);
    console.log(`Deal checked: 576 tiles, ct_hash ${d.ctHash.slice(0, 16)}..., saved to ${dealFile}`);

    const publisher = o.publisher ?? e.cfg.walrusPublisher;
    if (!publisher) throw new Error('No Walrus publisher for this network: pass --publisher (Mainnet: your own publisher or relay).');
    const epochs = o.epochs ? Number(o.epochs) : epochsFor(e, game.durationMs);
    console.log(`Uploading the Quilt (${epochs} epochs) ...`);
    const { quiltId } = await storeQuilt(publisher, tilesOf(d), epochs);
    saveRecord(e, { ...rec, quiltId, dealFile });
    console.log(`Quilt: ${quiltId}`);
    next(`whiteout open --game ${o.game}   (at T-0: this starts the clock)`);
  });

program
  .command('open')
  .description('Submit the sealed deal on-chain: the hunt opens and ends_at starts counting (FR4, FR5)')
  .requiredOption('--game <id>')
  .action(async (o) => {
    const e = env();
    const rec = loadRecord(e, o.game);
    if (!rec.dealFile || !rec.quiltId) throw new Error('Run `whiteout deal` first.');
    const d: DealFile = JSON.parse(readFileSync(rec.dealFile, 'utf8'));
    checkDealFile(e, d);
    const ctx = ctxFor(e, rec.coinType);
    const common = { gameId: o.game, capId: rec.capId, dealTs: BigInt(d.dealTs), ctHash: fromHex(d.ctHash), quiltId: rec.quiltId };
    const t =
      d.kind === 'enclave'
        ? tx.sealDealEnclave(ctx, { ...common, enclaveId: d.enclaveId!, dealSig: fromHex(d.dealSig) })
        : tx.sealDealCeremony(ctx, { ...common, dealerPk: fromHex(d.dealerPk) });
    const r = await exec(e, t);
    const { game } = await gameCtx(e, o.game);
    console.log(`Digest: ${r.digest}\nThe hunt is OPEN until ${new Date(game.endsAt).toISOString()}.`);
    next(`whiteout status --game ${o.game} --watch`);
  });

program
  .command('status')
  .description('Show a hunt: state, players, pending reveals and freezes')
  .requiredOption('--game <id>')
  .option('--watch', 'poll every 15 s and print changes')
  .option('--auto-freeze', 'with --watch: freeze overdue explorers (anyone may)')
  .action(async (o) => {
    const e = env(!!o.autoFreeze);
    let cursor: string | null = null;
    const trail = emptyTrail();
    for (;;) {
      const { game, ctx } = await gameCtx(e, o.game);
      const page = await listGameEvents(e.client, e.cfg.packageId, o.game, cursor);
      cursor = page.cursor;
      applyEvents(trail, page.events);
      for (const ev of page.events) console.log(`  event ${ev.name} ${summarize(ev.data)}`);
      const explorers = await getExplorers(e.client, [...trail.explorers.keys()]);
      const now = Date.now();
      const overdue = explorers.filter((x) => x.status === ExplorerStatus.ACTIVE && x.pending && now > x.pending.deadlineMs);
      console.log(
        `[${new Date().toISOString()}] status=${statusName(game.status)} dealer=${dealerName(game.dealerKind)} ` +
          `players=${game.playerCount}/${game.maxPlayers} pot=${game.pot} active=${explorers.filter((x) => x.status === ExplorerStatus.ACTIVE).length} ` +
          `pending=${explorers.filter((x) => x.pending).length} overdue=${overdue.length} ends=${game.endsAt ? new Date(game.endsAt).toISOString() : '-'}`,
      );
      if (game.finder) console.log(`  finder: ${game.finder}`);
      if (o.autoFreeze)
        for (const x of overdue) {
          const r = await exec(e, tx.freezeOverdue(ctx, { gameId: o.game, explorerId: x.id }));
          console.log(`  froze overdue ${x.id}: ${r.digest}`);
        }
      if (!o.watch) {
        if (isEnded(game, now) && game.status === GameStatus.OPEN) next(`whiteout finalize --game ${o.game}`);
        else if (isEnded(game, now)) next(`whiteout thaw --game ${o.game}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 15_000));
    }
  });

program
  .command('freeze-overdue')
  .description('Freeze every Explorer whose resolve deadline has passed (anyone may, FR14)')
  .requiredOption('--game <id>')
  .action(async (o) => {
    const e = env();
    const { ctx } = await gameCtx(e, o.game);
    const trail = applyEvents(emptyTrail(), (await listGameEvents(e.client, e.cfg.packageId, o.game)).events);
    const now = Date.now();
    const overdue = (await getExplorers(e.client, [...trail.explorers.keys()])).filter(
      (x) => x.status === ExplorerStatus.ACTIVE && x.pending && now > x.pending.deadlineMs,
    );
    if (!overdue.length) console.log('Nobody is overdue.');
    for (const x of overdue) console.log(`Froze ${x.id}: ${(await exec(e, tx.freezeOverdue(ctx, { gameId: o.game, explorerId: x.id }))).digest}`);
  });

program
  .command('finalize')
  .description('After ends_at with no finder: send the pot to the well fund (FR17)')
  .requiredOption('--game <id>')
  .action(async (o) => {
    const e = env();
    const { ctx } = await gameCtx(e, o.game);
    const r = await exec(e, tx.finalizeUnclaimed(ctx, { gameId: o.game }));
    console.log(`Digest: ${r.digest}`);
    next(`whiteout reclaim --game ${o.game}  then  whiteout thaw --game ${o.game}`);
  });

program
  .command('reclaim')
  .description('Take back a prize nobody won (FR17)')
  .requiredOption('--game <id>')
  .action(async (o) => {
    const e = env();
    const rec = loadRecord(e, o.game);
    const prizeType = rec.prizeType ?? (await prizeTypeOf(e, o.game));
    const r = await exec(e, tx.reclaimPrize(ctxFor(e, rec.coinType), { gameId: o.game, capId: rec.capId, prizeType, host: e.address }));
    console.log(`Digest: ${r.digest}\nThe prize is back in ${e.address}.`);
  });

program
  .command('cancel')
  .description('Cancel a LOBBY hunt and recover the prize (FR3)')
  .requiredOption('--game <id>')
  .action(async (o) => {
    const e = env();
    const rec = loadRecord(e, o.game);
    const { game } = await gameCtx(e, o.game);
    const prizeType = game.hasPrize ? (rec.prizeType ?? (await prizeTypeOf(e, o.game))) : null;
    const r = await exec(e, tx.cancel(ctxFor(e, rec.coinType), { gameId: o.game, capId: rec.capId, prizeType, host: e.address }));
    console.log(`Digest: ${r.digest}\nThe lobby is cancelled.`);
  });

program
  .command('thaw')
  .description('After the hunt ends: decrypt all 576 tiles, verify them, publish the thaw file (FR18, FR20)')
  .requiredOption('--game <id>')
  .option('--publisher <url>', 'Walrus publisher (default: network config)')
  .option('--out <file>', 'also write the thaw file here')
  .action(async (o) => {
    const e = env();
    const rec = loadRecord(e, o.game);
    const { game, ctx } = await gameCtx(e, o.game);
    if (!isEnded(game, Date.now())) throw new Error('The hunt has not ended yet.');
    const cts = rec.dealFile
      ? tilesOf(JSON.parse(readFileSync(rec.dealFile, 'utf8')) as DealFile).map((t) => t.ct)
      : await readAllTiles(e.cfg.walrusAggregators, game.quiltId, (n) => n % 96 === 0 && console.log(`  downloaded ${n}/576`));
    const seal = makeSealClient(e.client, e.cfg);
    const sessionKey = await SessionKey.create({ address: e.address, packageId: e.cfg.packageId, ttlMin: 30, suiClient: e.client });
    const { signature } = await e.signer.signPersonalMessage(sessionKey.getPersonalMessage());
    await sessionKey.setPersonalMessageSignature(signature);
    const tiles: Tile[] = [];
    for (let i = 0; i < 576; i += 48) {
      const batch = cts.slice(i, i + 48).map((ct, j) => ({ x: (i + j) % 24, y: Math.floor((i + j) / 24), ct }));
      const res = await decryptTiles({
        seal, suiClient: e.client, ctx, gameId: o.game, dealerPk: game.dealerPk, dealTs: game.dealTs,
        threshold: e.cfg.sealThreshold, sessionKey, tiles: batch,
      });
      for (const r of res) {
        if (!r.verified) throw new Error(`tile (${r.tile.x}, ${r.tile.y}) failed verification`);
        tiles.push(r.tile);
      }
      console.log(`  decrypted ${tiles.length}/576`);
    }
    const file = thawFile(o.game, tiles);
    const check = verifyThaw(file, o.game, game.dealerPk, game.dealTs);
    if (!check.ok) throw new Error(`thaw check failed: ${check.problems.join('; ')}`);
    if (o.out) writeJson(o.out, file);
    const publisher = o.publisher ?? e.cfg.walrusPublisher;
    if (!publisher) throw new Error('No Walrus publisher for this network: pass --publisher.');
    const blobId = await storeBlob(publisher, new TextEncoder().encode(JSON.stringify(file)), epochsFor(e, 0));
    const r = await exec(e, tx.publishThaw(ctx, { gameId: o.game, capId: rec.capId, blobId }));
    saveRecord(e, { ...rec, thawBlob: blobId });
    console.log(`Thaw file ${blobId} verified (relic at ${check.relic}). Digest: ${r.digest}`);
  });

program
  .command('verify')
  .description('Check a hunt as a spectator would: dealer, ciphertext hash, and the thaw file if published')
  .requiredOption('--game <id>')
  .action(async (o) => {
    const e = env(false);
    const { game } = await gameCtx(e, o.game);
    console.log(`Dealer: ${dealerName(game.dealerKind)}${game.enclaveId ? ` (enclave ${game.enclaveId})` : ''}`);
    if (game.dealerKind === DealerKind.CEREMONY) console.log('WARNING: host-dealt. The host could know this map.');
    const cts = await readAllTiles(e.cfg.walrusAggregators, game.quiltId);
    const { checkCiphertexts } = await import('@whiteout/core');
    console.log(`ct_hash: ${checkCiphertexts(cts, game.ctHash) ? 'matches' : 'MISMATCH: do not join'}`);
    if (game.thawBlob) {
      const { readBlob } = await import('@whiteout/core');
      const thaw = JSON.parse(new TextDecoder().decode(await readBlob(e.cfg.walrusAggregators, game.thawBlob)));
      const check = verifyThaw(thaw, o.game, game.dealerPk, game.dealTs);
      console.log(check.ok ? `Thaw file: all 576 tiles verify; relic at ${check.relic}` : `Thaw file FAILED: ${check.problems.slice(0, 5).join('; ')}`);
    }
  });

// ---------------------------------------------------------------------------

/** MD6/F18: no Mainnet hunt on a package whose UpgradeCap still exists. */
async function assertImmutable(e: Env) {
  if (e.cfg.network !== 'mainnet') return;
  const caps = e.deploy.upgradeCapIds ?? [];
  if (!caps.length) throw new Error('deploy/mainnet.json lists no UpgradeCap IDs; cannot prove the package is immutable.');
  const { objects } = await e.client.core.getObjects({ objectIds: caps });
  if (objects.some((x) => !(x instanceof Error))) {
    throw new Error('An UpgradeCap still exists. Make the packages immutable before creating a Mainnet hunt (MD6).');
  }
}

async function prizeTypeOf(e: Env, gameId: string): Promise<string> {
  const t = applyEvents(emptyTrail(), (await listGameEvents(e.client, e.cfg.packageId, gameId)).events);
  if (!t.prizeType) throw new Error('Could not find the prize type in the events.');
  return t.prizeType;
}

const statusName = (s: number) => Object.entries(GameStatus).find(([, v]) => v === s)?.[0] ?? String(s);
const dealerName = (s: number) => ({ 0: 'none', 1: 'enclave', 2: 'ceremony (host-dealt)' })[s] ?? String(s);

function summarize(data: unknown): string {
  const d = { ...(data as Record<string, unknown>) };
  delete d.game_id;
  if ('kind' in d) d.kind = TILE_KIND_NAMES[Number(d.kind)];
  return JSON.stringify(d, (_k, v) => (typeof v === 'bigint' ? v.toString() : Array.isArray(v) && v.length > 8 ? `[${v.length} bytes]` : v));
}

program.parseAsync().catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
