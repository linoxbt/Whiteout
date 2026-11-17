/**
 * Load bots (spec section 19, "Concurrency and load"; NFR1-NFR3, assumption A10).
 *
 * N bots join one zero-stake hunt and step at the 8 s cooldown for a set time. Each
 * step's resolve rides with the next step. The bots know the map and never step onto
 * a crevasse or the relic, so they keep playing. Measured per step:
 *   - submit -> executed (chain latency)
 *   - submit -> tile visible (adds the reveal: Walrus read + Seal key fetch + decrypt)
 * plus errors by kind, with shared-object contention counted separately.
 *
 * Localnet (CI): tiles are "encrypted" with the identity function; visible = executed.
 *   BYTECODE=build.json pnpm exec tsx load.ts --bots 8 --seconds 90
 * Testnet (real Seal and Walrus; needs a deployed package and a funded key):
 *   LOAD_NETWORK=testnet LOAD_FUNDER_KEY=suiprivkey... LOAD_PACKAGE=0x... \
 *     pnpm exec tsx load.ts --bots 64 --seconds 1800
 */
import { writeFileSync } from 'node:fs';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  DEFAULTS,
  GRID,
  SessionKey,
  TileKind,
  deal,
  decryptTiles,
  generateMap,
  getExplorer,
  makeClient,
  makeSealClient,
  readTile,
  sealEncryptor,
  seededRng,
  signTiles,
  storeQuilt,
  tileIndex,
  tx,
  type DirectionValue,
  type NetworkConfig,
} from '@whiteout/core';
import { ExecError, created, exec, explorerIdOf, faucet, fundFrom, localClient, publish, type Client } from './harness.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce<string[][]>((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1] ?? '']] : acc), []),
);
const BOTS = Number(args.bots ?? 8);
const SECONDS = Number(args.seconds ?? 90);
const NETWORK = (process.env.LOAD_NETWORK ?? 'localnet') as 'localnet' | 'testnet';
const COOLDOWN = 8_000;

interface Sample {
  executedMs: number;
  visibleMs: number;
}

const samples: Sample[] = [];
const errors: Record<string, number> = {};
const countError = (k: string) => (errors[k] = (errors[k] ?? 0) + 1);

function pct(xs: number[], p: number) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

