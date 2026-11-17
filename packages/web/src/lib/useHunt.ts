import { useCurrentAccount, useCurrentWallet } from '@mysten/dapp-kit-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { huntFor, type Hunt, type HuntView } from './hunt';

/** Subscribes a component to one hunt; polls the chain while mounted. */
export function useHunt(gameId: string): [Hunt, HuntView] {
  const hunt = huntFor(gameId);
  const view = useSyncExternalStore(hunt.subscribe, hunt.getView);
  const account = useCurrentAccount();
  const wallet = useCurrentWallet();
  useEffect(() => {
    hunt.start();
    return () => hunt.stop();
  }, [hunt]);
  useEffect(() => {
    hunt.setPlayer(account?.address ?? null, wallet ?? null);
  }, [hunt, account?.address, wallet]);
  return [hunt, view];
}

/** Re-renders every `ms` so countdowns move. */
export function useTick(ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

/** Minimal hash router: #/, #/hunt/<id>, #/hunt/<id>/verify, ... */
export function useRoute(): string[] {
  const read = () => window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
