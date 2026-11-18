import { ConnectButton } from '@mysten/dapp-kit-react/ui';
import { useEffect, useState } from 'react';
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
  useEffect(() => window.scrollTo(0, 0), [route.join('/')]);

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
          Whiteout
        </a>
        <nav>
          <a href="#/" onClick={() => scrollToId('expeditions')}>Expeditions</a>
          <a href="#/" onClick={() => scrollToId('field-guide')}>Field guide</a>
          <a href="#/" onClick={() => scrollToId('protocol')}>Protocol</a>
        </nav>
        <ConnectButton />
      </header>
      <main className={home ? '' : 'page wrap'}>{page}</main>
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
