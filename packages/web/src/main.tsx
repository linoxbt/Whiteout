import { DAppKitProvider } from '@mysten/dapp-kit-react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { dAppKit } from './dappkit';
import { notifyEnabled, registerAlerts } from './lib/notify';
import './styles.css';

if (notifyEnabled()) void registerAlerts();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DAppKitProvider dAppKit={dAppKit}>
      <App />
    </DAppKitProvider>
  </StrictMode>,
);
