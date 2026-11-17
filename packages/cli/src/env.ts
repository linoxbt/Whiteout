/** Shared CLI plumbing: config, signer, client, transaction execution, local state. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { Transaction } from '@mysten/sui/transactions';
import {
  getGame,
  loadConfig,
  makeClient,
  parseAbort,
  type Client,
  type GameState,
  type NetworkConfig,
  type tx,
} from '@whiteout/core';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export interface Deploy extends Partial<NetworkConfig> {
  dealerEnclaveId?: string;
  upgradeCapIds?: string[];
}

export interface Env {
  cfg: NetworkConfig;
  deploy: Deploy;
  client: Client;
  signer: Ed25519Keypair;
  address: string;
  stateDir: string;
}

export interface GlobalOpts {
  network: 'testnet' | 'mainnet';
  deploy?: string;
  stateDir?: string;
}

export function loadEnv(opts: GlobalOpts, needSigner = true, allowNoPackage = false): Env {
  const deployPath = opts.deploy ?? join(REPO_ROOT, 'deploy', `${opts.network}.json`);
  const deploy: Deploy = JSON.parse(readFileSync(deployPath, 'utf8'));
  const cfg = loadConfig(opts.network, stripEmpty(deploy));
  if (!cfg.packageId && !allowNoPackage) throw new Error(`packageId is not set in ${deployPath}`);
  const client = makeClient(cfg);
  const key = process.env.WHITEOUT_HOST_KEY ?? process.env.SUI_PRIVATE_KEY;
  if (needSigner && !key) throw new Error('Set WHITEOUT_HOST_KEY to the host wallet key (suiprivkey...)');
  const signer = key ? Ed25519Keypair.fromSecretKey(key) : Ed25519Keypair.generate();
  const stateDir = opts.stateDir ?? join(process.cwd(), '.whiteout');
  return { cfg, deploy, client, signer, address: signer.toSuiAddress(), stateDir };
}

function stripEmpty<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== '' && !(Array.isArray(v) && v.length === 0)),
  ) as Partial<T>;
}

export function ctxFor(env: Env, coinType: string): tx.Ctx {
  return { packageId: env.cfg.packageId, coinType };
}

export async function gameCtx(env: Env, gameId: string): Promise<{ game: GameState; ctx: tx.Ctx }> {
  const game = await getGame(env.client, gameId);
  return { game, ctx: ctxFor(env, game.coinType) };
}

export interface ExecResult {
  digest: string;
  created: Array<{ id: string; type: string }>;
  events: Array<{ eventType: string; bcs: Uint8Array }>;
}

/** Signs, executes and waits for a transaction; throws a readable error on abort. */
export async function exec(env: Env, transaction: Transaction): Promise<ExecResult> {
  transaction.setSenderIfNotSet(env.address);
  const res = await env.client.core.signAndExecuteTransaction({
    transaction,
    signer: env.signer,
    include: { effects: true, objectTypes: true, events: true },
  });
  const t = res.Transaction ?? res.FailedTransaction!;
  if (!t.status.success) {
    const info = parseAbort(t.status.error, env.cfg.packageId);
    throw new Error(
      info ? `${info.name} (${info.code}): ${info.message}` : `transaction failed: ${t.status.error.message}`,
    );
  }
  await env.client.core.waitForTransaction({ digest: t.digest });
  const created = (t.effects?.changedObjects ?? [])
    .filter((c) => c.idOperation === 'Created')
    .map((c) => ({ id: c.objectId, type: t.objectTypes?.[c.objectId] ?? '' }));
  return { digest: t.digest, created, events: (t.events ?? []) as ExecResult['events'] };
}

// === Local state (per game, under .whiteout/) ===

export interface GameRecord {
  gameId: string;
  capId: string;
  coinType: string;
  network: string;
  prizeId?: string;
  prizeType?: string;
  quiltId?: string;
  dealFile?: string;
  thawBlob?: string;
}

export function recordPath(env: Env, gameId: string) {
  return join(env.stateDir, `${gameId}.json`);
}

export function saveRecord(env: Env, rec: GameRecord) {
  mkdirSync(env.stateDir, { recursive: true });
  writeFileSync(recordPath(env, rec.gameId), JSON.stringify(rec, null, 2));
}

export function loadRecord(env: Env, gameId: string): GameRecord {
  const p = recordPath(env, gameId);
  if (!existsSync(p)) throw new Error(`No local record for ${gameId}. Was it created from this directory?`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

export function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
  );
}

// === Small helpers ===

/** "2h", "90m", "300s", "1500ms" or a plain number of milliseconds. */
export function parseDuration(s: string): number {
  const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/);
  if (!m) throw new Error(`bad duration: ${s}`);
  const n = Number(m[1]);
  const unit = m[2] ?? 'ms';
  return Math.round(n * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit]!);
}

export async function confirmTyped(prompt: string, expected: string, preset?: string): Promise<void> {
  const answer = preset ?? (await ask(prompt));
  if (answer.trim().toLowerCase() !== expected.toLowerCase()) throw new Error('Confirmation did not match. Nothing was sent.');
}

async function ask(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

export function next(cmd: string) {
  console.log(`\nNext: ${cmd}`);
}
