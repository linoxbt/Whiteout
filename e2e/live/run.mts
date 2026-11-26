/**
 * Live end-to-end test against the deployed site and Sui testnet. Real browser, real
 * wallets (see wallet.ts), real transactions, Seal key servers and Walrus.
 *
 *   WHITEOUT_HOST_KEY=suiprivkey... npx tsx live/run.mts <phase> [...]
 *
 * Phases share state through $LIVE_STATE (JSON). Run `setup` first.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import {
  GRID,
  TileKind,
  applyEvents,
  findExplorerId,
  getExplorer,
  emptyTrail,
  listGameEvents,
  parseAbort,
  deal,
  findRelics,
  generateMap,
  getGame,
  loadConfig,
  makeClient,
  makeSealClient,
  sealEncryptor,
  seededRng,
  storeQuilt,
  tileIndex,
  toHex,
  tx,
} from '@whiteout/core';
import type { Browser, BrowserContext, Page } from 'playwright';
import deploy from '../../deploy/testnet.json' with { type: 'json' };
import { connect, installWallet, type WalletLog } from './wallet.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright') as typeof import('playwright');

const SITE = process.env.SITE ?? 'https://whiteout-hunt.netlify.app/';
// Player keys live in this file: it must be a path the operator chose, never a shared default.
if (!process.env.LIVE_STATE) throw new Error('Set LIVE_STATE to a private file path (it holds test player keys).');
const STATE = process.env.LIVE_STATE;
const SHOTS = process.env.LIVE_SHOTS ?? '/tmp/whiteout-live';
mkdirSync(SHOTS, { recursive: true });

const cfg = loadConfig('testnet', deploy as never);
const client = makeClient(cfg);
const host = Ed25519Keypair.fromSecretKey(process.env.WHITEOUT_HOST_KEY!);
const ctx = { packageId: cfg.packageId, coinType: '0x2::sui::SUI' };

type State = Record<string, any>;
const load = (): State => {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'));
  } catch {
    return {};
  }
};
const save = (s: State) => writeFileSync(STATE, JSON.stringify(s, null, 2));
const results: Array<{ check: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string) {
  results.push({ check: name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const keyOf = (s: State, who: string) => Ed25519Keypair.fromSecretKey(s.keys[who]);

async function exec(kp: Ed25519Keypair, t: Transaction) {
  t.setSender(kp.toSuiAddress());
  const r: any = await client.core.signAndExecuteTransaction({ transaction: t, signer: kp, include: { effects: true, objectTypes: true } });
  const x = r.Transaction ?? r.FailedTransaction;
  if (!x.status.success) throw new Error(JSON.stringify(x.status.error));
  await client.core.waitForTransaction({ digest: x.digest });
  return x;
}

async function balance(addr: string) {
  const r: any = await client.core.getBalance({ owner: addr });
  return Number(r.balance.balance) / 1e9;
}

/** A browser page with a named wallet installed, opened at `hash`. */
async function open(browser: Browser, name: string, kp: Ed25519Keypair, hash: string, mobile = false) {
  const context: BrowserContext = await browser.newContext(
    mobile ? { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true } : { viewport: { width: 1360, height: 900 } },
  );
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const log = await installWallet(page, name, kp, client);
  await page.goto(SITE + hash, { waitUntil: 'load' });
  return { page, context, errors, log };
}

const shot = (page: Page, file: string) => page.screenshot({ path: `${SHOTS}/${file}.png` });

// =====================================================================

