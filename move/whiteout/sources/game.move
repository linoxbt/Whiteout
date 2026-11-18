/// Whiteout game rules, escrow and payouts (spec sections 8, 10 and 13).
///
/// Shape of the state:
/// - `Game<T>` is shared and written only by rare calls: lobby set-up, deal, join,
///   fatal freezes, the relic claim and settlement.
/// - `Explorer<T>` is shared, one per player per game. `step` and `resolve` take
///   `&Game` and `&mut Explorer`, so players never contend on one object (R1).
///   A crevasse with no rope goes through `resolve_fatal`, the only resolve path
///   that writes `Game` (its stake split feeds the pot).
///
/// The public entry points transfer coins and share objects. Each has a
/// `public(package)` `*_internal` twin that returns balances instead, so the
/// tests can check every amount.
module whiteout::game;

use enclave::enclave::Enclave;
use std::type_name;
use sui::random::{Self, Random, RandomGenerator};
use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::dynamic_object_field as dof;
use sui::event;
use sui::table::{Self, Table};
use whiteout::allowlist::Allowlist;
use whiteout::bitmap;
use whiteout::dealer::DEALER;
use whiteout::tiles;

// === Game status ===
const LOBBY: u8 = 0;
const OPEN: u8 = 1;
const ENDED_FOUND: u8 = 2;
const ENDED_UNCLAIMED: u8 = 3;
const CANCELLED: u8 = 4;

// === Dealer kinds ===
const DEALER_NONE: u8 = 0;
const DEALER_ENCLAVE: u8 = 1;
const DEALER_CEREMONY: u8 = 2;

// === Explorer status ===
const ACTIVE: u8 = 0;
const FROZEN: u8 = 1;
const WITHDRAWN: u8 = 2;
const FINDER: u8 = 3;

// === Rules ===
const GRID: u8 = 24;
const BASE_ROW: u8 = 0;
const STEP_COOLDOWN_MS: u64 = 8_000;
const GOGGLE_STEPS: u8 = 10;
const MAX_ROPES: u8 = 3;
const MAX_PLAYERS_CAP: u16 = 128;
const MAX_STAKE: u64 = 1 << 56;
const MIN_DURATION_MS: u64 = 3_600_000;
const MAX_DURATION_MS: u64 = 259_200_000;
const MIN_RESOLVE_WINDOW_MS: u64 = 120_000;
const MAX_RESOLVE_WINDOW_MS: u64 = 3_600_000;
const HASH_LEN: u64 = 32;
const PK_LEN: u64 = 32;

// === Phase 2: ranked relics and blizzards ===
const MAX_RELICS: u8 = 3;
const BPS: u64 = 10_000;
/// Drifts per blizzard, and at most this many in one row, so a row is never walled off.
const MAX_DRIFTS: u64 = 12;
const MAX_DRIFTS_PER_ROW: u64 = 8;
const MIN_BLIZZARD_EVERY_MS: u64 = 600_000;
const MIN_BLIZZARD_MS: u64 = 60_000;
/// Drifts always melt: a blizzard lasts at most 15 minutes and a third of the interval.
const MAX_BLIZZARD_MS: u64 = 900_000;

// === Directions ===
const NORTH: u8 = 0;
const EAST: u8 = 1;
const SOUTH: u8 = 2;
const WEST: u8 = 3;

// === Error codes (spec section 13; the client maps each to a message) ===
const EBadParam: u64 = 1;
const EWrongState: u64 = 2;
const ENotHost: u64 = 3;
const EPrizeExists: u64 = 4;
const ENoPrize: u64 = 5;
const EStakeInCeremony: u64 = 6;
const EFull: u64 = 7;
const EAlreadyJoined: u64 = 8;
const EWrongStake: u64 = 9;
const ECooldown: u64 = 10;
const EBadSig: u64 = 11;
const EUseClaim: u64 = 12;
const ENotOverdue: u64 = 13;
const EEnded: u64 = 14;
const ENotEnded: u64 = 15;
const ENotYours: u64 = 16;
const EInactive: u64 = 17;
const EPending: u64 = 18;
const EOutOfBounds: u64 = 19;
const EWrongGame: u64 = 20;
// 21 (ENoAccess) is raised by `whiteout::policy`.
const ENoPending: u64 = 22;
/// A crevasse with no rope must be resolved with `resolve_fatal`.
const EUseFatal: u64 = 23;
/// The game is gated: join with `join_gated` and the game's allowlist.
const EGated: u64 = 24;
/// The sender is not on the game's allowlist.
const ENotAllowed: u64 = 25;
/// Someone already claimed the relic on this tile.
const ERelicTaken: u64 = 26;
/// A blizzard drift blocks this tile until it melts.
const EDrift: u64 = 27;
/// No blizzard is due (or blizzards are off for this game).
const ENoBlizzard: u64 = 28;

// === Objects ===

public struct Game<phantom T> has key {
    id: UID,
    host: address,
    status: u8,
    dealer_kind: u8,
    dealer_pk: vector<u8>,
    enclave_id: Option<ID>,
    deal_ts: u64,
    quilt_id: vector<u8>,
    ct_hash: vector<u8>,
    entry_stake: u64,
    max_players: u16,
    player_count: u16,
    duration_ms: u64,
    resolve_window_ms: u64,
    open_at: u64,
    ends_at: u64,
    well_fund: address,
    pot: Balance<T>,
    explorers: Table<address, ID>,
    /// First finder (rank 1), kept for single-relic clients.
    finder: Option<address>,
    thaw_blob: Option<vector<u8>>,
    /// Relic tiles on the map, equal to the number of prizes.
    relics: u8,
    /// Pot share of each rank in basis points; sums to 10 000.
    pot_shares: vector<u16>,
    /// Prizes currently held by the game, keyed PrizeKey { rank } for 1..=relics.
    prizes_held: u8,
    prizes_deposited: u8,
    /// Finders in rank order, and the tiles they claimed.
    finders: vector<address>,
    claimed: vector<u16>,
    /// When set, only members of this allowlist may join.
    allowlist: Option<ID>,
    blizzard_every_ms: u64,
    blizzard_ms: u64,
    next_blizzard_at: u64,
    drifts: vector<u16>,
    drift_until: u64,
}

