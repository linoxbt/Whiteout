/** Move abort codes (spec section 13) mapped to what the player sees and can do. */

export interface AbortInfo {
  code: number;
  name: string;
  message: string;
  /** What the client should do next. */
  action: 'none' | 'retry' | 'refresh' | 'resolve_first' | 'wait' | 'thaw' | 'contact_host';
}

export const ABORTS: Record<number, AbortInfo> = {
  1: { code: 1, name: 'EBadParam', message: 'That value is out of range.', action: 'none' },
  2: { code: 2, name: 'EWrongState', message: 'The hunt is not in the right state for that.', action: 'refresh' },
  3: { code: 3, name: 'ENotHost', message: 'That host pass belongs to another hunt.', action: 'none' },
  4: { code: 4, name: 'EPrizeExists', message: 'This hunt already has a prize.', action: 'none' },
  5: { code: 5, name: 'ENoPrize', message: 'This hunt has no prize yet.', action: 'none' },
  6: { code: 6, name: 'EStakeInCeremony', message: 'Host-dealt hunts must be free to enter.', action: 'none' },
  7: { code: 7, name: 'EFull', message: 'This hunt is full.', action: 'none' },
  8: { code: 8, name: 'EAlreadyJoined', message: 'You already joined this hunt.', action: 'refresh' },
  9: { code: 9, name: 'EWrongStake', message: 'The stake or base camp column is wrong.', action: 'refresh' },
  10: { code: 10, name: 'ECooldown', message: 'Catch your breath: 8 seconds between steps.', action: 'wait' },
  11: { code: 11, name: 'EBadSig', message: 'This tile failed verification.', action: 'contact_host' },
  12: { code: 12, name: 'EUseClaim', message: 'You found the relic. Claim it!', action: 'resolve_first' },
  13: { code: 13, name: 'ENotOverdue', message: 'That reveal is not overdue yet.', action: 'none' },
  14: { code: 14, name: 'EEnded', message: 'The hunt is over.', action: 'thaw' },
  15: { code: 15, name: 'ENotEnded', message: 'The hunt is still running.', action: 'wait' },
  16: { code: 16, name: 'ENotYours', message: 'That yeti is not yours.', action: 'none' },
  17: { code: 17, name: 'EInactive', message: 'Your yeti is out of the hunt.', action: 'refresh' },
  18: { code: 18, name: 'EPending', message: 'Reveal the tile you are on first.', action: 'resolve_first' },
  19: { code: 19, name: 'EOutOfBounds', message: 'That is the edge of the mountain.', action: 'none' },
  20: { code: 20, name: 'EWrongGame', message: 'That belongs to another hunt.', action: 'none' },
  21: { code: 21, name: 'ENoAccess', message: 'That tile is still in the fog.', action: 'none' },
  22: { code: 22, name: 'ENoPending', message: 'Nothing to reveal here.', action: 'refresh' },
  23: { code: 23, name: 'EUseFatal', message: 'A crevasse, and no rope.', action: 'resolve_first' },
  24: { code: 24, name: 'EGated', message: 'This hunt is for allowlisted holders only.', action: 'refresh' },
  25: { code: 25, name: 'ENotAllowed', message: 'Your address is not on this hunt\'s allowlist.', action: 'none' },
  26: { code: 26, name: 'ERelicTaken', message: 'Someone already claimed this relic. Keep looking: another one is out there.', action: 'refresh' },
  27: { code: 27, name: 'EDrift', message: 'A snowdrift blocks that way until the blizzard passes.', action: 'wait' },
  28: { code: 28, name: 'ENoBlizzard', message: 'No blizzard is due yet.', action: 'none' },
  29: { code: 29, name: 'ENotAdmin', message: 'That allowlist pass belongs to another list.', action: 'none' },
  30: { code: 30, name: 'EBatchTooLarge', message: 'Add at most 1 000 addresses per call.', action: 'none' },
};

export class WhiteoutAbort extends Error {
  constructor(
    readonly info: AbortInfo,
    readonly module?: string,
  ) {
    super(info.message);
    this.name = info.name;
  }
}

/**
 * Finds a Whiteout abort in a failed transaction's error (gRPC `ExecutionError`
 * shape, or any thrown error whose message mentions `MoveAbort ... code`).
 */
export function parseAbort(err: unknown, packageId?: string): AbortInfo | null {
  const e = err as { MoveAbort?: { abortCode: string; location?: { package?: string; module?: string } } };
  if (e && typeof e === 'object' && e.MoveAbort) {
    const loc = e.MoveAbort.location;
    if (packageId && loc?.package && normalize(loc.package) !== normalize(packageId)) return null;
    return ABORTS[Number(e.MoveAbort.abortCode)] ?? null;
  }
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err);
  const m = msg?.match(/MoveAbort.*?(?:game|policy|tiles|allowlist).*?,\s*(\d+)\)/) ?? msg?.match(/abort(?:Code|_code)?\D+(\d+)/i);
  return m ? (ABORTS[Number(m[1])] ?? null) : null;
}

function normalize(id: string) {
  return id.replace(/^0x0*/, '0x').toLowerCase();
}

/** Exponential backoff with jitter: 500 ms base, factor 2, 5 tries (spec section 7). */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { tries?: number; baseMs?: number; retryIf?: (e: unknown) => boolean } = {},
): Promise<T> {
  const tries = opts.tries ?? 5;
  const base = opts.baseMs ?? 500;
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (opts.retryIf && !opts.retryIf(e)) throw e;
      if (i < tries - 1) await sleep(base * 2 ** i * (0.5 + Math.random()));
    }
  }
  throw last;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
