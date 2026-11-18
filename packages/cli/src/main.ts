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
  BPS,
  MAX_RELICS,
  applyEvents,
  blizzardDue,
  decryptTiles,
  getAllowlist,
  getGame,
  emptyTrail,
  fromHex,
  getExplorers,
  isEnded,
  listGameEvents,
  makeSealClient,
  readAllTiles,
  storeBlob,
  toHex,
  storeQuilt,
  thawFile,
  tx,
  verifyThaw,
  type Tile,
} from '@whiteout/core';
import { registerAdmin } from './admin.js';
import { storeBlobSdk, storeQuiltSdk } from './walrus-sdk.js';
import { alert, alertsFor, sponsorSample, type WatchSample } from './alerts.js';
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
  REPO_ROOT,
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
  .option('--relics <n>', `Phase 2: ranked relics and prizes (1-${MAX_RELICS})`, '1')
  .option('--shares <bps>', 'Phase 2: pot share per rank in basis points, e.g. 6000,2500,1500 (default: equal)')
  .option('--blizzard-every <d>', 'Phase 2: a blizzard may start every <d>, e.g. 30m (min 10m; default none)')
  .option('--blizzard-for <d>', 'Phase 2: how long drifts last, e.g. 5m (1m-15m, at most a third of the interval)', '5m')
  .option('--allowlist <id>', 'Phase 2: gate the hunt behind this allowlist (only members may join)')
  .action(async (o) => {
    const e = env();
    await assertImmutable(e);
    const well = String(o.well).toLowerCase();
    console.log(`Well fund: ${well}`);
    await confirmTyped('Retype the last 6 characters of the well-fund address: ', well.slice(-6), o.confirmWell);
    const ctx = ctxFor(e, o.coin);
    const relics = Number(o.relics);
    const potShares = o.shares ? String(o.shares).split(',').map(Number) : equalShares(relics);
    const blizzardEveryMs = o.blizzardEvery ? parseDuration(o.blizzardEvery) : 0;
    const blizzardMs = blizzardEveryMs ? parseDuration(o.blizzardFor) : 0;
    if (potShares.length !== relics || potShares.reduce((a, b) => a + b, 0) !== BPS) {
      throw new Error(`--shares needs ${relics} values summing to ${BPS}.`);
    }
    const base = {
      entryStake: BigInt(o.stake),
      maxPlayers: Number(o.players),
      durationMs: parseDuration(o.duration),
      resolveWindowMs: parseDuration(o.window),
      wellFund: well,
      host: e.address,
    };
    const simple = relics === 1 && !blizzardEveryMs;
    const r = await exec(
      e,
      simple ? tx.createLobby(ctx, base) : tx.createRankedLobby(ctx, { ...base, relics, potShares, blizzardEveryMs, blizzardMs }),
    );
    const game = r.created.find((c) => c.type.includes('::game::Game<'));
    const cap = r.created.find((c) => c.type.endsWith('::game::HostCap'));
    if (!game || !cap) throw new Error('could not find the new Game and HostCap in the effects');
    saveRecord(e, { gameId: game.id, capId: cap.id, coinType: o.coin, network: e.cfg.network });
    console.log(`Digest:  ${r.digest}\nGame:    ${game.id}\nHostCap: ${cap.id}`);
    if (relics > 1) console.log(`Ranked: ${relics} relics, pot shares ${potShares.map((b) => `${b / 100}%`).join(' / ')}`);
    if (blizzardEveryMs) console.log(`Blizzards every ${o.blizzardEvery}, drifts last ${o.blizzardFor}`);
    if (o.allowlist) {
      const g = await exec(e, tx.setAllowlist(ctx, { gameId: game.id, capId: cap.id, listId: o.allowlist }));
      console.log(`Gated by allowlist ${o.allowlist}: ${g.digest}`);
    }
    next(`whiteout deposit-prize --game ${game.id} --prize <objectId>${relics > 1 ? `   (once per relic, rank 1 first)` : ''}`);
  });

