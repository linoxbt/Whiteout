import { ConnectButton } from '@mysten/dapp-kit-react/ui';
import { Logo } from './components/Logo';
import { config } from './config';
import { useRoute } from './lib/useHunt';
import { Home } from './screens/Home';
import { Hunt } from './screens/Hunt';
import { Verify } from './screens/Verify';

export function App() {
  const route = useRoute();
  let page;
  if (route[0] === 'hunt' && route[1]) {
    page = route[2] === 'verify' ? <Verify gameId={route[1]} /> : <Hunt gameId={route[1]} mode={route[2]} />;
  } else {
    page = <Home />;
  }
  return (
    <div className="app">
      <header className="top">
        <a href="#/" className="brand" aria-label="Whiteout home">
          <Logo /> Whiteout
        </a>
        <nav>
          <a href="#/">Hunts</a>
          <a href="#/" onClick={() => setTimeout(() => document.getElementById('how')?.scrollIntoView({ behavior: 'smooth' }), 0)}>
            How it works
          </a>
        </nav>
        {config.network !== 'mainnet' && (
          <span className="pill">
            <span className="dot live" /> {config.network}
          </span>
        )}
        <ConnectButton />
      </header>
      <main>{page}</main>
      <footer>
        <span>Half of every frozen stake funds Lofi Foundation water wells.</span>
        <span>
          Built on Sui · Seal · Walrus · Nautilus
        </span>
      </footer>
    </div>
  );
}
