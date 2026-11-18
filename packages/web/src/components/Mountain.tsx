/** The 24x24 mountain on a canvas. Base camp (row 0) is at the bottom; north is up. */
import { useEffect, useRef, useState } from 'react';
import { Clouds } from './Backdrop';
import { GRID, RELIC_MIN_ROW, TileKind, sameId, type ExplorerState, type Tile, type Trail } from '@whiteout/core';

export interface MountainProps {
  trail: Trail;
  me: ExplorerState | null;
  address: string | null;
  tiles: Map<string, Tile>;
  revealing: string | null;
  /** Full map after the thaw: kinds by index y*24+x. */
  thaw?: Uint8Array | null;
  relic?: [number, number] | null;
  /** Phase 2: every relic after the thaw, claimed relic tiles, and live drifts. */
  relics?: Array<[number, number]> | null;
  claimed?: number[];
  drifts?: number[];
  /** Drifts show while now < driftUntil (chain time). */
  driftUntil?: number;
  now?: number;
  label: string;
}

const COLORS = {
  fog: '#e6edf3',
  fogLine: 'rgba(30, 60, 90, 0.035)',
  grid: 'rgba(30, 60, 90, 0.06)',
  snow: '#ffffff',
  crevasse: '#1c2a38',
  goggles: '#5aa9dc',
  rope: '#c98d4f',
  relic: '#e3a82f',
  seen: '#d3dde6',
  base: 'rgba(47, 127, 181, 0.55)',
};

/** Snow tiles you have read are tinted by warmth, so the trail shows the heat. */
const WARM_TINT = ['#ffffff', '#f4f9fd', '#e9f3fb', '#fdf6e2', '#fcebc6', '#f9dca6'];
const WARM_INK = ['#8496a8', '#5b97c4', '#2f7fb5', '#b58a17', '#c8761a', '#c2541a'];
const KIND_FILL: Record<number, string> = {
  0: COLORS.snow,
  1: COLORS.crevasse,
  2: COLORS.goggles,
  3: COLORS.rope,
  4: COLORS.relic,
};

