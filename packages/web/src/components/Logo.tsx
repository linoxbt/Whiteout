import { useId } from 'react';

/**
 * The Whiteout mark. The summit dissolves into white, the snow line is a W, and the
 * relic is sealed inside the mountain. Drawn on a 48-unit grid; the rock stops at the
 * snow line so no dark halo shows along the snowy slopes.
 */
const ROCK = 'M13.6 23 3 41.2a1.2 1.2 0 0 0 1 1.8h40a1.2 1.2 0 0 0 1-1.8L34.4 23l-5.2 8L24 25l-5.2 6z';
const SNOW = 'M24 5 34.4 23l-5.2 8L24 25l-5.2 6-5.2-8z';

export function Mark({ size = 30, tone = 'light' }: { size?: number; tone?: 'light' | 'dark' }) {
  const id = useId().replace(/:/g, '');
  const dark = tone === 'dark';
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" className="mark">
      <defs>
        <linearGradient id={`snow${id}`} x1="0" y1="5" x2="0" y2="31" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={dark ? '#ffffff' : '#edf3f8'} />
          <stop offset="1" stopColor={dark ? '#ffffff' : '#b4cde1'} />
        </linearGradient>
      </defs>
      <path d={ROCK} fill={dark ? '#3f7aa6' : '#102233'} />
      <path d={SNOW} fill={`url(#snow${id})`} />
      <rect className="mark-relic" x="21.1" y="32.7" width="5.8" height="5.8" rx="1" transform="rotate(45 24 35.6)" fill="#e3a82f" />
    </svg>
  );
}

export function Logo({ size = 30, tone = 'light' }: { size?: number; tone?: 'light' | 'dark' }) {
  return (
    <span className={`logo ${tone}`}>
      <Mark size={size} tone={tone} />
      <span className="wordmark">Whiteout</span>
    </span>
  );
}
