/**
 * Web smoke test (CI): serves the built client with the headers from public/_headers
 * (so the Content-Security-Policy is exercised), then loads every route on a desktop
 * and a phone viewport. Fails on an uncaught page error, a CSP violation, horizontal
 * overflow, or a page whose size keeps growing.
 *
 *   pnpm --filter @whiteout/web build && pnpm exec tsx web-smoke.mts
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright') as typeof import('playwright');

const DIST = new URL('../packages/web/dist/', import.meta.url).pathname;
if (!existsSync(join(DIST, 'index.html'))) throw new Error('Build the web client first: pnpm --filter @whiteout/web build');

/** Headers for "/*" from the _headers file (the same file Netlify applies). */
function siteHeaders(): Record<string, string> {
  const out: Record<string, string> = {};
  let inAll = false;
  for (const line of readFileSync(join(DIST, '_headers'), 'utf8').split('\n')) {
    if (/^\S/.test(line)) inAll = line.trim() === '/*';
    else if (inAll && line.includes(':')) {
      const i = line.indexOf(':');
      out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return out;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.wasm': 'application/wasm',
};
const headers = siteHeaders();
if (!headers['Content-Security-Policy']) throw new Error('_headers has no Content-Security-Policy');

const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^(\.\.[/\\])+/, '');
  let file = join(DIST, path);
  if (!file.startsWith(DIST) || !existsSync(file) || statSync(file).isDirectory()) file = join(DIST, 'index.html');
  res.writeHead(200, { ...headers, 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise<void>((r) => server.listen(4180, '127.0.0.1', r));
const SITE = 'http://127.0.0.1:4180/';

const ROUTES = ['', '#/history', '#/host', `#/hunt/0x${'0'.repeat(63)}1`, `#/hunt/0x${'0'.repeat(63)}1/verify`];
const failures: string[] = [];
const browser = await chromium.launch();
for (const [label, opts] of [
  ['desktop', { viewport: { width: 1360, height: 900 } }],
  ['phone', devices['iPhone 13']!],
] as const) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('console', (m) => {
    if (/Content Security Policy|Refused to (load|execute|connect|apply)/i.test(m.text())) problems.push(`CSP: ${m.text().slice(0, 200)}`);
  });
  for (const r of ROUTES) {
    await page.goto(SITE + r, { waitUntil: 'load' });
    await page.waitForTimeout(2500);
    const a = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight, vw: innerWidth }));
    await page.waitForTimeout(4000);
    const b = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }));
    if (a.w > a.vw + 1) problems.push(`${r || 'home'}: ${a.w}px wide on a ${a.vw}px screen`);
    if (b.h > a.h + 40 || b.w > a.w) problems.push(`${r || 'home'}: kept growing (${a.w}x${a.h} -> ${b.w}x${b.h})`);
    const header = await page.locator('header.top').count();
    if (!header) problems.push(`${r || 'home'}: no header rendered`);
  }
  for (const p of problems) failures.push(`[${label}] ${p}`);
  console.log(`${label}: ${problems.length ? `${problems.length} problem(s)` : 'ok'} (${ROUTES.length} routes)`);
  await ctx.close();
}
await browser.close();
server.close();
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('web smoke: all routes ok');