program
  .command('gate')
  .description('Phase 2: gate a LOBBY hunt behind an allowlist (only members may join)')
  .requiredOption('--game <id>')
  .requiredOption('--allowlist <id>')
  .action(async (o) => {
    const e = env();
    const rec = loadRecord(e, o.game);
    const r = await exec(e, tx.setAllowlist(ctxFor(e, rec.coinType), { gameId: o.game, capId: rec.capId, listId: o.allowlist }));
    const list = await getAllowlist(e.client, o.allowlist);
    console.log(`Digest: ${r.digest}\nOnly the ${list.size} members of "${list.name}" can join.`);
  });

const allowlist = program.command('allowlist').description('Phase 2: holder allowlists for gated hunts');

allowlist
  .command('create')
  .description('Create a shared allowlist; you receive the cap that edits it')
  .requiredOption('--name <name>', 'e.g. "Mystic Yeti holders, snapshot 2026-12-01"')
  .action(async (o) => {
    const e = env();
    const r = await exec(e, tx.createAllowlist({ packageId: e.cfg.packageId }, { name: o.name, owner: e.address }));
    const list = r.created.find((c) => c.type.endsWith('::allowlist::Allowlist'));
    const cap = r.created.find((c) => c.type.endsWith('::allowlist::AllowlistCap'));
    console.log(`Digest: ${r.digest}\nAllowlist:    ${list?.id}\nAllowlistCap: ${cap?.id}`);
    next(`whiteout allowlist add --list ${list?.id} --cap ${cap?.id} --file holders.txt`);
  });

for (const verb of ['add', 'remove'] as const) {
  allowlist
    .command(verb)
    .description(`${verb === 'add' ? 'Add' : 'Remove'} addresses (one per line in --file, or comma-separated in --addresses)`)
    .requiredOption('--list <id>')
    .requiredOption('--cap <id>')
    .option('--file <path>', 'text file with one address per line (a holder snapshot)')
    .option('--addresses <list>', 'comma-separated addresses')
    .action(async (o) => {
      const e = env();
      const raw = [...(o.file ? readFileSync(o.file, 'utf8').split(/\s+/) : []), ...(o.addresses ? String(o.addresses).split(',') : [])];
      const addrs = [...new Set(raw.map((a) => a.trim().toLowerCase()).filter((a) => /^0x[0-9a-f]{1,64}$/.test(a)))];
      if (!addrs.length) throw new Error('No addresses given.');
      // Up to 1 000 per Move call, a few calls per transaction.
      for (let i = 0; i < addrs.length; i += 4000) {
        const chunk = addrs.slice(i, i + 4000);
        const r = await exec(e, tx.editAllowlist({ packageId: e.cfg.packageId }, { listId: o.list, capId: o.cap, [verb]: chunk }));
        console.log(`${verb === 'add' ? 'Added' : 'Removed'} ${chunk.length}: ${r.digest}`);
      }
      const list = await getAllowlist(e.client, o.list);
      console.log(`"${list.name}" now has ${list.size} members.`);
    });
}

allowlist
  .command('show')
  .requiredOption('--list <id>')
  .action(async (o) => {
    const e = env(false);
    const list = await getAllowlist(e.client, o.list);
    console.log(`${list.name}: ${list.size} members (table ${list.membersTable})`);
  });

program
  .command('blizzard')
  .description('Phase 2: start a due blizzard (anyone may)')
  .requiredOption('--game <id>')
  .action(async (o) => {
    const e = env();
    const { game, ctx } = await gameCtx(e, o.game);
    if (!blizzardDue(game, Date.now())) {
      throw new Error(game.blizzardEveryMs ? `Not due until ${new Date(game.nextBlizzardAt).toISOString()}.` : 'Blizzards are off for this hunt.');
    }
    const r = await exec(e, tx.blizzard(ctx, { gameId: o.game }));
    const g = await getGame(e.client, o.game);
    console.log(`Digest: ${r.digest}\n${g.drifts.length} drifts until ${new Date(g.driftUntil).toISOString()}`);
  });

