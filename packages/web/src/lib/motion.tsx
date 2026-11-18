/** Small motion helpers. Everything respects prefers-reduced-motion (see styles.css). */
import { Fragment, useEffect, useRef, useState } from 'react';

/**
 * Fades elements marked `data-reveal` into view as they scroll in, including ones
 * added later (hunt cards arrive after the page). `data-delay` staggers them (ms).
 */
export function useRevealAll(root: React.RefObject<HTMLElement | null>, key: string) {
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const t = e.target as HTMLElement;
          const delay = Number(t.dataset.delay ?? 0);
          t.style.transitionDelay = `${delay}ms`;
          t.classList.add('in');
          // Drop the stagger once the entrance is over, so hover effects respond at once.
          setTimeout(() => (t.style.transitionDelay = ''), delay + 1400);
          io.unobserve(t);
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
    );
    const scan = () => el.querySelectorAll<HTMLElement>('[data-reveal]:not(.in)').forEach((n) => io.observe(n));
    scan();
    const mo = new MutationObserver(scan);
    mo.observe(el, { childList: true, subtree: true });
    return () => {
      io.disconnect();
      mo.disconnect();
    };
  }, [root, key]);
}

/** Counts up to `value` with an ease-out, the first time it changes from nothing. */
export function CountUp({ value, format = (n) => String(Math.round(n)) }: { value: number | null; format?: (n: number) => string }) {
  const [shown, setShown] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    if (value === null) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return setShown(value);
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / 900);
      const eased = 1 - (1 - k) ** 3;
      setShown(a + (value - a) * eased);
      if (k < 1) raf = requestAnimationFrame(step);
      else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{value === null ? '—' : format(shown)}</>;
}

const reduced = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const finePointer = () => !!window.matchMedia?.('(pointer: fine)').matches;

/** Inertial smooth scrolling on desktop (touch keeps native momentum). */
let lenis: import('lenis').default | null = null;
export function useSmoothScroll() {
  useEffect(() => {
    if (reduced() || !finePointer()) return;
    let raf = 0;
    let stop = false;
    void import('lenis').then(({ default: Lenis }) => {
      if (stop) return;
      lenis = new Lenis({ duration: 1.15, easing: (t) => 1 - Math.pow(1 - t, 4), wheelMultiplier: 0.95 });
      const loop = (t: number) => {
        lenis?.raf(t);
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    });
    return () => {
      stop = true;
      cancelAnimationFrame(raf);
      lenis?.destroy();
      lenis = null;
    };
  }, []);
}

/** Smoothly scrolls to an element id, through Lenis when it is running. */
export function scrollToId(id: string) {
  setTimeout(() => {
    const el = document.getElementById(id);
    if (!el) return;
    if (lenis) lenis.scrollTo(el, { offset: -90, duration: 1.4 });
    else window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 90, behavior: reduced() ? 'auto' : 'smooth' });
  }, 0);
}

export function scrollToTop(instant = false) {
  if (lenis) lenis.scrollTo(0, { immediate: instant, duration: 1.2 });
  else window.scrollTo({ top: 0, behavior: instant || reduced() ? 'auto' : 'smooth' });
}

/**
 * Splits text into masked words (or letters) that rise into place, staggered, when
 * the nearest [data-reveal] ancestor scrolls in. `from` continues the stagger across
 * several pieces of one heading.
 */
export function Words({ text, from = 0, letters = false }: { text: string; from?: number; letters?: boolean }) {
  const parts = letters ? [...text] : text.split(' ');
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>
          <span className="w" aria-hidden="true">
            <span style={{ '--wi': from + i } as React.CSSProperties}>{p}</span>
          </span>
          {!letters && i < parts.length - 1 ? ' ' : null}
        </Fragment>
      ))}
      <span className="sr-only">{text}</span>
    </>
  );
}

/**
 * Pointer effects for fine pointers, by event delegation:
 * - `.magnetic`: drifts toward the cursor and springs back.
 * - `.tilt`: tilts in 3D toward the cursor, with a moving glare.
 */
export function usePointerFx() {
  useEffect(() => {
    if (reduced() || !finePointer()) return;
    let mag: HTMLElement | null = null;
    let tilt: HTMLElement | null = null;
    const onMove = (e: PointerEvent) => {
      const t = e.target as Element | null;
      const m = t?.closest?.<HTMLElement>('.magnetic') ?? null;
      if (mag && mag !== m) mag.style.translate = '';
      mag = m;
      if (m) {
        const r = m.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2);
        const dy = e.clientY - (r.top + r.height / 2);
        m.style.translate = `${(dx * 0.22).toFixed(1)}px ${(dy * 0.3).toFixed(1)}px`;
      }
      const c = t?.closest?.<HTMLElement>('.tilt') ?? null;
      if (tilt && tilt !== c) {
        tilt.style.setProperty('--rx', '0deg');
        tilt.style.setProperty('--ry', '0deg');
      }
      tilt = c;
      if (c) {
        const r = c.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width;
        const py = (e.clientY - r.top) / r.height;
        c.style.setProperty('--rx', `${((0.5 - py) * 7).toFixed(2)}deg`);
        c.style.setProperty('--ry', `${((px - 0.5) * 9).toFixed(2)}deg`);
        c.style.setProperty('--gx', `${(px * 100).toFixed(1)}%`);
        c.style.setProperty('--gy', `${(py * 100).toFixed(1)}%`);
      }
    };
    const onLeave = () => {
      if (mag) mag.style.translate = '';
      if (tilt) {
        tilt.style.setProperty('--rx', '0deg');
        tilt.style.setProperty('--ry', '0deg');
      }
      mag = tilt = null;
    };
    document.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
    };
  }, []);
}

/** True while the page scrolls down (past `after`), false when it scrolls back up. */
export function useScrollDirection(after = 140) {
  const [down, setDown] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    let last = window.scrollY;
    let raf = 0;
    const on = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const y = window.scrollY;
        setScrolled(y > 40);
        if (Math.abs(y - last) < 6) return;
        setDown(y > last && y > after);
        last = y;
      });
    };
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => {
      window.removeEventListener('scroll', on);
      cancelAnimationFrame(raf);
    };
  }, [after]);
  return { down, scrolled };
}

/** Which of the given section ids is in the middle of the viewport. */
export function useActiveSection(ids: string[], enabled: boolean) {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return setActive(null);
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(e.target.id);
      },
      { rootMargin: '-45% 0px -50% 0px' },
    );
    const t = setTimeout(() => ids.forEach((id) => { const el = document.getElementById(id); if (el) io.observe(el); }), 50);
    return () => {
      clearTimeout(t);
      io.disconnect();
    };
  }, [ids.join(), enabled]);
  return active;
}

/** An accordion item whose body glides open (grid rows 0fr -> 1fr). */
export function Disclosure({ title, children, defaultOpen = false, ...rest }: { title: string; children: React.ReactNode; defaultOpen?: boolean } & React.HTMLAttributes<HTMLDivElement>) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`disclosure ${open ? 'open' : ''}`} {...rest}>
      <button className="disclosure-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span>{title}</span>
        <i aria-hidden="true" />
      </button>
      <div className="disclosure-body" role="region" aria-hidden={!open}>
        <div>{children}</div>
      </div>
    </div>
  );
}
