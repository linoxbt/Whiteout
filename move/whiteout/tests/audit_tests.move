/// Regression tests for the findings of the November 2026 audit.
#[test_only, allow(deprecated_usage)]
module whiteout::audit_tests;

use enclave::enclave;
use std::unit_test::destroy;
use sui::balance;
use sui::random;
use sui::sui::SUI;
use whiteout::allowlist;
use whiteout::dealer::{Self, DEALER};
use whiteout::fixtures;
use whiteout::game;
use whiteout::test_env::{Self as t, Prize};

const EVERY: u64 = 600_000;
const LASTS: u64 = 120_000;

// --- B1: a zero pot share could strand the pot forever --------------------

#[test, expected_failure(abort_code = 1, location = whiteout::game)]
fun a_zero_pot_share_is_refused() {
    let (_g, _cap, _env) = t::ranked_lobby(100, 8, 2, vector[10000, 0], 0, 0);
    abort
}

#[test]
fun the_last_rank_empties_the_pot_even_after_late_freezes() {
    let (mut g, cap, mut env) = t::open_ranked(100, 8, 2, vector[9000, 1000], 0, 0);
    // Rank 1 claims with an empty pot.
    let mut a = env.join(&mut g, t::alice(), 5);
    env.walk_to_relic(&g, &mut a);
    let ctx = env.ctx(t::alice());
    let (p1, s1) = game::claim_relic_internal<SUI, Prize>(&mut g, &mut a, fixtures::sig(5, 12), env.clock(), &ctx);
    assert!(s1.value() == 100);
    // Bob freezes after the first claim: half his stake goes into the pot.
    let mut b = env.join(&mut g, t::bob(), 6);
    env.step(&g, &mut b, t::n());
    let ctx = env.ctx(t::bob());
    let w = game::resolve_fatal_internal(&mut g, &mut b, fixtures::sig(6, 1), env.clock(), &ctx);
    assert!(w.value() == 50 && g.pot_value() == 50);
    // Rank 2 (the last) takes everything that is left.
    let mut c = env.join(&mut g, t::carol(), 2);
    env.walk_north(&g, &mut c, 12);
    env.step(&g, &mut c, t::n());
    let ctx = env.ctx(t::carol());
    let (p2, s2) = game::claim_relic_internal<SUI, Prize>(&mut g, &mut c, fixtures::sig(2, 13), env.clock(), &ctx);
    assert!(s2.value() == 100 + 50);
    assert!(g.status() == game::status_ended_found() && g.pot_value() == 0);
    // Conservation: three stakes in, all paid out.
    assert!(s1.value() + w.value() + s2.value() == 300);
    destroy(p1);
    destroy(p2);
    balance::destroy_for_testing(s1);
    balance::destroy_for_testing(s2);
    balance::destroy_for_testing(w);
    destroy(a);
    destroy(b);
    destroy(c);
    env.cleanup(g, cap);
}

// --- S10: the thaw file is published once ---------------------------------

#[test, expected_failure(abort_code = 2, location = whiteout::game)]
fun the_thaw_cannot_be_replaced() {
    let (mut g, cap, mut env) = t::open_game(0, 8);
    let end = g.ends_at();
    env.set_time(end);
    game::publish_thaw(&mut g, &cap, b"first", env.clock());
    game::publish_thaw(&mut g, &cap, b"second", env.clock());
    abort
}

// --- B19: blizzards melt before the end and never wall a tile in ----------

#[test, expected_failure(abort_code = 28, location = whiteout::game)]
fun no_blizzard_that_would_outlast_the_hunt() {
    let (mut g, _cap, mut env) = t::open_ranked(0, 8, 1, vector[10000], EVERY, LASTS);
    let end = g.ends_at();
    env.set_time(end - LASTS + 1);
    let mut gen = random::new_generator_from_seed_for_testing(b"late");
    game::blizzard_internal(&mut g, &mut gen, env.clock());
    abort
}

