import { useEffect, useRef, useState } from 'react';
import { TILE_COUNT, getGame, listGames, type GameState } from '@whiteout/core';
import { Backdrop, Clouds, Snowfall } from '../components/Backdrop';
import { Mark } from '../components/Logo';
import { TrailDemo } from '../components/TrailDemo';
import { HuntTags } from '../components/Phase2';
import { CountUp, Disclosure, Words, scrollToId } from '../lib/motion';
import { config, configured, googleLogin, suiClient } from '../config';
import { amount, dealerBadge, shortId, statusLabel, timeLeft } from '../lib/format';
import { useTick } from '../lib/route';

const FIELD_GUIDE = [
  { word: 'Snow', desc: 'Safe ground. Every tile you reach tells you how warm you are and how many crevasses lie next to you.' },
  { word: 'Crevasse', desc: 'Step in without a rope and your yeti freezes. Half its stake goes to the Lofi well fund, half to the pot.' },
  { word: 'Goggles', desc: 'For ten steps you can read the eight tiles around you, not just the one under your feet.' },
  { word: 'Rope', desc: 'Carries you over one crevasse. Hold up to three.' },
  { word: 'Relic', desc: 'Frozen somewhere above row twelve. The first yeti to reach it takes the prize and the whole pot.', relic: true },
];

const TICKER = [
  '24 × 24 sealed tiles',
  'One relic above row 12',
  'One step every 8 seconds',
  'Goggles: 10 steps of sight',
  'Up to 3 ropes',
  'Half of every frozen stake funds water wells',
  'Dealt by an attested enclave',
  'Thawed and verifiable',
];

const HOW = [
  { t: 'Pick a starting column', d: 'Every yeti sets out from base camp on the bottom row. Choose your column and pay the entry stake, if there is one.' },
  { t: 'Step one tile at a time', d: 'North, east, south or west, once every 8 seconds. Only the tile under your feet unseals for you.' },
  { t: 'Read warmth and hazards', d: 'Each tile tells you how warm you are (0 to 5) and how many crevasses touch it. Goggles and ropes lie in the snow.' },
  { t: 'Reach the relic first', d: 'It is frozen somewhere above row 12. Stand on it and claim it before anyone else does, or before the clock runs out.' },
];

const PIPELINE = [
  { name: 'Nautilus', title: 'Dealt in the dark', desc: 'An attested enclave draws the mountain and signs every tile. Its code is reproducible, and Sui checks its attestation.', icon: () => <ChipIcon /> },
  { name: 'Seal', title: 'Every tile locked', desc: 'Each tile is encrypted on its own. Key servers release it only to the yeti standing on it, as the contract decides.', icon: () => <LockIcon /> },
  { name: 'Walrus', title: 'Stored in the open', desc: `All ${TILE_COUNT} sealed tiles live on Walrus. Their hash is committed on-chain before the first step.`, icon: () => <StackIcon /> },
  { name: 'Sui', title: 'Every step checked', desc: 'The contract checks each move, the cooldown, and the dealer signature on every reveal. Players never wait on each other.', icon: () => <PathIcon /> },
  { name: 'Thaw', title: 'Audited by anyone', desc: 'When the hunt ends the whole map unseals. Anyone can rebuild it and match it to the hash and signatures.', icon: () => <SunIcon /> },
];

const FAQ = [
  { q: 'Can the host see the map?', a: 'Not in an enclave-dealt hunt: the map is drawn inside the enclave and only ever leaves it sealed. A host can also deal a map themselves for practice, but the contract labels it a ceremony hunt and makes it free to enter.' },
  {
    q: 'What do I need to play?',
    a: googleLogin
      ? 'A Google sign-in through zkLogin (gas is covered for you) or any Sui wallet.'
      : `Any Sui wallet set to ${config.network}. Every step is a small transaction from your wallet.`,
  },
  { q: 'What happens if nobody finds the relic?', a: 'After the deadline anyone can settle the hunt. The pot goes to the well fund, every surviving yeti takes its stake back, and the host reclaims the prize.' },
  { q: 'Can I stall to avoid a crevasse?', a: 'No. Each step must be revealed within a short window. After that anyone can freeze the yeti, even once the hunt has ended.' },
  { q: 'How do I know it was fair?', a: 'Open the verify page of any finished hunt. It downloads the thawed map from Walrus, checks it against the hash committed on Sui, and checks the dealer signature on every tile.' },
  { q: 'Where does the well money go?', a: 'Each hunt names a well-fund address on-chain. Half of every frozen stake, and any unclaimed pot, is paid to it directly by the contract.' },
];

function seedOf(id: string) {
  return parseInt(id.slice(-6), 16) || 1;
}

