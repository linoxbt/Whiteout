# Whiteout

A Lofi treasure hunt on Sui with no game master. Every tile of a 24×24 mountain is
encrypted with Seal. Key servers release a tile's key only to the player whose
on-chain Explorer stands on it (or next to it, while wearing goggles). An attested
Nautilus enclave deals the map, so neither the host nor the developer ever sees it.
The Move contract checks the dealer's signature on every reveal and holds the prize
and stakes in escrow. Half of every frozen stake funds Lofi Foundation water wells.

Built for CLAY Hackathon III. Design: *Whiteout — Build Specification v1.0*.

## What's here

| Part | Path | |
| --- | --- | --- |
| Move package: rules, escrow, Seal policy, allowlists | `move/whiteout` | Move tests incl. Phase 2 acceptance |
| Shared TypeScript core | `packages/core` | formats, map rules, deal, tx builders, chain reads |
| Host CLI | `packages/cli` | create, deal, open, status, settle, thaw, verify, admin |
| Sponsor service | `packages/sponsor` | gas for Google (zkLogin) players, Whiteout calls only |
| Web client | `packages/web` | play, spectate, thaw, verify, history, host console |
| Dealer enclave (Rust, Nautilus) | `enclave/whiteout-dealer` | offline Seal encryption, pinned key servers |
| End-to-end test | `e2e` | a full hunt on a local Sui network, in CI |

See [docs/phase-2.md](docs/phase-2.md) for ranked relics, holder gating, blizzards, the
host console, history and alerts; [docs/architecture.md](docs/architecture.md) for how the pieces fit,
[docs/deploy.md](docs/deploy.md) to deploy and run a hunt, and
[docs/verify-a-hunt.md](docs/verify-a-hunt.md) for what anyone can check.

## Develop

Needs Node 22, pnpm 10, Rust (for the dealer) and the [Sui CLI](https://docs.sui.io/guides/developer/getting-started/sui-install) (for Move).

```
pnpm install
pnpm -r test                     # TypeScript unit tests
pnpm -r typecheck
sui move test --path move/whiteout
(cd enclave/whiteout-dealer/src/nautilus-server && cargo test)
pnpm --filter @whiteout/web dev  # http://localhost:5173 (set packageId in deploy/testnet.json first)
```

If you change a signed message layout or the test map, regenerate the Move fixtures
(`pip install cryptography`, then `python3 move/whiteout/scripts/gen_fixtures.py`).
All three languages are tested against them.

## Status

Built and tested in CI (Move: 1 148 tests; TypeScript; Rust; localnet end-to-end and
load bots; a web smoke test under the production CSP). Live on Sui testnet at
https://whiteout-hunt.netlify.app with wallet sign-in; hunts there are host-dealt and
free. See `docs/security-audit.md` for the November 2026 audit and what is fixed.

Not done yet, and each needs an account or funds the repository cannot hold:
- Google sign-in and sponsored gas: an Enoki project (public and private keys), a Google
  OAuth client, and a deployed sponsor with Upstash Redis (`docs/deploy.md`, step 6).
- The attested dealer: an AWS Nitro instance to run and register the enclave.
- Mainnet: a funded key, the Seal Mainnet key servers, and the open questions in spec
  section 22 (well-fund address, art permission, prize, stake).
