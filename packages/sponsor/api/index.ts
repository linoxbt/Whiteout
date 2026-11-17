// Vercel serverless entry (spec section 21). Same app and environment as src/server.ts.
import { handle } from 'hono/vercel';
import { enokiHttp, makeApp } from '../src/app.js';
import { MemoryStore, UpstashStore } from '../src/quota.js';

const e = process.env;
const app = makeApp(
  {
    network: e.NETWORK ?? 'testnet',
    packageId: e.PACKAGE_ID ?? '',
    maxGasBudgetMist: 50_000_000n,
    allowedOrigins: e.ALLOWED_ORIGINS?.split(',').filter(Boolean) ?? [],
  },
  enokiHttp(e.ENOKI_PRIVATE_KEY ?? ''),
  e.REDIS_URL ? new UpstashStore(e.REDIS_URL, e.REDIS_TOKEN ?? '') : new MemoryStore(),
);

export default handle(app);
