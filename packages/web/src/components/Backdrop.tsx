/**
 * Procedural mountain art (original): daylight ridges with snow caps, valley mist, a
 * soft sun, and one small yeti. Deterministic per seed. With `parallax`, the layers
 * drift at different speeds as the page scrolls and the pointer moves.
 */
import { useEffect, useMemo, useRef } from 'react';

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

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
/** Far to near: rock tone, snow tone, how high the snow reaches, mist, parallax depth. */
const LAYERS = [
  { base: 560, rough: 90, peaks: [[980, 430], [1320, 300], [420, 260]] as Array<[number, number]>, fill: '#b9c8d6', snow: '#f7fafc', snowline: 0.7, mist: 0.0, depth: 0.08 },
  { base: 650, rough: 70, peaks: [[300, 260], [760, 330], [1450, 240]] as Array<[number, number]>, fill: '#9fb2c4', snow: '#f1f5f9', snowline: 0.62, mist: 0.55, depth: 0.16 },
  { base: 760, rough: 55, peaks: [[560, 210], [1180, 190]] as Array<[number, number]>, fill: '#8399ae', snow: '#e9f0f6', snowline: 0.55, mist: 0.6, depth: 0.26 },
  { base: 860, rough: 36, peaks: [[200, 120], [900, 90], [1500, 130]] as Array<[number, number]>, fill: '#e8eef4', snow: '#ffffff', snowline: 0.95, mist: 0.0, depth: 0.38 },
];

export function Backdrop({ seed = 7, yeti = true, parallax = false }: { seed?: number; yeti?: boolean; parallax?: boolean }) {
  const layers = useMemo(() => {
    const r = rng(seed);
    return LAYERS.map((d) => {
      const pts = ridge(r, W, d.base, d.rough, d.peaks);
      const path = `M0 ${H} ` + pts.map(([x, y]) => `L${x.toFixed(1)} ${y.toFixed(1)}`).join(' ') + ` L${W} ${H} Z`;
      const top = Math.min(...pts.map(([, y]) => y));
      const snowY = top + (d.base - top) * (1 - d.snowline);
      const lower = pts
        .slice()
        .reverse()
        .map(([x, y]) => [x, Math.max(y, Math.min(snowY + (r() - 0.5) * 26, y + 70))] as const);
      const cap = `M${pts.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L')} L${lower.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L')} Z`;
      return { ...d, path, cap, snowY };
    });
  }, [seed]);

  const groups = useRef<Array<SVGGElement | null>>([]);
  const sun = useRef<SVGGElement | null>(null);
  useEffect(() => {
    if (!parallax || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    let raf = 0;
    let mx = 0;
    let my = 0;
    let cx = 0;
    let cy = 0;
    const tick = () => {
      // Ease toward the pointer so motion stays soft.
      cx += (mx - cx) * 0.06;
      cy += (my - cy) * 0.06;
      const sy = window.scrollY;
      groups.current.forEach((g, i) => {
        if (!g) return;
        const d = LAYERS[i]!.depth;
        g.setAttribute('transform', `translate(${(cx * d * 60).toFixed(2)} ${(sy * d * 0.9 + cy * d * 24).toFixed(2)})`);
      });
      sun.current?.setAttribute('transform', `translate(${(cx * 10).toFixed(2)} ${(sy * 0.04).toFixed(2)})`);
      raf = requestAnimationFrame(tick);
    };
    const onMove = (e: PointerEvent) => {
      mx = e.clientX / window.innerWidth - 0.5;
      my = e.clientY / window.innerHeight - 0.5;
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
    };
  }, [parallax]);

  const id = `bd${seed}`;
  return (
    <svg className="backdrop" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMax slice" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#cfe2f1" />
          <stop offset="0.55" stopColor="#e7f0f7" />
          <stop offset="1" stopColor="#f6f9fb" />
        </linearGradient>
        <radialGradient id={`${id}sun`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#ffffff" stopOpacity="1" />
          <stop offset="0.25" stopColor="#fffaf0" stopOpacity="0.85" />
          <stop offset="1" stopColor="#fff6e5" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}mist`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0.85" />
        </linearGradient>
        <linearGradient id={`${id}floor`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f6f9fb" stopOpacity="0" />
          <stop offset="1" stopColor="#f6f9fb" stopOpacity="1" />
        </linearGradient>
        <filter id={`${id}soft`} x="-5%" y="-5%" width="110%" height="110%">
          <feGaussianBlur stdDeviation="0.8" />
        </filter>
      </defs>
      <rect width={W} height={H} fill={`url(#${id}sky)`} />
      <g ref={sun}>
        <circle cx="1220" cy="200" r="260" fill={`url(#${id}sun)`} />
      </g>
      {layers.map((l, i) => (
        <g key={i} ref={(el) => void (groups.current[i] = el)}>
          <path d={l.path} fill={l.fill} />
          <path d={l.cap} fill={l.snow} filter={`url(#${id}soft)`} />
          {l.mist > 0 && <rect x="-100" y={l.snowY + 40} width={W + 200} height={H - l.snowY + 200} fill={`url(#${id}mist)`} opacity={l.mist} />}
          {yeti && i === 2 && (
            <g transform="translate(1180 700) scale(1.2)">
              <ellipse cx="0" cy="22" rx="15" ry="3" fill="#5c7186" opacity="0.25" />
              <path d="M-8 20 C-10 6 -9 -6 0 -9 C9 -6 10 6 8 20 Z" fill="#16324a" />
              <circle cx="0" cy="-12" r="6" fill="#16324a" />
              <circle cx="-2" cy="-13" r="0.9" fill="#ffffff" />
              <circle cx="2" cy="-13" r="0.9" fill="#ffffff" />
            </g>
          )}
        </g>
      ))}
      <rect x="0" y={H * 0.7} width={W} height={H * 0.3 + 40} fill={`url(#${id}floor)`} />
    </svg>
  );
}

/** Light snowfall on a canvas, behind the hero text. */
export function Snowfall({ count = 90 }: { count?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const c = canvas.getContext('2d')!;
    let raf = 0;
    let w = 0;
    let h = 0;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const resize = () => {
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const flakes = Array.from({ length: count }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: 0.8 + Math.random() * 2.2,
      vy: 0.25 + Math.random() * 0.7,
      phase: Math.random() * Math.PI * 2,
    }));
    const tick = (t: number) => {
      c.clearRect(0, 0, w, h);
      for (const f of flakes) {
        f.y += f.vy;
        f.x += Math.sin(t / 1600 + f.phase) * 0.35;
        if (f.y > h + 4) {
          f.y = -4;
          f.x = Math.random() * w;
        }
        c.beginPath();
        c.arc(f.x, f.y, f.r, 0, Math.PI * 2);
        c.fillStyle = `rgba(255,255,255,${0.55 + f.r / 6})`;
        c.shadowColor = 'rgba(120,150,180,0.35)';
        c.shadowBlur = 3;
        c.fill();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    window.addEventListener('resize', resize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, [count]);
  return <canvas ref={ref} className="snowfall" aria-hidden="true" />;
}