export function Home() {
  const [games, setGames] = useState<GameState[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useTick(1000);

  useEffect(() => {
    if (!configured) return;
    let stop = false;
    const load = async () => {
      try {
        const ids = await listGames(suiClient, config.packageId, 30);
        const gs = await Promise.all(ids.map((id) => getGame(suiClient, id, config.packageId).catch(() => null)));
        if (!stop) setGames(gs.filter((g): g is GameState => !!g));
        setError(null);
      } catch (e) {
        if (!stop) setError((e as Error).message);
      }
    };
    void load();
    const t = setInterval(load, 15_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  const now = Date.now();
  const live = games?.filter((g) => g.status === 1 && now < g.endsAt) ?? [];
  const lobby = games?.filter((g) => g.status === 0) ?? [];
  const past = games?.filter((g) => g.status >= 2 || (g.status === 1 && now >= g.endsAt)) ?? [];
  const shown = [...live, ...lobby, ...past];
  const yetis = live.reduce((n, g) => n + g.playerCount, 0);
  const pot = live.reduce((n, g) => n + g.pot, 0n);
  const first = live[0];
  const go = (id: string) => (e: React.MouseEvent) => (e.preventDefault(), scrollToId(id));
  const heroInner = useRef<HTMLDivElement>(null);
  useHeroScroll(heroInner);

  return (
    <>
      <section className="hero">
        <Backdrop seed={7} parallax />
        <Clouds seed={7} count={9} />
        <Snowfall />
        <span className="coords tele">27°59′N / 86°55′E — {TILE_COUNT} tiles sealed</span>
        <div className="wrap hero-inner" ref={heroInner}>
          <span className="tele ice hero-kicker">An expedition on Sui / {new Date().getFullYear()}</span>
          <h1 data-reveal="words">
            <Words text="White" letters />
            <br />
            <span className="thin"><Words text="out" letters from={5} /></span>
          </h1>
          <p className="tagline">The relic is still out there. Nobody knows where.</p>
          <div className="cta">
            {first ? (
              <a className="btn primary arrow magnetic" href={`#/hunt/${first.id}`}>
                Join the hunt
              </a>
            ) : (
              <a className="btn primary arrow magnetic" href="#expeditions" onClick={go('expeditions')}>
                See expeditions
              </a>
            )}
            <a className="btn arrow magnetic" href="#field-guide" onClick={go('field-guide')}>
              Field guide
            </a>
          </div>
          <div className="hero-bar">
            <span className="tele">Mountain / Grid 24 × 24</span>
            <span className="tele signal">
              <span className={`blip ${live.length ? '' : 'off'}`} />
              {games ? (live.length ? `Signal detected · ${live.length} live` : 'No signal') : 'Scanning…'}
            </span>
            <span className="tele">{games ? `${yetis} yetis on the mountain` : '—'}</span>
          </div>
        </div>
        <span className="scroll-cue" aria-hidden="true" />
      </section>

      <div className="marquee" aria-hidden="true">
        <div className="marquee-track">
          {[0, 1].map((k) => (
            <span key={k}>
              {TICKER.map((t) => (
                <span key={t} className="tele">
                  <Mark size={14} animate={false} /> {t}
                </span>
              ))}
            </span>
          ))}
        </div>
      </div>

      <div className="wrap">
        <section className="section" id="how">
          <div className="how">
            <div className="how-copy">
              <div data-reveal="words">
                <span className="tele ice">How to play / 01</span>
                <h2 style={{ marginTop: 14 }}>
                  <Words text="Read the snow." />
                  <br />
                  <span className="accent"><Words text="Follow the warmth." from={3} /></span>
                </h2>
              </div>
              <ol className="steps">
                {HOW.map((h, i) => (
                  <li key={h.t} data-reveal data-delay={i * 90}>
                    <span className="n">{String(i + 1).padStart(2, '0')}</span>
                    <div>
                      <h3>{h.t}</h3>
                      <p>{h.d}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
            <div className="how-demo tilt-soft" data-reveal data-delay="150">
              <TrailDemo />
            </div>
          </div>
        </section>

        <section className="section" id="expeditions">
          <div className="split">
            <div className="intro" data-reveal="words">
              <span className="tele ice">Expeditions / 02</span>
              <h2 style={{ marginTop: 14 }}>
                <Words text="A mountain that" />
                <br />
                <span className="accent"><Words text="keeps secrets." from={3} /></span>
              </h2>
              <p>
                Every hunt is a fresh 24 × 24 mountain, dealt in the dark. Each tile is sealed: you can read only the
                ground under your yeti. Warmth tells you how close the relic is.
              </p>
              <div className="readout">
                <div>
                  <div className="stat-label">Live</div>
                  <div className="stat-value"><CountUp value={games ? live.length : null} /></div>
                </div>
                <div>
                  <div className="stat-label">Yetis</div>
                  <div className="stat-value"><CountUp value={games ? yetis : null} /></div>
                </div>
                <div>
                  <div className="stat-label">Pot</div>
                  <div className="stat-value"><CountUp value={games ? Number(pot) / 1e9 : null} format={(n) => (n === 0 ? '0' : n.toFixed(2))} /></div>
                </div>
              </div>
            </div>
            <div>
              {!configured && <p className="empty">Not deployed yet: set packageId in deploy/{config.network}.json</p>}
              {error && (
                <div className="banner error" role="alert">
                  Signal lost. Retrying… <small className="mono">{error.slice(0, 70)}</small>
                </div>
              )}
              {configured && !games && !error && (
                <div className="skeleton-list" aria-busy="true">
                  <div />
                  <div />
                </div>
              )}
              {games && !shown.length && <p className="empty">No expeditions yet. The next one sets out soon.</p>}
              <ul className="expeditions">
                {shown.map((g, i) => (
                  <Expedition key={g.id} g={g} n={i + 1} now={now} delay={i * 90} />
                ))}
                {games && shown.length < 3 && (
                  <li data-reveal data-delay={shown.length * 90}>
                    <div className="exp-card next">
                      <Backdrop seed={99} yeti={false} />
                      <Clouds seed={99} count={4} fog={false} top={[4, 34]} />
                      <div className="exp-top">
                        <span className="tele signal"><span className="blip off" /> Forming</span>
                      </div>
                      <div className="exp-body">
                        <span className="tele">Expedition {String(shown.length + 1).padStart(2, '0')}</span>
                        <h3>Next ascent</h3>
                        <p className="small">A new mountain is dealt for every hunt. Watch this space, or ask a host to open one.</p>
                      </div>
                    </div>
                  </li>
                )}
              </ul>
            </div>
          </div>
        </section>

        <section className="section" id="field-guide">
          <div className="section-head" data-reveal="words">
            <h2><Words text="Field guide" /></h2>
            <span className="tele">What lies under the snow / 03</span>
          </div>
          <ol className="field-guide">
            {FIELD_GUIDE.map((f, i) => (
              <li key={f.word} className={f.relic ? 'relic' : ''} data-reveal data-delay={i * 70}>
                <span className="num">{String(i + 1).padStart(3, '0')}</span>
                <span className="word">{f.word}</span>
                <span className="desc">{f.desc}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="section" id="rewards">
          <div className="section-head" data-reveal="words">
            <h2>
              <Words text="Every stake" /> <span className="accent"><Words text="goes somewhere" from={2} /></span>
            </h2>
            <span className="tele">Rewards / 04</span>
          </div>
          <div className="rewards">
            <div className="reward finder tilt" data-reveal>
              <span className="tele">The finder</span>
              <div className="reward-figure">
                <span>Prize</span>
                <i>+</i>
                <span>Pot</span>
                <i>+</i>
                <span>Stake</span>
              </div>
              <p>The first yeti to stand on the relic and prove it ends the hunt. The prize object, the whole pot and its own stake go to that player in one transaction.</p>
            </div>
            <div className="reward tilt" data-reveal data-delay="110">
              <span className="tele">A frozen yeti</span>
              <div className="split-bar" aria-label="Half to the well fund, half to the pot">
                <i className="wells"><b>50%</b> Well fund</i>
                <i className="pot"><b>50%</b> Pot</i>
              </div>
              <p>Step into a crevasse with no rope and your yeti freezes. Half its stake goes to the Lofi water-well fund at once; the other half grows the pot for whoever finds the relic.</p>
            </div>
            <div className="reward tilt" data-reveal data-delay="220">
              <span className="tele">Nobody finds it</span>
              <ul className="reward-list">
                <li><b>Pot</b> goes to the well fund</li>
                <li><b>Survivors</b> take their stakes back</li>
                <li><b>Host</b> reclaims the prize</li>
              </ul>
              <p>When time runs out, anyone can settle the hunt. Nothing waits on the host.</p>
            </div>
          </div>
        </section>

        <section className="section" id="protocol">
          <div className="section-head" data-reveal="words">
            <h2>
              <Words text="No game" /> <span className="accent"><Words text="master" from={2} /></span>
            </h2>
            <span className="tele">Protocol / 05</span>
          </div>
          <p className="lede" data-reveal>
            Nobody, not even the host, can see the map while the hunt is live. Each piece of the stack does one job, and each
            can be checked.
          </p>
          <ol className="pipeline">
            {PIPELINE.map((p, i) => (
              <li key={p.name} className="tilt" data-reveal data-delay={i * 100}>
                <div className="pipe-icon">{p.icon()}</div>
                <span className="tele ice">{p.name}</span>
                <h3>{p.title}</h3>
                <p>{p.desc}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="section" id="faq">
          <div className="faq-grid">
            <div data-reveal="words">
              <span className="tele ice">Questions / 06</span>
              <h2 style={{ marginTop: 14 }}>
                <Words text="Before you" />
                <br />
                <span className="accent"><Words text="set out" from={2} /></span>
              </h2>
            </div>
            <div className="faq">
              {FAQ.map((f, i) => (
                <Disclosure key={f.q} title={f.q} defaultOpen={i === 0} data-reveal="" data-delay={String(i * 60)}>
                  <p>{f.a}</p>
                </Disclosure>
              ))}
            </div>
          </div>
        </section>

        <section className="section">
          <div className="cta-band" data-reveal>
            <Backdrop seed={41} />
            <Clouds seed={41} count={5} fog={false} top={[2, 30]} />
            <div className="cta-copy">
              <Mark size={44} />
              <h2 data-reveal="words">
                <Words text="The mountain" />
                <br />
                <Words text="is" from={2} /> <span className="accent"><Words text="waiting." from={3} /></span>
              </h2>
              <p>One relic. {TILE_COUNT} sealed tiles. Every step proven on Sui.</p>
              <div className="cta">
                {first ? (
                  <a className="btn primary arrow magnetic" href={`#/hunt/${first.id}`}>Join the hunt</a>
                ) : (
                  <a className="btn primary arrow magnetic" href="#expeditions" onClick={go('expeditions')}>See expeditions</a>
                )}
                <a className="btn arrow magnetic" href="#how" onClick={go('how')}>How to play</a>
              </div>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}

function Expedition({ g, n, now, delay }: { g: GameState; n: number; now: number; delay: number }) {
  const badge = dealerBadge(g.dealerKind);
  const isLive = g.status === 1 && now < g.endsAt;
  return (
    <li data-reveal data-delay={delay}>
      <a className="exp-card tilt" href={`#/hunt/${g.id}`}>
        <Backdrop seed={seedOf(g.id)} yeti={false} />
        <Clouds seed={seedOf(g.id)} count={3} fog={false} top={[4, 30]} />
        <div className="exp-top">
          <span className="tele signal">
            <span className={`blip ${isLive ? '' : 'off'}`} />
            {statusLabel(g, now)}
          </span>
          <span className={`badge ${badge.tone}`}>{badge.text}</span>
        </div>
        <div className="exp-body">
          <span className="tele">Expedition {String(n).padStart(2, '0')} / {shortId(g.id, 4)}</span>
          <h3>{isLive ? timeLeft(g.endsAt - now) : statusLabel(g, now)}</h3>
          <HuntTags g={g} />
          <div className="kv">
            <div>
              <span className="k">Entry</span>
              <span className="v">{g.entryStake === 0n ? 'Free' : amount(g.entryStake, g.coinType)}</span>
            </div>
            <div>
              <span className="k">Pot</span>
              <span className="v">{amount(g.pot, g.coinType)}</span>
            </div>
            <div>
              <span className="k">Yetis</span>
              <span className="v">
                {g.playerCount}/{g.maxPlayers}
              </span>
            </div>
            <div>
              <span className="k">Enter</span>
              <span className="v arrow" />
            </div>
          </div>
        </div>
      </a>
    </li>
  );
}

const iconProps = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const LockIcon = () => (
  <svg {...iconProps}>
    <rect x="4" y="11" width="16" height="10" rx="3" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </svg>
);
const ChipIcon = () => (
  <svg {...iconProps}>
    <rect x="6" y="6" width="12" height="12" rx="3" />
    <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
  </svg>
);
const StackIcon = () => (
  <svg {...iconProps}>
    <path d="m12 3 9 5-9 5-9-5z" />
    <path d="m3 13 9 5 9-5" />
  </svg>
);
const PathIcon = () => (
  <svg {...iconProps}>
    <circle cx="6" cy="18" r="2.5" />
    <circle cx="18" cy="6" r="2.5" />
    <path d="M8.5 18H15a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.5" />
  </svg>
);
const SunIcon = () => (
  <svg {...iconProps}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
);

/** The hero copy drifts up and fades as the page scrolls away from it. */
function useHeroScroll(ref: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    let raf = 0;
    const apply = () => {
      raf = 0;
      const el = ref.current;
      if (!el) return;
      const h = window.innerHeight;
      const y = Math.min(window.scrollY, h);
      el.style.transform = `translate3d(0, ${(y * -0.22).toFixed(1)}px, 0)`;
      el.style.opacity = String(Math.max(0, 1 - y / (h * 0.75)).toFixed(3));
    };
    const on = () => {
      if (!raf) raf = requestAnimationFrame(apply);
    };
    window.addEventListener('scroll', on, { passive: true });
    apply();
    return () => {
      window.removeEventListener('scroll', on);
      cancelAnimationFrame(raf);
    };
  }, [ref]);
}
