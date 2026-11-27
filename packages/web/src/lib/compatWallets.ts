/**
 * Lists Sui wallets that only offer Sui Mainnet (OKX Wallet, Phantom and others) on a
 * Testnet deployment. The wallet kit hides a wallet whose chains do not include the
 * app's network, so such wallets never appear in "Connect".
 *
 * A Sui signature does not depend on the network: it covers the transaction bytes,
 * which name Testnet objects. So for each such wallet we register a stand-in that
 * advertises this network and:
 *   - builds every transaction here, against this network's full node;
 *   - asks the real wallet only to sign the finished bytes (`sui:signTransaction`, or
 *     the older `sui:signTransactionBlock`);
 *   - executes the signed transaction on this network itself.
 * Personal-message signatures (the Seal reading session) pass straight through.
 *
 * A wallet that can only sign *and* execute is skipped: it would send the transaction
 * to Mainnet. Some wallets preview a transaction on their own network before signing
 * and may warn that it would fail there; the player confirms in the wallet as usual.
 */
import { Transaction } from '@mysten/sui/transactions';
import { toBase64 } from '@mysten/sui/utils';
import { getWallets, type Wallet, type WalletAccount } from '@mysten/wallet-standard';
import { config, suiClient } from '../config';

const CHAIN = `sui:${config.network}` as const;
const wrapped = new WeakSet<Wallet>();
/** Names of wallets shown through this adapter (the help dialog explains them). */
export const adaptedWallets = new Set<string>();

type Feature<T = unknown> = Record<string, T>;

function canAdapt(w: Wallet): boolean {
  const f = w.features as Feature;
  const isSui = w.chains.some((c) => c.startsWith('sui:'));
  const offersNetwork = w.chains.includes(CHAIN);
  const signOnly = 'sui:signTransaction' in f || 'sui:signTransactionBlock' in f;
  return isSui && !offersNetwork && signOnly && 'standard:connect' in f && 'standard:events' in f;
}

function adapt(real: Wallet): Wallet {
  const f = real.features as Feature<Record<string, (...a: never[]) => unknown>>;
  const features = ['standard:connect', 'standard:disconnect', 'standard:events', 'sui:signTransaction', 'sui:signAndExecuteTransaction'];
  if (f['sui:signPersonalMessage']) features.push('sui:signPersonalMessage');

  const mine = (a: WalletAccount): WalletAccount =>
    ({ address: a.address, publicKey: a.publicKey, chains: [CHAIN], features, label: a.label, icon: a.icon }) as WalletAccount;
  const realAccount = (address: string) => {
    const a = real.accounts.find((x) => x.address === address);
    if (!a) throw new Error('This account is no longer connected in the wallet.');
    return a;
  };
  const realChain = real.chains.find((c) => c.startsWith('sui:'))!;

  /** Builds against this network, then has the real wallet sign the finished bytes. */
  async function sign(transaction: { toJSON: () => Promise<string> }, address: string) {
    const tx = Transaction.from(await transaction.toJSON());
    tx.setSenderIfNotSet(address);
    const bytes = await tx.build({ client: suiClient });
    const account = realAccount(address);
    const v2 = f['sui:signTransaction'] as unknown as { signTransaction?: (i: unknown) => Promise<{ bytes: string; signature: string }> };
    if (v2?.signTransaction) {
      const out = await v2.signTransaction({
        transaction: { toJSON: async () => Transaction.from(bytes).toJSON() },
        account,
        chain: realChain,
      });
      return { bytes: toBase64(bytes), signature: out.signature };
    }
    const v1 = f['sui:signTransactionBlock'] as unknown as {
      signTransactionBlock: (i: unknown) => Promise<{ transactionBlockBytes: string; signature: string }>;
    };
    const out = await v1.signTransactionBlock({ transactionBlock: Transaction.from(bytes), account, chain: realChain });
    return { bytes: toBase64(bytes), signature: out.signature };
  }

  const stand: Wallet = {
    version: '1.0.0',
    name: real.name,
    icon: real.icon,
    chains: [CHAIN],
    get accounts() {
      return real.accounts.filter((a) => a.chains.some((c) => c.startsWith('sui:'))).map(mine);
    },
    features: {
      'standard:connect': {
        version: '1.0.0',
        connect: async (input?: unknown) => {
          const r = (await (f['standard:connect'] as unknown as { connect: (i?: unknown) => Promise<{ accounts: readonly WalletAccount[] }> }).connect(input)) ?? {
            accounts: real.accounts,
          };
          return { accounts: r.accounts.filter((a) => a.chains.some((c) => c.startsWith('sui:'))).map(mine) };
        },
      },
      'standard:disconnect': {
        version: '1.0.0',
        disconnect: async () => (f['standard:disconnect'] as unknown as { disconnect?: () => Promise<void> } | undefined)?.disconnect?.(),
      },
      'standard:events': {
        version: '1.0.0',
        on: (event: string, cb: (p: { accounts?: readonly WalletAccount[] }) => void) =>
          (f['standard:events'] as unknown as { on: (e: string, c: (p: { accounts?: readonly WalletAccount[] }) => void) => () => void }).on(event, (p) =>
            cb({ ...p, ...(p.accounts ? { accounts: p.accounts.map(mine) } : {}) }),
          ),
      },
      'sui:signTransaction': {
        version: '2.0.0',
        signTransaction: async ({ transaction, account }: { transaction: { toJSON: () => Promise<string> }; account: WalletAccount }) =>
          sign(transaction, account.address),
      },
      'sui:signAndExecuteTransaction': {
        version: '2.0.0',
        signAndExecuteTransaction: async ({ transaction, account }: { transaction: { toJSON: () => Promise<string> }; account: WalletAccount }) => {
          const { bytes, signature } = await sign(transaction, account.address);
          const r = await suiClient.core.executeTransaction({
            transaction: Uint8Array.from(atob(bytes), (ch) => ch.charCodeAt(0)),
            signatures: [signature],
            include: { effects: true },
          });
          const t = r.Transaction ?? r.FailedTransaction!;
          return { bytes, signature, digest: t.digest, effects: toBase64(t.effects!.bcs!) };
        },
      },
      ...(f['sui:signPersonalMessage']
        ? {
            'sui:signPersonalMessage': {
              version: '1.1.0',
              signPersonalMessage: ({ message, account }: { message: Uint8Array; account: WalletAccount }) =>
                (f['sui:signPersonalMessage'] as unknown as { signPersonalMessage: (i: unknown) => Promise<unknown> }).signPersonalMessage({
                  message,
                  account: realAccount(account.address),
                  chain: realChain,
                }),
            },
          }
        : {}),
    },
  };
  return stand;
}

/** Registers a stand-in for every installed Sui wallet that lacks this network, now and as wallets load. */
export function installCompatWallets() {
  if (typeof window === 'undefined' || config.network === 'mainnet') return;
  const api = getWallets();
  const scan = (list: readonly Wallet[]) => {
    for (const w of list) {
      if (wrapped.has(w) || !canAdapt(w)) continue;
      wrapped.add(w);
      adaptedWallets.add(w.name);
      api.register(adapt(w));
    }
  };
  scan(api.get());
  api.on('register', (...ws: Wallet[]) => scan(ws));
}
