/** Wallets: Google via Enoki zkLogin (MD12), plus any standard Sui wallet. */
import { createDAppKit } from '@mysten/dapp-kit-react';
import { enokiWalletsInitializer } from '@mysten/enoki';
import { makeClient } from '@whiteout/core';
import { config } from './config';

const enoki =
  config.enokiPublicKey && config.googleClientId
    ? [
        enokiWalletsInitializer({
          apiKey: config.enokiPublicKey,
          providers: {
            // openid scope only: no email reaches the sponsor service (spec section 9).
            google: { clientId: config.googleClientId, extraParams: { scope: 'openid' } },
          },
        }),
      ]
    : [];

export const dAppKit = createDAppKit({
  networks: [config.network],
  defaultNetwork: config.network,
  createClient: () => makeClient(config),
  walletInitializers: enoki,
  slushWalletConfig: { appName: 'Whiteout' },
  autoConnect: true,
});

declare module '@mysten/dapp-kit-react' {
  interface Register {
    dAppKit: typeof dAppKit;
  }
}