public struct Explorer<phantom T> has key {
    id: UID,
    game_id: ID,
    owner: address,
    x: u8,
    y: u8,
    vision: u8,
    vision_steps: u8,
    ropes: u8,
    status: u8,
    pending: Option<Pending>,
    last_step_ms: u64,
    visited: vector<u8>,
    stake: Balance<T>,
    steps: u32,
}

public struct Pending has copy, drop, store {
    x: u8,
    y: u8,
    deadline_ms: u64,
}

public struct HostCap has key, store {
    id: UID,
    game_id: ID,
}

/// Dynamic object field key for the prize of each rank (1 = first finder).
public struct PrizeKey has copy, drop, store { rank: u8 }

// === Events (every event carries game_id) ===

public struct LobbyCreated has copy, drop {
    game_id: ID,
    host: address,
    coin_type: std::ascii::String,
    entry_stake: u64,
    max_players: u16,
    duration_ms: u64,
    resolve_window_ms: u64,
    well_fund: address,
    relics: u8,
    pot_shares: vector<u16>,
    blizzard_every_ms: u64,
    blizzard_ms: u64,
}

public struct PrizeDeposited has copy, drop {
    game_id: ID,
    prize_id: ID,
    prize_type: std::ascii::String,
    rank: u8,
}

public struct AllowlistSet has copy, drop {
    game_id: ID,
    list_id: ID,
}

public struct BlizzardStarted has copy, drop {
    game_id: ID,
    drifts: vector<u16>,
    until_ms: u64,
    next_ms: u64,
}

public struct LobbyCancelled has copy, drop { game_id: ID }

public struct GameDealt has copy, drop {
    game_id: ID,
    dealer_kind: u8,
    enclave_id: Option<ID>,
    quilt_id: vector<u8>,
    ct_hash: vector<u8>,
    open_at: u64,
    ends_at: u64,
}

public struct ExplorerJoined has copy, drop {
    game_id: ID,
    explorer_id: ID,
    owner: address,
    column: u8,
}

public struct Stepped has copy, drop {
    game_id: ID,
    explorer_id: ID,
    x: u8,
    y: u8,
    pending: bool,
}

public struct TileResolved has copy, drop {
    game_id: ID,
    explorer_id: ID,
    x: u8,
    y: u8,
    kind: u8,
}

public struct ItemGained has copy, drop {
    game_id: ID,
    explorer_id: ID,
    item: u8,
}

public struct RopeUsed has copy, drop {
    game_id: ID,
    explorer_id: ID,
    x: u8,
    y: u8,
}

public struct ExplorerFrozen has copy, drop {
    game_id: ID,
    explorer_id: ID,
    to_well: u64,
    to_pot: u64,
    overdue: bool,
}

public struct RelicClaimed has copy, drop {
    game_id: ID,
    explorer_id: ID,
    finder: address,
    prize_id: ID,
    /// The pot share paid with this claim.
    pot: u64,
    rank: u8,
    x: u8,
    y: u8,
}

public struct GameFinalized has copy, drop {
    game_id: ID,
    to_well: u64,
}

public struct StakeWithdrawn has copy, drop {
    game_id: ID,
    explorer_id: ID,
    amount: u64,
}

public struct PrizeReclaimed has copy, drop {
    game_id: ID,
    prize_id: ID,
    rank: u8,
}

public struct ThawPublished has copy, drop {
    game_id: ID,
    blob_id: vector<u8>,
}

// =====================================================================
// Lobby
// =====================================================================

/// FR1. Creates and shares a single-relic LOBBY game with no blizzards.
public fun create_lobby<T>(
    entry_stake: u64,
    max_players: u16,
    duration_ms: u64,
    resolve_window_ms: u64,
    well_fund: address,
    ctx: &mut TxContext,
): HostCap {
    create_ranked_lobby<T>(
        entry_stake,
        max_players,
        duration_ms,
        resolve_window_ms,
        well_fund,
        1,
        vector[BPS as u16],
        0,
        0,
        ctx,
    )
}

/// Phase 2. A LOBBY game with `relics` ranked prizes (1 to 3), the pot split by
/// `pot_shares` (basis points per rank, summing to 10 000), and optional blizzards
/// every `blizzard_every_ms`, each lasting `blizzard_ms` (both 0 for none).
public fun create_ranked_lobby<T>(
    entry_stake: u64,
    max_players: u16,
    duration_ms: u64,
    resolve_window_ms: u64,
    well_fund: address,
    relics: u8,
    pot_shares: vector<u16>,
    blizzard_every_ms: u64,
    blizzard_ms: u64,
    ctx: &mut TxContext,
): HostCap {
    let (game, cap) = new_ranked_lobby<T>(
        entry_stake,
        max_players,
        duration_ms,
        resolve_window_ms,
        well_fund,
        relics,
        pot_shares,
        blizzard_every_ms,
        blizzard_ms,
        ctx,
    );
    transfer::share_object(game);
    cap
}

