/// Test harness. `Env` owns the clock and hands out a fresh `TxContext` per
/// action, so object IDs never collide and the sender is explicit.
#[test_only, allow(deprecated_usage)]
module whiteout::test_env;

use enclave::enclave;
use sui::clock::{Self, Clock};
use sui::coin;
use sui::sui::SUI;
use whiteout::dealer::{Self, DEALER};
use whiteout::fixtures;
use whiteout::game::{Self, Game, Explorer, HostCap};

const HOST: address = @0xA0;
const WELL: address = @0xB0;
const ALICE: address = @0xA1;
const BOB: address = @0xB2;
const CAROL: address = @0xC3;

/// Wall-clock time at which the test game opens.
const T0: u64 = 1_000_000;
const TWO_HOURS: u64 = 7_200_000;
const WINDOW: u64 = 300_000;

// Directions.
const N: u8 = 0;
const E: u8 = 1;
const S: u8 = 2;
const W: u8 = 3;

public struct Prize has key, store { id: UID }

public struct Env {
    nonce: u64,
    clock: Clock,
}

public fun host(): address { HOST }

public fun well(): address { WELL }

public fun alice(): address { ALICE }

public fun bob(): address { BOB }

public fun carol(): address { CAROL }

public fun t0(): u64 { T0 }

public fun duration(): u64 { TWO_HOURS }

public fun window(): u64 { WINDOW }

public fun n(): u8 { N }

public fun e(): u8 { E }

public fun s(): u8 { S }

public fun w(): u8 { W }

/// The context in which the fixture game's UID is derived (see gen_fixtures.py).
public fun host_ctx(): TxContext {
    tx_context::new(HOST, fixtures::tx_hash(), 0, 0, 0)
}

/// A LOBBY game with the fixture ID. Asserts the ID matches the fixtures.
public fun lobby(entry_stake: u64, max_players: u16): (Game<SUI>, HostCap, Env) {
    let mut ctx = host_ctx();
    let (g, cap) = game::new_lobby<SUI>(entry_stake, max_players, TWO_HOURS, WINDOW, WELL, &mut ctx);
    assert!(object::id(&g) == fixtures::game_id());
    let mut clock = clock::create_for_testing(&mut ctx);
    // The test clock never moves backwards within one test, so a second game
    // in the same test opens at the current time instead of T0.
    clock.set_for_testing(T0.max(clock::borrow().timestamp_ms()));
    (g, cap, Env { nonce: 1000, clock })
}

public fun new_prize(env: &mut Env): Prize {
    let mut ctx = env.ctx(HOST);
    Prize { id: object::new(&mut ctx) }
}

/// An OPEN game dealt by an enclave holding the fixture dealer key.
public fun open_game(entry_stake: u64, max_players: u16): (Game<SUI>, HostCap, Env) {
    let (mut g, cap, mut env) = lobby(entry_stake, max_players);
    let prize = env.new_prize();
    game::deposit_prize(&mut g, &cap, prize);
    env.deal_enclave(&mut g, &cap, fixtures::deal_sig());
    (g, cap, env)
}

public fun deal_enclave(env: &mut Env, g: &mut Game<SUI>, cap: &HostCap, sig: vector<u8>) {
    let mut ctx = env.ctx(HOST);
    let enc = enclave::new_enclave_for_testing<DEALER>(fixtures::dealer_pk(), &mut ctx);
    game::seal_deal_enclave(
        g,
        cap,
        &enc,
        fixtures::deal_ts(),
        fixtures::ct_hash(),
        b"quilt-fixture",
        sig,
        &env.clock,
    );
    enc.destroy();
}

public fun ctx(env: &mut Env, sender: address): TxContext {
    env.nonce = env.nonce + 1;
    tx_context::new(sender, tx_context::dummy_tx_hash_with_hint(env.nonce), 0, 0, 0)
}

public fun clock(env: &Env): &Clock { &env.clock }

public fun now(env: &Env): u64 { env.clock.timestamp_ms() }

public fun advance(env: &mut Env, ms: u64) {
    let t = env.clock.timestamp_ms() + ms;
    env.clock.set_for_testing(t);
}

public fun set_time(env: &mut Env, ms: u64) {
    env.clock.set_for_testing(ms);
}

/// Joins as `who` at `column`, paying the game's exact stake.
public fun join(env: &mut Env, g: &mut Game<SUI>, who: address, column: u8): Explorer<SUI> {
    let stake = g.entry_stake();
    env.join_paying(g, who, column, stake)
}

public fun join_paying(
    env: &mut Env,
    g: &mut Game<SUI>,
    who: address,
    column: u8,
    amount: u64,
): Explorer<SUI> {
    let mut ctx = env.ctx(who);
    let coin = coin::mint_for_testing<SUI>(amount, &mut ctx);
    game::join_internal(g, coin, column, &env.clock, &mut ctx)
}

/// Steps after waiting out the cooldown.
public fun step(env: &mut Env, g: &Game<SUI>, x: &mut Explorer<SUI>, dir: u8) {
    env.advance(8_000);
    let ctx = env.ctx(x.owner());
    game::step(g, x, dir, &env.clock, &ctx);
}

/// Resolves the pending tile with its true kind and signature (non-fatal kinds).
public fun resolve(env: &mut Env, g: &Game<SUI>, x: &mut Explorer<SUI>) {
    let (px, py, _) = x.pending();
    let ctx = env.ctx(x.owner());
    game::resolve(g, x, fixtures::kind(px, py), fixtures::sig(px, py), &env.clock, &ctx);
}

/// Step, then resolve if the step created a pending tile.
public fun walk(env: &mut Env, g: &Game<SUI>, x: &mut Explorer<SUI>, dir: u8) {
    env.step(g, x, dir);
    if (x.has_pending()) env.resolve(g, x);
}

/// From (5, 0): up column 5 through goggles, rope and a bridged crevasse to stand
/// on the relic at (5, 12) with it pending.
public fun walk_to_relic(env: &mut Env, g: &Game<SUI>, x: &mut Explorer<SUI>) {
    assert!(x.x() == 5 && x.y() == 0);
    11u64.do!(|_| env.walk(g, x, N));
    env.step(g, x, N);
    assert!(x.y() == 12 && x.has_pending());
}

public fun destroy(env: Env) {
    let Env { nonce: _, clock } = env;
    clock.destroy_for_testing();
}

public fun cleanup(env: Env, g: Game<SUI>, cap: HostCap) {
    env.destroy();
    game::destroy_for_testing(g);
    game::destroy_cap_for_testing(cap);
}

public fun dealer_witness(): DEALER { dealer::witness_for_testing() }
