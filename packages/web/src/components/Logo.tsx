import { useId } from 'react';

/**
 * The Whiteout mark: a bold W whose upper half breaks into blizzard streaks (the
 * whiteout), holding the relic in the notch at its base.
 *
 * Grid: 48 units. Four strokes, each 8.4 wide with an 8.4 run over 32 units of
 * height, mirror-symmetric about x = 24. Streak gaps widen toward the top.
 */
export const W_PATH = 'M3 8h8.4l8.4 32h-8.4zM19.8 8h8.4l-8.4 32h-8.4zM19.8 8h8.4l8.4 32h-8.4zM36.6 8H45l-8.4 32h-8.4z';
/** Solid bands of the W, top to bottom (y, height). The gaps between them are the streaks. */
export const BANDS: Array<[number, number]> = [
  [8, 2.2],
  [12.4, 2.2],
  [16.3, 2.3],
  [19.8, 2.4],
  [22.9, 17.1],
];
export const RELIC = { x: 22.15, y: 34.75, s: 3.7, cx: 24, cy: 36.6 };

const TONES = {
  light: ['#7cc0ea', '#2f7fb5', '#0d1b2a', '#f0b43a'],
  dark: ['#ffffff', '#d9ecf9', '#7cc0ea', '#f5bd42'],
} as const;

export function Mark({ size = 30, tone = 'light', animate = true }: { size?: number; tone?: 'light' | 'dark'; animate?: boolean }) {
  const id = useId().replace(/:/g, '');
  const [top, mid, bottom, relic] = TONES[tone];
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" className={`mark ${animate ? 'anim' : ''}`}>
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="8" x2="0" y2="40" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={top} />
          <stop offset="0.45" stopColor={mid} />
          <stop offset="1" stopColor={bottom} />
        </linearGradient>
        <clipPath id={`c${id}`}>
          <path d={W_PATH} />
        </clipPath>
      </defs>
      <g clipPath={`url(#c${id})`}>
        {BANDS.map(([y, h], i) => (
          <rect key={i} className="band" style={{ '--i': BANDS.length - 1 - i } as React.CSSProperties} x="0" y={y} width="48" height={h} fill={`url(#g${id})`} />
        ))}
      </g>
      <rect className="relic" x={RELIC.x} y={RELIC.y} width={RELIC.s} height={RELIC.s} rx="0.6" fill={relic} />
    </svg>
  );
}

/** "whiteout" set in Saira, with the relic as the dot of the i. */
export function Wordmark() {
  return (
    <span className="wordmark" aria-label="Whiteout">
      wh<span className="wm-i">ı<b aria-hidden="true" /></span>teout
    </span>
  );
}

export function Logo({ size = 30, tone = 'light' }: { size?: number; tone?: 'light' | 'dark' }) {
  return (
    <span className={`logo ${tone}`}>
      <Mark size={size} tone={tone} />
      <Wordmark />
    </span>
  );
}
