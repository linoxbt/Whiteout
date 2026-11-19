/// Phase 2 acceptance tests (spec section 16): multi-prize payouts conserve value,
/// gating rejects non-holders, and blizzards never make the map unsolvable.
#[test_only, allow(deprecated_usage)]
module whiteout::phase2_tests;

use std::unit_test::destroy;
use sui::balance;
use sui::random;
use sui::sui::SUI;
use whiteout::allowlist;
use whiteout::fixtures;
use whiteout::game;
use whiteout::test_env::{Self as t, Prize};
use whiteout::tiles;

const NO_BLIZZARD: u64 = 0;
const EVERY: u64 = 600_000;
const LASTS: u64 = 120_000;

// =====================================================================
// Ranked lobbies
// =====================================================================

#[test]
fun ranked_lobby_accepts_one_to_three_relics() {
    let (g, cap, env) = t::ranked_lobby(0, 8, 3, vector[6000, 2500, 1500], EVERY, LASTS);
    assert!(g.relics() == 3 && g.pot_shares() == vector[6000, 2500, 1500]);
    env.cleanup(g, cap);
}

#[test, expected_failure(abort_code = 1, location = whiteout::game)]
fun four_relics_abort() {
    let (_g, _cap, _env) = t::ranked_lobby(0, 8, 4, vector[2500, 2500, 2500, 2500], 0, 0);
    abort
}

#[test, expected_failure(abort_code = 1, location = whiteout::game)]
fun shares_must_sum_to_10000() {
    let (_g, _cap, _env) = t::ranked_lobby(0, 8, 2, vector[6000, 3000], 0, 0);
    abort
}

#[test, expected_failure(abort_code = 1, location = whiteout::game)]
fun one_share_per_relic() {
    let (_g, _cap, _env) = t::ranked_lobby(0, 8, 2, vector[10000], 0, 0);
    abort
}

#[test, expected_failure(abort_code = 1, location = whiteout::game)]
fun blizzard_longer_than_15_minutes_aborts() {
    let (_g, _cap, _env) = t::ranked_lobby(0, 8, 1, vector[10000], 3_600_000, 900_001);
    abort
}

#[test, expected_failure(abort_code = 1, location = whiteout::game)]
fun blizzard_longer_than_a_third_of_the_interval_aborts() {
    let (_g, _cap, _env) = t::ranked_lobby(0, 8, 1, vector[10000], 600_000, 200_001);
    abort
}

#[test, expected_failure(abort_code = 4, location = whiteout::game)]
fun one_prize_per_relic() {
    let (mut g, cap, mut env) = t::ranked_lobby(0, 8, 2, vector[5000, 5000], 0, 0);
    3u64.do!(|_| {
        let p = env.new_prize();
        game::deposit_prize(&mut g, &cap, p);
    });
    abort
}

#[test, expected_failure(abort_code = 5, location = whiteout::game)]
fun deal_needs_every_prize() {
    let (mut g, cap, mut env) = t::ranked_lobby(0, 8, 2, vector[5000, 5000], 0, 0);
    let p = env.new_prize();
    game::deposit_prize(&mut g, &cap, p);
    env.deal_enclave(&mut g, &cap, fixtures::deal_sig_for(2));
    abort
}

#[test, expected_failure(abort_code = 11, location = whiteout::game)]
fun deal_signed_for_a_different_relic_count_aborts() {
    let (mut g, cap, mut env) = t::ranked_lobby(0, 8, 2, vector[5000, 5000], 0, 0);
    2u64.do!(|_| {
        let p = env.new_prize();
        game::deposit_prize(&mut g, &cap, p);
    });
    // The dealer signed a one-relic deal; the game has two prizes.
    env.deal_enclave(&mut g, &cap, fixtures::deal_sig());
    abort
}

// =====================================================================
// Ranked claims
// =====================================================================

