# Phase 2: Whiteout as a recurring Lofi event

Phase 2 of the spec (section 16) adds six things. All of them ship in one new package
version: games do not migrate, so a v1 hunt stays on the v1 package.

## Ranked relics

A hunt can hide 1 to 3 relics and hold one prize per relic. The host sets the pot
split in basis points per rank (for example 6000/2500/1500) when creating the lobby.

- Finders rank in the order they claim. Rank *k* takes prize *k*, their own stake, and
  `pot × share_k / (shares of ranks k and below)` of the pot at that moment. The last
  rank therefore takes whatever is left, and every unit is accounted for
  (`three_ranked_finders_split_the_pot_and_conserve_value`).
- The hunt ends as soon as every relic is claimed. Otherwise settlement after
  `ends_at` sends the remaining pot to the well fund, and the host takes back the
  unwon prizes, highest rank first.
- A relic someone already claimed is ordinary ground: resolving it is allowed, and a
  second claim aborts with `ERelicTaken` (26).
- The dealer places relics in rows 12 to 23, at least 6 tiles apart (Chebyshev), each
  reachable from base camp. Warmth points at the nearest relic.
- The deal signature now commits to the relic count (`DealPayload.relics`). The
  contract checks it against the game's prize count, so a dealer cannot quietly place
  fewer relics than there are prizes. The Move fixtures, the TypeScript core and the
  Rust enclave are all tested against the same signatures for 1, 2 and 3 relics.

## Holder gating

`whiteout::allowlist` is a shared set of addresses, edited only by the holder of its
`AllowlistCap` (for example the Lofi team, from a snapshot of Mystic Yeti or $LOFI
holders). The host attaches a list in the lobby with `set_allowlist`. A gated game
then refuses `join` (`EGated`, 24) and accepts `join_gated` only from members
(`ENotAllowed`, 25). The list is fixed once the hunt opens.

## Blizzards

A hunt may schedule blizzards: every `blizzard_every_ms` (at least 10 minutes), anyone
may call `game::blizzard`, a private `entry` function that reads Sui Random.

- It drops 12 snowdrifts on distinct tiles: never on base camp, at most 8 in one row,
  so no row is ever walled off.
- A drift only stops a yeti stepping onto it (`EDrift`, 27). Nobody is moved, so the
  state-lag risk the spec warns about (R7) does not arise.
- Drifts melt after `blizzard_ms`: at most 15 minutes and at most a third of the
  interval. After that the dealer-checked map, with a path to every relic, is fully
  open again. This is how a blizzard never makes the map unsolvable
  (`blizzards_stay_inside_their_bounds` checks the bounds over many seeds).
- Randomness is used only in that private entry function and never in `seal_approve`.
- Active players' clients start a due blizzard after a short random wait; the CLI
  (`status --watch --auto-blizzard`) and the host console can too.

## Host console

`#/host` does in the browser what the `whiteout` CLI does. The host signs with their
own wallet and pays gas; host actions are never sponsored.

1. Create a hunt: well fund, stake, players, length, reveal window, relics and pot
   split, blizzards, and an optional allowlist.
2. Deposit a prize per rank: an amount of SUI split from your gas coin, or any object
   you own.
3. Deal: a ceremony deal in the browser (free hunts only; the map is drawn, signed,
   Seal-encrypted and uploaded to Walrus on this device), or an attested enclave. The
   console runs the same checks as `whiteout deal`.
4. Open, then run the hunt: start due blizzards, freeze overdue yetis.
5. Settle, reclaim unwon prizes, and thaw: decrypt all 576 tiles, verify every
   signature and publish the thaw file.

It also creates allowlists and adds or removes addresses from a pasted snapshot.

## History

`#/history` lists every finished hunt, rebuilt from one scan of the package's events:
finders by rank and what each took from the pot, freezes, steps, and the total paid to
the wells. With a wallet connected you can filter to the hunts you played.

## Deadline alerts

Players can turn on browser notifications for reveal deadlines (under a minute left),
blizzards, rivals' finds and the last 10 minutes of a hunt. They fire while the hunt
is open in a tab, including a background tab. There is no push server, so a closed tab
gets no alerts.

## CLI

```
whiteout create --well <addr> --relics 3 --shares 6000,2500,1500 \
  --blizzard-every 30m --blizzard-for 5m --allowlist <list id>
whiteout deposit-prize --game <id> --prize <object>     # once per relic, rank 1 first
whiteout allowlist create --name "Mystic Yeti holders, Dec snapshot"
whiteout allowlist add --list <id> --cap <cap> --file holders.txt
whiteout gate --game <id> --allowlist <id>
whiteout blizzard --game <id>
whiteout status --game <id> --watch --auto-freeze --auto-blizzard
```

## Not built

The spec lists Phase 2 dependencies outside the code: the Lofi team's agreement on
gating rules (which holders, which snapshot), and a stable Mainnet key-server tier.
Sybil resistance beyond stake and gating stays a research item.