export function Mountain(p: MountainProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const spin = useRef(0);
  // Motion state: when each tile first appeared, and the yeti's glide between tiles.
  const born = useRef(new Map<string, number>());
  const firstPaint = useRef(true);
  const glide = useRef<{ fx: number; fy: number; tx: number; ty: number; t0: number } | null>(null);
  // The thaw sweeps up the mountain from base camp (spec section 11, Thaw screen).
  const [thawRows, setThawRows] = useState(0);
  useEffect(() => {
    if (!p.thaw) return setThawRows(0);
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return setThawRows(GRID);
    let row = 0;
    const t = setInterval(() => {
      row += 1;
      setThawRows(row);
      if (row >= GRID) clearInterval(t);
    }, 70);
    return () => clearInterval(t);
  }, [p.thaw]);

  useEffect(() => {
    let raf = 0;
    const now0 = performance.now();
    for (const key of p.tiles.keys()) if (!born.current.has(key)) born.current.set(key, firstPaint.current ? 0 : now0);
    if (p.thaw) for (let i = 0; i < GRID * GRID; i++) {
      const key = `${i % GRID},${Math.floor(i / GRID)}`;
      if (!born.current.has(key) && Math.floor(i / GRID) < thawRows) born.current.set(key, now0);
    }
    firstPaint.current = false;
    if (p.me) {
      const g = glide.current;
      if (!g) glide.current = { fx: p.me.x, fy: p.me.y, tx: p.me.x, ty: p.me.y, t0: 0 };
      else if (g.tx !== p.me.x || g.ty !== p.me.y) {
        const k = easeOut(Math.min(1, (now0 - g.t0) / GLIDE_MS));
        glide.current = { fx: g.fx + (g.tx - g.fx) * k, fy: g.fy + (g.ty - g.fy) * k, tx: p.me.x, ty: p.me.y, t0: now0 };
      }
    }
    const draw = () => {
      const now = performance.now();
      let moving = false;
      const canvas = ref.current;
      const box = wrap.current;
      if (!canvas || !box) return;
      const size = Math.min(box.clientWidth, 720);
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== size * dpr) {
        canvas.width = size * dpr;
        canvas.height = size * dpr;
        canvas.style.width = `${size}px`;
        canvas.style.height = `${size}px`;
      }
      const c = canvas.getContext('2d')!;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cell = size / GRID;
      const px = (x: number) => x * cell;
      const py = (y: number) => (GRID - 1 - y) * cell; // row 0 at the bottom

      // Snow field: brighter toward base camp, bluer with altitude, soft drifts.
      const alt = c.createLinearGradient(0, 0, 0, size);
      alt.addColorStop(0, '#d9e5ef');
      alt.addColorStop(1, '#f2f6f9');
      c.fillStyle = alt;
      c.fillRect(0, 0, size, size);
      c.drawImage(drifts(size), 0, 0, size, size);
      c.strokeStyle = COLORS.grid;
      c.lineWidth = 1;
      c.beginPath();
      for (let i = 1; i < GRID; i++) {
        c.moveTo(i * cell + 0.5, 0);
        c.lineTo(i * cell + 0.5, size);
        c.moveTo(0, i * cell + 0.5);
        c.lineTo(size, i * cell + 0.5);
      }
      c.stroke();

      // The relic lies above row 12.
      c.save();
      c.setLineDash([4, 5]);
      c.strokeStyle = 'rgba(200, 144, 31, 0.45)';
      c.lineWidth = 1.5;
      c.beginPath();
      c.moveTo(0, py(RELIC_MIN_ROW - 1));
      c.lineTo(size, py(RELIC_MIN_ROW - 1));
      c.stroke();
      c.restore();
      const tag = Math.max(8, cell * 0.3);
      c.font = `600 ${tag}px 'Datatype Variable', monospace`;
      c.textAlign = 'left';
      c.textBaseline = 'bottom';
      c.fillStyle = 'rgba(176, 120, 20, 0.75)';
      c.fillText('RELIC ZONE ↑', 6, py(RELIC_MIN_ROW - 1) - 4);
      c.fillStyle = 'rgba(47, 127, 181, 0.7)';
      c.fillText('BASE CAMP', 6, size - 6);

      const fontPx = Math.max(9, cell * 0.44);
      c.textAlign = 'center';
      c.textBaseline = 'middle';

      for (let y = 0; y < GRID; y++)
        for (let x = 0; x < GRID; x++) {
          const key = `${x},${y}`;
          const mine = p.tiles.get(key);
          const thawKind = p.thaw && y < thawRows ? p.thaw[y * GRID + x] : undefined;
          const publicKind = p.trail.resolved.get(key);
          const kind = mine?.kind ?? thawKind ?? publicKind;
          if (kind === undefined) continue;
          const lit = !!mine || thawKind !== undefined;
          const tx = px(x) + 1;
          const ty = py(y) + 1;
          const ts = cell - 2;
          const age = now - (born.current.get(key) ?? 0);
          c.save();
          if (age < POP_MS) {
            moving = true;
            const k = Math.max(0, age / POP_MS);
            const sc = 0.55 + 0.45 * backOut(k);
            c.globalAlpha = Math.min(1, k * 2.2);
            c.translate(tx + ts / 2, ty + ts / 2);
            c.scale(sc, sc);
            c.translate(-(tx + ts / 2), -(ty + ts / 2));
          }
          c.save();
          if (lit && kind !== TileKind.CREVASSE) {
            c.shadowColor = kind === TileKind.RELIC ? 'rgba(227, 168, 47, 0.8)' : 'rgba(30, 60, 90, 0.16)';
            c.shadowBlur = kind === TileKind.RELIC ? 20 : 5;
            c.shadowOffsetY = kind === TileKind.RELIC ? 0 : 1.5;
          }
          c.fillStyle = !lit ? COLORS.seen : kind === TileKind.SNOW && mine ? WARM_TINT[mine.warmth]! : KIND_FILL[kind]!;
          if (!lit) c.globalAlpha = kind === TileKind.CREVASSE ? 0.55 : 0.9;
          roundRect(c, tx, ty, ts, ts, Math.max(2, cell * 0.14));
          c.fill();
          c.restore();
          glyph(c, kind, tx, ty, ts, lit);
          if (mine && kind !== TileKind.CREVASSE) {
            if (kind === TileKind.SNOW) {
              c.font = `600 ${fontPx}px 'Datatype Variable', monospace`;
              c.fillStyle = WARM_INK[mine.warmth]!;
              c.fillText(String(mine.warmth), tx + ts / 2, ty + ts / 2 + 0.5);
            }
            if (mine.hazards > 0) {
              const r = Math.max(5, cell * 0.2);
              c.fillStyle = '#e5484d';
              c.beginPath();
              c.arc(tx + ts - r * 0.55, ty + r * 0.55, r, 0, Math.PI * 2);
              c.fill();
              c.font = `700 ${r * 1.25}px 'Datatype Variable', monospace`;
              c.fillStyle = '#ffffff';
              c.fillText(String(mine.hazards), tx + ts - r * 0.55, ty + r * 0.6);
            }
          }
          c.restore();
        }

      // Base camp line.
      c.strokeStyle = COLORS.base;
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(0, size - 1);
      c.lineTo(size, size - 1);
      c.stroke();

      for (const r of p.relics ?? (p.relic ? [p.relic] : [])) {
        if (p.thaw && r[1] >= thawRows) continue;
        c.strokeStyle = '#e3a82f';
        c.lineWidth = 2;
        roundRect(c, px(r[0]) - 2, py(r[1]) - 2, cell + 4, cell + 4, cell * 0.22);
        c.stroke();
      }

      // Phase 2: a claimed relic is struck through; it is plain ground now.
      for (const i of p.claimed ?? []) {
        const x = i % GRID;
        const y = Math.floor(i / GRID);
        c.save();
        c.strokeStyle = 'rgba(16, 34, 51, 0.55)';
        c.lineWidth = Math.max(1.5, cell * 0.07);
        c.lineCap = 'round';
        c.beginPath();
        c.moveTo(px(x) + cell * 0.22, py(y) + cell * 0.78);
        c.lineTo(px(x) + cell * 0.78, py(y) + cell * 0.22);
        c.stroke();
        c.restore();
      }

      // Phase 2: snowdrifts from a blizzard, until they melt.
      if (p.drifts?.length && (p.now ?? Date.now()) < (p.driftUntil ?? 0)) {
        for (const i of p.drifts) drift(c, px(i % GRID), py(Math.floor(i / GRID)), cell);
      }

      // Yetis.
      for (const [, e] of p.trail.explorers) {
        if (e.withdrawn && !e.finder) continue;
        const own = !!p.address && sameId(e.owner, p.address);
        if (own) continue;
        yeti(c, px(e.x) + cell / 2, py(e.y) + cell / 2, cell, e.frozen ? '#a9c7de' : '#93a3b3', e.frozen);
      }
      if (p.me) {
        if (p.me.pending && p.revealing) {
          spin.current = (spin.current + 0.12) % (Math.PI * 2);
          c.strokeStyle = '#2f7fb5';
          c.lineWidth = 2.5;
          c.beginPath();
          c.arc(px(p.me.pending.x) + cell / 2, py(p.me.pending.y) + cell / 2, cell * 0.42, spin.current, spin.current + 4);
          c.stroke();
        }
        if (p.me.vision > 0) {
          c.strokeStyle = 'rgba(47,127,181,0.45)';
          c.lineWidth = 2;
          c.strokeRect(px(p.me.x - 1), py(p.me.y + 1), cell * 3, cell * 3);
        }
        const g = glide.current;
        let gx = p.me.x;
        let gy = p.me.y;
        let hop = 0;
        if (g) {
          const k = Math.min(1, (now - g.t0) / GLIDE_MS);
          if (k < 1) moving = true;
          const e = easeOut(k);
          gx = g.fx + (g.tx - g.fx) * e;
          gy = g.fy + (g.ty - g.fy) * e;
          hop = Math.sin(Math.PI * k) * cell * 0.18;
        }
        yeti(c, px(gx) + cell / 2, py(gy) + cell / 2 - hop, cell, p.me.status === 1 ? '#a9c7de' : '#16324a', p.me.status === 1, true);
      }
      if (p.revealing || moving) raf = requestAnimationFrame(draw);
    };
    draw();
    const onResize = () => draw();
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
    };
  }, [p.trail, p.me, p.address, p.tiles, p.revealing, p.thaw, p.relic, p.relics, p.claimed, p.drifts, p.driftUntil, thawRows]);

  return (
    <div ref={wrap} className="mountain">
      <div className="map-frame">
        <canvas ref={ref} role="img" aria-label={p.label} />
        <Clouds seed={5} count={4} fog={false} top={[0, 80]} />
      </div>
    </div>
  );
}