/// Bob freezes on (6, 1): 50 to the well, 50 to the pot. Three finders then take
/// 25, 15 and 10 (shares 50/30/20), each with their prize and stake. Every unit of
/// the 400 paid in is accounted for, and the game ends with the third claim.
#[test]
fun three_ranked_finders_split_the_pot_and_conserve_value() {
    let (mut g, cap, mut env) = t::open_ranked(100, 8, 3, vector[5000, 3000, 2000], 0, 0);
    let mut b = env.join(&mut g, t::bob(), 6);
    env.step(&g, &mut b, t::n());
    let ctx = env.ctx(t::bob());
    let well = game::resolve_fatal_internal(&mut g, &mut b, fixtures::sig(6, 1), env.clock(), &ctx);
    assert!(well.value() == 50 && g.pot_value() == 50);

    // Rank 1: Alice up column 5.
    let mut a = env.join(&mut g, t::alice(), 5);
    env.walk_to_relic(&g, &mut a);
    assert!(g.pot_share(1) == 25);
    let ctx = env.ctx(t::alice());
    let (p1, s1) = game::claim_relic_internal<SUI, Prize>(&mut g, &mut a, fixtures::sig(5, 12), env.clock(), &ctx);
    assert!(s1.value() == 100 + 25);
    assert!(g.status() == game::status_open() && g.finders() == vector[t::alice()]);

    // Rank 2: Carol up column 2 to (2, 13).
    let mut c = env.join(&mut g, t::carol(), 2);
    env.walk_north(&g, &mut c, 12);
    env.step(&g, &mut c, t::n());
    let ctx = env.ctx(t::carol());
    let (p2, s2) = game::claim_relic_internal<SUI, Prize>(&mut g, &mut c, fixtures::sig(2, 13), env.clock(), &ctx);
    assert!(s2.value() == 100 + 15);

    // Rank 3: Dave up column 20 to (20, 16) takes the rest and ends the game.
    let mut d = env.join(&mut g, t::dave(), 20);
    env.walk_north(&g, &mut d, 15);
    env.step(&g, &mut d, t::n());
    let ctx = env.ctx(t::dave());
    let (p3, s3) = game::claim_relic_internal<SUI, Prize>(&mut g, &mut d, fixtures::sig(20, 16), env.clock(), &ctx);
    assert!(s3.value() == 100 + 10);

    assert!(g.status() == game::status_ended_found());
    assert!(g.finders() == vector[t::alice(), t::carol(), t::dave()]);
    assert!(g.claimed() == vector[tiles::index(5, 12), tiles::index(2, 13), tiles::index(20, 16)]);
    assert!(g.finder() == option::some(t::alice()));
    assert!(g.pot_value() == 0 && !g.has_prize() && g.prizes_held() == 0);
    // Conservation: 4 stakes of 100 in, all paid out.
    assert!(well.value() + s1.value() + s2.value() + s3.value() == 400);
    // Prizes went out in rank order (deposited first = rank 1).
    assert!(object::id(&p1) != object::id(&p2) && object::id(&p2) != object::id(&p3));

    destroy(p1);
    destroy(p2);
    destroy(p3);
    balance::destroy_for_testing(well);
    balance::destroy_for_testing(s1);
    balance::destroy_for_testing(s2);
    balance::destroy_for_testing(s3);
    destroy(a);
    destroy(b);
    destroy(c);
    destroy(d);
    env.cleanup(g, cap);
}

#[test, expected_failure(abort_code = 26, location = whiteout::game)]
fun a_claimed_relic_cannot_be_claimed_again() {
    let (mut g, _cap, mut env) = t::open_ranked(0, 8, 2, vector[5000, 5000], 0, 0);
    let mut a = env.join(&mut g, t::alice(), 5);
    let mut b = env.join(&mut g, t::bob(), 5);
    env.walk_to_relic(&g, &mut a);
    let ctx = env.ctx(t::alice());
    let (_p, _s) = game::claim_relic_internal<SUI, Prize>(&mut g, &mut a, fixtures::sig(5, 12), env.clock(), &ctx);
    env.walk_to_relic(&g, &mut b);
    let ctx = env.ctx(t::bob());
    let (_p2, _s2) = game::claim_relic_internal<SUI, Prize>(&mut g, &mut b, fixtures::sig(5, 12), env.clock(), &ctx);
    abort
}

