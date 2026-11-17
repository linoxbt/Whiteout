# Whiteout

A Lofi treasure hunt on Sui with no game master. Every tile of a 24×24 mountain is
encrypted with Seal. Key servers release a tile's key only to the player whose
on-chain Explorer stands on it (or next to it, while wearing goggles). An attested
Nautilus enclave deals the map, so neither the host nor the developer ever sees it.
The Move contract checks the dealer's signature on every reveal and holds the prize
and stakes in escrow.

Built for CLAY Hackathon III. The full design is the *Whiteout — Build Specification v1.0*.

## Status

| Part | Path | State |
| --- | --- | --- |
| Move package (rules, escrow, Seal policy) | `move/whiteout` | Written, with tests. CI compiles and runs them |
| Vendored Nautilus enclave package | `move/enclave` | Copied from upstream (see `VENDORED.md`) |
| Dealer enclave (Rust) | `enclave/whiteout-dealer` | Not started |
| Shared TS core, web client, sponsor, host CLI | `packages/*` | Not started |

## Move package

```
move/whiteout/
  sources/
    game.move      Game, Explorer, HostCap; lobby, deal, join, step, resolve, freeze, claim, settlement
    policy.move    seal_approve (player vision) and seal_approve_thaw (after the game ends)
    tiles.move     signed message formats, kind check, Seal identity encode/decode
    dealer.move    DEALER witness for Enclave<DEALER>
    bitmap.move    72-byte visited set
  tests/           unit tests per acceptance criterion, plus a conservation property test
  scripts/gen_fixtures.py   signs a test map with a fixed dealer key -> tests/fixtures.move
```

Run the tests (needs the [Sui CLI](https://docs.sui.io/guides/developer/getting-started/sui-install)):

```
sui move test --path move/whiteout
```

If you change a signed message layout or the test map, regenerate the fixtures
(needs `pip install cryptography`):

```
python3 move/whiteout/scripts/gen_fixtures.py
```

### Changes from spec v1.0

These follow the review suggestions left in the spec doc:

- **`resolve` takes `&Game`.** A crevasse with no rope goes through the new
  `resolve_fatal(&mut Game, …)`, so ordinary resolves never write the shared Game
  object (keeps the R1 fix intact). `resolve` aborts `EUseFatal` (23) for that case.
- **`seal_approve_thaw(id, g, clock)`** ships alongside `seal_approve`, so the thaw
  needs no Explorer argument and works for a game nobody joined.
- **`seal_deal_enclave` accepts only `Enclave<DEALER>`**, so an enclave registered
  for another app cannot deal a Whiteout game.
- **`cancel_empty`** cancels a lobby that never received a prize.
- Public functions that pay out have `*_internal` twins that return balances
  instead of transferring them, so tests can check every amount.