public(package) fun new_lobby<T>(
    entry_stake: u64,
    max_players: u16,
    duration_ms: u64,
    resolve_window_ms: u64,
    well_fund: address,
    ctx: &mut TxContext,
): (Game<T>, HostCap) {
    new_ranked_lobby<T>(
        entry_stake,
        max_players,
        duration_ms,
        resolve_window_ms,
        well_fund,
        1,
        vector[BPS as u16],
        0,
        0,
        ctx,
    )
}

public(package) fun new_ranked_lobby<T>(
    entry_stake: u64,
    max_players: u16,
    duration_ms: u64,
    resolve_window_ms: u64,
    well_fund: address,
    relics: u8,
    pot_shares: vector<u16>,
    blizzard_every_ms: u64,
    blizzard_ms: u64,
    ctx: &mut TxContext,
): (Game<T>, HostCap) {
    assert!(entry_stake <= MAX_STAKE, EBadParam);
    assert!(max_players >= 1 && max_players <= MAX_PLAYERS_CAP, EBadParam);
    assert!(duration_ms >= MIN_DURATION_MS && duration_ms <= MAX_DURATION_MS, EBadParam);
    assert!(
        resolve_window_ms >= MIN_RESOLVE_WINDOW_MS && resolve_window_ms <= MAX_RESOLVE_WINDOW_MS,
        EBadParam,
    );
    assert!(well_fund != @0x0, EBadParam);
    assert!(relics >= 1 && relics <= MAX_RELICS, EBadParam);
    assert!(pot_shares.length() == (relics as u64), EBadParam);
    let mut total = 0;
    pot_shares.do_ref!(|b| total = total + (*b as u64));
    assert!(total == BPS, EBadParam);
    assert!(
        (blizzard_every_ms == 0 && blizzard_ms == 0) ||
            (blizzard_every_ms >= MIN_BLIZZARD_EVERY_MS && blizzard_ms >= MIN_BLIZZARD_MS &&
                blizzard_ms <= MAX_BLIZZARD_MS && blizzard_ms * 3 <= blizzard_every_ms),
        EBadParam,
    );

    // The Game's UID is created first, so its ID is known before the deal (R2).
    let id = object::new(ctx);
    let game_id = id.to_inner();
    let game = Game<T> {
        id,
        host: ctx.sender(),
        status: LOBBY,
        dealer_kind: DEALER_NONE,
        dealer_pk: vector[],
        enclave_id: option::none(),
        deal_ts: 0,
        quilt_id: vector[],
        ct_hash: vector[],
        entry_stake,
        max_players,
        player_count: 0,
        duration_ms,
        resolve_window_ms,
        open_at: 0,
        ends_at: 0,
        well_fund,
        pot: balance::zero(),
        explorers: table::new(ctx),
        finder: option::none(),
        thaw_blob: option::none(),
        relics,
        pot_shares,
        prizes_held: 0,
        prizes_deposited: 0,
        finders: vector[],
        claimed: vector[],
        allowlist: option::none(),
        blizzard_every_ms,
        blizzard_ms,
        next_blizzard_at: 0,
        drifts: vector[],
        drift_until: 0,
    };
    let cap = HostCap { id: object::new(ctx), game_id };
    event::emit(LobbyCreated {
        game_id,
        host: ctx.sender(),
        coin_type: type_name::with_defining_ids<T>().into_string(),
        entry_stake,
        max_players,
        duration_ms,
        resolve_window_ms,
        well_fund,
        relics,
        pot_shares: game.pot_shares,
        blizzard_every_ms,
        blizzard_ms,
    });
    (game, cap)
}

/// Phase 2 gating: only members of `list` may join. Set while in LOBBY.
public fun set_allowlist<T>(g: &mut Game<T>, cap: &HostCap, list: &Allowlist) {
    assert_host(g, cap);
    assert!(g.status == LOBBY, EWrongState);
    let list_id = object::id(list);
    g.allowlist = option::some(list_id);
    event::emit(AllowlistSet { game_id: g.id.to_inner(), list_id });
}

/// FR2. One prize per relic, deposited in rank order while the game is in LOBBY.
public fun deposit_prize<T, P: key + store>(g: &mut Game<T>, cap: &HostCap, prize: P) {
    assert_host(g, cap);
    assert!(g.status == LOBBY, EWrongState);
    assert!(g.prizes_deposited < g.relics, EPrizeExists);
    let rank = g.prizes_deposited + 1;
    let prize_id = object::id(&prize);
    dof::add(&mut g.id, PrizeKey { rank }, prize);
    g.prizes_deposited = rank;
    g.prizes_held = g.prizes_held + 1;
    event::emit(PrizeDeposited {
        game_id: g.id.to_inner(),
        prize_id,
        prize_type: type_name::with_defining_ids<P>().into_string(),
        rank,
    });
}

/// FR3. Cancels a LOBBY game and returns its highest-ranked-number prize to the
/// host. Any other prizes come back through `reclaim_prize`.
public fun cancel<T, P: key + store>(g: &mut Game<T>, cap: &HostCap): P {
    assert_host(g, cap);
    assert!(g.status == LOBBY, EWrongState);
    assert!(g.prizes_held > 0, ENoPrize);
    g.status = CANCELLED;
    event::emit(LobbyCancelled { game_id: g.id.to_inner() });
    take_top_prize(g)
}

/// FR3, for a lobby cancelled before any prize was deposited.
public fun cancel_empty<T>(g: &mut Game<T>, cap: &HostCap) {
    assert_host(g, cap);
    assert!(g.status == LOBBY, EWrongState);
    assert!(g.prizes_held == 0, EPrizeExists);
    g.status = CANCELLED;
    event::emit(LobbyCancelled { game_id: g.id.to_inner() });
}

// =====================================================================
// Deal
// =====================================================================