#[test]
fun a_claimed_relic_is_ground_to_stand_on() {
    let (mut g, cap, mut env) = t::open_ranked(0, 8, 2, vector[5000, 5000], 0, 0);
    let mut a = env.join(&mut g, t::alice(), 5);
    let mut b = env.join(&mut g, t::bob(), 5);
    env.walk_to_relic(&g, &mut a);
    let ctx = env.ctx(t::alice());
    let (p, s) = game::claim_relic_internal<SUI, Prize>(&mut g, &mut a, fixtures::sig(5, 12), env.clock(), &ctx);
    env.walk_to_relic(&g, &mut b);
    env.resolve(&g, &mut b);
    assert!(b.is_active() && !b.has_pending() && b.y() == 12);
    destroy(p);
    balance::destroy_for_testing(s);
    destroy(a);
    destroy(b);
    env.cleanup(g, cap);
}

#[test, expected_failure(abort_code = 12, location = whiteout::game)]
fun an_unclaimed_relic_still_needs_a_claim() {
    let (mut g, _cap, mut env) = t::open_ranked(0, 8, 2, vector[5000, 5000], 0, 0);
    let mut a = env.join(&mut g, t::alice(), 5);
    env.walk_to_relic(&g, &mut a);
    env.resolve(&g, &mut a);
    abort
}

/// One of two relics found: settlement sends the rest of the pot to the well and
/// the host takes back the second prize. The game counts as found.
#[test]
fun partial_find_settles_and_returns_the_unwon_prize() {
    let (mut g, cap, mut env) = t::open_ranked(100, 8, 2, vector[7000, 3000], 0, 0);
    let mut b = env.join(&mut g, t::bob(), 6);
    env.step(&g, &mut b, t::n());
    let ctx = env.ctx(t::bob());
    let w1 = game::resolve_fatal_internal(&mut g, &mut b, fixtures::sig(6, 1), env.clock(), &ctx);
    let mut a = env.join(&mut g, t::alice(), 5);
    env.walk_to_relic(&g, &mut a);
    let ctx = env.ctx(t::alice());
    let (p1, s1) = game::claim_relic_internal<SUI, Prize>(&mut g, &mut a, fixtures::sig(5, 12), env.clock(), &ctx);
    assert!(s1.value() == 100 + 35);
    let end = g.ends_at();
    env.set_time(end);
    let w2 = game::finalize_unclaimed_internal(&mut g, env.clock());
    assert!(w2.value() == 15);
    assert!(g.status() == game::status_ended_found());
    assert!(w1.value() + s1.value() + w2.value() == 200);
    let p2: Prize = game::reclaim_prize(&mut g, &cap);
    assert!(!g.has_prize());
    destroy(p1);
    destroy(p2);
    balance::destroy_for_testing(w1);
    balance::destroy_for_testing(w2);
    balance::destroy_for_testing(s1);
    destroy(a);
    destroy(b);
    env.cleanup(g, cap);
}

#[test, expected_failure(abort_code = 5, location = whiteout::game)]
fun only_unwon_prizes_come_back() {
    let (mut g, cap, mut env) = t::open_ranked(0, 8, 2, vector[5000, 5000], 0, 0);
    let mut a = env.join(&mut g, t::alice(), 5);
    env.walk_to_relic(&g, &mut a);
    let ctx = env.ctx(t::alice());
    let (_p1, _s1) = game::claim_relic_internal<SUI, Prize>(&mut g, &mut a, fixtures::sig(5, 12), env.clock(), &ctx);
    let end = g.ends_at();
    env.set_time(end);
    let w = game::finalize_unclaimed_internal(&mut g, env.clock());
    balance::destroy_for_testing(w);
    let _p2: Prize = game::reclaim_prize(&mut g, &cap);
    let _p3: Prize = game::reclaim_prize(&mut g, &cap);
    abort
}

