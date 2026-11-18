import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { ConnectButton } from '@mysten/dapp-kit-react/ui';
import { WalletHelp } from './components/WalletHelp';
import { useEffect, useRef, useState } from 'react';
import { Logo } from './components/Logo';
import { scrollToId, scrollToTop, useActiveSection, usePointerFx, useRevealAll, useScrollDirection, useSmoothScroll } from './lib/motion';
import { config } from './config';
import { useRoute } from './lib/useHunt';
import { Home } from './screens/Home';
import { Hunt } from './screens/Hunt';
import { Verify } from './screens/Verify';
import { History } from './screens/History';
import { Host } from './screens/Host';

/** Landing sections (scroll) and pages (routes). */
const NAV: Array<[string, string]> = [
  ['how', 'How to play'],
  ['expeditions', 'Expeditions'],
  ['rewards', 'Rewards'],
  ['faq', 'FAQ'],
];
const PAGES: Array<[string, string]> = [
  ['history', 'History'],
  ['host', 'Host'],
];

const NAV_IDS = NAV.map(([id]) => id);

export function App() {
  const route = useRoute();
  const account = useCurrentAccount();
  const section = route[0] ?? '';
  const home = section === '';
  useSmoothScroll();
  usePointerFx();
  const { down, scrolled } = useScrollDirection();
  const active = useActiveSection(NAV_IDS, home);
  const key = route.join('/');
  useEffect(() => scrollToTop(true), [key]);
  // A pill slides under the nav link of the section in view.
  const navRef = useRef<HTMLElement>(null);
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null);
  useEffect(() => {
    const a = active && navRef.current?.querySelector<HTMLElement>(`[data-id="${active}"]`);
    setPill(a ? { x: a.offsetLeft, w: a.offsetWidth } : null);
  }, [active]);
  const mainRef = useRef<HTMLElement>(null);
  useRevealAll(mainRef, key);

  // Only the landing page carries the footer; every other page ends with its content.
  const gameId = section === 'hunt' ? route[1] : undefined;
  let page;
  if (gameId) {
    page = route[2] === 'verify' ? <Verify gameId={gameId} /> : <Hunt gameId={gameId} mode={route[2]} />;
  } else if (section === 'history') {
    page = <History />;
  } else if (section === 'host') {
    page = <Host gameId={route[1]} />;
  } else {
    page = <Home />;
  }
  const landing = page.type === Home;

  return (
    <div className="app">
      <header className={`top ${scrolled || !home ? 'solid' : ''} ${down ? 'tucked' : ''}`}>
        <a href="#/" className="brand" aria-label="Whiteout home" onClick={() => home && scrollToTop()}>
          <Logo size={32} />
        </a>
        <nav ref={navRef}>
          <span className="nav-pill" style={pill ? { transform: `translateX(${pill.x}px)`, width: pill.w, opacity: 1 } : { opacity: 0 }} aria-hidden="true" />
          {NAV.map(([id, label]) => (
            <a key={id} data-id={id} className={active === id ? 'active' : ''} href="#/" onClick={() => scrollToId(id)}>{label}</a>
          ))}
          <span className="nav-sep" aria-hidden="true" />
          {PAGES.map(([id, label]) => (
            <a key={id} href={`#/${id}`} className={section === id ? 'active page-link' : 'page-link'}>{label}</a>
          ))}
        </nav>
        {!account && <WalletHelp variant="icon" />}
        <ConnectButton />
      </header>
      <main ref={mainRef} key={key} className={`route ${home ? '' : 'page wrap'}`}>
        {page}
      </main>
      {landing && (
        <footer className="site-foot">
          <div className="wrap">
            <div className="foot-grid">
              <div className="foot-brand">
                <Logo size={34} />
                <p>A treasure hunt on Sui with no game master. Every tile is sealed until you stand on it.</p>
                <span className="pill"><span className="dot live" /> Sui {config.network}</span>
              </div>
              <div>
                <span className="tele">Play</span>
                <a href="#/" onClick={() => scrollToId('expeditions')}>Expeditions</a>
                <a href="#/" onClick={() => scrollToId('how')}>How to play</a>
                <a href="#/" onClick={() => scrollToId('field-guide')}>Field guide</a>
                <a href="#/history">Hunt history</a>
                <a href="#/host">Host a hunt</a>
                {config.network !== 'mainnet' && <a href="https://faucet.sui.io" target="_blank" rel="noreferrer">Testnet faucet ↗</a>}
              </div>
              <div>
                <span className="tele">Learn</span>
                <a href="#/" onClick={() => scrollToId('rewards')}>Rewards</a>
                <a href="#/" onClick={() => scrollToId('protocol')}>Protocol</a>
                <a href="#/" onClick={() => scrollToId('faq')}>FAQ</a>
              </div>
              <div>
                <span className="tele">Built on</span>
                <span>Sui</span>
                <span>Seal</span>
                <span>Walrus</span>
                <span>Nautilus</span>
              </div>
            </div>
            <div className="foot-base">
              <span className="tele">© {new Date().getFullYear()} Whiteout</span>
              <span className="tele">Half of every frozen stake funds Lofi water wells</span>
            </div>
          </div>
        </footer>
      )}
    </div>
  );
}
