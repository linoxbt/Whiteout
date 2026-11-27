import { DAppKitProvider } from '@mysten/dapp-kit-react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { dAppKit } from './dappkit';
import { installCompatWallets } from './lib/compatWallets';
import { notifyEnabled, registerAlerts } from './lib/notify';
import './styles.css';

if (notifyEnabled()) void registerAlerts();
// OKX, Phantom and other Mainnet-only Sui wallets appear in Connect too (see the module).
installCompatWallets();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DAppKitProvider dAppKit={dAppKit}>
      <App />
    </DAppKitProvider>
  </StrictMode>,
);