#[test]
fun cancelling_a_ranked_lobby_returns_every_prize() {
    let (mut g, cap, mut env) = t::ranked_lobby(0, 8, 3, vector[4000, 3000, 3000], 0, 0);
    3u64.do!(|_| {
        let p = env.new_prize();
        game::deposit_prize(&mut g, &cap, p);
    });
    let p3: Prize = game::cancel(&mut g, &cap);
    let p2: Prize = game::reclaim_prize(&mut g, &cap);
    let p1: Prize = game::reclaim_prize(&mut g, &cap);
    assert!(g.status() == game::status_cancelled() && !g.has_prize());
    destroy(p1);
    destroy(p2);
    destroy(p3);
    env.cleanup(g, cap);
}

// =====================================================================
// Gating
// =====================================================================

#[test]
fun members_join_a_gated_game() {
    let (mut g, cap, mut env) = t::ranked_lobby(0, 8, 1, vector[10000], 0, 0);
    let mut ctx = env.ctx(t::host());
    let (mut list, lcap) = allowlist::new(b"Mystic Yeti holders".to_string(), &mut ctx);
    allowlist::add(&mut list, &lcap, vector[t::alice(), t::carol(), t::alice()]);
    assert!(list.size() == 2 && list.contains(t::alice()) && !list.contains(t::bob()));
    game::set_allowlist(&mut g, &cap, &list);
    let p = env.new_prize();
    game::deposit_prize(&mut g, &cap, p);
    env.deal_enclave(&mut g, &cap, fixtures::deal_sig());
    assert!(g.allowlist() == option::some(object::id(&list)));

    let mut ctx = env.ctx(t::alice());
    let coin = sui::coin::mint_for_testing<SUI>(0, &mut ctx);
    let a = game::join_gated_internal(&mut g, &list, coin, 5, env.clock(), &mut ctx);
    assert!(a.owner() == t::alice());

    allowlist::remove(&mut list, &lcap, vector[t::carol(), t::bob()]);
    assert!(list.size() == 1 && !list.contains(t::carol()));
    destroy(a);
    allowlist::destroy_for_testing(list, lcap);
    env.cleanup(g, cap);
}

#[test, expected_failure(abort_code = 25, location = whiteout::game)]
fun gating_rejects_non_holders() {
    let (mut g, cap, mut env) = t::ranked_lobby(0, 8, 1, vector[10000], 0, 0);
    let mut ctx = env.ctx(t::host());
    let (mut list, lcap) = allowlist::new(b"holders".to_string(), &mut ctx);
    allowlist::add(&mut list, &lcap, vector[t::alice()]);
    game::set_allowlist(&mut g, &cap, &list);
    let p = env.new_prize();
    game::deposit_prize(&mut g, &cap, p);
    env.deal_enclave(&mut g, &cap, fixtures::deal_sig());
    let mut ctx = env.ctx(t::bob());
    let coin = sui::coin::mint_for_testing<SUI>(0, &mut ctx);
    let _b = game::join_gated_internal(&mut g, &list, coin, 5, env.clock(), &mut ctx);
    abort
}

#[test, expected_failure(abort_code = 24, location = whiteout::game)]
fun a_gated_game_refuses_the_open_door() {
    let (mut g, cap, mut env) = t::ranked_lobby(0, 8, 1, vector[10000], 0, 0);
    let mut ctx = env.ctx(t::host());
    let (mut list, lcap) = allowlist::new(b"holders".to_string(), &mut ctx);
    allowlist::add(&mut list, &lcap, vector[t::alice()]);
    game::set_allowlist(&mut g, &cap, &list);
    let p = env.new_prize();
    game::deposit_prize(&mut g, &cap, p);
    env.deal_enclave(&mut g, &cap, fixtures::deal_sig());
    let _a = env.join(&mut g, t::alice(), 5);
    abort
}

