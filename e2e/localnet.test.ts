/**
 * End-to-end on a local Sui network (CI runs `sui start` first). Publishes the
 * package from compiled bytecode, then plays a ceremony hunt through the real chain:
 * create, deposit prize, deal, join, walk to the relic (resolves batched with steps),
 * a second player freezes on a crevasse, claim, and every event parses.
 *
 * Seal and Walrus are not on localnet: tiles are "encrypted" with the identity
 * function. The chain never sees tile contents, only ct_hash and signatures, so the
 * contract paths are exactly the production ones.
 *
 * Run: LOCALNET=1 BYTECODE=build.json pnpm --filter @whiteout/e2e localnet
 */
import { readFileSync } from 'node:fs';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { ed25519 } from '@noble/curves/ed25519.js';
import { describe, expect, it } from 'vitest';
import {
  ExplorerStatus,
  GRID,
  GameStatus,
  TileKind,
  applyEvents,
  deal,
  emptyTrail,
  findRelic,
  generateMap,
  getExplorer,
  getGame,
  listGameEvents,
  parseAbort,
  seededRng,
  signTiles,
  tileIndex,
  tx,
  type DirectionValue,
  type MapKinds,
} from '@whiteout/core';

const RPC = process.env.LOCALNET_RPC ?? 'http://127.0.0.1:9000';
const FAUCET = process.env.LOCALNET_FAUCET ?? 'http://127.0.0.1:9123';
const run = process.env.LOCALNET ? describe : describe.skip;
const client = new SuiGrpcClient({ network: 'localnet', baseUrl: RPC });

