/**
 * The one environment loader, shared by the Node server (src/server.ts) and the Vercel
 * function (api/index.ts). It fails fast, listing every problem at once, instead of
 * starting a service that sponsors without limits:
 *  - PACKAGE_ID and ENOKI_PRIVATE_KEY are required;
 *  - REDIS_URL + REDIS_TOKEN (Upstash REST) are required unless ALLOW_MEMORY_STORE=1;
 *  - ALLOWED_ORIGINS must list exact origins unless ALLOW_MEMORY_STORE=1.
 * ALLOW_MEMORY_STORE=1 is for dev and tests only (quotas then live in one process) and is
 * refused on a Vercel production deployment.
 *
 * Variables: NETWORK, PACKAGE_ID, ENOKI_PRIVATE_KEY, REDIS_URL, REDIS_TOKEN,
 * ALLOW_MEMORY_STORE, ALLOWED_ORIGINS, SUI_RPC_URL, DAILY_TX_BUDGET,
 * IP_RATE_LIMIT_PER_MIN, BEACON_RATE_LIMIT_PER_MIN, METRICS_TOKEN, TRUST_PROXY, PORT.
 */
import { isValidSuiAddress, normalizeSuiAddress } from '@mysten/sui/utils';
import { DEFAULTS } from '@whiteout/core';
import { headerIp, type Deps, type SponsorConfig } from './app.js';
import { enokiHttp } from './enoki.js';
import { CachedGameRegistry, fullnodeTypeLookup } from './games.js';
import { DEFAULT_DAILY_TX_BUDGET, MemoryStore, UpstashStore, type Store } from './quota.js';

export class EnvError extends Error {
  override name = 'EnvError';
  constructor(readonly problems: string[]) {
    super(`sponsor configuration is invalid:\n  - ${problems.join('\n  - ')}`);
  }
}

/** 0.05 SUI (spec section 10). */
export const MAX_GAS_BUDGET_MIST = 50_000_000n;

const NETWORKS = ['testnet', 'mainnet', 'devnet', 'localnet'] as const;
const RPC: Record<(typeof NETWORKS)[number], string> = {
  testnet: DEFAULTS.testnet.rpcUrl,
  mainnet: DEFAULTS.mainnet.rpcUrl,
  devnet: 'https://fullnode.devnet.sui.io:443',
  localnet: 'http://127.0.0.1:9000',
};

export interface LoadedEnv {
  config: SponsorConfig;
  deps: Deps;
  port: number;
  /** Whether client IPs come from proxy headers (x-real-ip / x-forwarded-for). */
  trustProxy: boolean;
  memoryStore: boolean;
  rpcUrl: string;
}

type Env = Record<string, string | undefined>;

export function loadEnv(env: Env, runtime: 'node' | 'vercel', overrides: { store?: Store; deps?: Partial<Deps> } = {}): LoadedEnv {
  const problems: string[] = [];
  const str = (k: string) => {
    const v = env[k]?.trim();
    return v ? v : undefined;
  };
  const int = (k: string, d: number) => {
    const v = str(k);
    if (v === undefined) return d;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) {
      problems.push(`${k} must be a positive integer (got "${v}")`);
      return d;
    }
    return n;
  };

  const network = (str('NETWORK') ?? 'testnet') as (typeof NETWORKS)[number];
  if (!NETWORKS.includes(network)) problems.push(`NETWORK must be one of ${NETWORKS.join(', ')}`);

  const packageId = str('PACKAGE_ID');
  if (!packageId) problems.push('PACKAGE_ID is required');
  else if (!isValidSuiAddress(normalizeSuiAddress(packageId)) || !/^0x[0-9a-fA-F]{1,64}$/.test(packageId)) {
    problems.push('PACKAGE_ID is not a Sui address');
  }

  const enokiKey = str('ENOKI_PRIVATE_KEY');
  if (!enokiKey) problems.push('ENOKI_PRIVATE_KEY is required');

  const memoryStore = str('ALLOW_MEMORY_STORE') === '1';
  if (memoryStore && env.VERCEL_ENV === 'production') {
    problems.push('ALLOW_MEMORY_STORE=1 is refused on a production deployment: set REDIS_URL and REDIS_TOKEN');
  }

  const redisUrl = str('REDIS_URL');
  const redisToken = str('REDIS_TOKEN');
  if (redisUrl || redisToken) {
    if (!redisUrl || !redisToken) problems.push('REDIS_URL and REDIS_TOKEN must be set together');
    else if (!/^https:\/\//.test(redisUrl)) problems.push('REDIS_URL must be the Upstash REST URL (https://...)');
  } else if (!memoryStore && !overrides.store) {
    problems.push('REDIS_URL and REDIS_TOKEN are required (set ALLOW_MEMORY_STORE=1 for a single-process dev store)');
  }

  let allowedOrigins: string[] | '*' = (str('ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  if (allowedOrigins.includes('*')) {
    if (memoryStore) allowedOrigins = '*';
    else problems.push('ALLOWED_ORIGINS may not contain "*" in production: list the web origins');
  } else if (!allowedOrigins.length) {
    if (memoryStore) allowedOrigins = '*';
    else problems.push('ALLOWED_ORIGINS is required (comma-separated origins, e.g. https://whiteout.example)');
  } else {
    for (const o of allowedOrigins) {
      try {
        const u = new URL(o);
        if (u.origin !== o) throw new Error();
      } catch {
        problems.push(`ALLOWED_ORIGINS entry "${o}" is not an origin like https://host[:port]`);
      }
    }
  }

  const rpcUrl = str('SUI_RPC_URL') ?? RPC[network] ?? RPC.testnet;
  const dailyTxBudget = int('DAILY_TX_BUDGET', DEFAULT_DAILY_TX_BUDGET);
  const ipRatePerMin = int('IP_RATE_LIMIT_PER_MIN', 120);
  const beaconRatePerMin = int('BEACON_RATE_LIMIT_PER_MIN', 30);
  const metricsToken = str('METRICS_TOKEN');
  if (metricsToken && metricsToken.length < 16) problems.push('METRICS_TOKEN must be at least 16 characters');
  const trustProxy = runtime === 'vercel' || str('TRUST_PROXY') === '1';
  const port = int('PORT', 8787);

  if (problems.length) throw new EnvError(problems);

  const config: SponsorConfig = {
    network,
    packageId: normalizeSuiAddress(packageId!),
    maxGasBudgetMist: MAX_GAS_BUDGET_MIST,
    allowedOrigins,
    dailyTxBudget,
    ipRatePerMin,
    beaconRatePerMin,
    ...(metricsToken ? { metricsToken } : {}),
    clientIp: trustProxy ? headerIp : () => 'unknown',
  };
  const store = overrides.store ?? (redisUrl ? new UpstashStore(redisUrl, redisToken!) : new MemoryStore());
  const deps: Deps = {
    enoki: overrides.deps?.enoki ?? enokiHttp(enokiKey!, { packageId: config.packageId }),
    store,
    games: overrides.deps?.games ?? new CachedGameRegistry(fullnodeTypeLookup(network, rpcUrl), config.packageId),
  };
  return { config, deps, port, trustProxy, memoryStore: !redisUrl && !overrides.store, rpcUrl };
}
