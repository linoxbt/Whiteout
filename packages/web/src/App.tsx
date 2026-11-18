import { ConnectButton } from '@mysten/dapp-kit-react/ui';
import { useEffect, useRef, useState } from 'react';
import { Logo } from './components/Logo';
import { useRevealAll } from './lib/motion';
import { config } from './config';
import { useRoute } from './lib/useHunt';
import { Home } from './screens/Home';
import { Hunt } from './screens/Hunt';
import { Verify } from './screens/Verify';

const NAV: Array<[string, string]> = [
  ['how', 'How to play'],
  ['expeditions', 'Expeditions'],
  ['rewards', 'Rewards'],
  ['protocol', 'Protocol'],
  ['faq', 'FAQ'],
];

function scrollToId(id: string) {
  setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' }), 0);
}

export function App() {
  const route = useRoute();
  const home = route[0] !== 'hunt';
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 40);
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  const key = route.join('/');
  useEffect(() => window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior }), [key]);
  const mainRef = useRef<HTMLElement>(null);
  useRevealAll(mainRef, key);

  let page;
  if (!home && route[1]) {
    page = route[2] === 'verify' ? <Verify gameId={route[1]} /> : <Hunt gameId={route[1]} mode={route[2]} />;
  } else {
    page = <Home />;
  }

  return (
    <div className="app">
      <header className={`top ${scrolled || !home ? 'solid' : ''}`}>
        <a href="#/" className="brand" aria-label="Whiteout home" onClick={() => home && window.scrollTo({ top: 0, behavior: 'smooth' })}>
          <Logo size={30} />
        </a>
        <nav>
          {NAV.map(([id, label]) => (
            <a key={id} href="#/" onClick={() => scrollToId(id)}>{label}</a>
          ))}
        </nav>
        <ConnectButton />
      </header>
      <main ref={mainRef} key={key} className={`route ${home ? '' : 'page wrap'}`}>
        {page}
      </main>
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
    </div>
  );
}