/// FR4, MD4. Opens the game after verifying the attested dealer's signature over
/// this game's ID and the ciphertext hash. Only `Enclave<DEALER>` is accepted, so an
/// enclave registered for another app cannot deal.
public fun seal_deal_enclave<T>(
    g: &mut Game<T>,
    cap: &HostCap,
    enclave: &Enclave<DEALER>,
    deal_ts: u64,
    ct_hash: vector<u8>,
    quilt_id: vector<u8>,
    sig: vector<u8>,
    clock: &Clock,
) {
    assert_host(g, cap);
    assert!(g.status == LOBBY, EWrongState);
    assert!(g.prizes_deposited == g.relics, ENoPrize);
    assert!(ct_hash.length() == HASH_LEN, EBadParam);
    assert!(!quilt_id.is_empty(), EBadParam);
    let payload = tiles::deal_payload(g.id.to_inner(), g.relics, ct_hash);
    assert!(enclave.verify_signature(tiles::intent_deal(), deal_ts, payload, &sig), EBadSig);
    open(
        g,
        DEALER_ENCLAVE,
        *enclave.pk(),
        option::some(object::id(enclave)),
        deal_ts,
        ct_hash,
        quilt_id,
        clock,
    );
}

/// FR4, MD5. Host-dealt fallback: the host knows the map, so the stake must be zero.
/// The game is labelled CEREMONY on-chain and in every event.
public fun seal_deal_ceremony<T>(
    g: &mut Game<T>,
    cap: &HostCap,
    dealer_pk: vector<u8>,
    deal_ts: u64,
    ct_hash: vector<u8>,
    quilt_id: vector<u8>,
    clock: &Clock,
) {
    assert_host(g, cap);
    assert!(g.status == LOBBY, EWrongState);
    assert!(g.entry_stake == 0, EStakeInCeremony);
    assert!(g.prizes_deposited == g.relics, ENoPrize);
    assert!(dealer_pk.length() == PK_LEN, EBadParam);
    assert!(ct_hash.length() == HASH_LEN, EBadParam);
    assert!(!quilt_id.is_empty(), EBadParam);
    open(g, DEALER_CEREMONY, dealer_pk, option::none(), deal_ts, ct_hash, quilt_id, clock);
}

fun open<T>(
    g: &mut Game<T>,
    dealer_kind: u8,
    dealer_pk: vector<u8>,
    enclave_id: Option<ID>,
    deal_ts: u64,
    ct_hash: vector<u8>,
    quilt_id: vector<u8>,
    clock: &Clock,
) {
    let now = clock.timestamp_ms();
    g.status = OPEN;
    g.dealer_kind = dealer_kind;
    g.dealer_pk = dealer_pk;
    g.enclave_id = enclave_id;
    g.deal_ts = deal_ts;
    g.ct_hash = ct_hash;
    g.quilt_id = quilt_id;
    g.open_at = now;
    g.ends_at = now + g.duration_ms;
    if (g.blizzard_every_ms > 0) g.next_blizzard_at = now + g.blizzard_every_ms;
    event::emit(GameDealt {
        game_id: g.id.to_inner(),
        dealer_kind,
        enclave_id,
        quilt_id: g.quilt_id,
        ct_hash: g.ct_hash,
        open_at: g.open_at,
        ends_at: g.ends_at,
    });
}

// =====================================================================
// Play
// =====================================================================

/// FR6. Pays the exact stake and starts on (column, 0). Shares a new Explorer.
/// Ungated games only.
public fun join<T>(g: &mut Game<T>, stake: Coin<T>, column: u8, clock: &Clock, ctx: &mut TxContext) {
    let e = join_internal(g, stake, column, clock, ctx);
    transfer::share_object(e);
}

/// Phase 2. Joins a gated game; the sender must be on the game's allowlist.
public fun join_gated<T>(
    g: &mut Game<T>,
    list: &Allowlist,
    stake: Coin<T>,
    column: u8,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let e = join_gated_internal(g, list, stake, column, clock, ctx);
    transfer::share_object(e);
}

public(package) fun join_internal<T>(
    g: &mut Game<T>,
    stake: Coin<T>,
    column: u8,
    clock: &Clock,
    ctx: &mut TxContext,
): Explorer<T> {
    assert!(g.allowlist.is_none(), EGated);
    enter(g, stake, column, clock, ctx)
}

public(package) fun join_gated_internal<T>(
    g: &mut Game<T>,
    list: &Allowlist,
    stake: Coin<T>,
    column: u8,
    clock: &Clock,
    ctx: &mut TxContext,
): Explorer<T> {
    assert!(g.allowlist == option::some(object::id(list)), EGated);
    assert!(list.contains(ctx.sender()), ENotAllowed);
    enter(g, stake, column, clock, ctx)
}

fun enter<T>(
    g: &mut Game<T>,
    stake: Coin<T>,
    column: u8,
    clock: &Clock,
    ctx: &mut TxContext,
): Explorer<T> {
    assert!(g.status == OPEN, EWrongState);
    assert!(clock.timestamp_ms() < g.ends_at, EEnded);
    assert!(g.player_count < g.max_players, EFull);
    let owner = ctx.sender();
    assert!(!g.explorers.contains(owner), EAlreadyJoined);
    assert!(stake.value() == g.entry_stake && column < GRID, EWrongStake);

    let mut visited = bitmap::new();
    bitmap::insert(&mut visited, column, BASE_ROW);
    let e = Explorer<T> {
        id: object::new(ctx),
        game_id: g.id.to_inner(),
        owner,
        x: column,
        y: BASE_ROW,
        vision: 0,
        vision_steps: 0,
        ropes: 0,
        status: ACTIVE,
        pending: option::none(),
        last_step_ms: 0,
        visited,
        stake: stake.into_balance(),
        steps: 0,
    };
    let explorer_id = object::id(&e);
    g.explorers.add(owner, explorer_id);
    g.player_count = g.player_count + 1;
    event::emit(ExplorerJoined { game_id: e.game_id, explorer_id, owner, column });
    e
}