function yeti(c: CanvasRenderingContext2D, x: number, y: number, cell: number, fill: string, frozen: boolean, own = false) {
  const r = cell * (own ? 0.36 : 0.28);
  c.save();
  if (own) {
    c.shadowColor = 'rgba(47, 127, 181, 0.55)';
    c.shadowBlur = cell * 0.8;
  }
  c.fillStyle = fill;
  c.strokeStyle = own ? '#ffffff' : 'rgba(255,255,255,0.9)';
  c.lineWidth = own ? 2 : 1;
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.fill();
  c.restore();
  c.stroke();
  c.fillStyle = own ? '#ffffff' : '#1c2a38';
  c.beginPath();
  c.arc(x - r * 0.35, y - r * 0.12, r * 0.13, 0, Math.PI * 2);
  c.arc(x + r * 0.35, y - r * 0.12, r * 0.13, 0, Math.PI * 2);
  c.fill();
  if (frozen) {
    c.strokeStyle = '#5aa9dc';
    c.lineWidth = 1.5;
    c.strokeRect(x - r, y - r, r * 2, r * 2);
  }
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

const GLIDE_MS = 420;
const POP_MS = 520;
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const backOut = (t: number) => 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2);

/** Tile glyphs: a cracked crevasse, goggles, a coiled rope, and the relic diamond. */
function glyph(c: CanvasRenderingContext2D, kind: number, x: number, y: number, s: number, lit: boolean) {
  if (kind === TileKind.SNOW) return;
  const ink = kind === TileKind.CREVASSE ? (lit ? '#9fd0ef' : 'rgba(255,255,255,0.6)') : lit ? '#ffffff' : '#8a9aab';
  c.save();
  c.translate(x, y);
  c.strokeStyle = ink;
  c.fillStyle = ink;
  c.lineWidth = Math.max(1.2, s * 0.07);
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.beginPath();
  if (kind === TileKind.CREVASSE) {
    c.moveTo(s * 0.32, s * 0.16);
    c.lineTo(s * 0.52, s * 0.42);
    c.lineTo(s * 0.4, s * 0.58);
    c.lineTo(s * 0.66, s * 0.84);
    c.moveTo(s * 0.52, s * 0.42);
    c.lineTo(s * 0.7, s * 0.36);
    c.stroke();
  } else if (kind === TileKind.GOGGLES) {
    c.arc(s * 0.33, s * 0.52, s * 0.14, 0, Math.PI * 2);
    c.moveTo(s * 0.81, s * 0.52);
    c.arc(s * 0.67, s * 0.52, s * 0.14, 0, Math.PI * 2);
    c.moveTo(s * 0.47, s * 0.5);
    c.lineTo(s * 0.53, s * 0.5);
    c.stroke();
  } else if (kind === TileKind.ROPE) {
    c.arc(s * 0.5, s * 0.5, s * 0.24, 0, Math.PI * 2);
    c.moveTo(s * 0.62, s * 0.5);
    c.arc(s * 0.5, s * 0.5, s * 0.12, 0, Math.PI * 2);
    c.stroke();
  } else if (kind === TileKind.RELIC) {
    c.moveTo(s * 0.5, s * 0.22);
    c.lineTo(s * 0.78, s * 0.5);
    c.lineTo(s * 0.5, s * 0.78);
    c.lineTo(s * 0.22, s * 0.5);
    c.closePath();
    c.fill();
  }
  c.restore();
}

