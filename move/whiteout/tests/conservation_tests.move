/// AC21: random op sequences hold the conservation invariant of spec section 10.
///
///   stakes paid in = stakes held by Explorers + pot + paid to the well fund
///                    + paid to the finder + withdrawn by survivors
///
/// The spec asks for 10 000 sequences in CI. `SEQUENCES` is kept small so the
/// default `sui move test` run stays quick; raise it for the release gate.
#[test_only, allow(deprecated_usage)]
module whiteout::conservation_tests;

use std::unit_test::destroy;
use sui::balance::Balance;
use sui::sui::SUI;
use whiteout::fixtures;
use whiteout::game::{Self, Game, Explorer};
use whiteout::test_env::{Self as t, Env, Prize};
use whiteout::tiles;

const SEQUENCES: u64 = 40;
const OPS_PER_SEQUENCE: u64 = 250;
const PLAYERS: u64 = 4;

public struct Rng has drop { state: u64 }

fun next(r: &mut Rng): u64 {
    // 64-bit LCG (Knuth MMIX constants), wrapping.
    r.state = ((r.state as u128) * 6364136223846793005 + 1442695040888963407 & 0xFFFF_FFFF_FFFF_FFFF) as u64;
    r.state >> 33
}

fun below(r: &mut Rng, n: u64): u64 { next(r) % n }

public struct Ledger has drop {
    paid_in: u64,
    to_well: u64,
    to_finder: u64,
    withdrawn: u64,
}

fun player(i: u64): address { sui::address::from_u256((0x100 + i) as u256) }

fun live(g: &Game<SUI>, env: &Env, margin: u64): bool {
    g.status() == game::status_open() && env.now() + margin < g.ends_at()
}

fun check(g: &Game<SUI>, xs: &vector<Explorer<SUI>>, l: &Ledger) {
    let mut held = 0;
    xs.do_ref!(|e| held = held + e.stake_value());
    assert!(l.paid_in == held + g.pot_value() + l.to_well + l.to_finder + l.withdrawn);
}

fun take(b: Balance<SUI>): u64 {
    let v = b.value();
    destroy(b);
    v
}

/// Resolves explorer `i`'s pending tile the way a client would.
fun resolve_any(env: &mut Env, g: &mut Game<SUI>, xs: &mut vector<Explorer<SUI>>, i: u64, l: &mut Ledger) {
    let e = &mut xs[i];
    let (px, py, _) = e.pending();
    let kind = fixtures::kind(px, py);
    if (kind == tiles::crevasse() && e.ropes() == 0) {
        let ctx = env.ctx(e.owner());
        let w = game::resolve_fatal_internal(g, e, fixtures::sig(px, py), env.clock(), &ctx);
        l.to_well = l.to_well + take(w);
    } else if (kind == tiles::relic() && live(g, env, 0)) {
        let ctx = env.ctx(e.owner());
        let (prize, payout) = game::claim_relic_internal<SUI, Prize>(
            g,
            e,
            fixtures::sig(px, py),
            env.clock(),
            &ctx,
        );
        destroy(prize);
        l.to_finder = l.to_finder + take(payout);
    } else {
        env.resolve(g, e);
    }
}