#[test, expected_failure(abort_code = 24, location = whiteout::game)]
fun another_list_does_not_open_a_gated_game() {
    let (mut g, cap, mut env) = t::ranked_lobby(0, 8, 1, vector[10000], 0, 0);
    let mut ctx = env.ctx(t::host());
    let (list, _lcap) = allowlist::new(b"holders".to_string(), &mut ctx);
    let (mut other, ocap) = allowlist::new(b"anyone".to_string(), &mut ctx);
    allowlist::add(&mut other, &ocap, vector[t::bob()]);
    game::set_allowlist(&mut g, &cap, &list);
    let p = env.new_prize();
    game::deposit_prize(&mut g, &cap, p);
    env.deal_enclave(&mut g, &cap, fixtures::deal_sig());
    let mut ctx = env.ctx(t::bob());
    let coin = sui::coin::mint_for_testing<SUI>(0, &mut ctx);
    let _b = game::join_gated_internal(&mut g, &other, coin, 5, env.clock(), &mut ctx);
    abort
}

#[test, expected_failure(abort_code = 24, location = whiteout::game)]
fun an_ungated_game_has_no_gated_door() {
    let (mut g, _cap, mut env) = t::open_game(0, 8);
    let mut ctx = env.ctx(t::host());
    let (list, _lcap) = allowlist::new(b"holders".to_string(), &mut ctx);
    let mut ctx = env.ctx(t::alice());
    let coin = sui::coin::mint_for_testing<SUI>(0, &mut ctx);
    let _a = game::join_gated_internal(&mut g, &list, coin, 5, env.clock(), &mut ctx);
    abort
}

#[test, expected_failure(abort_code = 2, location = whiteout::game)]
fun the_gate_cannot_change_once_the_game_opens() {
    let (mut g, cap, mut env) = t::open_game(0, 8);
    let mut ctx = env.ctx(t::host());
    let (list, _lcap) = allowlist::new(b"holders".to_string(), &mut ctx);
    game::set_allowlist(&mut g, &cap, &list);
    abort
}

#[test, expected_failure(abort_code = 29, location = whiteout::allowlist)]
fun only_the_lists_cap_edits_it() {
    let mut ctx = tx_context::dummy();
    let (mut list, _cap) = allowlist::new(b"a".to_string(), &mut ctx);
    let (_other, other_cap) = allowlist::new(b"b".to_string(), &mut ctx);
    allowlist::add(&mut list, &other_cap, vector[@0x1]);
    abort
}

// =====================================================================
// Blizzards
// =====================================================================

#[test, expected_failure(abort_code = 28, location = whiteout::game)]
fun no_blizzard_before_it_is_due() {
    let (mut g, _cap, mut env) = t::open_ranked(0, 8, 1, vector[10000], EVERY, LASTS);
    env.advance(EVERY - 1);
    let mut gen = random::new_generator_from_seed_for_testing(b"early");
    game::blizzard_internal(&mut g, &mut gen, env.clock());
    abort
}

#[test, expected_failure(abort_code = 28, location = whiteout::game)]
fun no_blizzard_when_they_are_off() {
    let (mut g, _cap, mut env) = t::open_ranked(0, 8, 1, vector[10000], NO_BLIZZARD, 0);
    env.advance(EVERY);
    let mut gen = random::new_generator_from_seed_for_testing(b"off");
    game::blizzard_internal(&mut g, &mut gen, env.clock());
    abort
}

