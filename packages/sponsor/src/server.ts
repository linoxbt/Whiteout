/** Node entry point. Environment: see src/env.ts (shared with api/index.ts). */
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { makeApp } from './app.js';
import { EnvError, loadEnv } from './env.js';

let loaded;
try {
  loaded = loadEnv(process.env, 'node');
} catch (e) {
  console.error(e instanceof EnvError ? e.message : e);
  process.exit(1);
}
const { config, deps, port, trustProxy, memoryStore } = loaded;
// Without a trusted proxy in front, rate limits key on the socket address, not on headers a client can forge.
if (!trustProxy) config.clientIp = (c) => getConnInfo(c).remote.address ?? 'unknown';

serve({ fetch: makeApp(config, deps).fetch, port });
console.log(
  JSON.stringify({ msg: 'sponsor listening', port, network: config.network, store: memoryStore ? 'memory (dev only)' : 'upstash', trustProxy }),
);
