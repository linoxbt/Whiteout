import { ConnectButton } from '@mysten/dapp-kit-react/ui';
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
        <a href="#/" className="brand">
          <img src="/favicon.svg" alt="" width={28} height={28} /> Whiteout
        </a>
        {config.network !== 'mainnet' && <span className="badge none">{config.network}</span>}
        <ConnectButton />
      </header>
      <main>{page}</main>
      <footer className="small">
        Half of every frozen stake funds Lofi Foundation water wells.
      </footer>
    </div>
  );
}