/** A blizzard drift: a white mound with wind lines, clearly impassable. */
function drift(c: CanvasRenderingContext2D, x: number, y: number, s: number) {
  c.save();
  c.fillStyle = 'rgba(238, 245, 251, 0.96)';
  c.strokeStyle = 'rgba(47, 127, 181, 0.55)';
  c.lineWidth = 1;
  roundRect(c, x + 1, y + 1, s - 2, s - 2, Math.max(2, s * 0.18));
  c.fill();
  c.stroke();
  c.fillStyle = '#ffffff';
  c.shadowColor = 'rgba(30, 60, 90, 0.25)';
  c.shadowBlur = 4;
  c.beginPath();
  c.moveTo(x + s * 0.12, y + s * 0.78);
  c.quadraticCurveTo(x + s * 0.32, y + s * 0.38, x + s * 0.52, y + s * 0.62);
  c.quadraticCurveTo(x + s * 0.68, y + s * 0.34, x + s * 0.88, y + s * 0.78);
  c.closePath();
  c.fill();
  c.shadowBlur = 0;
  c.strokeStyle = 'rgba(47, 127, 181, 0.6)';
  c.lineWidth = Math.max(1, s * 0.05);
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(x + s * 0.18, y + s * 0.26);
  c.lineTo(x + s * 0.5, y + s * 0.26);
  c.moveTo(x + s * 0.34, y + s * 0.4);
  c.lineTo(x + s * 0.7, y + s * 0.4);
  c.stroke();
  c.restore();
}

