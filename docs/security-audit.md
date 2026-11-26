# Audit record (November 2026)

An internal audit (five independent reviewers: contracts, crypto and data path, web
client, sponsor/config/CI, spec traceability) found the issues below. Each was fixed
and verified with tests, a live browser run on testnet, and a second independent
review. This page records what changed and what is still open. It is not a substitute
for an external audit of the Move package before Mainnet.

Testnet package: `0xa2ccda7c8479b551a78aecff79a9efca295cca172a6ca8d4315718e960aca52a`
(v3, the audited code). Earlier packages (v1 `0x20ce…`, v2 `0x68cc…`) are retired.

## Fixed

| ID | Severity | Issue | Fix |
|---|---|---|---|
| B1 | High | A ranked pot share of 0 on the last rank stranded forfeited stakes in the pot forever | Every share must be > 0 (`game.move`, `a_zero_pot_share_is_refused`) |
| B2 | High | Overlapping web refreshes applied events twice and could land stale state | Single-flight refresh; events de-duplicated by `digest:index` |
| B3 | High | The queued-resolve timer ignored the on-chain deadline | Timer = min(60 s, window/2, deadline − 20 s) |
| B4 / N3 | High | Leaving the hunt page dropped the queued resolve | The timer survives `stop()`; live test waits on another page and checks the chain |
| B5 | High | The hold timer could race an in-flight step | One chain action at a time; the step cancels the timer; retries while busy |
| B6 / N1 | High | Event reads rescanned the whole package and broke once the node pruned old events | Newest-first scan back to the game's creation, forward polling, a forward scan when the node's pruned edge is hit, and state from the Game's own table and prize fields (`reconcileTrail`) |
| B7 | High | Sponsor digests kept in memory on serverless | Shared Redis store, 60 s TTL, execute lock |
| S1 | High | Two enclave deals in one millisecond had interchangeable tile signatures | Strictly increasing `deal_ts` per enclave key |
| S2 | High | Sponsor quota failed open and was keyed by a client-chosen object | Redis required; 600 per address per rolling 24 h; daily budget; per-IP limit; game type check; 0.05 SUI gas cap enforced on the sponsored bytes |
| S3 | Medium | Sponsor allowed `coin::send_funds` to anyone | Only back to the sender (change from a paid join) |
| S4 | Medium | Any registered enclave could deal, including debug or retired builds | `DealerRegistry` holds `Cap<DEALER>`, pins one config; deals need the current PCR version; zero PCRs refused |
| S5 | Medium | Deal checks ignored the ciphertexts' package | CLI, console and the player's integrity check require this package |
| S6 | Medium | Thaw verification accepted a signed but unfair map | Map rules, every clue, relic count and padding checked; `whiteout verify` decrypts sampled sealed tiles and compares |
| S7 | Medium | Security headers not served (zip deploys skip `netlify.toml`) | `public/_headers` with CSP, frame-ancestors, nosniff; CI smoke test runs under the CSP |
| S8 | Medium | Sponsor beacons/stats open, CORS `*` | Validated and rate-limited; explicit origins required in production; counters behind `METRICS_TOKEN` |
| S10 | Low | `publish_thaw` could be overwritten | Published once |
| S12 | Low | Verify read an RPC error as "immutable" | Only a missing UpgradeCap proves immutability |
| B8–B20, S9, S13, S14 | Medium/Low | Enclave CORS and https guidance, allowlist retries, consent nagging, no auto-blizzard transactions, error states, timeouts, coin types, allowlist batch sizes, sponsor error mapping, bad-clue tiles, CLI verify exit codes and package checks, blizzard drifts walling tiles in or outlasting the hunt, well-fund retype, harness key path, CI permissions and pinned Sui CLI | See commit history for each |

Tests added: 1 148 Move tests (incl. 10 024 conservation sequences and the regressions
above), 10 000 generated maps in the Rust dealer, core tests for pruned-node reads,
sponsor tests (72), a Playwright smoke test in CI, and a live testnet browser run
(`e2e/live/run.mts`, 42/42 on 26 Nov 2026) covering host console, three players, claims,
a freeze, a queued reveal reaching the chain while the player is on another page, thaw,
verify, history, browser deal, blizzard and holder gating. Test wallets are funded with
`e2e/live/faucet.py` (the faucet's proof-of-work API).

## Open

| ID | Severity for Mainnet | What remains | Needs |
|---|---|---|---|
| M3 | Critical | No Mainnet package; Seal key servers and threshold not chosen; package not yet immutable | Funded key, Seal Mainnet tier, `admin make-immutable` |
| M2 | Critical | No attested dealer is running; testnet hunts are host-dealt and free | AWS Nitro instance, a `dealer-v*` release tag, `admin enclave-config` + `admin register` |
| M1 | High | Google sign-in and sponsored gas not live | Enoki project keys, Google OAuth client, Upstash Redis, a deployed sponsor |
| M11 | High | `main` holds only the initial commit; no release tag | Merge the work branch; tag the dealer build |
| — | High | No external audit of the Move package | An independent auditor |
| M5 | Medium | Load tested at 8 bots on localnet, not 64 on testnet | Testnet funds and a scheduled run (`e2e/load.ts --bots 64`) |
| M6 | Medium | Deadline alerts only while a tab is open | A push service |
| N5 | Low | A dealer config created but never pinned could, in theory, back an enclave at the same version | Create the config once (contract change, next package) |
| S11 | Low | Allowlist members can change after a gated hunt opens (by design) | Documented in `docs/phase-2.md` |
| M7, M8 | Low | Blizzards drop drifts instead of shifting crevasses; one package holds MVP and Phase 2 | Spec decisions |