/// FR7, FR8. One tile N/E/S/W. Reads `Game` only.
public fun step<T>(g: &Game<T>, e: &mut Explorer<T>, dir: u8, clock: &Clock, ctx: &TxContext) {
    assert_mine(g, e, ctx);
    assert!(e.status == ACTIVE, EInactive);
    let now = clock.timestamp_ms();
    assert!(g.status == OPEN && now < g.ends_at, EEnded);
    assert!(e.pending.is_none(), EPending);
    assert!(e.steps == 0 || now >= e.last_step_ms + STEP_COOLDOWN_MS, ECooldown);

    let (x, y) = (e.x, e.y);
    let (nx, ny) = if (dir == NORTH) {
        assert!(y + 1 < GRID, EOutOfBounds);
        (x, y + 1)
    } else if (dir == EAST) {
        assert!(x + 1 < GRID, EOutOfBounds);
        (x + 1, y)
    } else if (dir == SOUTH) {
        assert!(y > 0, EOutOfBounds);
        (x, y - 1)
    } else {
        assert!(dir == WEST, EBadParam);
        assert!(x > 0, EOutOfBounds);
        (x - 1, y)
    };
    assert!(!drift_at(g, nx, ny, now), EDrift);

    e.x = nx;
    e.y = ny;
    e.steps = e.steps + 1;
    e.last_step_ms = now;

    // Goggles count down on every step (MD3): pickup tile + the next 9 positions.
    if (e.vision_steps > 0) {
        e.vision_steps = e.vision_steps - 1;
        if (e.vision_steps == 0) e.vision = 0;
    };

    let fresh = !bitmap::contains(&e.visited, nx, ny);
    if (fresh) {
        e.pending.fill(Pending { x: nx, y: ny, deadline_ms: now + g.resolve_window_ms });
    };
    event::emit(Stepped {
        game_id: e.game_id,
        explorer_id: object::id(e),
        x: nx,
        y: ny,
        pending: fresh,
    });
}

/// FR11. Resolves the pending tile with the dealer's kind signature. Reads `Game`
/// only. Snow, goggles, rope, a crevasse bridged with a rope, and a relic after
/// the game ended. A live relic aborts `EUseClaim`; a crevasse with no rope
/// aborts `EUseFatal`.
public fun resolve<T>(
    g: &Game<T>,
    e: &mut Explorer<T>,
    kind: u8,
    kind_sig: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert_mine(g, e, ctx);
    assert!(e.status == ACTIVE, EInactive);
    let p = take_verified_pending(g, e, kind, &kind_sig);
    let explorer_id = object::id(e);

    if (kind == tiles::goggles()) {
        e.vision = 1;
        e.vision_steps = GOGGLE_STEPS;
        event::emit(ItemGained { game_id: e.game_id, explorer_id, item: kind });
    } else if (kind == tiles::rope()) {
        if (e.ropes < MAX_ROPES) e.ropes = e.ropes + 1;
        event::emit(ItemGained { game_id: e.game_id, explorer_id, item: kind });
    } else if (kind == tiles::crevasse()) {
        assert!(e.ropes > 0, EUseFatal);
        e.ropes = e.ropes - 1;
        event::emit(RopeUsed { game_id: e.game_id, explorer_id, x: p.x, y: p.y });
    } else if (kind == tiles::relic()) {
        // A relic someone already claimed is just ground to stand on.
        assert!(is_ended(g, clock) || g.claimed.contains(&tiles::index(p.x, p.y)), EUseClaim);
    };

    finish_resolve(e, p, kind);
}

/// FR11, FR15. A crevasse with no rope: the Explorer freezes and its stake splits.
public fun resolve_fatal<T>(
    g: &mut Game<T>,
    e: &mut Explorer<T>,
    kind_sig: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let to_well = resolve_fatal_internal(g, e, kind_sig, clock, ctx);
    pay(to_well, g.well_fund, ctx);
}

public(package) fun resolve_fatal_internal<T>(
    g: &mut Game<T>,
    e: &mut Explorer<T>,
    kind_sig: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
): Balance<T> {
    assert_mine(g, e, ctx);
    assert!(e.status == ACTIVE, EInactive);
    assert!(e.ropes == 0, EBadParam);
    let crevasse = tiles::crevasse();
    let p = take_verified_pending(g, e, crevasse, &kind_sig);
    finish_resolve(e, p, crevasse);
    freeze_explorer(g, e, false, clock)
}

/// FR16, Phase 2. Claims the relic under the Explorer. Finders rank in claim
/// order: rank k takes prize k, its own stake, and pot * share_k / (shares of
/// ranks k and below), so the last rank takes whatever is left. The game ends when
/// every relic is claimed.
public fun claim_relic<T, P: key + store>(
    g: &mut Game<T>,
    e: &mut Explorer<T>,
    kind_sig: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let (prize, payout) = claim_relic_internal<T, P>(g, e, kind_sig, clock, ctx);
    transfer::public_transfer(prize, e.owner);
    pay(payout, e.owner, ctx);
}