#[test]
fun drifts_never_wall_a_tile_in() {
    // Every blizzard of a two-hour hunt (11 of them), each from its own seed.
    {
        let seed_i = 0u64;
        let (mut g, cap, mut env) = t::open_ranked(0, 8, 1, vector[10000], EVERY, LASTS);
        let mut i = 0u64;
        while (g.next_blizzard_at() + LASTS <= g.ends_at()) {
            let due = g.next_blizzard_at();
            env.set_time(due);
            let mut seed = b"walls";
            seed.append(sui::bcs::to_bytes(&seed_i));
            seed.append(sui::bcs::to_bytes(&i));
            let mut gen = random::new_generator_from_seed_for_testing(seed);
            game::blizzard_internal(&mut g, &mut gen, env.clock());
            assert!(g.drift_until() <= g.ends_at());
            let now = env.now();
            // No two drifts touch, and every tile keeps an open neighbour.
            let drifts = g.drifts();
            assert!(drifts.length() == 12);
            let mut j = 0;
            while (j < drifts.length()) {
                let mut k = j + 1;
                while (k < drifts.length()) {
                    let (ax, ay) = (drifts[j] % 24, drifts[j] / 24);
                    let (bx, by) = (drifts[k] % 24, drifts[k] / 24);
                    let dx = if (ax > bx) ax - bx else bx - ax;
                    let dy = if (ay > by) ay - by else by - ay;
                    assert!(dx > 1 || dy > 1);
                    k = k + 1;
                };
                j = j + 1;
            };
            let mut x = 0u8;
            while (x < 24) {
                let mut y = 0u8;
                while (y < 24) {
                    let mut open = 0u8;
                    if (x > 0 && !g.drift_at(x - 1, y, now)) open = open + 1;
                    if (x < 23 && !g.drift_at(x + 1, y, now)) open = open + 1;
                    if (y > 0 && !g.drift_at(x, y - 1, now)) open = open + 1;
                    if (y < 23 && !g.drift_at(x, y + 1, now)) open = open + 1;
                    assert!(open >= 1);
                    y = y + 1;
                };
                x = x + 1;
            };
            i = i + 1;
        };
        assert!(i >= 10);
        env.cleanup(g, cap);
    };
}

// --- S4: only the pinned dealer config, at its current version, may deal ---

#[test, expected_failure(abort_code = 35, location = whiteout::dealer)]
fun an_enclave_from_before_a_pcr_rotation_cannot_deal() {
    let (mut g, cap, mut env) = t::lobby(0, 8);
    let prize = env.new_prize();
    game::deposit_prize(&mut g, &cap, prize);
    let mut ctx = env.ctx(t::host());
    let enc = enclave::new_enclave_for_testing<DEALER>(fixtures::dealer_pk(), &mut ctx);
    let (reg, mut config) = dealer::new_for_testing(&mut ctx);
    dealer::bump_version_for_testing(&reg, &mut config);
    game::seal_deal_enclave(&mut g, &cap, &reg, &config, &enc, fixtures::deal_ts(), fixtures::ct_hash(), b"q", fixtures::deal_sig(), env.clock());
    abort
}

#[test, expected_failure(abort_code = 34, location = whiteout::dealer)]
fun a_second_config_cannot_deal() {
    let (mut g, cap, mut env) = t::lobby(0, 8);
    let prize = env.new_prize();
    game::deposit_prize(&mut g, &cap, prize);
    let mut ctx = env.ctx(t::host());
    let enc = enclave::new_enclave_for_testing<DEALER>(fixtures::dealer_pk(), &mut ctx);
    let (reg, _config) = dealer::new_for_testing(&mut ctx);
    let (_reg2, other) = dealer::new_for_testing(&mut ctx);
    game::seal_deal_enclave(&mut g, &cap, &reg, &other, &enc, fixtures::deal_ts(), fixtures::ct_hash(), b"q", fixtures::deal_sig(), env.clock());
    abort
}

// --- Error codes the audit found untested ----------------------------------

#[test, expected_failure(abort_code = 30, location = whiteout::allowlist)]
fun an_allowlist_batch_over_1000_is_refused() {
    let mut ctx = tx_context::dummy();
    let (mut list, cap) = allowlist::new(b"big".to_string(), &mut ctx);
    let mut members = vector[];
    let mut i = 0u64;
    while (i < 1001) {
        members.push_back(sui::address::from_u256((i as u256) + 1));
        i = i + 1;
    };
    allowlist::add(&mut list, &cap, members);
    abort
}
