/**
 * A looping, scripted hunt on a 7 × 7 corner of the mountain: the yeti sets out, reads
 * warmth, picks up a rope, crosses a crevasse, finds the relic, and the map thaws.
 */
import { useEffect, useState } from 'react';

const N = 7;
const P = 46; // tile pitch
const T = 40; // tile size

type Step = { x: number; y: number; w?: number; kind?: 'rope' | 'crevasse' | 'relic'; hz?: number; msg: string };
const STEPS: Step[] = [
  { x: 3, y: 0, w: 1, msg: 'Set out from base camp. Warmth 1: cold.' },
  { x: 3, y: 1, w: 2, msg: 'One step north. Warmth 2: getting closer.' },
  { x: 3, y: 2, w: 2, kind: 'rope', hz: 2, msg: 'A rope. Two crevasses lie next to you.' },
  { x: 3, y: 3, kind: 'crevasse', msg: 'Crevasse! The rope carries you across.' },
  { x: 3, y: 4, w: 3, msg: 'Safe ground. Warmth 3: mild.' },
  { x: 4, y: 4, w: 3, msg: 'East. Still mild. Keep climbing.' },
  { x: 4, y: 5, w: 4, msg: 'Warmth 4: warm.' },
  { x: 5, y: 5, w: 5, msg: 'Warmth 5: hot. It is right here.' },
  { x: 5, y: 6, kind: 'relic', msg: 'The relic. Prize, pot and stake are yours.' },
];
/** The rest of the map, shown only when it thaws. */
const HIDDEN: Array<[number, number, 'crevasse' | 'goggles' | 'rope']> = [
  [2, 3, 'crevasse'], [1, 5, 'crevasse'], [6, 2, 'crevasse'], [5, 3, 'crevasse'], [0, 1, 'crevasse'], [2, 6, 'crevasse'],
  [1, 2, 'goggles'], [6, 5, 'rope'],
];
const WARM = ['#cfe0ee', '#9cc6e4', '#7fb6dd', '#e9c46a', '#e8a33d', '#de7f2c'];

const px = (x: number) => x * P + 3;
const py = (y: number) => (N - 1 - y) * P + 3;

const THAWED = 'The hunt ends and the whole mountain thaws. Anyone can audit it.';
const MESSAGES = [...new Set([...STEPS.map((s) => s.msg), THAWED])];

export function TrailDemo() {
  const [i, setI] = useState(0);
  const total = STEPS.length + 3; // + hold, thaw, thaw
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return setI(STEPS.length + 1);
    const t = setInterval(() => setI((n) => (n + 1) % total), 1250);
    return () => clearInterval(t);
  }, [total]);

  const at = Math.min(i, STEPS.length - 1);
  const seen = STEPS.slice(0, at + 1);
  const me = STEPS[at]!;
  const thawed = i >= STEPS.length;
  const msg = thawed ? THAWED : me.msg;
  const ropes = seen.some((s) => s.kind === 'rope') && !seen.some((s) => s.kind === 'crevasse') ? 1 : 0;

  return (
    <figure className="trail-demo">
      <div className="td-board">
        <svg viewBox={`0 0 ${N * P} ${N * P}`} role="img" aria-label="Animated example of a hunt">
          {Array.from({ length: N * N }, (_, k) => {
            const x = k % N;
            const y = Math.floor(k / N);
            return <rect key={k} className="td-fog" x={px(x)} y={py(y)} width={T} height={T} rx="8" />;
          })}
          {HIDDEN.map(([x, y, kind]) => (
            <g key={`${x}${y}`} className={`td-thaw ${thawed ? 'on' : ''}`} style={{ transitionDelay: `${(x + y) * 40}ms` }}>
              <rect x={px(x)} y={py(y)} width={T} height={T} rx="8" className={`td-${kind}`} />
              {kind !== 'crevasse' && <circle cx={px(x) + T / 2} cy={py(y) + T / 2} r="6" className={`td-dot-${kind}`} />}
            </g>
          ))}
          {seen.map((s, k) => (
            <g key={k} className="td-tile">
              <rect x={px(s.x)} y={py(s.y)} width={T} height={T} rx="8" className={s.kind === 'crevasse' ? 'td-crevasse' : s.kind === 'relic' ? 'td-relic' : 'td-snow'} />
              {s.w !== undefined && (
                <>
                  <rect x={px(s.x) + 6} y={py(s.y) + T - 9} width={T - 12} height="3.5" rx="1.75" fill={WARM[s.w]} />
                  <text x={px(s.x) + T / 2} y={py(s.y) + T / 2 + 1} className="td-num">{s.w}</text>
                </>
              )}
              {s.kind === 'rope' && <circle cx={px(s.x) + T - 8} cy={py(s.y) + 8} r="4" className="td-dot-rope" />}
              {s.kind === 'crevasse' && <path d={`M${px(s.x) + 8} ${py(s.y) + 20}h24`} className="td-bridge" />}
            </g>
          ))}
          <g className="td-yeti" style={{ transform: `translate(${px(me.x) + T / 2}px, ${py(me.y) + T / 2}px)` }}>
            <circle r="17" className="td-halo" />
            <path d="M-7 11 C-9 2 -8 -4 0 -6 C8 -4 9 2 7 11 Z" fill="#16324a" />
            <circle cy="-9" r="5.5" fill="#16324a" />
            <circle cx="-2" cy="-10" r="0.9" fill="#fff" />
            <circle cx="2" cy="-10" r="0.9" fill="#fff" />
          </g>
        </svg>
      </div>
      <figcaption>
        <span className="tele ice">Step {String(Math.min(i + 1, STEPS.length)).padStart(2, '0')} / {String(STEPS.length).padStart(2, '0')}</span>
        {/* Every message sits in one cell, so the card keeps the height of the longest. */}
        <span className="td-msgs" aria-live="polite">
          {MESSAGES.map((m) => (
            <span key={m === msg ? `on:${m}` : m} className={`td-msg ${m === msg ? 'on' : ''}`} aria-hidden={m !== msg}>
              {m}
            </span>
          ))}
        </span>
        <span className="td-inv tele">
          Rope {ropes}/3 · Hazards {thawed ? '—' : (me.hz ?? 0)}
        </span>
      </figcaption>
    </figure>
  );
}