public(package) fun claim_relic_internal<T, P: key + store>(
    g: &mut Game<T>,
    e: &mut Explorer<T>,
    kind_sig: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
): (P, Balance<T>) {
    assert_mine(g, e, ctx);
    assert!(e.status == ACTIVE, EInactive);
    let now = clock.timestamp_ms();
    assert!(g.status == OPEN && now < g.ends_at, EEnded);
    assert!(e.pending.is_some(), ENoPending);
    let at = *e.pending.borrow();
    let tile = tiles::index(at.x, at.y);
    assert!(!g.claimed.contains(&tile), ERelicTaken);
    let relic = tiles::relic();
    let p = take_verified_pending(g, e, relic, &kind_sig);
    finish_resolve(e, p, relic);

    let rank = (g.finders.length() as u8) + 1;
    let prize: P = dof::remove(&mut g.id, PrizeKey { rank });
    g.prizes_held = g.prizes_held - 1;
    let share = pot_share(g, rank);
    let pot = g.pot.split(share);
    let mut payout = e.stake.withdraw_all();
    payout.join(pot);

    e.status = FINDER;
    g.finders.push_back(e.owner);
    g.claimed.push_back(tile);
    if (rank == 1) g.finder = option::some(e.owner);
    if (rank == g.relics) g.status = ENDED_FOUND;
    event::emit(RelicClaimed {
        game_id: e.game_id,
        explorer_id: object::id(e),
        finder: e.owner,
        prize_id: object::id(&prize),
        pot: share,
        rank,
        x: p.x,
        y: p.y,
    });
    (prize, payout)
}

/// The pot paid to `rank` right now: pot * share / (shares of this rank and below).
public fun pot_share<T>(g: &Game<T>, rank: u8): u64 {
    let i = (rank as u64) - 1;
    let mut rest = 0;
    let n = g.pot_shares.length();
    let mut j = i;
    while (j < n) {
        rest = rest + (g.pot_shares[j] as u64);
        j = j + 1;
    };
    if (rest == 0) return 0;
    (((g.pot.value() as u128) * (g.pot_shares[i] as u128) / (rest as u128)) as u64)
}

// =====================================================================
// Blizzards (Phase 2)
// =====================================================================

/// Anyone may start a due blizzard. It drops `MAX_DRIFTS` snowdrifts on random
/// tiles: none on base camp, at most `MAX_DRIFTS_PER_ROW` in any row. A drift only
/// stops yetis stepping onto it; nobody is moved. Drifts melt after `blizzard_ms`,
/// so the dealer-checked path to every relic is always open again. Private entry:
/// randomness is never readable by another module mid-transaction.
entry fun blizzard<T>(g: &mut Game<T>, r: &Random, clock: &Clock, ctx: &mut TxContext) {
    let mut gen = random::new_generator(r, ctx);
    blizzard_internal(g, &mut gen, clock);
}

public(package) fun blizzard_internal<T>(g: &mut Game<T>, gen: &mut RandomGenerator, clock: &Clock) {
    let now = clock.timestamp_ms();
    assert!(g.status == OPEN && now < g.ends_at, EEnded);
    assert!(g.blizzard_every_ms > 0 && now >= g.next_blizzard_at, ENoBlizzard);
    let mut per_row = vector[];
    (GRID as u64).do!(|_| per_row.push_back(0u64));
    let mut drifts = vector[];
    while (drifts.length() < MAX_DRIFTS) {
        let x = gen.generate_u8_in_range(0, GRID - 1);
        let y = gen.generate_u8_in_range(BASE_ROW + 1, GRID - 1);
        let tile = tiles::index(x, y);
        let row = (y as u64);
        let in_row = per_row[row];
        if (!drifts.contains(&tile) && in_row < MAX_DRIFTS_PER_ROW) {
            drifts.push_back(tile);
            *vector::borrow_mut(&mut per_row, row) = in_row + 1;
        };
    };
    g.drifts = drifts;
    g.drift_until = now + g.blizzard_ms;
    // The next blizzard keeps the game's rhythm: the next multiple of the interval.
    let periods = (now - g.open_at) / g.blizzard_every_ms + 1;
    g.next_blizzard_at = g.open_at + periods * g.blizzard_every_ms;
    event::emit(BlizzardStarted {
        game_id: g.id.to_inner(),
        drifts: g.drifts,
        until_ms: g.drift_until,
        next_ms: g.next_blizzard_at,
    });
}

/// True while a drift covers (x, y).
public fun drift_at<T>(g: &Game<T>, x: u8, y: u8, now: u64): bool {
    now < g.drift_until && g.drifts.contains(&tiles::index(x, y))
}

/// FR14, MD8. Anyone may freeze an Explorer whose resolve deadline has passed.
/// Works after the game ends too, so stalling never avoids a crevasse.
public fun freeze_overdue<T>(g: &mut Game<T>, e: &mut Explorer<T>, clock: &Clock, ctx: &mut TxContext) {
    let to_well = freeze_overdue_internal(g, e, clock);
    pay(to_well, g.well_fund, ctx);
}

public(package) fun freeze_overdue_internal<T>(
    g: &mut Game<T>,
    e: &mut Explorer<T>,
    clock: &Clock,
): Balance<T> {
    assert!(e.game_id == g.id.to_inner(), EWrongGame);
    assert!(e.status == ACTIVE, EInactive);
    assert!(e.pending.is_some(), ENoPending);
    assert!(clock.timestamp_ms() > e.pending.borrow().deadline_ms, ENotOverdue);
    e.pending = option::none();
    freeze_explorer(g, e, true, clock)
}

// =====================================================================
// Settlement
// =====================================================================

/// FR17. After `ends_at`, anyone settles a game whose relics were not all found:
/// the pot left over goes to the well fund.
public fun finalize_unclaimed<T>(g: &mut Game<T>, clock: &Clock, ctx: &mut TxContext) {
    let to_well = finalize_unclaimed_internal(g, clock);
    pay(to_well, g.well_fund, ctx);
}

