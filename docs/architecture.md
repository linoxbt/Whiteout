# Architecture

Sui is the only source of truth. There is no Whiteout database: every client rebuilds state from on-chain objects and events. The Whiteout team runs two things: a stateless sponsor service, and the dealer enclave for a few minutes per hunt.

```
                 ┌──────────── Sui (immutable package `whiteout`) ────────────┐
                 │ game: Game<T> (shared), Explorer<T> (shared, one/player),  │
                 │       HostCap, escrow, payouts, events                     │
                 │ policy: seal_approve, seal_approve_thaw                    │
                 └───────▲───────────────▲───────────────────▲────────────────┘
                         │ step/resolve  │ dry-run policy     │ deal, settle
 ┌─────────────┐  pays   │               │                    │
 │ Sponsor     │◄────────┤        ┌──────┴───────┐     ┌──────┴───────┐  POST /deal  ┌──────────────┐
 │ (Hono,      │ gas     │        │ Seal key     │     │ Host CLI     │─────────────►│ Dealer       │
 │  Enoki)     │         │        │ servers      │     │ (whiteout)   │◄─────────────│ enclave      │
 └─────▲───────┘         │        └──────▲───────┘     └──────┬───────┘ ciphertexts  │ (Nitro)      │
       │ zkLogin tx      │               │ fetchKeys          │ Quilt upload          └──────────────┘
 ┌─────┴─────────────────┴───────────────┴────────┐    ┌──────▼───────┐
 │ Web client (React): play, spectate, thaw,      │◄───│ Walrus       │ 576 tile ciphertexts (one Quilt),
 │ verify. Decrypts and verifies tiles locally.   │    │              │ thaw file
 └────────────────────────────────────────────────┘    └──────────────┘
```

## Repository

| Path | What | Tests |
| --- | --- | --- |
| `move/whiteout` | Game rules, escrow, payouts, Seal policy | `sui move test` (111 tests, incl. conservation property) |
| `move/enclave` | Nautilus enclave package, vendored | upstream tests |
| `packages/core` | Message formats, identities, map rules, deal, tx builders, chain reads, Seal/Walrus helpers | Vitest; re-verifies all Move fixture signatures |
| `packages/cli` | Host CLI: create, deal, open, status, settle, thaw, verify, admin | Vitest; checks real Rust dealer output |
| `packages/sponsor` | Sponsor service: Whiteout-only policy, no gas coin, per-hunt quota | Vitest (policy + HTTP) |
| `packages/web` | Player, spectator, thaw and verify screens | Vitest; production build in CI |
| `enclave/whiteout-dealer` | Rust dealer in the Nautilus template layout | `cargo test`: map rules, fixture signatures, Seal round trip |
| `e2e` | Full hunt on a local Sui network | runs in CI against `sui start` |

## One step, end to end

1. **Step.** The client builds `game::step` (plus the previous tile's `resolve` in the same transaction when it can). zkLogin players send the transaction kind to the sponsor, which checks it and has Enoki pay gas; wallet players sign and pay.
2. **Reveal.** After the step's effects arrive, the client fetches the tile ciphertext(s) from Walrus (cached in IndexedDB), builds one `seal_approve` call per visible tile, calls `fetchKeys` once, decrypts, and verifies the clue signature. Tiles that fail verification are never shown.
3. **Resolve.** The kind and its signature ride with the next step, or go alone after half the resolve window. A crevasse with no rope goes through `resolve_fatal`, the only resolve that writes `Game`; a live relic waits for the player's Claim.

## Formats that must agree

The Move package, `packages/core/src/messages.ts`, the Rust dealer (`apps/whiteout/deal.rs`) and `move/whiteout/scripts/gen_fixtures.py` all produce the same bytes. Three tests hold this together: Move verifies the Python-signed fixtures, TypeScript re-verifies all 576 of them, and Rust reproduces the same signatures from the same key (Ed25519 is deterministic).

| Message | Intent | Payload (BCS) |
| --- | --- | --- |
| Deal | 1 | `game_id: ID, grid: u8 = 24, tiles: u16 = 576, ct_hash: vector<u8>` |
| Tile kind (verified on-chain) | 2 | `game_id: ID, x: u8, y: u8, kind: u8` |
| Tile clue (verified in the browser) | 3 | `game_id, x, y, kind, warmth: u8, hazards: u8` |

Each is `IntentMessage { intent: u8, timestamp_ms: u64 = deal_ts, payload }`. A tile plaintext is BCS `TilePlain { version: 1, kind, warmth, hazards, kind_sig, clue_sig }` (134 bytes) zero-padded to 160. The Seal identity is `game_id ‖ x ‖ y` (34 bytes). `ct_hash` is Blake2b-256 over the 576 ciphertexts in row-major order, each prefixed with its u32 little-endian length.

## Changes from spec v1.0

- `resolve` takes `&Game`; `resolve_fatal` handles a crevasse with no rope (keeps the R1 fix).
- `seal_approve_thaw` ships alongside `seal_approve` (no Explorer needed for the thaw).
- `seal_deal_enclave` accepts only `Enclave<DEALER>`.
- `cancel_empty` cancels a lobby that never got a prize.
- The sponsor refuses any command touching the gas coin and any funds withdrawal from the sponsor; its quota is 1 200 transactions per address per hunt.
- The enclave package is published inside the `whiteout` package (`--with-unpublished-dependencies`), so there is one package and one UpgradeCap to destroy.
