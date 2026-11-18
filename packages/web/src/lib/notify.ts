/**
 * Deadline alerts (Phase 2). Browser notifications while the hunt is open in a tab
 * (including a background tab); there is no push server, so a closed tab gets none.
 * Each alert fires once per key.
 */
const KEY = 'whiteout:notify';
const fired = new Set<string>();

export function notifySupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function notifyEnabled(): boolean {
  return notifySupported() && Notification.permission === 'granted' && localStorage.getItem(KEY) !== 'off';
}

export async function enableNotify(): Promise<boolean> {
  if (!notifySupported()) return false;
  localStorage.setItem(KEY, 'on');
  const p = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  return p === 'granted';
}

export function disableNotify() {
  localStorage.setItem(KEY, 'off');
}

/** Shows `body` once for `key`, only when the page is not in front (it shows a notice instead). */
export function notify(key: string, title: string, body: string): boolean {
  if (fired.has(key)) return false;
  fired.add(key);
  if (!notifyEnabled() || document.visibilityState === 'visible') return true;
  try {
    const n = new Notification(title, { body, icon: '/favicon.svg', badge: '/favicon.svg', tag: key });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* some browsers only allow notifications from a service worker */
  }
  return true;
}
