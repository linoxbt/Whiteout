import { describe, expect, it } from 'vitest';
import { amount, dealerBadge, shortId, statusLabel, timeLeft, warmthWord } from '../src/lib/format';

describe('formatting', () => {
  it('formats SUI amounts from MIST', () => {
    expect(amount(1_500_000_000n, '0x2::sui::SUI')).toBe('1.5 SUI');
    expect(amount(1n, '0x2::sui::SUI')).toBe('0.000000001 SUI');
    expect(amount(0n, '0x2::sui::SUI')).toBe('0 SUI');
    expect(amount(42n, '0xabc::lofi::LOFI')).toBe('42 LOFI');
  });

  it('formats countdowns', () => {
    expect(timeLeft(0)).toBe('0:00');
    expect(timeLeft(252_000)).toBe('4:12');
    expect(timeLeft(7_200_000)).toBe('2h 00m');
  });

  it('labels dealers and hunt states', () => {
    expect(dealerBadge(1).tone).toBe('good');
    expect(dealerBadge(2).text).toBe('Host-dealt');
    const g = { status: 1, endsAt: 1000 } as Parameters<typeof statusLabel>[0];
    expect(statusLabel(g, 999)).toBe('Live');
    expect(statusLabel(g, 1000)).toBe('Ended');
    expect(warmthWord(5)).toBe('hot');
    expect(shortId('0x' + 'a'.repeat(64))).toMatch(/…/);
  });
});