async function fund(address: string) {
  for (const path of ['/v2/gas', '/gas']) {
    const r = await fetch(`${FAUCET}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ FixedAmountRequest: { recipient: address } }),
    });
    if (r.ok) return;
  }
  throw new Error('faucet failed');
}

async function exec(signer: Ed25519Keypair, t: Transaction) {
  t.setSenderIfNotSet(signer.toSuiAddress());
  const res = await client.core.signAndExecuteTransaction({
    transaction: t,
    signer,
    include: { effects: true, objectTypes: true },
  });
  const r = res.Transaction ?? res.FailedTransaction!;
  if (!r.status.success) {
    const info = parseAbort(r.status.error);
    throw new Error(info ? `${info.name}: ${info.message}` : r.status.error.message);
  }
  await client.core.waitForTransaction({ digest: r.digest });
  return r;
}

const created = (r: Awaited<ReturnType<typeof exec>>, suffix: string) =>
  r.effects!.changedObjects.find((c) => c.idOperation === 'Created' && r.objectTypes![c.objectId]?.includes(suffix))!.objectId;

/** Shortest crevasse-free path from row 0 to the relic, as directions. */
function pathToRelic(map: MapKinds): { column: number; dirs: DirectionValue[] } {
  const [rx, ry] = findRelic(map);
  const prev = new Map<number, [number, DirectionValue]>();
  const queue = Array.from({ length: GRID }, (_, x) => tileIndex(x, 0));
  const seen = new Set(queue);
  while (queue.length) {
    const i = queue.shift()!;
    if (i === tileIndex(rx, ry)) break;
    const x = i % GRID;
    const y = Math.floor(i / GRID);
    for (const [dx, dy, d] of [[0, 1, 0], [1, 0, 1], [0, -1, 2], [-1, 0, 3]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) continue;
      const j = tileIndex(nx, ny);
      if (seen.has(j) || map[j] === TileKind.CREVASSE) continue;
      seen.add(j);
      prev.set(j, [i, d]);
      queue.push(j);
    }
  }
  const dirs: DirectionValue[] = [];
  let cur = tileIndex(rx, ry);
  while (prev.has(cur)) {
    const [p, d] = prev.get(cur)!;
    dirs.unshift(d);
    cur = p;
  }
  return { column: cur % GRID, dirs };
}

run('Whiteout on localnet', () => {
  it('plays a ceremony hunt end to end', { timeout: 900_000 }, async () => {
    const host = Ed25519Keypair.generate();
    const alice = Ed25519Keypair.generate();
    const bob = Ed25519Keypair.generate();
    await Promise.all([host, alice, bob].map((k) => fund(k.toSuiAddress())));
    await new Promise((r) => setTimeout(r, 3000));

    // --- Publish -----------------------------------------------------------------
    const build = JSON.parse(readFileSync(process.env.BYTECODE ?? 'build.json', 'utf8')) as {
      modules: string[];
      dependencies: string[];
    };
    const pub = new Transaction();
    const [upgradeCap] = pub.publish({ modules: build.modules, dependencies: build.dependencies });
    pub.transferObjects([upgradeCap!], host.toSuiAddress());
    const published = await exec(host, pub);
    const packageId = published.effects!.changedObjects.find((c) => c.outputState === 'PackageWrite')!.objectId;
    const ctx = { packageId, coinType: '0x2::sui::SUI' };

    // --- Lobby + prize -------------------------------------------------------------
    const lobby = await exec(
      host,
      tx.createLobby(ctx, {
        entryStake: 0n, maxPlayers: 4, durationMs: 3_600_000, resolveWindowMs: 120_000,
        wellFund: '0x' + 'e'.repeat(64), host: host.toSuiAddress(),
      }),
    );
    const gameId = created(lobby, '::game::Game<');
    const capId = created(lobby, '::game::HostCap');

    const prizeTx = new Transaction();
    const [prizeCoin] = prizeTx.splitCoins(prizeTx.gas, [123_456]);
    prizeTx.moveCall({
      target: `${packageId}::game::deposit_prize`,
      typeArguments: ['0x2::sui::SUI', '0x2::coin::Coin<0x2::sui::SUI>'],
      arguments: [prizeTx.object(gameId), prizeTx.object(capId), prizeCoin!],
    });
    await exec(host, prizeTx);

    // --- Ceremony deal (identity "encryption", see header) --------------------------
    const map = generateMap(seededRng(2026));
    const sk = ed25519.utils.randomSecretKey();
    const dealTs = BigInt(Date.now());
    const out = await deal({ map, gameId, dealTs, secretKey: sk, encrypt: async (_id, pt) => pt });
    const tiles = signTiles(map, gameId, dealTs, sk);
    const tileAt = (x: number, y: number) => tiles[tileIndex(x, y)]!;
    await exec(
      host,
      tx.sealDealCeremony(ctx, { gameId, capId, dealerPk: out.dealerPk, dealTs, ctHash: out.ctHash, quiltId: 'localnet' }),
    );
    let game = await getGame(client, gameId);
    expect(game.status).toBe(GameStatus.OPEN);
    expect(game.dealerKind).toBe(2);
    expect(game.hasPrize).toBe(true);

    // --- Bob walks into a crevasse on row 1 ---------------------------------------
    const plan = pathToRelic(map);
    const bobColumn = [...Array(GRID).keys()].find((x) => map[tileIndex(x, 1)] === TileKind.CREVASSE && x !== plan.column);
    if (bobColumn !== undefined) {
      await exec(bob, tx.join(ctx, { gameId, stake: 0n, column: bobColumn }));
      const trail = applyEvents(emptyTrail(), (await listGameEvents(client, packageId, gameId)).events);
      const bobId = [...trail.explorers.entries()].find(([, e]) => e.owner === bob.toSuiAddress())![0];
      await exec(bob, tx.step(ctx, { gameId, explorerId: bobId, dir: 0 }));
      const t = tileAt(bobColumn, 1);
      await exec(bob, tx.resolveTile(ctx, { gameId, explorerId: bobId, kind: t.kind, kindSig: t.kindSig, ropes: 0, huntLive: true, prizeType: null }));
      expect((await getExplorer(client, bobId)).status).toBe(ExplorerStatus.FROZEN);
    }

    // --- Alice walks to the relic, batching each resolve with the next step ---------
    await exec(alice, tx.join(ctx, { gameId, stake: 0n, column: plan.column }));
    const trail0 = applyEvents(emptyTrail(), (await listGameEvents(client, packageId, gameId)).events);
    const aliceId = [...trail0.explorers.entries()].find(([, e]) => e.owner === alice.toSuiAddress())![0];
    for (const dir of plan.dirs) {
      const me = await getExplorer(client, aliceId);
      const t = new Transaction();
      if (me.pending) {
        const tile = tileAt(me.pending.x, me.pending.y);
        tx.resolveTile(ctx, { gameId, explorerId: aliceId, kind: tile.kind, kindSig: tile.kindSig, ropes: me.ropes, huntLive: true, prizeType: null }, t);
      }
      tx.step(ctx, { gameId, explorerId: aliceId, dir }, t);
      const wait = Math.max(0, me.lastStepMs + 8_500 - Date.now());
      await new Promise((r) => setTimeout(r, me.steps === 0 ? 0 : wait));
      await exec(alice, t);
    }
    const atRelic = await getExplorer(client, aliceId);
    const [rx, ry] = findRelic(map);
    expect([atRelic.x, atRelic.y]).toEqual([rx, ry]);
    expect(atRelic.pending).toMatchObject({ x: rx, y: ry });

    const relic = tileAt(rx, ry);
    await exec(
      alice,
      tx.resolveTile(ctx, {
        gameId, explorerId: aliceId, kind: relic.kind, kindSig: relic.kindSig, ropes: atRelic.ropes, huntLive: true,
        prizeType: '0x2::coin::Coin<0x2::sui::SUI>',
      }),
    );

    // --- Outcome -------------------------------------------------------------------
    game = await getGame(client, gameId);
    expect(game.status).toBe(GameStatus.ENDED_FOUND);
    expect(game.finder).toBe(alice.toSuiAddress());
    expect(game.hasPrize).toBe(false);
    expect((await getExplorer(client, aliceId)).status).toBe(ExplorerStatus.FINDER);

    const events = (await listGameEvents(client, packageId, gameId)).events;
    const names = events.map((e) => e.name);
    for (const n of ['LobbyCreated', 'PrizeDeposited', 'GameDealt', 'ExplorerJoined', 'Stepped', 'TileResolved', 'RelicClaimed']) {
      expect(names).toContain(n);
    }
    if (bobColumn !== undefined) expect(names).toContain('ExplorerFrozen');
    const trail = applyEvents(emptyTrail(), events);
    expect(trail.finder).toBe(alice.toSuiAddress());
    expect(trail.prizeType).toContain('::coin::Coin<');
  });
});
