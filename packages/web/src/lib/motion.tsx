/** Small motion helpers. Everything respects prefers-reduced-motion (see styles.css). */
import { useEffect, useRef, useState } from 'react';

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
          t.style.transitionDelay = `${t.dataset.delay ?? 0}ms`;
          t.classList.add('in');
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
