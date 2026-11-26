import { DealerKind, GameStatus, TILE_KIND_NAMES, type GameState } from '@whiteout/core';

export function shortId(id: string, n = 6) {
  return id.length > 2 * n + 2 ? `${id.slice(0, n + 2)}…${id.slice(-n)}` : id;
}

const isSui = (t: string) => /^(0x0*2)::sui::SUI$/.test(t);
const decimalsOf = new Map<string, number>();
const symbolOf = new Map<string, string>();
const asking = new Set<string>();

/** Looks up a coin's decimals and symbol once (SUI needs no lookup). */
export async function rememberCoin(coinType: string): Promise<void> {
  if (isSui(coinType) || decimalsOf.has(coinType) || asking.has(coinType)) return;
  asking.add(coinType);
  try {
    const { suiClient } = await import('../config');
    const { coinMetadata } = await suiClient.core.getCoinMetadata({ coinType });
    if (coinMetadata) {
      decimalsOf.set(coinType, coinMetadata.decimals);
      symbolOf.set(coinType, coinMetadata.symbol);
    }
  } catch {
    /* shown in base units until the lookup works */
  } finally {
    asking.delete(coinType);
  }
}

/** Base units → a readable amount, using the coin's decimals (SUI: 9). */
export function amount(v: bigint, coinType: string): string {
  const known = isSui(coinType) || decimalsOf.has(coinType);
  const symbol = symbolOf.get(coinType) ?? coinType.split('::').pop() ?? '';
  const decimals = isSui(coinType) ? 9 : (decimalsOf.get(coinType) ?? 0);
  if (!known) {
    void rememberCoin(coinType);
    return `${v} ${symbol} (base units)`;
  }
  if (!decimals) return `${v} ${symbol}`;
  const s = v.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''} ${symbol}`;
}

export function timeLeft(ms: number): string {
  if (ms <= 0) return '0:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}:${String(sec).padStart(2, '0')}`;
}

export function statusLabel(g: GameState, now: number): string {
  if (g.status === GameStatus.LOBBY) return 'Lobby';
  if (g.status === GameStatus.CANCELLED) return 'Cancelled';
  if (g.status === GameStatus.ENDED_FOUND) return 'Relic found';
  if (g.status === GameStatus.ENDED_UNCLAIMED || now >= g.endsAt) return 'Ended';
  return 'Live';
}

export function dealerBadge(kind: number): { text: string; tone: 'good' | 'warn' | 'none' } {
  if (kind === DealerKind.ENCLAVE) return { text: 'Sealed by enclave', tone: 'good' };
  if (kind === DealerKind.CEREMONY) return { text: 'Host-dealt', tone: 'warn' };
  return { text: 'Not dealt yet', tone: 'none' };
}

export const kindName = (k: number) => TILE_KIND_NAMES[k] ?? '?';

export function warmthWord(w: number): string {
  return ['frozen', 'cold', 'cool', 'mild', 'warm', 'hot'][w] ?? '';
}

/** Yetis frozen: from the freeze events, or from Explorer states when old events are pruned. */
export function frozenCount(trail: { frozenAt: unknown[]; explorers: Map<string, { frozen: boolean }> }): number {
  return Math.max(trail.frozenAt.length, [...trail.explorers.values()].filter((e) => e.frozen).length);
}
