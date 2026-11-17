import { loadConfig, makeClient, type NetworkConfig } from '@whiteout/core';
import mainnet from '../../../deploy/mainnet.json';
import testnet from '../../../deploy/testnet.json';

const network = (import.meta.env.VITE_NETWORK ?? 'testnet') as 'testnet' | 'mainnet';
const deploy = Object.fromEntries(
  Object.entries(network === 'mainnet' ? mainnet : testnet).filter(([, v]) => v !== '' && !(Array.isArray(v) && !v.length)),
) as Partial<NetworkConfig> & { upgradeCapIds?: string[]; dealerSourceUrl?: string };

const env = import.meta.env;
export const config: NetworkConfig & { upgradeCapIds: string[] } = {
  ...loadConfig(network, deploy),
  upgradeCapIds: deploy.upgradeCapIds ?? [],
  ...(env.VITE_SPONSOR_URL ? { sponsorUrl: env.VITE_SPONSOR_URL } : {}),
  ...(env.VITE_ENOKI_PUBLIC_KEY ? { enokiPublicKey: env.VITE_ENOKI_PUBLIC_KEY } : {}),
  ...(env.VITE_GOOGLE_CLIENT_ID ? { googleClientId: env.VITE_GOOGLE_CLIENT_ID } : {}),
};

export const configured = Boolean(config.packageId);

/** One read client for the whole page. */
export const suiClient = makeClient(config);
