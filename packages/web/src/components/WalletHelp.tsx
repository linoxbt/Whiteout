/**
 * "Wallet not listed?" The connect dialog can only list Sui wallets that the browser
 * has registered (Wallet Standard) for the current network. On phones, browsers run
 * no extensions, so wallet apps such as OKX or Phantom are only seen inside their own
 * in-app browsers: this helper opens Whiteout there. On desktop it lists installed
 * wallets that were hidden because they do not support this network, and install links.
 */
import { getWallets } from '@mysten/wallet-standard';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { config } from '../config';

const isMobile = () =>
  typeof navigator !== 'undefined' && (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.matchMedia?.('(pointer: coarse)').matches);

/** Universal links that open a page inside the wallet app's browser (or its download page). */
const OPEN_IN_APP = [
  {
    name: 'OKX Wallet',
    href: (url: string) => `https://www.okx.com/download?deeplink=${encodeURIComponent(`okx://wallet/dapp/url?dappUrl=${encodeURIComponent(url)}`)}`,
  },
  {
    name: 'Phantom',
    href: (url: string) => `https://phantom.app/ul/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(new URL(url).origin)}`,
  },
];

const INSTALL = [
  { name: 'Slush', href: 'https://slush.app' },
  { name: 'OKX Wallet', href: 'https://web3.okx.com/download' },
  { name: 'Phantom', href: 'https://phantom.com/download' },
  { name: 'Suiet', href: 'https://suiet.app' },
  { name: 'Nightly', href: 'https://nightly.app' },
];

interface Seen {
  ready: string[];
  otherNetwork: string[];
}

function scan(): Seen {
  const chain = `sui:${config.network}`;
  const sui = getWallets()
    .get()
    .filter((w) => w.chains.some((c) => c.startsWith('sui:')));
  return {
    ready: sui.filter((w) => w.chains.includes(chain as `${string}:${string}`)).map((w) => w.name),
    otherNetwork: sui.filter((w) => !w.chains.includes(chain as `${string}:${string}`)).map((w) => w.name),
  };
}

export function WalletHelp({ variant = 'link' }: { variant?: 'link' | 'icon' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {variant === 'icon' ? (
        <button className="wallet-help-icon" onClick={() => setOpen(true)} aria-label="Wallet not listed?" title="Wallet not listed?">
          ?
        </button>
      ) : (
        <button className="link-button" onClick={() => setOpen(true)}>
          Wallet not listed?
        </button>
      )}
      {/* Portal: the header is transformed, which would trap a fixed-position dialog. */}
      {open && createPortal(<WalletHelpDialog onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

function WalletHelpDialog({ onClose }: { onClose: () => void }) {
  const [seen, setSeen] = useState<Seen>(scan);
  const [copied, setCopied] = useState(false);
  const mobile = isMobile();
  const url = location.href;
  useEffect(() => {
    // Extensions can register late; keep the list fresh while the dialog is open.
    const api = getWallets();
    const off = [api.on('register', () => setSeen(scan())), api.on('unregister', () => setSeen(scan()))];
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => {
      off.forEach((f) => f());
      window.removeEventListener('keydown', esc);
    };
  }, [onClose]);

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="wallet-help-title" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="card wallet-help">
        <button className="close" onClick={onClose} aria-label="Close">×</button>
        <h2 id="wallet-help-title">Wallet not listed?</h2>

        {mobile ? (
          <>
            <p className="small">
              Phone browsers cannot run wallet extensions, so only Slush (which works on the web) shows up here. Open Whiteout
              inside your wallet app instead: its browser connects directly.
            </p>
            <div className="wallet-links">
              {OPEN_IN_APP.map((w) => (
                <a key={w.name} className="btn arrow" href={w.href(url)}>
                  Open in {w.name}
                </a>
              ))}
            </div>
            <p className="small">
              Another Sui wallet app (Suiet, Nightly, Surf…)? Copy the link and paste it into the app's browser.
            </p>
            <button
              onClick={async () => {
                await navigator.clipboard?.writeText(url);
                setCopied(true);
              }}
            >
              {copied ? 'Link copied' : 'Copy link'}
            </button>
          </>
        ) : (
          <>
            <p className="small">
              The list shows Sui wallets installed in this browser that work on Sui {config.network}.
            </p>
            <ul className="wallet-seen">
              {seen.ready.map((n) => (
                <li key={n}><i className="ok" /> {n}: ready</li>
              ))}
              {seen.otherNetwork.map((n) => (
                <li key={n}>
                  <i className="warn" /> {n}: installed, but it does not offer Sui {config.network}. Switch it to {config.network} in its
                  settings, or use another wallet.
                </li>
              ))}
              {!seen.ready.length && !seen.otherNetwork.length && <li><i /> No Sui wallet extension found in this browser.</li>}
            </ul>
            <p className="small">Installed a wallet just now? Reload the page so the browser registers it. Or get one:</p>
            <div className="wallet-links">
              {INSTALL.map((w) => (
                <a key={w.name} className="btn" href={w.href} target="_blank" rel="noreferrer">
                  {w.name} ↗
                </a>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
