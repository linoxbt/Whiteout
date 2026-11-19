/**
 * Watcher alerts (spec sections 7 and 21): failed deals, freezes caused by overdue
 * resolves, overdue pendings, a high key-fetch error rate, the sponsor down.
 * Sent to the host's Telegram when TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set.
 */

export async function alert(text: string): Promise<void> {
  console.log(`ALERT ${text}`);
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: `Whiteout: ${text}` }),
      signal: AbortSignal.timeout(10_000),
    });
    // A wrong token or chat answers 4xx: say so, or alerts vanish silently.
    if (!r.ok) console.error(`Telegram refused the alert (${r.status}): ${(await r.text()).slice(0, 200)}`);
  } catch (e) {
    console.error(`could not send the Telegram alert: ${(e as Error).message}`);
  }
}

export interface WatchSample {
  overdue: number;
  overdueFreezes: number;
  keyFetchErrors: number;
  reveals: number;
  sponsorUp: boolean | null;
}

/** Decides which alerts a new sample raises, compared with the previous one. */
export function alertsFor(prev: WatchSample | null, cur: WatchSample, errorRateThreshold = 0.2): string[] {
  const out: string[] = [];
  if (cur.overdue > (prev?.overdue ?? 0)) out.push(`${cur.overdue} yeti(s) are past their resolve deadline.`);
  if (cur.overdueFreezes > (prev?.overdueFreezes ?? 0)) {
    out.push(`${cur.overdueFreezes - (prev?.overdueFreezes ?? 0)} yeti(s) frozen for an overdue reveal. Check Seal and Walrus.`);
  }
  const dErr = cur.keyFetchErrors - (prev?.keyFetchErrors ?? 0);
  const dOk = cur.reveals - (prev?.reveals ?? 0);
  if (dErr + dOk >= 10 && dErr / (dErr + dOk) > errorRateThreshold) {
    out.push(`Key-fetch error rate ${Math.round((100 * dErr) / (dErr + dOk))}% over the last interval.`);
  }
  if (cur.sponsorUp === false && prev?.sponsorUp !== false) out.push('The sponsor service is not answering.');
  return out;
}

/** Last good beacon counts per sponsor and game, reused when /stats answers 429/503. */
const lastStats = new Map<string, { keyFetchErrors: number; reveals: number }>();

/**
 * Sponsor contract: GET /health is 200 { ok: true, version } when the sponsor and its
 * store are up (503 { ok: false } otherwise); GET /stats/:gameId is 200
 * { key_fetch_error, reveal_ok }, rate-limited per IP (429) and 503 when the store is down.
 */
export async function sponsorSample(sponsorUrl: string | undefined, gameId: string) {
  if (!sponsorUrl) return { sponsorUp: null, keyFetchErrors: 0, reveals: 0 };
  const key = `${sponsorUrl} ${gameId}`;
  const last = lastStats.get(key) ?? { keyFetchErrors: 0, reveals: 0 };
  try {
    const [health, stats] = await Promise.all([
      fetch(`${sponsorUrl}/health`, { signal: AbortSignal.timeout(5000) }),
      fetch(`${sponsorUrl}/stats/${gameId}`, { signal: AbortSignal.timeout(5000) }),
    ]);
    // A refused /stats (rate limit, store down) must not read as counters dropping to zero,
    // or the next good sample would look like a burst of key-fetch errors.
    if (!stats.ok) return { sponsorUp: health.ok, ...last };
    const s = (await stats.json()) as { key_fetch_error?: number; reveal_ok?: number };
    const cur = { keyFetchErrors: s.key_fetch_error ?? 0, reveals: s.reveal_ok ?? 0 };
    lastStats.set(key, cur);
    return { sponsorUp: health.ok, ...cur };
  } catch {
    return { sponsorUp: false, ...last };
  }
}