public(package) fun finalize_unclaimed_internal<T>(g: &mut Game<T>, clock: &Clock): Balance<T> {
    assert!(g.status == OPEN, EWrongState);
    assert!(clock.timestamp_ms() >= g.ends_at, ENotEnded);
    g.status = if (g.finders.is_empty()) ENDED_UNCLAIMED else ENDED_FOUND;
    let to_well = g.pot.withdraw_all();
    event::emit(GameFinalized { game_id: g.id.to_inner(), to_well: to_well.value() });
    to_well
}

/// FR19. A surviving Explorer with nothing pending takes its stake back.
public fun withdraw_stake<T>(g: &Game<T>, e: &mut Explorer<T>, clock: &Clock, ctx: &mut TxContext) {
    let stake = withdraw_stake_internal(g, e, clock, ctx);
    pay(stake, e.owner, ctx);
}

public(package) fun withdraw_stake_internal<T>(
    g: &Game<T>,
    e: &mut Explorer<T>,
    clock: &Clock,
    ctx: &TxContext,
): Balance<T> {
    assert_mine(g, e, ctx);
    assert!(is_ended(g, clock), ENotEnded);
    assert!(e.pending.is_none(), EPending);
    assert!(e.status == ACTIVE, EInactive);
    e.status = WITHDRAWN;
    let stake = e.stake.withdraw_all();
    event::emit(StakeWithdrawn {
        game_id: e.game_id,
        explorer_id: object::id(e),
        amount: stake.value(),
    });
    stake
}

/// FR17. The host takes back prizes nobody won, one per call, lowest rank last,
/// once the game is settled or cancelled.
public fun reclaim_prize<T, P: key + store>(g: &mut Game<T>, cap: &HostCap): P {
    assert_host(g, cap);
    assert!(
        g.status == ENDED_UNCLAIMED || g.status == ENDED_FOUND || g.status == CANCELLED,
        EWrongState,
    );
    assert!(g.prizes_held > 0, ENoPrize);
    take_top_prize(g)
}

/// FR20. Records the Walrus blob ID of the verified thaw file.
public fun publish_thaw<T>(g: &mut Game<T>, cap: &HostCap, blob_id: vector<u8>, clock: &Clock) {
    assert_host(g, cap);
    assert!(is_ended(g, clock), ENotEnded);
    assert!(!blob_id.is_empty(), EBadParam);
    g.thaw_blob = option::some(blob_id);
    event::emit(ThawPublished { game_id: g.id.to_inner(), blob_id });
}

// =====================================================================
// Views
// =====================================================================

/// Ended for the Seal policy and for settlement: a finder, a finalised game, or an
/// open game past `ends_at` (the thaw does not wait for `finalize_unclaimed`).
public fun is_ended<T>(g: &Game<T>, clock: &Clock): bool {
    g.status == ENDED_FOUND || g.status == ENDED_UNCLAIMED ||
        (g.status == OPEN && clock.timestamp_ms() >= g.ends_at)
}

public fun status<T>(g: &Game<T>): u8 { g.status }

public fun dealer_kind<T>(g: &Game<T>): u8 { g.dealer_kind }

public fun dealer_pk<T>(g: &Game<T>): &vector<u8> { &g.dealer_pk }

public fun enclave_id<T>(g: &Game<T>): Option<ID> { g.enclave_id }

public fun deal_ts<T>(g: &Game<T>): u64 { g.deal_ts }

public fun ct_hash<T>(g: &Game<T>): &vector<u8> { &g.ct_hash }

public fun quilt_id<T>(g: &Game<T>): &vector<u8> { &g.quilt_id }

public fun entry_stake<T>(g: &Game<T>): u64 { g.entry_stake }

public fun player_count<T>(g: &Game<T>): u16 { g.player_count }

public fun open_at<T>(g: &Game<T>): u64 { g.open_at }

public fun ends_at<T>(g: &Game<T>): u64 { g.ends_at }

public fun well_fund<T>(g: &Game<T>): address { g.well_fund }

public fun pot_value<T>(g: &Game<T>): u64 { g.pot.value() }

public fun finder<T>(g: &Game<T>): Option<address> { g.finder }

public fun has_prize<T>(g: &Game<T>): bool { g.prizes_held > 0 }

public fun relics<T>(g: &Game<T>): u8 { g.relics }

public fun pot_shares<T>(g: &Game<T>): vector<u16> { g.pot_shares }

public fun prizes_held<T>(g: &Game<T>): u8 { g.prizes_held }

public fun finders<T>(g: &Game<T>): vector<address> { g.finders }

public fun claimed<T>(g: &Game<T>): vector<u16> { g.claimed }

public fun allowlist<T>(g: &Game<T>): Option<ID> { g.allowlist }

public fun next_blizzard_at<T>(g: &Game<T>): u64 { g.next_blizzard_at }

public fun drifts<T>(g: &Game<T>): vector<u16> { g.drifts }

public fun drift_until<T>(g: &Game<T>): u64 { g.drift_until }

public fun thaw_blob<T>(g: &Game<T>): Option<vector<u8>> { g.thaw_blob }

public fun explorer_of<T>(g: &Game<T>, player: address): Option<ID> {
    if (g.explorers.contains(player)) option::some(*g.explorers.borrow(player))
    else option::none()
}

public fun cap_game_id(cap: &HostCap): ID { cap.game_id }

public fun game_id<T>(e: &Explorer<T>): ID { e.game_id }

public fun owner<T>(e: &Explorer<T>): address { e.owner }

public fun x<T>(e: &Explorer<T>): u8 { e.x }

public fun y<T>(e: &Explorer<T>): u8 { e.y }