program
  .command('deposit-prize')
  .description('Deposit a prize object (FR2); ranked hunts take one per relic, rank 1 first')
  .requiredOption('--game <id>')
  .requiredOption('--prize <objectId>', 'an object you own with key + store')
  .action(async (o) => {
    const e = env();
    const rec = loadRecord(e, o.game);
    const { object } = await e.client.core.getObject({ objectId: o.prize });
    const r = await exec(e, tx.depositPrize(ctxFor(e, rec.coinType), { gameId: o.game, capId: rec.capId, prizeId: o.prize, prizeType: object.type }));
    const { game } = await gameCtx(e, o.game);
    saveRecord(e, { ...rec, prizeId: rec.prizeId ?? o.prize, prizeType: rec.prizeType ?? object.type });
    console.log(`Digest: ${r.digest}\nPrize ${o.prize} (${object.type}) is in escrow as rank ${game.prizesDeposited} of ${game.relics}.`);
    if (game.prizesDeposited < game.relics) next(`whiteout deposit-prize --game ${o.game} --prize <objectId>   (rank ${game.prizesDeposited + 1})`);
    else next(`whiteout deal --game ${o.game} --enclave-url <url>   (or --ceremony for a zero-stake hunt)`);
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
  .option('--sdk', 'upload with the Walrus SDK and upload relay (default on Mainnet)')
  .action(async (o) => {
    const e = env();
    const rec = loadRecord(e, o.game);
    const { game } = await gameCtx(e, o.game);
    if (game.status !== GameStatus.LOBBY) throw new Error('The hunt is not in LOBBY.');
    if (game.prizesDeposited < game.relics) throw new Error(`Deposit all ${game.relics} prizes first (${game.prizesDeposited} so far).`);
    let d: DealFile;
    if (o.ceremony) {
      if (game.entryStake !== 0n) throw new Error('Ceremony hunts must have zero entry stake (MD5).');
      console.log('Dealing locally (ceremony). This hunt will be labelled host-dealt.');
      d = await ceremonyDeal(e, o.game, game.relics);
      checkDealFile(e, d);
    } else {
      const enclaveId = o.enclaveId ?? e.deploy.dealerEnclaveId;
      if (!o.enclaveUrl || !enclaveId) throw new Error('Pass --enclave-url and --enclave-id (or --ceremony).');
      console.log(`Requesting a deal from ${o.enclaveUrl} ...`);
      try {
        d = await requestEnclaveDeal(e, o.game, o.enclaveUrl, enclaveId, game.relics);
      } catch (err) {
        await alert(`Deal failed for ${o.game}: ${(err as Error).message}`);
        throw err;
      }
    }
    const dealFile = join(e.stateDir, o.game, 'deal.json');
    writeJson(dealFile, d);
    console.log(`Deal checked: 576 tiles, ct_hash ${d.ctHash.slice(0, 16)}..., saved to ${dealFile}`);

    const publisher = o.sdk ? undefined : (o.publisher ?? e.cfg.walrusPublisher);
    const epochs = o.epochs ? Number(o.epochs) : epochsFor(e, game.durationMs);
    console.log(`Uploading the Quilt (${epochs} epochs) ${publisher ? `via ${publisher}` : 'with the Walrus SDK (host pays WAL)'} ...`);
    const { quiltId } = publisher ? await storeQuilt(publisher, tilesOf(d), epochs) : await storeQuiltSdk(e, tilesOf(d), epochs);
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
  .option('--auto-blizzard', 'with --watch: start blizzards when due (Phase 2)')
  .action(async (o) => {
    const e = env(!!o.autoFreeze || !!o.autoBlizzard);
    let cursor: string | null = null;
    const trail = emptyTrail();
    let prev: WatchSample | null = null;
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
      game.finders.forEach((f, i) => console.log(`  rank ${i + 1} finder: ${f}`));
      if (game.relics > 1) console.log(`  relics found ${game.finders.length}/${game.relics}, prizes held ${game.prizesHeld}`);
      if (game.allowlist) console.log(`  gated by allowlist ${game.allowlist}`);
      if (game.blizzardEveryMs) {
        const drifting = now < game.driftUntil ? `${game.drifts.length} drifts until ${new Date(game.driftUntil).toISOString()}, ` : '';
        console.log(`  blizzards: ${drifting}next ${new Date(game.nextBlizzardAt).toISOString()}`);
      }
      if (o.autoBlizzard && blizzardDue(game, now)) {
        const r = await exec(e, tx.blizzard(ctx, { gameId: o.game }));
        console.log(`  started a blizzard: ${r.digest}`);
      }
      if (o.watch) {
        const sample: WatchSample = {
          overdue: overdue.length,
          overdueFreezes: trail.frozenAt.filter((f) => f.overdue).length,
          ...(await sponsorSample(e.cfg.sponsorUrl, o.game)),
        };
        for (const a of alertsFor(prev, sample)) await alert(`[${o.game.slice(0, 10)}] ${a}`);
        prev = sample;
      }
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
  .description('Take back every prize nobody won (FR17), highest rank first')
  .requiredOption('--game <id>')
  .action(async (o) => {
    const e = env();
    const rec = loadRecord(e, o.game);
    const ctx = ctxFor(e, rec.coinType);
    const { game } = await gameCtx(e, o.game);
    if (!game.prizesHeld) throw new Error('No prizes left to reclaim.');
    const t = new (await import('@mysten/sui/transactions')).Transaction();
    for (let rank = game.finders.length + game.prizesHeld; rank > game.finders.length; rank--) {
      tx.reclaimPrize(ctx, { gameId: o.game, capId: rec.capId, prizeType: await prizeTypeOf(e, o.game, rank), host: e.address }, t);
    }
    const r = await exec(e, t);
    console.log(`Digest: ${r.digest}\n${game.prizesHeld} prize(s) back in ${e.address}.`);
  });

program
  .command('cancel')
  .description('Cancel a LOBBY hunt and recover the prize (FR3)')
  .requiredOption('--game <id>')
  .action(async (o) => {
    const e = env();
    const rec = loadRecord(e, o.game);
    const { game } = await gameCtx(e, o.game);
    const ctx = ctxFor(e, rec.coinType);
    const prizeType = game.hasPrize ? await prizeTypeOf(e, o.game, game.prizesHeld) : null;
    const t = tx.cancel(ctx, { gameId: o.game, capId: rec.capId, prizeType, host: e.address });
    // Ranked lobbies: cancel returns the top prize; reclaim the rest in the same transaction.
    for (let rank = game.prizesHeld - 1; rank >= 1; rank--) {
      tx.reclaimPrize(ctx, { gameId: o.game, capId: rec.capId, prizeType: await prizeTypeOf(e, o.game, rank), host: e.address }, t);
    }
    const r = await exec(e, t);
    console.log(`Digest: ${r.digest}\nThe lobby is cancelled and ${game.prizesHeld} prize(s) returned.`);
  });

program
  .command('thaw')
  .description('After the hunt ends: decrypt all 576 tiles, verify them, publish the thaw file (FR18, FR20)')
  .requiredOption('--game <id>')
  .option('--publisher <url>', 'Walrus publisher (default: network config)')
  .option('--out <file>', 'also write the thaw file here')
  .option('--sdk', 'upload with the Walrus SDK and upload relay (default on Mainnet)')
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
    const publisher = o.sdk ? undefined : (o.publisher ?? e.cfg.walrusPublisher);
    const bytes = new TextEncoder().encode(JSON.stringify(file));
    const blobId = publisher ? await storeBlob(publisher, bytes, epochsFor(e, 0)) : await storeBlobSdk(e, bytes, epochsFor(e, 0));
    const r = await exec(e, tx.publishThaw(ctx, { gameId: o.game, capId: rec.capId, blobId }));
    saveRecord(e, { ...rec, thawBlob: blobId });
    console.log(`Thaw file ${blobId} verified (relics at ${check.relics?.map((p) => `(${p})`).join(' ')}). Digest: ${r.digest}`);
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
      const relicsOk = check.ok && check.relics!.length === game.relics;
      console.log(
        check.ok
          ? `Thaw file: all 576 tiles verify; ${check.relics!.length} relic(s) at ${check.relics!.map((p) => `(${p})`).join(' ')}${relicsOk ? '' : ` (MISMATCH: the hunt has ${game.relics} prizes)`}`
          : `Thaw file FAILED: ${check.problems.slice(0, 5).join('; ')}`,
      );
    }
  });

program
  .command('pin-dealer')
  .description('Write the dealer build config (package ID, Seal key servers and their public keys) for this network')
  .option('--package <id>', 'Whiteout package ID (default: deploy file)')
  .option('--out <file>', 'output file (default: enclave/whiteout-dealer/src/nautilus-server/config/<network>.json)')
  .action(async (o) => {
    const opts = program.opts<GlobalOpts>();
    const e = loadEnv({ ...opts }, false, true);
    const packageId = o.package ?? e.cfg.packageId;
    if (!packageId) throw new Error('No package ID: publish first, or pass --package.');
    const seal = makeSealClient(e.client, e.cfg);
    const servers = await seal.getKeyServers();
    const config = {
      network: e.cfg.network,
      package_id: packageId,
      threshold: e.cfg.sealThreshold,
      key_servers: e.cfg.sealServers.map((s) => {
        const ks = [...servers.values()].find((k) => k.objectId.toLowerCase() === s.objectId.toLowerCase());
        if (!ks) throw new Error(`key server ${s.objectId} not found`);
        return { object_id: ks.objectId, public_key: toHex(ks.pk), weight: s.weight };
      }),
    };
    const out = o.out ?? join(REPO_ROOT, 'enclave/whiteout-dealer/src/nautilus-server/config', `${e.cfg.network}.json`);
    writeJson(out, config);
    console.log(`Wrote ${out}. Rebuild the enclave: its PCRs change with this file (MD16).`);
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

async function prizeTypeOf(e: Env, gameId: string, rank = 1): Promise<string> {
  const t = applyEvents(emptyTrail(), (await listGameEvents(e.client, e.cfg.packageId, gameId)).events);
  const type = t.prizeTypes.get(rank);
  if (!type) throw new Error(`Could not find the rank ${rank} prize type in the events.`);
  return type;
}

/** Equal pot shares in basis points; rank 1 takes the rounding remainder. */
function equalShares(relics: number): number[] {
  const each = Math.floor(BPS / relics);
  return Array.from({ length: relics }, (_, i) => (i === 0 ? BPS - each * (relics - 1) : each));
}

const statusName = (s: number) => Object.entries(GameStatus).find(([, v]) => v === s)?.[0] ?? String(s);
const dealerName = (s: number) => ({ 0: 'none', 1: 'enclave', 2: 'ceremony (host-dealt)' })[s] ?? String(s);

function summarize(data: unknown): string {
  const d = { ...(data as Record<string, unknown>) };
  delete d.game_id;
  if ('kind' in d) d.kind = TILE_KIND_NAMES[Number(d.kind)];
  return JSON.stringify(d, (_k, v) => (typeof v === 'bigint' ? v.toString() : Array.isArray(v) && v.length > 8 ? `[${v.length} bytes]` : v));
}

registerAdmin(program);

program.parseAsync().catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
