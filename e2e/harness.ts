/** Shared by the localnet test and the load bots: clients, funding, publishing, execution. */
import { readFileSync } from 'node:fs';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { parseAbort, tx, applyEvents, emptyTrail, listGameEvents, GRID, TileKind, findRelic, tileIndex } from '@whiteout/core';
import type { DirectionValue, MapKinds } from '@whiteout/core';

export const RPC = process.env.LOCALNET_RPC ?? 'http://127.0.0.1:9000';
export const FAUCET = process.env.LOCALNET_FAUCET ?? 'http://127.0.0.1:9123';

export function localClient(url = RPC) {
  return new SuiGrpcClient({ network: 'localnet', baseUrl: url });
}

export type Client = SuiGrpcClient;

export async function faucet(address: string) {
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

/** Sends `amountMist` from a funded key to each address in one transaction. */
export async function fundFrom(client: Client, funder: Ed25519Keypair, to: string[], amountMist: bigint) {
  const t = new Transaction();
  const coins = t.splitCoins(t.gas, to.map(() => amountMist));
  to.forEach((addr, i) => t.transferObjects([coins[i]!], addr));
  await exec(client, funder, t);
}

export class ExecError extends Error {
  constructor(
    message: string,
    readonly kind: 'abort' | 'contention' | 'other',
    readonly code?: number,
  ) {
    super(message);
  }
}

export async function exec(client: Client, signer: Ed25519Keypair, t: Transaction) {
  t.setSenderIfNotSet(signer.toSuiAddress());
  let res;
  try {
    res = await client.core.signAndExecuteTransaction({ transaction: t, signer, include: { effects: true, objectTypes: true } });
  } catch (e) {
    const m = (e as Error).message;
    throw new ExecError(m, /congest|contention|ObjectsDoubleUsed|locked/i.test(m) ? 'contention' : 'other');
  }
  const r = res.Transaction ?? res.FailedTransaction!;
  if (!r.status.success) {
    const info = parseAbort(r.status.error);
    const congested = (r.status.error as { $kind?: string }).$kind === 'CongestedObjects';
    throw new ExecError(
      info ? `${info.name}: ${info.message}` : r.status.error.message,
      congested ? 'contention' : info ? 'abort' : 'other',
      info?.code,
    );
  }
  await client.core.waitForTransaction({ digest: r.digest });
  return r;
}

export const created = (r: Awaited<ReturnType<typeof exec>>, suffix: string) =>
  r.effects!.changedObjects.find((c) => c.idOperation === 'Created' && r.objectTypes![c.objectId]?.includes(suffix))!.objectId;

export async function publish(client: Client, signer: Ed25519Keypair, bytecodeFile: string): Promise<string> {
  const build = JSON.parse(readFileSync(bytecodeFile, 'utf8')) as { modules: string[]; dependencies: string[] };
  const t = new Transaction();
  const [cap] = t.publish({ modules: build.modules, dependencies: build.dependencies });
  t.transferObjects([cap!], signer.toSuiAddress());
  const r = await exec(client, signer, t);
  return r.effects!.changedObjects.find((c) => c.outputState === 'PackageWrite')!.objectId;
}

export async function explorerIdOf(client: Client, packageId: string, gameId: string, owner: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const trail = applyEvents(emptyTrail(), (await listGameEvents(client, packageId, gameId)).events);
    const hit = [...trail.explorers.entries()].find(([, e]) => e.owner === owner);
    if (hit) return hit[0];
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('explorer not found');
}

/** Shortest crevasse-free path from row 0 to the relic, as directions. */
export function pathToRelic(map: MapKinds): { column: number; dirs: DirectionValue[] } {
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

export { tx };