#[test, expected_failure(abort_code = 14, location = whiteout::game)]
fun no_blizzard_after_the_end() {
    let (mut g, _cap, mut env) = t::open_ranked(0, 8, 1, vector[10000], EVERY, LASTS);
    let end = g.ends_at();
    env.set_time(end);
    let mut gen = random::new_generator_from_seed_for_testing(b"late");
    game::blizzard_internal(&mut g, &mut gen, env.clock());
    abort
}

/// Blizzards never make the map unsolvable: across many seeds, drifts are 12
/// distinct tiles, never on base camp, at most 8 in a row (no row is walled off),
/// they melt after the blizzard, and no yeti is moved.
#[test]
fun blizzards_stay_inside_their_bounds() {
    let (mut g, cap, mut env) = t::open_ranked(0, 8, 1, vector[10000], EVERY, LASTS);
    let mut a = env.join(&mut g, t::alice(), 9);
    env.walk_north(&g, &mut a, 3);
    let open_at = g.open_at();
    let mut i = 0u64;
    while (i < 40) {
        let due = g.next_blizzard_at();
        env.set_time(due);
        let mut seed = b"whiteout";
        seed.append(sui::bcs::to_bytes(&i));
        let mut gen = random::new_generator_from_seed_for_testing(seed);
        game::blizzard_internal(&mut g, &mut gen, env.clock());

        let drifts = g.drifts();
        assert!(drifts.length() == 12);
        let mut rows = vector[];
        24u64.do!(|_| rows.push_back(0u64));
        let mut j = 0;
        while (j < drifts.length()) {
            let tile = drifts[j];
            let y = ((tile / 24) as u64);
            assert!(y >= 1 && y < 24);
            let mut k = j + 1;
            while (k < drifts.length()) {
                assert!(drifts[k] != tile);
                k = k + 1;
            };
            let n = rows[y] + 1;
            *vector::borrow_mut(&mut rows, y) = n;
            assert!(n <= 8);
            j = j + 1;
        };
        assert!(g.drift_until() == due + LASTS);
        // The rhythm holds: the next blizzard is one interval on.
        assert!(g.next_blizzard_at() == due + EVERY && (g.next_blizzard_at() - open_at) % EVERY == 0);
        // Nobody moved.
        assert!(a.x() == 9 && a.y() == 3);
        // Every drift has melted when the blizzard ends.
        let melt = g.drift_until();
        let mut m = 0;
        while (m < drifts.length()) {
            let tile = drifts[m];
            assert!(!g.drift_at(((tile % 24) as u8), ((tile / 24) as u8), melt));
            m = m + 1;
        };
        // Stop before the hunt itself ends.
        if (g.next_blizzard_at() >= g.ends_at()) break;
        i = i + 1;
    };
    destroy(a);
    env.cleanup(g, cap);
}

#[test, expected_failure(abort_code = 27, location = whiteout::game)]
fun a_drift_blocks_the_step() {
    let (mut g, _cap, mut env) = t::open_ranked(0, 8, 1, vector[10000], EVERY, LASTS);
    let mut a = env.join(&mut g, t::alice(), 9);
    let until = env.now() + 60_000;
    game::set_drifts_for_testing(&mut g, vector[tiles::index(9, 1)], until);
    env.step(&g, &mut a, t::n());
    abort
}

#[test]
fun a_melted_drift_lets_you_through() {
    let (mut g, cap, mut env) = t::open_ranked(0, 8, 1, vector[10000], EVERY, LASTS);
    let mut a = env.join(&mut g, t::alice(), 9);
    let until = env.now() + 60_000;
    game::set_drifts_for_testing(&mut g, vector[tiles::index(9, 1)], until);
    // Sideways is fine while the drift stands.
    env.walk(&g, &mut a, t::e());
    env.set_time(until);
    env.walk(&g, &mut a, t::w());
    env.walk(&g, &mut a, t::n());
    assert!(a.x() == 9 && a.y() == 1);
    destroy(a);
    env.cleanup(g, cap);
}