async function main() {
  const local = NETWORK === 'localnet';
  const cfg: NetworkConfig | null = local
    ? null
    : { ...DEFAULTS.testnet, packageId: process.env.LOAD_PACKAGE ?? '', enclavePackageId: '', enclaveConfigId: '' };
  const client: Client = local ? localClient() : (makeClient(cfg!) as unknown as Client);

  const host = local ? Ed25519Keypair.generate() : Ed25519Keypair.fromSecretKey(process.env.LOAD_FUNDER_KEY!);
  const bots = Array.from({ length: BOTS }, () => Ed25519Keypair.generate());
  if (local) {
    await faucet(host.toSuiAddress());
    await new Promise((r) => setTimeout(r, 2000));
  }
  // Each bot gets 0.5 SUI for gas (about 0.004 SUI per step + resolve on testnet).
  for (let i = 0; i < bots.length; i += 100) {
    await fundFrom(client, host, bots.slice(i, i + 100).map((b) => b.toSuiAddress()), 500_000_000n);
  }

  const packageId = local ? await publish(client, host, process.env.BYTECODE ?? 'build.json') : cfg!.packageId;
  const ctx = { packageId, coinType: '0x2::sui::SUI' };

  // --- A zero-stake ceremony hunt with a known map ------------------------------------
  const lobby = await exec(
    client,
    host,
    tx.createLobby(ctx, {
      entryStake: 0n, maxPlayers: Math.min(128, BOTS), durationMs: 3_600_000, resolveWindowMs: 300_000,
      wellFund: host.toSuiAddress(), host: host.toSuiAddress(),
    }),
  );
  const gameId = created(lobby, '::game::Game<');
  const capId = created(lobby, '::game::HostCap');
  const prize = new Transaction();
  const [coin] = prize.splitCoins(prize.gas, [1]);
  prize.moveCall({
    target: `${packageId}::game::deposit_prize`,
    typeArguments: ['0x2::sui::SUI', '0x2::coin::Coin<0x2::sui::SUI>'],
    arguments: [prize.object(gameId), prize.object(capId), coin!],
  });
  await exec(client, host, prize);

  const map = generateMap(seededRng(7));
  const sk = ed25519.utils.randomSecretKey();
  const dealTs = BigInt(Date.now());
  const seal = cfg ? makeSealClient(client as never, cfg) : null;
  const out = await deal({
    map, gameId, dealTs, secretKey: sk,
    encrypt: seal ? sealEncryptor(seal, packageId, cfg!.sealThreshold) : async (_id, pt) => pt,
  });
  const tiles = signTiles(map, gameId, dealTs, sk);
  const quiltId = cfg ? (await storeQuilt(cfg.walrusPublisher!, out.tiles, 2)).quiltId : 'localnet';
  await exec(client, host, tx.sealDealCeremony(ctx, { gameId, capId, dealerPk: out.dealerPk, dealTs, ctHash: out.ctHash, quiltId }));
  console.log(`hunt ${gameId} open; ${BOTS} bots for ${SECONDS}s on ${NETWORK}`);

  // --- Bots -------------------------------------------------------------------------
  const deadline = Date.now() + SECONDS * 1000;
  const safe = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < GRID && y < GRID && map[tileIndex(x, y)] !== TileKind.CREVASSE && map[tileIndex(x, y)] !== TileKind.RELIC;

  async function bot(kp: Ed25519Keypair, i: number) {
    const column = (i * 7) % GRID;
    await exec(client, kp, tx.join(ctx, { gameId, stake: 0n, column }));
    const explorerId = await explorerIdOf(client, packageId, gameId, kp.toSuiAddress());
    let sessionKey: SessionKey | null = null;
    if (seal) {
      sessionKey = await SessionKey.create({ address: kp.toSuiAddress(), packageId, ttlMin: 30, suiClient: client as never });
      const { signature } = await kp.signPersonalMessage(sessionKey.getPersonalMessage());
      await sessionKey.setPersonalMessageSignature(signature);
    }
    let lastStep = 0;
    while (Date.now() < deadline) {
      const me = await getExplorer(client as never, explorerId);
      const options = ([[0, 0, 1], [1, 1, 0], [2, 0, -1], [3, -1, 0]] as const).filter(([, dx, dy]) => safe(me.x + dx, me.y + dy));
      const [dir] = options[Math.floor(Math.random() * options.length)] ?? [0];
      const t = new Transaction();
      if (me.pending) {
        const tile = tiles[tileIndex(me.pending.x, me.pending.y)]!;
        tx.resolveTile(ctx, { gameId, explorerId, kind: tile.kind, kindSig: tile.kindSig, ropes: me.ropes, huntLive: true, prizeType: null }, t);
      }
      tx.step(ctx, { gameId, explorerId, dir: dir as DirectionValue }, t);
      const wait = lastStep ? lastStep + COOLDOWN + 300 - Date.now() : 0;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const start = Date.now();
      try {
        await exec(client, kp, t);
        lastStep = Date.now();
        const executedMs = Date.now() - start;
        const after = await getExplorer(client as never, explorerId);
        if (seal && sessionKey && after.pending) {
          const ct = await readTile(cfg!.walrusAggregators, quiltId, after.x, after.y);
          await decryptTiles({
            seal, suiClient: client as never, ctx, gameId, explorerId, dealerPk: out.dealerPk, dealTs,
            threshold: cfg!.sealThreshold, sessionKey, tiles: [{ x: after.x, y: after.y, ct }],
          });
        }
        samples.push({ executedMs, visibleMs: Date.now() - start });
      } catch (e) {
        const err = e as ExecError;
        countError(err.kind === 'abort' ? `abort ${err.code}` : (err.kind ?? 'other'));
        if (err.kind !== 'abort') await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
  await Promise.all(bots.map((b, i) => bot(b, i).catch((e) => countError(`bot crashed: ${(e as Error).message.slice(0, 80)}`))));

  const exec_ = samples.map((s) => s.executedMs);
  const vis = samples.map((s) => s.visibleMs);
  const report = {
    network: NETWORK, bots: BOTS, seconds: SECONDS, steps: samples.length,
    stepsPerMinute: Math.round((samples.length / SECONDS) * 60),
    executed: { p50: pct(exec_, 50), p95: pct(exec_, 95) },
    visible: { p50: pct(vis, 50), p95: pct(vis, 95) },
    errors,
    nfr1: { p50Target: 4000, p95Target: 12000, pass: pct(vis, 50) <= 4000 && pct(vis, 95) <= 12000 },
  };
  console.log(JSON.stringify(report, null, 2));
  writeFileSync(args.out ?? 'load-report.json', JSON.stringify(report, null, 2));

  const contention = errors.contention ?? 0;
  const crashed = Object.keys(errors).filter((k) => k.startsWith('bot crashed')).length;
  if (contention > 0 || crashed > 0 || !report.nfr1.pass || samples.length === 0) {
    console.error('load test failed: contention, crashed bots, no steps, or NFR1 missed');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
