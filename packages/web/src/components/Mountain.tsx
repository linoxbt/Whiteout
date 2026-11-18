/** The 24x24 mountain on a canvas. Base camp (row 0) is at the bottom; north is up. */
import { useEffect, useRef, useState } from 'react';
import { GRID, TileKind, sameId, type ExplorerState, type Tile, type Trail } from '@whiteout/core';

export interface MountainProps {
  trail: Trail;
  me: ExplorerState | null;
  address: string | null;
  tiles: Map<string, Tile>;
  revealing: string | null;
  /** Full map after the thaw: kinds by index y*24+x. */
  thaw?: Uint8Array | null;
  relic?: [number, number] | null;
  label: string;
}

const COLORS = {
  fog: '#c7d0dd',
  fogLine: '#b7c2d2',
  snow: '#f4f7fb',
  crevasse: '#20283a',
  goggles: '#7aa7e0',
  rope: '#c9965b',
  relic: '#f2c94c',
  seen: '#e3e9f2',
  grid: '#aab6c8',
};

const KIND_LABEL: Record<number, string> = { 0: '', 1: 'C', 2: 'G', 3: 'R', 4: '★' };
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
    const draw = () => {
      const canvas = ref.current;
      const box = wrap.current;
      if (!canvas || !box) return;
      const size = Math.min(box.clientWidth, 640);
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

      // Fog.
      c.fillStyle = COLORS.fog;
      c.fillRect(0, 0, size, size);
      c.strokeStyle = COLORS.fogLine;
      c.lineWidth = 1;
      for (let i = -GRID; i < GRID * 2; i += 1.5) {
        c.beginPath();
        c.moveTo(i * cell, 0);
        c.lineTo((i + GRID) * cell, size);
        c.stroke();
      }

      const fontPx = Math.max(8, cell * 0.42);
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
          c.fillStyle = mine || thawKind !== undefined ? KIND_FILL[kind]! : COLORS.seen;
          c.fillRect(px(x) + 0.5, py(y) + 0.5, cell - 1, cell - 1);
          if (kind !== TileKind.SNOW) {
            c.fillStyle = kind === TileKind.CREVASSE ? '#f4f7fb' : '#1d2433';
            c.font = `600 ${fontPx}px system-ui, sans-serif`;
            c.fillText(KIND_LABEL[kind]!, px(x) + cell / 2, py(y) + cell / 2);
          }
          if (mine) {
            // Clues: warmth (top-left) and hazards (bottom-right).
            c.font = `600 ${fontPx * 0.7}px system-ui, sans-serif`;
            c.fillStyle = `hsl(${220 - mine.warmth * 40}, 70%, 42%)`;
            c.fillText(String(mine.warmth), px(x) + cell * 0.27, py(y) + cell * 0.28);
            if (mine.hazards > 0) {
              c.fillStyle = '#c0392b';
              c.fillText(String(mine.hazards), px(x) + cell * 0.73, py(y) + cell * 0.74);
            }
          }
        }

      // Base camp line.
      c.strokeStyle = '#6b7c96';
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(0, size - 1);
      c.lineTo(size, size - 1);
      c.stroke();

      if (p.relic && (!p.thaw || p.relic[1] < thawRows)) {
        c.strokeStyle = '#d4a017';
        c.lineWidth = 3;
        c.strokeRect(px(p.relic[0]) + 1.5, py(p.relic[1]) + 1.5, cell - 3, cell - 3);
      }

      // Yetis.
      for (const [, e] of p.trail.explorers) {
        if (e.withdrawn && !e.finder) continue;
        const own = !!p.address && sameId(e.owner, p.address);
        if (own) continue;
        yeti(c, px(e.x) + cell / 2, py(e.y) + cell / 2, cell, e.frozen ? '#8fb3d9' : '#6b7c96', e.frozen);
      }
      if (p.me) {
        if (p.me.pending && p.revealing) {
          spin.current = (spin.current + 0.12) % (Math.PI * 2);
          c.strokeStyle = '#2f6fd1';
          c.lineWidth = 2.5;
          c.beginPath();
          c.arc(px(p.me.pending.x) + cell / 2, py(p.me.pending.y) + cell / 2, cell * 0.42, spin.current, spin.current + 4);
          c.stroke();
        }
        if (p.me.vision > 0) {
          c.strokeStyle = 'rgba(47,111,209,0.6)';
          c.lineWidth = 2;
          c.strokeRect(px(p.me.x - 1), py(p.me.y + 1), cell * 3, cell * 3);
        }
        yeti(c, px(p.me.x) + cell / 2, py(p.me.y) + cell / 2, cell, p.me.status === 1 ? '#8fb3d9' : '#ffffff', p.me.status === 1, true);
      }
      if (p.revealing) raf = requestAnimationFrame(draw);
    };
    draw();
    const onResize = () => draw();
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
    };
  }, [p.trail, p.me, p.address, p.tiles, p.revealing, p.thaw, p.relic, thawRows]);

  return (
    <div ref={wrap} className="mountain">
      <canvas ref={ref} role="img" aria-label={p.label} />
    </div>
  );
}

function yeti(c: CanvasRenderingContext2D, x: number, y: number, cell: number, fill: string, frozen: boolean, own = false) {
  const r = cell * (own ? 0.36 : 0.3);
  c.fillStyle = fill;
  c.strokeStyle = own ? '#1d2433' : '#3d4a60';
  c.lineWidth = own ? 2.5 : 1.5;
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.fill();
  c.stroke();
  c.fillStyle = '#1d2433';
  c.beginPath();
  c.arc(x - r * 0.35, y - r * 0.15, r * 0.13, 0, Math.PI * 2);
  c.arc(x + r * 0.35, y - r * 0.15, r * 0.13, 0, Math.PI * 2);
  c.fill();
  if (frozen) {
    c.strokeStyle = '#2f6fd1';
    c.lineWidth = 1.5;
    c.strokeRect(x - r, y - r, r * 2, r * 2);
  }
}
