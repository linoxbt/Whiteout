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
  fog: '#0a1018',
  fogLine: 'rgba(143, 216, 255, 0.045)',
  grid: 'rgba(255, 255, 255, 0.035)',
  snow: '#e8f1fb',
  crevasse: '#000000',
  goggles: '#8fd8ff',
  rope: '#d9a066',
  relic: '#ffcf5c',
  seen: '#16202d',
  base: 'rgba(143, 216, 255, 0.35)',
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

      // Fog: dark slate with a faint diagonal sheen and a cell grid.
      c.fillStyle = COLORS.fog;
      c.fillRect(0, 0, size, size);
      const glow = c.createRadialGradient(size / 2, size, 0, size / 2, size, size);
      glow.addColorStop(0, 'rgba(143, 216, 255, 0.10)');
      glow.addColorStop(1, 'rgba(143, 216, 255, 0)');
      c.fillStyle = glow;
      c.fillRect(0, 0, size, size);
      c.strokeStyle = COLORS.fogLine;
      c.lineWidth = 1;
      for (let i = -GRID; i < GRID * 2; i += 1.5) {
        c.beginPath();
        c.moveTo(i * cell, 0);
        c.lineTo((i + GRID) * cell, size);
        c.stroke();
      }
      c.strokeStyle = COLORS.grid;
      for (let i = 1; i < GRID; i++) {
        c.beginPath();
        c.moveTo(i * cell + 0.5, 0);
        c.lineTo(i * cell + 0.5, size);
        c.moveTo(0, i * cell + 0.5);
        c.lineTo(size, i * cell + 0.5);
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
          const lit = !!mine || thawKind !== undefined;
          c.save();
          if (lit && kind !== TileKind.CREVASSE) {
            c.shadowColor = kind === TileKind.RELIC ? 'rgba(255, 207, 92, 0.8)' : 'rgba(232, 241, 251, 0.35)';
            c.shadowBlur = kind === TileKind.RELIC ? 18 : 8;
          }
          c.fillStyle = lit ? KIND_FILL[kind]! : COLORS.seen;
          roundRect(c, px(x) + 1, py(y) + 1, cell - 2, cell - 2, Math.max(2, cell * 0.18));
          c.fill();
          c.restore();
          if (lit && kind === TileKind.CREVASSE) {
            c.strokeStyle = 'rgba(143, 216, 255, 0.5)';
            c.lineWidth = 1;
            roundRect(c, px(x) + 1.5, py(y) + 1.5, cell - 3, cell - 3, Math.max(2, cell * 0.18));
            c.stroke();
          }
          if (kind !== TileKind.SNOW) {
            c.fillStyle = kind === TileKind.CREVASSE ? '#8fd8ff' : lit ? '#0b1017' : '#5b6577';
            c.font = `600 ${fontPx}px system-ui, sans-serif`;
            c.fillText(KIND_LABEL[kind]!, px(x) + cell / 2, py(y) + cell / 2);
          }
          if (mine) {
            // Clues: warmth (top-left) and hazards (bottom-right).
            c.font = `600 ${fontPx * 0.7}px system-ui, sans-serif`;
            c.fillStyle = `hsl(${205 - mine.warmth * 35}, 75%, 40%)`;
            c.fillText(String(mine.warmth), px(x) + cell * 0.27, py(y) + cell * 0.28);
            if (mine.hazards > 0) {
              c.fillStyle = '#e5484d';
              c.fillText(String(mine.hazards), px(x) + cell * 0.73, py(y) + cell * 0.74);
            }
          }
        }

      // Base camp line.
      c.strokeStyle = COLORS.base;
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(0, size - 1);
      c.lineTo(size, size - 1);
      c.stroke();

      if (p.relic && (!p.thaw || p.relic[1] < thawRows)) {
        c.strokeStyle = '#ffcf5c';
        c.lineWidth = 2;
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
          c.strokeStyle = '#8fd8ff';
          c.lineWidth = 2.5;
          c.beginPath();
          c.arc(px(p.me.pending.x) + cell / 2, py(p.me.pending.y) + cell / 2, cell * 0.42, spin.current, spin.current + 4);
          c.stroke();
        }
        if (p.me.vision > 0) {
          c.strokeStyle = 'rgba(143,216,255,0.55)';
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
  const r = cell * (own ? 0.36 : 0.28);
  c.save();
  if (own) {
    c.shadowColor = 'rgba(143, 216, 255, 0.9)';
    c.shadowBlur = cell * 0.8;
  }
  c.fillStyle = fill;
  c.strokeStyle = own ? '#8fd8ff' : 'rgba(255,255,255,0.35)';
  c.lineWidth = own ? 2 : 1;
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.fill();
  c.restore();
  c.stroke();
  c.fillStyle = '#0b1017';
  c.beginPath();
  c.arc(x - r * 0.35, y - r * 0.12, r * 0.13, 0, Math.PI * 2);
  c.arc(x + r * 0.35, y - r * 0.12, r * 0.13, 0, Math.PI * 2);
  c.fill();
  if (frozen) {
    c.strokeStyle = '#8fd8ff';
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
