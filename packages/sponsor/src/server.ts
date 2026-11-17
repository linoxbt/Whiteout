/** Node entry point. Environment: NETWORK, PACKAGE_ID, ENOKI_PRIVATE_KEY, optional
 * REDIS_URL + REDIS_TOKEN (Upstash REST), ALLOWED_ORIGINS, PORT. */
import { serve } from '@hono/node-server';
import { enokiHttp, makeApp } from './app.js';
import { MemoryStore, UpstashStore } from './quota.js';

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`${k} is required`);
  return v;
};

const app = makeApp(
  {
    network: env('NETWORK', 'testnet'),
    packageId: env('PACKAGE_ID'),
    maxGasBudgetMist: 50_000_000n, // 0.05 SUI (spec section 10); enforced in the Enoki portal
    allowedOrigins: process.env.ALLOWED_ORIGINS?.split(',').filter(Boolean) ?? [],
  },
  enokiHttp(env('ENOKI_PRIVATE_KEY')),
  process.env.REDIS_URL ? new UpstashStore(env('REDIS_URL'), env('REDIS_TOKEN')) : new MemoryStore(),
);

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`sponsor listening on :${port}`);
