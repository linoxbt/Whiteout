import { loadConfig, makeClient, type NetworkConfig } from '@whiteout/core';
import mainnet from '../../../deploy/mainnet.json';
import testnet from '../../../deploy/testnet.json';

const network = (import.meta.env.VITE_NETWORK ?? 'testnet') as 'testnet' | 'mainnet';
const deploy = Object.fromEntries(
  Object.entries(network === 'mainnet' ? mainnet : testnet).filter(([, v]) => v !== '' && !(Array.isArray(v) && !v.length)),
) as Partial<NetworkConfig> & { upgradeCapIds?: string[]; dealerSourceUrl?: string; dealerEnclaveId?: string };

const env = import.meta.env;
export const config: NetworkConfig & { upgradeCapIds: string[]; dealerEnclaveId?: string } = {
  ...loadConfig(network, deploy),
  upgradeCapIds: deploy.upgradeCapIds ?? [],
  ...(deploy.dealerEnclaveId ? { dealerEnclaveId: deploy.dealerEnclaveId } : {}),
  ...(env.VITE_SPONSOR_URL ? { sponsorUrl: env.VITE_SPONSOR_URL } : {}),
  ...(env.VITE_ENOKI_PUBLIC_KEY ? { enokiPublicKey: env.VITE_ENOKI_PUBLIC_KEY } : {}),
  ...(env.VITE_GOOGLE_CLIENT_ID ? { googleClientId: env.VITE_GOOGLE_CLIENT_ID } : {}),
};

export const configured = Boolean(config.packageId);

/**
 * Google sign-in and sponsored gas go together: a zkLogin account starts with no SUI,
 * so Google is offered only when the sponsor is configured as well.
 */
export const googleLogin = Boolean(config.enokiPublicKey && config.googleClientId && config.sponsorUrl);

/** One read client for the whole page. */
export const suiClient = makeClient(config);
