import { ConnectButton } from '@mysten/dapp-kit-react/ui';
import { useEffect, useRef, useState } from 'react';
import { useRevealAll } from './lib/motion';
import { config } from './config';
import { useRoute } from './lib/useHunt';
import { Home } from './screens/Home';
import { Hunt } from './screens/Hunt';
import { Verify } from './screens/Verify';

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
        <a href="#/" className="brand" aria-label="Whiteout home">
          <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
            <path d="M3 26 13 8l5 7.6 3.6-4.8L29 26z" fill="#102233" />
            <path d="M13 8l-3 5.4 3-1.6 1.8 2.4z" fill="#ffffff" />
            <circle cx="24" cy="7" r="2.2" fill="#5aa9dc" />
          </svg>
          Whiteout
        </a>
        <nav>
          <a href="#/" onClick={() => scrollToId('expeditions')}>Expeditions</a>
          <a href="#/" onClick={() => scrollToId('field-guide')}>Field guide</a>
          <a href="#/" onClick={() => scrollToId('protocol')}>Protocol</a>
        </nav>
        <ConnectButton />
      </header>
      <main ref={mainRef} key={key} className={`route ${home ? '' : 'page wrap'}`}>
        {page}
      </main>
      <div className="wrap">
        <footer className="log">
          <span className="tele">Whiteout / Sui {config.network}</span>
          <span className="tele">Half of every frozen stake funds Lofi water wells</span>
          <span className="tele">Sui · Seal · Walrus · Nautilus</span>
        </footer>
      </div>
    </div>
  );
}