fun run_sequence(seed: u64) {
    let mut r = Rng { state: seed };
    let stake = below(&mut r, 1_000);
    let (mut g, cap, mut env) = t::open_game(stake, PLAYERS as u16);
    let mut l = Ledger { paid_in: 0, to_well: 0, to_finder: 0, withdrawn: 0 };

    // Player 0 starts under the relic's column; the rest start anywhere.
    let mut xs = vector[];
    PLAYERS.do!(|i| {
        let column = if (i == 0) 5 else (below(&mut r, 24) as u8);
        xs.push_back(env.join(&mut g, player(i), column));
        l.paid_in = l.paid_in + stake;
    });
    check(&g, &xs, &l);

    OPS_PER_SEQUENCE.do!(|_| {
        let i = below(&mut r, PLAYERS);
        let op = below(&mut r, 100);
        if (op < 55) {
            // Step, if legal. Player 0 mostly heads north.
            let e = &mut xs[i];
            let dir = if (i == 0 && below(&mut r, 3) > 0) t::n() else (below(&mut r, 4) as u8);
            let ok_dir = (dir == t::n() && e.y() < 23) || (dir == t::e() && e.x() < 23) ||
                (dir == t::s() && e.y() > 0) || (dir == t::w() && e.x() > 0);
            if (e.is_active() && !e.has_pending() && ok_dir && live(&g, &env, 8_000)) {
                env.step(&g, e, dir);
            }
        } else if (op < 80) {
            if ((&xs[i]).is_active() && (&xs[i]).has_pending()) {
                resolve_any(&mut env, &mut g, &mut xs, i, &mut l);
            }
        } else if (op < 88) {
            let e = &mut xs[i];
            if (e.is_active() && e.has_pending()) {
                let (_, _, deadline) = e.pending();
                if (env.now() > deadline) {
                    let w = game::freeze_overdue_internal(&mut g, e, env.clock());
                    l.to_well = l.to_well + take(w);
                }
            }
        } else if (op < 96) {
            let jump = below(&mut r, 400_000);
            env.advance(jump);
        } else {
            if (g.status() == game::status_open() && env.now() >= g.ends_at()) {
                let w = game::finalize_unclaimed_internal(&mut g, env.clock());
                l.to_well = l.to_well + take(w);
            };
            let e = &mut xs[i];
            if (game::is_ended(&g, env.clock()) && e.is_active() && !e.has_pending()) {
                let ctx = env.ctx(e.owner());
                let s = game::withdraw_stake_internal(&g, e, env.clock(), &ctx);
                l.withdrawn = l.withdrawn + take(s);
            }
        };
        check(&g, &xs, &l);
    });

    // Settle everything: end the game, clear pendings, finalise, withdraw.
    if (!game::is_ended(&g, env.clock())) {
        let end = g.ends_at();
        env.set_time(end);
    };
    env.advance(t::window() + 1);
    PLAYERS.do!(|i| {
        if ((&xs[i]).is_active() && (&xs[i]).has_pending()) {
            if (below(&mut r, 2) == 0) {
                resolve_any(&mut env, &mut g, &mut xs, i, &mut l);
            } else {
                let w = game::freeze_overdue_internal(&mut g, &mut xs[i], env.clock());
                l.to_well = l.to_well + take(w);
            }
        };
        check(&g, &xs, &l);
    });
    if (g.status() == game::status_open()) {
        let w = game::finalize_unclaimed_internal(&mut g, env.clock());
        l.to_well = l.to_well + take(w);
    };
    PLAYERS.do!(|i| {
        let e = &mut xs[i];
        if (e.is_active()) {
            let ctx = env.ctx(e.owner());
            let s = game::withdraw_stake_internal(&g, e, env.clock(), &ctx);
            l.withdrawn = l.withdrawn + take(s);
        };
    });

    // Fully settled: nothing left in the game or in any Explorer.
    check(&g, &xs, &l);
    assert!(g.pot_value() == 0);
    xs.do_ref!(|e| assert!(e.stake_value() == 0 && !e.has_pending()));
    // No Explorer ever has two outcomes: each ends exactly one way.
    let mut finders = 0;
    xs.do_ref!(|e| {
        let st = e.explorer_status();
        assert!(
            st == game::explorer_frozen() || st == game::explorer_withdrawn() ||
                st == game::explorer_finder(),
        );
        if (st == game::explorer_finder()) finders = finders + 1;
    });
    assert!(finders <= 1);
    assert!((finders == 1) == (g.status() == game::status_ended_found()));

    destroy(xs);
    env.cleanup(g, cap);
}

#[test]
fun ac21_conservation_holds_over_random_sequences() {
    SEQUENCES.do!(|s| run_sequence(s * 7919 + 1));
}

#[test]
fun lane_walker_can_claim() {
    // A deterministic sequence through the relic, so the finder branch of the
    // invariant is always exercised at least once.
    let (mut g, cap, mut env) = t::open_game(25, 4);
    let mut l = Ledger { paid_in: 0, to_well: 0, to_finder: 0, withdrawn: 0 };
    let mut xs = vector[];
    xs.push_back(env.join(&mut g, player(0), 5));
    xs.push_back(env.join(&mut g, player(1), 6));
    l.paid_in = 50;
    env.step(&g, &mut xs[1], t::n()); // (6, 1): crevasse
    resolve_any(&mut env, &mut g, &mut xs, 1, &mut l);
    check(&g, &xs, &l);
    env.walk_to_relic(&g, &mut xs[0]);
    resolve_any(&mut env, &mut g, &mut xs, 0, &mut l);
    check(&g, &xs, &l);
    assert!(l.to_finder == 25 + 13 && l.to_well == 12);
    destroy(xs);
    env.cleanup(g, cap);
}
