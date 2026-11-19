// Vercel serverless entry (spec section 21). Same app and environment loader as src/server.ts:
// a missing PACKAGE_ID, ENOKI_PRIVATE_KEY, Redis or ALLOWED_ORIGINS fails the function at load.
import { handle } from 'hono/vercel';
import { makeApp } from '../src/app.js';
import { loadEnv } from '../src/env.js';

const { config, deps } = loadEnv(process.env, 'vercel');

export default handle(makeApp(config, deps));
