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
export { useRoute, useTick } from './route';
