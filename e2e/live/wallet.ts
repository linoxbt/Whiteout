/**
 * A real Sui wallet for browser tests. The page sees a standard Wallet Standard
 * wallet; signing and execution happen here in Node with a real key, so every
 * click in the app sends a real transaction to the network.
 */
import type { Page } from 'playwright';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { toBase64 } from '@mysten/sui/utils';
import type { SuiGrpcClient } from '@mysten/sui/grpc';

export interface WalletLog {
  signed: number;
  executed: string[];
  failed: string[];
  messages: number;
}

export async function installWallet(page: Page, name: string, kp: Ed25519Keypair, client: SuiGrpcClient, network = 'testnet') {
  const address = kp.toSuiAddress();
  const log: WalletLog = { signed: 0, executed: [], failed: [], messages: 0 };

  async function build(json: string) {
    const t = Transaction.from(json);
    t.setSenderIfNotSet(address);
    const bytes = await t.build({ client });
    const { signature } = await kp.signTransaction(bytes);
    log.signed++;
    return { bytes, signature };
  }

  await page.exposeFunction(`__e2eSign_${name}`, async (json: string) => {
    const { bytes, signature } = await build(json);
    return { bytes: toBase64(bytes), signature };
  });
  await page.exposeFunction(`__e2eSignExec_${name}`, async (json: string) => {
    const { bytes, signature } = await build(json);
    const r: any = await client.core.executeTransaction({ transaction: bytes, signatures: [signature], include: { effects: true } });
    const t = r.Transaction ?? r.FailedTransaction;
    if (t.status.success) log.executed.push(t.digest);
    else log.failed.push(`${t.digest}: ${JSON.stringify(t.status.error).slice(0, 200)}`);
    return { bytes: toBase64(bytes), signature, digest: t.digest, effects: toBase64(t.effects.bcs) };
  });
  await page.exposeFunction(`__e2eSignMsg_${name}`, async (message: number[]) => {
    const { signature } = await kp.signPersonalMessage(Uint8Array.from(message));
    log.messages++;
    return { bytes: toBase64(Uint8Array.from(message)), signature };
  });

  // A plain string: tsx would wrap a serialized function in helpers the page lacks.
  const args = JSON.stringify({ name, address, publicKey: Array.from(kp.getPublicKey().toRawBytes()), chain: `sui:${network}` });
  await page.addInitScript(`(() => {
    const { name, address, publicKey, chain } = ${args};
    const icon = 'data:image/svg+xml;base64,' + btoa('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="8" fill="#2f7fb5"/></svg>');
    const features = ['sui:signTransaction', 'sui:signAndExecuteTransaction', 'sui:signPersonalMessage'];
    const account = { address, publicKey: Uint8Array.from(publicKey), chains: [chain], features, label: name, icon };
    let connected = false;
    const listeners = [];
    const wallet = {
      version: '1.0.0', name, icon, chains: [chain],
      get accounts() { return connected ? [account] : []; },
      features: {
        'standard:connect': { version: '1.0.0', connect: async () => { connected = true; listeners.forEach((l) => l({ accounts: [account] })); return { accounts: [account] }; } },
        'standard:disconnect': { version: '1.0.0', disconnect: async () => { connected = false; } },
        'standard:events': { version: '1.0.0', on: (_e, cb) => { listeners.push(cb); return () => listeners.splice(listeners.indexOf(cb), 1); } },
        'sui:signTransaction': { version: '2.0.0', signTransaction: async ({ transaction }) => window['__e2eSign_' + name](await transaction.toJSON()) },
        'sui:signAndExecuteTransaction': { version: '2.0.0', signAndExecuteTransaction: async ({ transaction }) => window['__e2eSignExec_' + name](await transaction.toJSON()) },
        'sui:signPersonalMessage': { version: '1.1.0', signPersonalMessage: async ({ message }) => window['__e2eSignMsg_' + name](Array.from(message)) },
      },
    };
    const register = (api) => api.register(wallet);
    window.addEventListener('wallet-standard:app-ready', (e) => register(e.detail));
    try { window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register })); } catch {}
  })();`);
  return log;
}

/** Opens the connect dialog and picks the named wallet (the dialog is in a shadow root). */
export async function connect(page: Page, name: string) {
  await page.locator('mysten-dapp-kit-connect-button').first().click();
  await page.getByText(name, { exact: true }).first().click();
  await page.waitForFunction(() => !document.querySelector('.wallet-help-icon'), null, { timeout: 15_000 });
}
