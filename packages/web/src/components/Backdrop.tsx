/**
 * Procedural mountain art (original): layered ridges with snow caps, fog between the
 * layers, a pale moon, and one small yeti at the foot of the mountain. Deterministic
 * per seed, so it renders the same on every visit.
 */
import { useMemo } from 'react';

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

/** Midpoint displacement ridge across [0, w]. */
function ridge(r: () => number, w: number, base: number, rough: number, peaks: Array<[number, number]>) {
  const n = 129;
  const ys = new Array<number>(n).fill(base);
  for (const [px, ph] of peaks) {
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      const d = Math.abs(x - px) / (w * 0.22);
      ys[i] = Math.min(ys[i]!, base - ph * Math.max(0, 1 - d ** 1.25));
    }
  }
  let step = (n - 1) / 2;
  let amp = rough;
  while (step >= 1) {
    for (let i = step; i < n - 1; i += step * 2) ys[i]! += (r() - 0.5) * amp;
    for (let i = 0; i < n; i++) ys[i]! += (r() - 0.5) * amp * 0.15;
    step = Math.floor(step / 2);
    amp *= 0.55;
  }
  return ys.map((y, i) => [(i / (n - 1)) * w, y] as const);
}

const W = 1600;
const H = 900;

export function Backdrop({ seed = 7, yeti = true }: { seed?: number; yeti?: boolean }) {
  const layers = useMemo(() => {
    const r = rng(seed);
    const defs = [
      { base: 560, rough: 90, peaks: [[980, 430], [1320, 300], [420, 260]] as Array<[number, number]>, fill: '#3a4656', snow: '#c9d6e3', snowline: 0.62, fog: 0.0 },
      { base: 650, rough: 70, peaks: [[300, 260], [760, 330], [1450, 240]] as Array<[number, number]>, fill: '#273140', snow: '#9fb1c4', snowline: 0.72, fog: 0.35 },
      { base: 760, rough: 55, peaks: [[560, 210], [1180, 190]] as Array<[number, number]>, fill: '#161d27', snow: '#6f8193', snowline: 0.82, fog: 0.5 },
      { base: 860, rough: 36, peaks: [[200, 120], [900, 90], [1500, 130]] as Array<[number, number]>, fill: '#0b1017', snow: '#3c4a59', snowline: 0.9, fog: 0.6 },
    ];
    return defs.map((d) => {
      const pts = ridge(r, W, d.base, d.rough, d.peaks);
      const path = `M0 ${H} ` + pts.map(([x, y]) => `L${x.toFixed(1)} ${y.toFixed(1)}`).join(' ') + ` L${W} ${H} Z`;
      const top = Math.min(...pts.map(([, y]) => y));
      const snowY = top + (d.base - top) * (1 - d.snowline);
      // Snow cap: the ridge clipped above the snowline, with a ragged lower edge.
      const capPts = pts.map(([x, y]) => [x, y] as const);
      const lower = pts
        .slice()
        .reverse()
        .map(([x, y]) => [x, Math.max(y, Math.min(snowY + (r() - 0.5) * 26, y + 60))] as const);
      const cap = `M${capPts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L')} L${lower.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L')} Z`;
      return { ...d, path, cap, snowY };
    });
  }, [seed]);

  return (
    <svg className="backdrop" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMax slice" aria-hidden="true">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#05070a" />
          <stop offset="0.55" stopColor="#111a25" />
          <stop offset="1" stopColor="#1d2836" />
        </linearGradient>
        <radialGradient id="moon" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#f1f4f6" />
          <stop offset="0.7" stopColor="#d9e1e8" />
          <stop offset="1" stopColor="#d9e1e8" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="halo" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#cfe0ee" stopOpacity="0.18" />
          <stop offset="1" stopColor="#cfe0ee" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="fog" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#c7d4e0" stopOpacity="0" />
          <stop offset="1" stopColor="#c7d4e0" stopOpacity="0.16" />
        </linearGradient>
        <linearGradient id="floor" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0b0d10" stopOpacity="0" />
          <stop offset="1" stopColor="#0b0d10" stopOpacity="1" />
        </linearGradient>
        <filter id="soft" x="-5%" y="-5%" width="110%" height="110%">
          <feGaussianBlur stdDeviation="1.2" />
        </filter>
      </defs>
      <rect width={W} height={H} fill="url(#sky)" />
      <circle cx="1230" cy="190" r="190" fill="url(#halo)" />
      <circle cx="1230" cy="190" r="46" fill="url(#moon)" opacity="0.85" />
      {layers.map((l, i) => (
        <g key={i}>
          <path d={l.path} fill={l.fill} />
          <path d={l.cap} fill={l.snow} opacity={0.9 - i * 0.12} filter="url(#soft)" />
          {l.fog > 0 && <rect x="0" y={l.snowY - 40} width={W} height={H - l.snowY + 40} fill="url(#fog)" opacity={l.fog} />}
        </g>
      ))}
      {yeti && (
        <g transform="translate(1180 738) scale(1.15)" opacity="0.92">
          <ellipse cx="0" cy="22" rx="16" ry="3" fill="#000" opacity="0.4" />
          <path d="M-8 20 C-10 6 -9 -6 0 -9 C9 -6 10 6 8 20 Z" fill="#dfe6ec" />
          <circle cx="0" cy="-12" r="6" fill="#dfe6ec" />
          <circle cx="-2" cy="-13" r="0.9" fill="#0b0d10" />
          <circle cx="2" cy="-13" r="0.9" fill="#0b0d10" />
        </g>
      )}
      <rect x="0" y={H * 0.62} width={W} height={H * 0.38} fill="url(#floor)" />
    </svg>
  );
}
