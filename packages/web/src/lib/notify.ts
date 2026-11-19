/**
 * Deadline alerts (Phase 2). Browser notifications while the hunt is open in a tab
 * (including a background tab), shown through the service worker where the browser
 * requires one (Android). There is no push server, so a closed tab gets none.
 * Each alert fires once per key, and only while the page is hidden: a visible page
 * shows an in-app notice instead and keeps the alert for when it is hidden.
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
  if (p === 'granted') await registerAlerts();
  return p === 'granted';
}

export function disableNotify() {
  localStorage.setItem(KEY, 'off');
}

let registration: Promise<ServiceWorkerRegistration | null> | null = null;

/** Registers the alert service worker (https or localhost only). */
export function registerAlerts(): Promise<ServiceWorkerRegistration | null> {
  registration ??= (async () => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator) || !window.isSecureContext) return null;
    try {
      return await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    } catch {
      return null;
    }
  })();
  return registration;
}

/**
 * Shows `body` once for `key` while the page is hidden. Returns false when nothing was
 * shown (already shown, alerts off, or the page is in front), so a visible page can
 * show its own notice.
 */
export function notify(key: string, title: string, body: string): boolean {
  if (fired.has(key) || !notifyEnabled() || document.visibilityState === 'visible') return false;
  fired.add(key);
  const options: NotificationOptions = { body, icon: '/favicon.svg', badge: '/favicon.svg', tag: key, data: { url: location.href } };
  void (async () => {
    const reg = await registerAlerts();
    if (reg) {
      await reg.showNotification(title, options);
      return;
    }
    try {
      const n = new Notification(title, options);
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch {
      /* no notification support at all */
    }
  })();
  return true;
}