/** Soft snow drifts, painted once per size. */
const driftCache = new Map<number, HTMLCanvasElement>();
function drifts(size: number) {
  let d = driftCache.get(size);
  if (d) return d;
  d = document.createElement('canvas');
  d.width = d.height = 360;
  const c = d.getContext('2d')!;
  let s = 99;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 70; i++) {
    const x = r() * 360;
    const y = r() * 360;
    const rad = 14 + r() * 50;
    const g = c.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, `rgba(255,255,255,${0.25 + r() * 0.35})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  driftCache.set(size, d);
  return d;
}

const LEGEND: Array<[string, string, number]> = [
  ['Snow', '#ffffff', TileKind.SNOW],
  ['Crevasse', '#1c2a38', TileKind.CREVASSE],
  ['Goggles', '#5aa9dc', TileKind.GOGGLES],
  ['Rope', '#c98d4f', TileKind.ROPE],
  ['Relic', '#e3a82f', TileKind.RELIC],
];

/** Key to the map: tile kinds, the warmth scale and the hazard badge. */
export function Legend() {
  return (
    <div className="legend">
      {LEGEND.map(([name, fill, kind]) => (
        <span key={name}>
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <rect x="1" y="1" width="16" height="16" rx="4" fill={fill} stroke="rgba(16,34,51,0.14)" />
            <LegendGlyph kind={kind} />
          </svg>
          {name}
        </span>
      ))}
      <span className="warm-scale" title="Warmth 0 to 5">
        {WARM_TINT.map((t, i) => (
          <i key={i} style={{ background: t, color: WARM_INK[i] }}>{i}</i>
        ))}
        Warmth
      </span>
      <span>
        <i className="hz">2</i> Crevasses next to it
      </span>
      <span>
        <i className="drift-key" /> Drift (blizzard)
      </span>
    </div>
  );
}

function LegendGlyph({ kind }: { kind: number }) {
  const p = { fill: 'none', stroke: kind === TileKind.CREVASSE ? '#9fd0ef' : '#fff', strokeWidth: 1.4, strokeLinecap: 'round' as const };
  if (kind === TileKind.CREVASSE) return <path d="M6.5 4 9.5 8 7.5 10.5 11.5 14" {...p} />;
  if (kind === TileKind.GOGGLES) return <><circle cx="6.3" cy="9.3" r="2.3" {...p} /><circle cx="11.7" cy="9.3" r="2.3" {...p} /></>;
  if (kind === TileKind.ROPE) return <><circle cx="9" cy="9" r="4" {...p} /><circle cx="9" cy="9" r="1.8" {...p} /></>;
  if (kind === TileKind.RELIC) return <path d="M9 4.5 13.5 9 9 13.5 4.5 9z" fill="#fff" />;
  return null;
}