const phases: Record<string, () => Promise<void>> = {
  /** Three fresh player keys, funded from the host. */
  async setup() {
    const s = load();
    s.keys ??= {};
    for (const p of ['p1', 'p2', 'p3']) s.keys[p] ??= Ed25519Keypair.generate().getSecretKey();
    save(s);
    const addrs = ['p1', 'p2', 'p3'].map((p) => keyOf(s, p).toSuiAddress());
    const t = new Transaction();
    const coins = t.splitCoins(t.gas, addrs.map(() => 60_000_000));
    addrs.forEach((a, i) => t.transferObjects([coins[i]!], a));
    const r = await exec(host, t);
    console.log('funded', addrs, r.digest);
    for (const a of addrs) check(`player funded ${a.slice(0, 10)}`, (await balance(a)) >= 0.06);
  },

  /** Host console UI: create a ranked blizzard lobby and deposit both prizes. */
  async hostCreate() {
    const s = load();
    const b = await chromium.launch();
    const { page, errors, log } = await open(b, 'E2E Host', host, '#/host');
    await connect(page, 'E2E Host');
    await fillWell(page);
    await page.getByLabel('Length (hours)').fill('1');
    await page.getByRole('button', { name: '2 ranked' }).click();
    await page.getByText('Blizzards: drifts block').click();
    await page.getByLabel('Every (min)').fill('10');
    await page.getByLabel('Drifts last (min)').fill('1');
    await shot(page, 'A1-create-form');
    await page.getByRole('button', { name: /Create the lobby/ }).click();
    await page.waitForURL(/#\/host\/0x/, { timeout: 90_000 });
    const gameId = page.url().split('#/host/')[1]!;
    s.huntK = { gameId };
    save(s);
    check('console: lobby created', !!gameId, gameId);
    for (const rank of [1, 2]) {
      await page.locator('.prize-step input[type=number]').fill('0.01');
      await page.getByRole('button', { name: `Deposit as prize ${rank}` }).click();
      await page.getByText(`Prize ${rank} is in escrow.`).waitFor({ timeout: 90_000 });
    }
    await page.waitForTimeout(2500);
    await shot(page, 'A2-prizes');
    const g = await getGame(client, gameId);
    check('console: 2 relics, shares 70/30, blizzards 10m/1m', g.relics === 2 && g.potShares.join() === '7000,3000' && g.blizzardEveryMs === 600_000 && g.blizzardMs === 60_000);
    check('console: both prizes in escrow', g.prizesDeposited === 2 && g.prizesHeld === 2);
    check('console: no page errors', errors.length === 0, errors.join(' | '));
    console.log('wallet', log);
    await b.close();
  },

  /** Harness deals hunt K as the ceremony dealer with a map it keeps, then opens it. */
  async dealKnown() {
    const s = load();
    const gameId = s.huntK.gameId;
    const caps: any = await client.core.listOwnedObjects({ owner: host.toSuiAddress(), type: `${cfg.packageId}::game::HostCap`, include: { content: true } });
    const { bcs } = await import('@mysten/sui/bcs');
    const Cap = bcs.struct('HostCap', { id: bcs.Address, game_id: bcs.Address });
    const capId = caps.objects.map((o: any) => Cap.parse(o.content)).find((c: any) => c.game_id === gameId).id;
    const map = generateMap(seededRng(Date.now() & 0xffff), 2);
    const secretKey = (await import('@noble/curves/ed25519.js')).ed25519.utils.randomSecretKey();
    const out = await deal({ map, gameId, dealTs: BigInt(Date.now()), secretKey, encrypt: sealEncryptor(makeSealClient(client, cfg), cfg.packageId, cfg.sealThreshold) });
    const { quiltId } = await storeQuilt(cfg.walrusPublishers ?? cfg.walrusPublisher!, out.tiles, 5);
    const r = await exec(host, tx.sealDealCeremony(ctx, { gameId, capId, dealerPk: out.dealerPk, dealTs: out.dealTs, ctHash: out.ctHash, quiltId }));
    s.huntK = { ...s.huntK, capId, quiltId, map: toHex(map), relics: findRelics(map) };
    save(s);
    check('harness: hunt K dealt and opened', (await getGame(client, gameId)).status === 1, r.digest);
  },

  /** Three players through the game UI: two claim ranked relics, one freezes. */
  async play() {
    const s = load();
    const gameId = s.huntK.gameId;
    const map = Uint8Array.from(Buffer.from(s.huntK.map, 'hex'));
    const relics: Array<[number, number]> = s.huntK.relics;
    const b = await chromium.launch();
    const runs = [
      runner(b, 'p3', 'E2E Player 3', gameId, freezePlan(map)),
      runner(b, 'p1', 'E2E Player 1', gameId, pathTo(map, relics[0]!)),
      runner(b, 'p2', 'E2E Player 2', gameId, pathTo(map, relics[1]!)),
    ];
    const out = await Promise.allSettled(runs);
    out.forEach((o, i) => check(`player ${['3 (freeze)', '1', '2'][i]} finished`, o.status === 'fulfilled', o.status === 'rejected' ? String(o.reason).slice(0, 300) : ''));
    const g = await getGame(client, gameId);
    check('hunt ended with both relics found (ENDED_FOUND)', g.status === 2 && g.finders.length === 2, `finders ${g.finders.length}`);
    check('pot and prizes all paid out', g.pot === 0n && g.prizesHeld === 0);
    await b.close();
  },

  /** Host console: thaw and publish, then the player thaw screen, verify page and history. */
  async thaw() {
    const s = load();
    const gameId = s.huntK.gameId;
    const b = await chromium.launch();
    const { page, errors } = await open(b, 'E2E Host', host, `#/host/${gameId}`);
    await connect(page, 'E2E Host');
    await page.getByRole('button', { name: 'Thaw and publish' }).click({ timeout: 60_000 });
    await page.getByText('Thaw file published').waitFor({ timeout: 300_000 });
    await shot(page, 'E1-thaw-published');
    const g = await getGame(client, gameId);
    check('console: thaw file published on-chain', !!g.thawBlob, g.thawBlob ?? '');
    check('console thaw: no page errors', errors.length === 0, errors.join(' | '));

    const v = await open(b, 'E2E Player 1', keyOf(s, 'p1'), `#/hunt/${gameId}/verify`);
    await v.page.getByText(/ct_hash|ciphertext/i).first().waitFor({ timeout: 60_000 });
    await v.page.waitForFunction(() => /match/i.test(document.body.innerText) || /mismatch/i.test(document.body.innerText), null, { timeout: 180_000 });
    await shot(v.page, 'E2-verify');
    const body = await v.page.innerText('body');
    check('verify page: ciphertexts match the on-chain hash', /match/i.test(body) && !/mismatch/i.test(body));

    const t = await open(b, 'E2E Player 2', keyOf(s, 'p2'), `#/hunt/${gameId}`);
    await t.page.getByText('2 of 2 relics found').waitFor({ timeout: 60_000 });
    await t.page.waitForTimeout(6000);
    await shot(t.page, 'E3-thaw-screen');
    const thawText = await t.page.innerText('body');
    check('thaw screen: shows both relics found and the thaw file verified', /relics found/i.test(thawText) && /Thaw file verified/.test(thawText) && !/failed verification/i.test(thawText));

    const h = await open(b, 'E2E Player 1', keyOf(s, 'p1'), '#/history');
    await h.page.locator('.log-row').first().waitFor({ timeout: 90_000 });
    await h.page.waitForTimeout(2000);
    await shot(h.page, 'E4-history');
    const rows = await h.page.locator('.log-row').count();
    const hist = await h.page.innerText('.logbook');
    check('history: lists the finished hunt with two ranked finders', rows >= 1 && /1st/.test(hist) && /2nd/.test(hist), `${rows} rows`);
    for (const x of [v, t, h]) check('no page errors', x.errors.length === 0, x.errors.join(' | '));
    await b.close();
  },

  /** Host console: a hunt dealt entirely in the browser, opened and joined. */
  async browserDeal() {
    const s = load();
    const b = await chromium.launch();
    const { page, errors } = await open(b, 'E2E Host', host, '#/host');
    await connect(page, 'E2E Host');
    await fillWell(page);
    await page.getByLabel('Length (hours)').fill('1');
    await page.getByText('Blizzards: drifts block').click();
    await page.getByLabel('Every (min)').fill('10');
    await page.getByLabel('Drifts last (min)').fill('1');
    await page.getByRole('button', { name: /Create the lobby/ }).click();
    await page.waitForURL(/#\/host\/0x/, { timeout: 90_000 });
    const gameId = page.url().split('#/host/')[1]!;
    s.huntC = { gameId };
    save(s);
    await page.locator('.prize-step input[type=number]').fill('0.01');
    await page.getByRole('button', { name: 'Deposit as prize 1' }).click();
    await page.getByText('Prize 1 is in escrow.').waitFor({ timeout: 90_000 });
    const started = Date.now();
    await page.getByRole('button', { name: 'Deal here' }).click({ timeout: 30_000 });
    await page.getByText('Deal checked and uploaded').waitFor({ timeout: 600_000 });
    check('console: ceremony deal in the browser (seal 576 tiles, Walrus upload)', true, `${Math.round((Date.now() - started) / 1000)} s`);
    await page.getByRole('button', { name: 'Open the hunt now' }).click();
    await page.getByText('The hunt is open.').waitFor({ timeout: 90_000 });
    await shot(page, 'F1-browser-deal-open');
    const g = await getGame(client, gameId);
    s.huntC.openAt = g.openAt;
    save(s);
    check('console: browser-dealt hunt is open on-chain', g.status === 1 && g.dealerKind === 2);
    // A player joins it and reveals a tile, proving the browser-sealed tiles decrypt.
    const p = await open(b, 'E2E Player 1', keyOf(s, 'p1'), `#/hunt/${gameId}`);
    await connect(p.page, 'E2E Player 1');
    await joinAndConsent(p.page, 12);
    await p.page.locator('.here .meta strong').filter({ hasNotText: 'In the fog' }).waitFor({ timeout: 120_000 });
    const here = await p.page.innerText('.here .meta');
    check('player: first tile of a browser-dealt map decrypts and verifies', /snow|goggles|rope/i.test(here), here.replace(/\n/g, ' '));
    check('no page errors (host, player)', errors.length + p.errors.length === 0, [...errors, ...p.errors].join(' | '));
    await b.close();
  },

  /** Once due: the host console starts a blizzard; a player's map shows the drifts. */
  async blizzard() {
    const s = load();
    const gameId = s.huntC.gameId;
    const g0 = await getGame(client, gameId);
    const wait = g0.nextBlizzardAt - Date.now();
    if (wait > 0) {
      console.log(`blizzard due in ${Math.ceil(wait / 1000)} s; waiting`);
      await new Promise((r) => setTimeout(r, wait + 3000));
    }
    const b = await chromium.launch();
    const p = await open(b, 'E2E Player 1', keyOf(s, 'p1'), `#/hunt/${gameId}`);
    await connect(p.page, 'E2E Player 1');
    // The player's own client may start it first (active players do); otherwise the host does.
    const h = await open(b, 'E2E Host', host, `#/host/${gameId}`);
    await connect(h.page, 'E2E Host');
    const btn = h.page.getByRole('button', { name: 'Start the due blizzard' });
    if (await btn.waitFor({ timeout: 15_000 }).then(() => true, () => false)) {
      await btn.click();
      await h.page.getByText('A blizzard started.').waitFor({ timeout: 90_000 });
    }
    // Whoever starts it (an active player's client or the host), wait for the drifts to land.
    let g = await getGame(client, gameId);
    for (let i = 0; i < 30 && g.driftUntil <= g0.driftUntil; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      g = await getGame(client, gameId);
    }
    check('blizzard: 12 drifts on-chain, none on base camp, at most 8 per row', g.drifts.length === 12 && g.drifts.every((d) => d >= GRID) && Math.max(...Object.values(g.drifts.reduce<Record<number, number>>((m, d) => ((m[Math.floor(d / GRID)] = (m[Math.floor(d / GRID)] ?? 0) + 1), m), {}))) <= 8);
    await p.page.getByText(/drifts melt in/).waitFor({ timeout: 30_000 }).catch(() => {});
    await shot(p.page, 'F2-blizzard-player');
    check('player sees the blizzard (weather panel)', /drifts melt in/.test(await p.page.innerText('body')));
    check('no page errors', p.errors.length + h.errors.length === 0, [...p.errors, ...h.errors].join(' | '));
    await b.close();
  },

  /** Allowlist gating through the console: a member joins, a non-member is refused. */
  async gated() {
    const s = load();
    const b = await chromium.launch();
    const { page, errors } = await open(b, 'E2E Host', host, '#/host');
    await connect(page, 'E2E Host');
    const name = `E2E holders ${Date.now() % 100000}`;
    await page.getByPlaceholder(/New list/).fill(name);
    await page.getByRole('button', { name: 'Create list' }).click();
    await page.getByText('Allowlist created.').waitFor({ timeout: 90_000 });
    const box = page.locator('.allowlist', { hasText: name });
    await box.locator('textarea').fill(keyOf(s, 'p1').toSuiAddress());
    await box.getByRole('button', { name: 'Add' }).click();
    await page.getByText('Added 1 address.').waitFor({ timeout: 90_000 });
    check('console: allowlist created with one member', true, name);
    await page.reload();
    await connect(page, 'E2E Host').catch(() => {});
    await fillWell(page);
    await page.getByLabel('Length (hours)').fill('1');
    await page.locator('select').selectOption({ label: `${name} (1)` });
    await page.getByRole('button', { name: /Create the lobby/ }).click();
    await page.waitForURL(/#\/host\/0x/, { timeout: 120_000 });
    const gameId = page.url().split('#/host/')[1]!;
    await page.locator('.prize-step input[type=number]').fill('0.01');
    await page.getByRole('button', { name: 'Deposit as prize 1' }).click();
    await page.getByText('Prize 1 is in escrow.').waitFor({ timeout: 90_000 });
    const g0 = await getGame(client, gameId);
    check('console: gated lobby carries the allowlist', !!g0.allowlist);
    s.huntG = { gameId };
    save(s);
    // Deal and open from the harness (the browser deal is covered in browserDeal).
    s.huntK0 = s.huntK;
    s.huntK = { gameId };
    save(s);
    await phases.dealKnown!();
    const s2 = load();
    s2.huntG = s2.huntK;
    s2.huntK = s2.huntK0;
    save(s2);

    const outsider = await open(b, 'E2E Player 3', keyOf(s, 'p3'), `#/hunt/${gameId}`);
    await connect(outsider.page, 'E2E Player 3');
    await outsider.page.getByText(/is not on it/).waitFor({ timeout: 60_000 });
    await shot(outsider.page, 'G1-gated-outsider');
    check('gated: non-member is told and cannot set out', await outsider.page.getByRole('button', { name: /Set out/ }).isDisabled());
    const member = await open(b, 'E2E Player 1', keyOf(s, 'p1'), `#/hunt/${gameId}`);
    await connect(member.page, 'E2E Player 1');
    await member.page.getByText(/You are on/).waitFor({ timeout: 60_000 });
    await joinAndConsent(member.page, 3);
    await member.page.locator('.here').waitFor({ timeout: 60_000 });
    const joined = applyEvents(emptyTrail(), (await listGameEvents(client, deploy.packageId, gameId)).events);
    check('gated: member joins through join_gated', [...joined.explorers.values()].some((x) => x.owner === keyOf(s, 'p1').toSuiAddress()));
    // And the contract itself refuses an outsider who goes around the UI.
    let refused = false;
    try {
      await exec(keyOf(s, 'p3'), tx.join(ctx, { gameId, stake: 0n, column: 7, allowlistId: g0.allowlist }));
    } catch (e) {
      refused = parseAbort(e, deploy.packageId)?.code === 25 || /ENotAllowed/.test(String(e));
    }
    check('gated: contract refuses a direct join_gated from a non-member (ENotAllowed)', refused);
    check('no page errors', errors.length + outsider.errors.length + member.errors.length === 0, [...errors, ...outsider.errors, ...member.errors].join(' | '));
    await b.close();
  },

  async balances() {
    const s = load();
    console.log('host', await balance(host.toSuiAddress()));
    for (const p of ['p1', 'p2', 'p3']) console.log(p, await balance(keyOf(s, p).toSuiAddress()));
  },
};

// === Player automation ===

type Plan = { start: number; moves: Array<0 | 1 | 2 | 3>; end: 'claim' | 'freeze' };

/** Shortest crevasse-free 4-way path from base camp to `goal`, as moves. */
function pathTo(map: Uint8Array, goal: [number, number]): Plan {
  const prev = new Map<number, number>();
  const q: number[] = [];
  for (let x = 0; x < GRID; x++) (prev.set(tileIndex(x, 0), -1), q.push(tileIndex(x, 0)));
  const target = tileIndex(goal[0], goal[1]);
  for (let h = 0; h < q.length; h++) {
    const i = q[h]!;
    if (i === target) break;
    const x = i % GRID;
    const y = Math.floor(i / GRID);
    for (const [dx, dy] of [[0, 1], [1, 0], [-1, 0], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) continue;
      const j = tileIndex(nx, ny);
      if (prev.has(j) || map[j] === TileKind.CREVASSE || (map[j] === TileKind.RELIC && j !== target)) continue;
      prev.set(j, i);
      q.push(j);
    }
  }
  const cells: number[] = [];
  for (let i = target; i !== -1; i = prev.get(i)!) cells.unshift(i);
  const moves = cells.slice(1).map((c, k) => {
    const d = c - cells[k]!;
    return (d === GRID ? 0 : d === 1 ? 1 : d === -GRID ? 2 : 3) as 0 | 1 | 2 | 3;
  });
  return { start: cells[0]! % GRID, moves, end: 'claim' };
}

/** A column whose row-1 tile is a crevasse: one step north and no rope. */
function freezePlan(map: Uint8Array): Plan {
  for (let x = 0; x < GRID; x++) if (map[tileIndex(x, 1)] === TileKind.CREVASSE) return { start: x, moves: [0], end: 'freeze' };
  throw new Error('no crevasse on row 1');
}

const DIR = ['North', 'East', 'South', 'West'];

/** The console asks for the well-fund address and its last 6 characters (F17). */
async function fillWell(page: Page) {
  await page.getByPlaceholder('0x… (Lofi well fund)').fill(host.toSuiAddress());
  await page.getByLabel(/last 6 characters/).fill(host.toSuiAddress().slice(-6));
}

/**
 * Audit B4: a revealed tile queued to ride with the next step must still reach the
 * chain if the player opens another page and comes back without stepping.
 */
async function leaveAndReturn(page: Page, gameId: string, who: string) {
  const queued = page.getByText(/Saved on-chain with your next step/);
  if (!(await queued.waitFor({ timeout: 30_000 }).then(() => true, () => false))) {
    console.log(`\n${who}: this tile resolved at once; nothing queued to test leaving with`);
    return;
  }
  // Stay on another page (the hunt page unmounts) until the chain shows the resolve.
  await page.evaluate(() => (location.hash = '#/history'));
  const g = await getGame(client, gameId);
  const me = keyOf(load(), who).toSuiAddress();
  const explorerId = await findExplorerId(client, g, me);
  let landed = false;
  for (let i = 0; i < 75 && explorerId; i++) {
    const x = await getExplorer(client, explorerId);
    if (!x.pending) {
      landed = true;
      break;
    }
    await page.waitForTimeout(2000);
  }
  check(`${who}: a queued reveal reaches the chain while the player is on another page`, landed);
  await page.evaluate((id) => (location.hash = `#/hunt/${id}`), gameId);
  await page.locator('.here').waitFor({ timeout: 60_000 });
}

async function joinAndConsent(page: Page, column: number) {
  await page.getByText('All 576 tiles match').waitFor({ timeout: 240_000 });
  await page.locator('.camp-strip i').nth(column).click();
  await page.getByRole('button', { name: /Set out/ }).click();
  const allow = page.getByRole('button', { name: 'Allow' });
  await allow.waitFor({ timeout: 90_000 });
  await allow.click();
}

async function position(page: Page) {
  const t = await page.innerText('.here .meta .mono');
  const m = t.match(/col (\d+) · row (\d+)/);
  return m ? [Number(m[1]) - 1, Number(m[2]) - 1] : null;
}

async function runner(b: Browser, who: string, name: string, gameId: string, plan: Plan) {
  const s = load();
  const { page, errors, log } = await open(b, name, keyOf(s, who), `#/hunt/${gameId}`);
  try {
    await connect(page, name);
    await joinAndConsent(page, plan.start);
    await page.locator('.here').waitFor({ timeout: 90_000 });
    let [x, y] = [plan.start, 0];
    for (const [i, m] of plan.moves.entries()) {
      const btn = page.getByRole('button', { name: DIR[m]!, exact: true });
      await page.waitForFunction((label) => {
        const el = document.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
        return el && !el.disabled;
      }, DIR[m]!, { timeout: 180_000, polling: 300 });
      await btn.click();
      const dx = [0, 1, 0, -1][m]!;
      const dy = [1, 0, -1, 0][m]!;
      x += dx;
      y += dy;
      if (i === plan.moves.length - 1) break;
      await page.waitForFunction(([ex, ey]) => {
        const t = document.querySelector('.here .meta .mono')?.textContent ?? '';
        const mm = t.match(/col (\d+) · row (\d+)/);
        return mm && Number(mm[1]) - 1 === ex && Number(mm[2]) - 1 === ey;
      }, [x, y], { timeout: 120_000, polling: 300 });
      process.stdout.write(`${who}:${x},${y} `);
      if (who === 'p2' && i === 2) await leaveAndReturn(page, gameId, who);
    }
    if (plan.end === 'claim') {
      const claim = page.getByRole('button', { name: /Claim the relic/ });
      await claim.waitFor({ timeout: 180_000 });
      await shot(page, `C-${who}-claim`);
      await claim.click();
      await page.getByText(/You claimed a relic/).waitFor({ timeout: 120_000 });
      await shot(page, `C-${who}-claimed`);
      check(`${who}: claimed a ranked relic through the UI`, true, `${plan.moves.length} steps, ${log.executed.length} tx`);
    } else {
      await page.getByText(/Your yeti fell into a crevasse/).waitFor({ timeout: 180_000 });
      await shot(page, `D-${who}-frozen`);
      check(`${who}: stepped on a crevasse without a rope and froze`, true);
    }
    check(`${who}: no failed transactions`, log.failed.length === 0, log.failed.join(' | '));
    check(`${who}: no page errors`, errors.length === 0, errors.join(' | '));
  } catch (e) {
    await shot(page, `X-${who}-error`).catch(() => {});
    throw e;
  } finally {
    await page.context().close();
  }
}

// =====================================================================

for (const name of process.argv.slice(2)) {
  console.log(`\n=== ${name} ===`);
  try {
    await phases[name]!();
  } catch (e) {
    check(`${name} completed`, false, (e as Error).message.slice(0, 400));
  }
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
writeFileSync(`${SHOTS}/results-${process.argv.slice(2).join('-')}.json`, JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
