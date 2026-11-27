/**
 * Checks that a Sui wallet offering only Mainnet (like OKX Wallet or Phantom) is listed
 * in Connect on the testnet site and can play: Whiteout builds and executes, the wallet
 * only signs.
 *
 *   LIVE_STATE=<state.json> HUNT=<open game id> [SITE=https://...] npx tsx live/compat-wallet.mts
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { findExplorerId, getExplorer, getGame, loadConfig, makeClient } from '@whiteout/core';
import deploy from '../../deploy/testnet.json' with { type: 'json' };
import { installWallet } from './wallet.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright') as typeof import('playwright');
const SITE = (process.env.SITE ?? 'https://whiteout-hunt.netlify.app').replace(/\/$/, '');
const gameId = process.env.HUNT!;
if (!process.env.LIVE_STATE || !gameId) throw new Error('Set LIVE_STATE and HUNT.');
const c = makeClient(loadConfig('testnet', deploy as never));
const s = JSON.parse(readFileSync(process.env.LIVE_STATE, 'utf8'));
const kp = Ed25519Keypair.fromSecretKey(s.keys[process.env.PLAYER ?? 'p3']);

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const b = await chromium.launch();
const page = await (await b.newContext({ viewport: { width: 1360, height: 900 } })).newPage();
const errs: string[] = [];
page.on('pageerror', (e) => errs.push(e.message));
const log = await installWallet(page, 'OKX Wallet', kp, c as never, 'mainnet');
await page.goto(`${SITE}/#/hunt/${gameId}`);
await page.locator('mysten-dapp-kit-connect-button').first().click();
check('a Mainnet-only wallet is listed in Connect', await page.getByText('OKX Wallet', { exact: true }).first().waitFor({ timeout: 15_000 }).then(() => true, () => false));
await page.getByText('OKX Wallet', { exact: true }).first().click();
await page.waitForFunction(() => !document.querySelector('.wallet-help-icon'), null, { timeout: 15_000 });
await page.getByText('All 576 tiles match').waitFor({ timeout: 240_000 });
await page.locator('.camp-strip i').nth(12).click();
await page.getByRole('button', { name: /Set out/ }).click();
await page.getByRole('button', { name: 'Allow' }).click({ timeout: 90_000 });
await page.locator('.here').waitFor({ timeout: 90_000 });
await page.waitForFunction(() => {
  const el = document.querySelector('button[aria-label="North"]') as HTMLButtonElement | null;
  return el && !el.disabled;
}, null, { timeout: 120_000 });
await page.getByRole('button', { name: 'North', exact: true }).click();
await page.waitForTimeout(8000);
const g = await getGame(c, gameId);
const id = await findExplorerId(c, g, kp.toSuiAddress());
const x = id ? await getExplorer(c, id) : null;
check('it joins and steps on testnet', !!x && x.steps >= 1, x ? `steps ${x.steps} at (${x.x}, ${x.y})` : 'no explorer');
check('the wallet only signs; Whiteout executes', log.signed >= 2 && log.executed.length === 0, `${log.signed} signed, ${log.executed.length} executed by the wallet`);
check('reading session signed through it', log.messages >= 1);
check('no page errors', errs.length === 0, errs.join(' | '));
await b.close();
process.exit(failed ? 1 : 0);