public fun vision<T>(e: &Explorer<T>): u8 { e.vision }

public fun vision_steps<T>(e: &Explorer<T>): u8 { e.vision_steps }

public fun ropes<T>(e: &Explorer<T>): u8 { e.ropes }

public fun explorer_status<T>(e: &Explorer<T>): u8 { e.status }

public fun is_active<T>(e: &Explorer<T>): bool { e.status == ACTIVE }

public fun has_pending<T>(e: &Explorer<T>): bool { e.pending.is_some() }

/// (x, y, deadline_ms) of the pending tile. Aborts if there is none.
public fun pending<T>(e: &Explorer<T>): (u8, u8, u64) {
    assert!(e.pending.is_some(), ENoPending);
    let p = e.pending.borrow();
    (p.x, p.y, p.deadline_ms)
}

public fun visited<T>(e: &Explorer<T>, x: u8, y: u8): bool { bitmap::contains(&e.visited, x, y) }

public fun stake_value<T>(e: &Explorer<T>): u64 { e.stake.value() }

public fun steps<T>(e: &Explorer<T>): u32 { e.steps }

public fun last_step_ms<T>(e: &Explorer<T>): u64 { e.last_step_ms }

// Status constants for clients and the policy.
public fun status_lobby(): u8 { LOBBY }

public fun status_open(): u8 { OPEN }

public fun status_ended_found(): u8 { ENDED_FOUND }

public fun status_ended_unclaimed(): u8 { ENDED_UNCLAIMED }

public fun status_cancelled(): u8 { CANCELLED }

public fun dealer_enclave(): u8 { DEALER_ENCLAVE }

public fun dealer_ceremony(): u8 { DEALER_CEREMONY }

public fun explorer_active(): u8 { ACTIVE }

public fun explorer_frozen(): u8 { FROZEN }

public fun explorer_withdrawn(): u8 { WITHDRAWN }

public fun explorer_finder(): u8 { FINDER }

// =====================================================================
// Internals
// =====================================================================

fun assert_host<T>(g: &Game<T>, cap: &HostCap) {
    assert!(cap.game_id == g.id.to_inner(), ENotHost);
}

fun assert_mine<T>(g: &Game<T>, e: &Explorer<T>, ctx: &TxContext) {
    assert!(e.game_id == g.id.to_inner(), EWrongGame);
    assert!(e.owner == ctx.sender(), ENotYours);
}

/// Checks the dealer's kind signature for the Explorer's own pending tile and
/// takes it. The caller never supplies coordinates (MD7).
fun take_verified_pending<T>(
    g: &Game<T>,
    e: &mut Explorer<T>,
    kind: u8,
    kind_sig: &vector<u8>,
): Pending {
    assert!(e.pending.is_some(), ENoPending);
    let p = *e.pending.borrow();
    assert!(
        tiles::verify_kind(&g.dealer_pk, g.id.to_inner(), g.deal_ts, p.x, p.y, kind, kind_sig),
        EBadSig,
    );
    e.pending = option::none();
    p
}

fun finish_resolve<T>(e: &mut Explorer<T>, p: Pending, kind: u8) {
    bitmap::insert(&mut e.visited, p.x, p.y);
    event::emit(TileResolved {
        game_id: e.game_id,
        explorer_id: object::id(e),
        x: p.x,
        y: p.y,
        kind,
    });
}

/// MD13 split: floor(stake / 2) to the well fund now; the rest to the pot while the
/// game is live, or to the well fund once it has ended. Returns the well-fund share.
fun freeze_explorer<T>(g: &mut Game<T>, e: &mut Explorer<T>, overdue: bool, clock: &Clock): Balance<T> {
    let mut stake = e.stake.withdraw_all();
    let total = stake.value();
    let well = total / 2;
    let mut to_well = stake.split(well);
    let to_pot = total - well;
    let (to_well_value, to_pot_value) = if (is_ended(g, clock)) {
        to_well.join(stake);
        (total, 0)
    } else {
        g.pot.join(stake);
        (well, to_pot)
    };
    e.status = FROZEN;
    event::emit(ExplorerFrozen {
        game_id: e.game_id,
        explorer_id: object::id(e),
        to_well: to_well_value,
        to_pot: to_pot_value,
        overdue,
    });
    to_well
}

/// Removes the highest-numbered prize still held (unwon prizes come back last rank first).
fun take_top_prize<T, P: key + store>(g: &mut Game<T>): P {
    let rank = (g.finders.length() as u8) + g.prizes_held;
    let prize: P = dof::remove(&mut g.id, PrizeKey { rank });
    g.prizes_held = g.prizes_held - 1;
    event::emit(PrizeReclaimed { game_id: g.id.to_inner(), prize_id: object::id(&prize), rank });
    prize
}

fun pay<T>(b: Balance<T>, to: address, ctx: &mut TxContext) {
    if (b.value() == 0) b.destroy_zero()
    else transfer::public_transfer(coin::from_balance(b, ctx), to);
}

// =====================================================================
// Test helpers
// =====================================================================

#[test_only]
public fun destroy_for_testing<T>(g: Game<T>) {
    std::unit_test::destroy(g);
}

/// Places drifts directly, so a test can stand a yeti next to one.
#[test_only]
public fun set_drifts_for_testing<T>(g: &mut Game<T>, drifts: vector<u16>, until_ms: u64) {
    g.drifts = drifts;
    g.drift_until = until_ms;
}

#[test_only]
public fun destroy_explorer_for_testing<T>(e: Explorer<T>) {
    std::unit_test::destroy(e);
}

#[test_only]
public fun destroy_cap_for_testing(cap: HostCap) {
    let HostCap { id, .. } = cap;
    id.delete();
}
