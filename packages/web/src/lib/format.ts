import { DealerKind, GameStatus, TILE_KIND_NAMES, type GameState } from '@whiteout/core';

export function shortId(id: string, n = 6) {
  return id.length > 2 * n + 2 ? `${id.slice(0, n + 2)}…${id.slice(-n)}` : id;
}

/** Base units → a readable amount; SUI shows 9 decimals. */
export function amount(v: bigint, coinType: string): string {
  const symbol = coinType.split('::').pop() ?? '';
  const decimals = coinType.endsWith('::sui::SUI') ? 9 : 0;
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
