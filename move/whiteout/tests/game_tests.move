/// Game lifecycle, movement, resolve and settlement. Test names cite the spec's
/// acceptance criteria (section 20) where one applies.
#[test_only, allow(deprecated_usage)]
module whiteout::game_tests;

use std::unit_test::destroy;
use sui::sui::SUI;
use whiteout::fixtures;
use whiteout::game;
use whiteout::test_env::{Self as t, Prize};
use whiteout::tiles;

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

#[test]
fun game_id_matches_fixture() {
    let (g, cap, env) = t::lobby(0, 4);
    assert!(object::id(&g) == fixtures::game_id());
    assert!(game::cap_game_id(&cap) == fixtures::game_id());
    env.cleanup(g, cap);
}

#[test]
fun fixture_map_lane_is_as_documented() {
    assert!(fixtures::kind(5, 2) == tiles::goggles());
    assert!(fixtures::kind(5, 3) == tiles::rope());
    assert!(fixtures::kind(5, 4) == tiles::crevasse());
    assert!(fixtures::kind(5, 12) == tiles::relic());
    assert!(fixtures::kind(6, 1) == tiles::crevasse());
    let mut x = 0u8;
    while (x < 24) {
        assert!(fixtures::kind(x, 0) == tiles::snow());
        x = x + 1;
    };
}

// ---------------------------------------------------------------------
// AC1: creation limits
// ---------------------------------------------------------------------

#[test]
fun ac1_window_bounds_accepted() {
    let mut ctx = t::host_ctx();
    let (g1, c1) = game::new_lobby<SUI>(0, 1, 3_600_000, 120_000, t::well(), &mut ctx);
    let (g2, c2) = game::new_lobby<SUI>(1 << 56, 128, 259_200_000, 3_600_000, t::well(), &mut ctx);
    destroy(g1);
    destroy(c1);
    destroy(g2);
    destroy(c2);
}

#[test, expected_failure(abort_code = 1, location = whiteout::game)]
fun ac1_window_too_short() {
    let mut ctx = t::host_ctx();
    let (_g, _c) = game::new_lobby<SUI>(0, 4, 7_200_000, 119_999, t::well(), &mut ctx);
    abort
}

#[test, expected_failure(abort_code = 1, location = whiteout::game)]
fun ac1_window_too_long() {
    let mut ctx = t::host_ctx();
    let (_g, _c) = game::new_lobby<SUI>(0, 4, 7_200_000, 3_600_001, t::well(), &mut ctx);
    abort
}

#[test, expected_failure(abort_code = 1, location = whiteout::game)]
fun ac1_too_many_players() {
    let mut ctx = t::host_ctx();
    let (_g, _c) = game::new_lobby<SUI>(0, 129, 7_200_000, 300_000, t::well(), &mut ctx);
    abort
}

#[test, expected_failure(abort_code = 1, location = whiteout::game)]
fun ac1_stake_too_large() {
    let mut ctx = t::host_ctx();
    let (_g, _c) = game::new_lobby<SUI>((1 << 56) + 1, 4, 7_200_000, 300_000, t::well(), &mut ctx);
    abort
}

#[test, expected_failure(abort_code = 1, location = whiteout::game)]
fun ac1_duration_too_short() {
    let mut ctx = t::host_ctx();
    let (_g, _c) = game::new_lobby<SUI>(0, 4, 3_599_999, 300_000, t::well(), &mut ctx);
    abort
}

// ---------------------------------------------------------------------
// AC2: prize and cancel
// ---------------------------------------------------------------------

#[test]
fun ac2_cancel_returns_exact_prize() {
    let (mut g, cap, mut env) = t::lobby(0, 4);
    let prize = env.new_prize();
    let prize_id = object::id(&prize);
    game::deposit_prize(&mut g, &cap, prize);
    let back: Prize = game::cancel(&mut g, &cap);
    assert!(object::id(&back) == prize_id);
    assert!(g.status() == game::status_cancelled());
    destroy(back);
    env.cleanup(g, cap);
}

#[test, expected_failure(abort_code = 4, location = whiteout::game)]
fun ac2_second_prize_aborts() {
    let (mut g, cap, mut env) = t::lobby(0, 4);
    let p1 = env.new_prize();
    let p2 = env.new_prize();
    game::deposit_prize(&mut g, &cap, p1);
    game::deposit_prize(&mut g, &cap, p2);
    abort
}

#[test, expected_failure(abort_code = 3, location = whiteout::game)]
fun wrong_host_cap_aborts() {
    let (mut g, cap, mut env) = t::lobby(0, 4);
    let mut ctx = env.ctx(t::bob());
    let (other, other_cap) = game::new_lobby<SUI>(0, 4, 7_200_000, 300_000, t::well(), &mut ctx);
    let prize = env.new_prize();
    game::deposit_prize(&mut g, &other_cap, prize);
    destroy(other);
    destroy(cap);
    abort
}

// ---------------------------------------------------------------------
// AC3, AC4: deals
// ---------------------------------------------------------------------

#[test]
fun ac3_enclave_deal_opens() {
    let (g, cap, env) = t::open_game(10, 4);
    assert!(g.status() == game::status_open());
    assert!(g.dealer_kind() == game::dealer_enclave());
    assert!(g.enclave_id().is_some());
    assert!(*g.dealer_pk() == fixtures::dealer_pk());
    assert!(*g.ct_hash() == fixtures::ct_hash());
    assert!(g.open_at() == t::t0());
    assert!(g.ends_at() == g.open_at() + t::duration());
    env.cleanup(g, cap);
}

#[test, expected_failure(abort_code = 11, location = whiteout::game)]
fun ac3_deal_signed_for_other_game_aborts() {
    let (mut g, cap, mut env) = t::lobby(10, 4);
    let prize = env.new_prize();
    game::deposit_prize(&mut g, &cap, prize);
    env.deal_enclave(&mut g, &cap, fixtures::deal_sig_other_game());
    abort
}

#[test, expected_failure(abort_code = 5, location = whiteout::game)]
fun deal_without_prize_aborts() {
    let (mut g, cap, mut env) = t::lobby(10, 4);
    env.deal_enclave(&mut g, &cap, fixtures::deal_sig());
    abort
}

#[test, expected_failure(abort_code = 2, location = whiteout::game)]
fun second_deal_aborts() {
    let (mut g, cap, mut env) = t::open_game(10, 4);
    env.deal_enclave(&mut g, &cap, fixtures::deal_sig());
    abort
}

#[test]
fun ceremony_deal_zero_stake_opens() {
    let (mut g, cap, mut env) = t::lobby(0, 4);
    let prize = env.new_prize();
    game::deposit_prize(&mut g, &cap, prize);
    game::seal_deal_ceremony(
        &mut g,
        &cap,
        fixtures::dealer_pk(),
        fixtures::deal_ts(),
        fixtures::ct_hash(),
        b"quilt",
        env.clock(),
    );
    assert!(g.dealer_kind() == game::dealer_ceremony());
    assert!(g.enclave_id().is_none());
    env.cleanup(g, cap);
}

#[test, expected_failure(abort_code = 6, location = whiteout::game)]
fun ac4_ceremony_with_stake_aborts() {
    let (mut g, cap, mut env) = t::lobby(1, 4);
    let prize = env.new_prize();
    game::deposit_prize(&mut g, &cap, prize);
    game::seal_deal_ceremony(
        &mut g,
        &cap,
        fixtures::dealer_pk(),
        fixtures::deal_ts(),
        fixtures::ct_hash(),
        b"quilt",
        env.clock(),
    );
    abort
}

// ---------------------------------------------------------------------
// AC5: join
// ---------------------------------------------------------------------

#[test]
fun join_places_explorer_on_base_camp() {
    let (mut g, cap, mut env) = t::open_game(10, 4);
    let a = env.join(&mut g, t::alice(), 7);
    assert!(a.x() == 7 && a.y() == 0);
    assert!(a.visited(7, 0) && !a.has_pending());
    assert!(a.stake_value() == 10);
    assert!(g.player_count() == 1);
    assert!(g.explorer_of(t::alice()) == option::some(object::id(&a)));
    destroy(a);
    env.cleanup(g, cap);
}

#[test, expected_failure(abort_code = 9, location = whiteout::game)]
fun ac5_stake_minus_one_aborts() {
    let (mut g, _cap, mut env) = t::open_game(10, 4);
    let _a = env.join_paying(&mut g, t::alice(), 0, 9);
    abort
}

#[test, expected_failure(abort_code = 9, location = whiteout::game)]
fun ac5_stake_plus_one_aborts() {
    let (mut g, _cap, mut env) = t::open_game(10, 4);
    let _a = env.join_paying(&mut g, t::alice(), 0, 11);
    abort
}

#[test, expected_failure(abort_code = 9, location = whiteout::game)]
fun ac5_column_off_grid_aborts() {
    let (mut g, _cap, mut env) = t::open_game(10, 4);
    let _a = env.join(&mut g, t::alice(), 24);
    abort
}

#[test, expected_failure(abort_code = 7, location = whiteout::game)]
fun ac5_full_game_aborts() {
    let (mut g, _cap, mut env) = t::open_game(10, 2);
    let _a = env.join(&mut g, t::alice(), 0);
    let _b = env.join(&mut g, t::bob(), 1);
    let _c = env.join(&mut g, t::carol(), 2);
    abort
}

#[test, expected_failure(abort_code = 8, location = whiteout::game)]
fun ac5_second_join_aborts() {
    let (mut g, _cap, mut env) = t::open_game(10, 4);
    let _a = env.join(&mut g, t::alice(), 0);
    let _b = env.join(&mut g, t::alice(), 1);
    abort
}

#[test, expected_failure(abort_code = 2, location = whiteout::game)]
fun join_lobby_aborts() {
    let (mut g, _cap, mut env) = t::lobby(0, 4);
    let _a = env.join(&mut g, t::alice(), 0);
    abort
}

#[test, expected_failure(abort_code = 14, location = whiteout::game)]
fun join_after_end_aborts() {
    let (mut g, _cap, mut env) = t::open_game(0, 4);
    env.advance(t::duration());
    let _a = env.join(&mut g, t::alice(), 0);
    abort
}

// ---------------------------------------------------------------------
// AC6, AC7: movement
// ---------------------------------------------------------------------

#[test]
fun ac6_cooldown_boundary_succeeds_at_8000() {
    let (mut g, cap, mut env) = t::open_game(0, 4);
    let mut a = env.join(&mut g, t::alice(), 9);
    env.walk(&g, &mut a, t::n());
    env.advance(8_000);
    let ctx = env.ctx(t::alice());
    // Exactly 8 000 ms after the last step (resolve took no clock time).
    game::step(&g, &mut a, t::n(), env.clock(), &ctx);
    assert!(a.y() == 2);
    destroy(a);
    env.cleanup(g, cap);
}

#[test, expected_failure(abort_code = 10, location = whiteout::game)]
fun ac6_step_at_7999_aborts() {
    let (mut g, _cap, mut env) = t::open_game(0, 4);
    let mut a = env.join(&mut g, t::alice(), 9);
    env.walk(&g, &mut a, t::n());
    env.advance(7_999);
    let ctx = env.ctx(t::alice());
    game::step(&g, &mut a, t::n(), env.clock(), &ctx);
    abort
}

#[test, expected_failure(abort_code = 19, location = whiteout::game)]
fun ac6_step_south_off_grid_aborts() {
    let (mut g, _cap, mut env) = t::open_game(0, 4);
    let mut a = env.join(&mut g, t::alice(), 9);
    env.step(&g, &mut a, t::s());
    abort
}

#[test, expected_failure(abort_code = 19, location = whiteout::game)]
fun ac6_step_west_off_grid_aborts() {
    let (mut g, _cap, mut env) = t::open_game(0, 4);
    let mut a = env.join(&mut g, t::alice(), 0);
    env.step(&g, &mut a, t::w());
    abort
}

#[test, expected_failure(abort_code = 1, location = whiteout::game)]
fun bad_direction_aborts() {
    let (mut g, _cap, mut env) = t::open_game(0, 4);
    let mut a = env.join(&mut g, t::alice(), 9);
    env.step(&g, &mut a, 4);
    abort
}

#[test, expected_failure(abort_code = 18, location = whiteout::game)]
fun ac7_step_with_pending_aborts() {
    let (mut g, _cap, mut env) = t::open_game(0, 4);
    let mut a = env.join(&mut g, t::alice(), 9);
    env.step(&g, &mut a, t::n());
    env.step(&g, &mut a, t::n());
    abort
}

#[test]
fun ac7_revisit_creates_no_pending() {
    let (mut g, cap, mut env) = t::open_game(0, 4);
    let mut a = env.join(&mut g, t::alice(), 9);
    env.walk(&g, &mut a, t::n());
    env.step(&g, &mut a, t::s());
    assert!(!a.has_pending());
    env.step(&g, &mut a, t::n());
    assert!(!a.has_pending());
    assert!(a.steps() == 3);
    destroy(a);
    env.cleanup(g, cap);
}

#[test]
fun step_sets_deadline_from_window() {
    let (mut g, cap, mut env) = t::open_game(0, 4);
    let mut a = env.join(&mut g, t::alice(), 9);
    env.step(&g, &mut a, t::n());
    let (px, py, deadline) = a.pending();
    assert!(px == 9 && py == 1);
    assert!(deadline == env.now() + t::window());
    destroy(a);
    env.cleanup(g, cap);
}

#[test, expected_failure(abort_code = 16, location = whiteout::game)]
fun step_other_players_explorer_aborts() {
    let (mut g, _cap, mut env) = t::open_game(0, 4);
    let mut a = env.join(&mut g, t::alice(), 9);
    env.advance(8_000);
    let ctx = env.ctx(t::bob());
    game::step(&g, &mut a, t::n(), env.clock(), &ctx);
    abort
}

#[test, expected_failure(abort_code = 14, location = whiteout::game)]
fun step_after_end_aborts() {
    let (mut g, _cap, mut env) = t::open_game(0, 4);
    let mut a = env.join(&mut g, t::alice(), 9);
    env.advance(t::duration());
    env.step(&g, &mut a, t::n());
    abort
}

// ---------------------------------------------------------------------
// AC11: signatures
// ---------------------------------------------------------------------

#[test, expected_failure(abort_code = 11, location = whiteout::game)]
fun ac11_signature_for_neighbour_tile_aborts() {
    let (mut g, _cap, mut env) = t::open_game(0, 4);
    let mut a = env.join(&mut g, t::alice(), 9);
    env.step(&g, &mut a, t::n()); // pending (9, 1), snow
    let ctx = env.ctx(t::alice());
    // (10, 1)'s signature, claiming (9, 1)'s true kind.
    game::resolve(&g, &mut a, fixtures::kind(9, 1), fixtures::sig(10, 1), env.clock(), &ctx);
    abort
}

#[test, expected_failure(abort_code = 11, location = whiteout::game)]
fun ac11_forged_kind_aborts() {
    let (mut g, _cap, mut env) = t::open_game(0, 4);
    let mut a = env.join(&mut g, t::alice(), 5);
    env.walk(&g, &mut a, t::n());
    env.step(&g, &mut a, t::n()); // (5, 2) is goggles; claim it is rope
    let ctx = env.ctx(t::alice());
    game::resolve(&g, &mut a, tiles::rope(), fixtures::sig(5, 2), env.clock(), &ctx);
    abort
}

#[test, expected_failure(abort_code = 11, location = whiteout::game)]
fun signature_from_other_game_aborts() {
    let (mut g, _cap, mut env) = t::open_game(0, 4);
    let mut a = env.join(&mut g, t::alice(), 5);
    env.step(&g, &mut a, t::n()); // (5, 1)
    let ctx = env.ctx(t::alice());
    game::resolve(&g, &mut a, fixtures::kind(5, 1), fixtures::other_game_sig_5_1(), env.clock(), &ctx);
    abort
}

#[test, expected_failure(abort_code = 22, location = whiteout::game)]
fun resolve_without_pending_aborts() {
    let (mut g, _cap, mut env) = t::open_game(0, 4);
    let mut a = env.join(&mut g, t::alice(), 5);
    let ctx = env.ctx(t::alice());
    game::resolve(&g, &mut a, tiles::snow(), fixtures::sig(5, 0), env.clock(), &ctx);
    abort
}

#[test]
fun ac11_true_kind_resolves() {
    let (mut g, cap, mut env) = t::open_game(0, 4);
    let mut a = env.join(&mut g, t::alice(), 9);
    env.step(&g, &mut a, t::n());
    env.resolve(&g, &mut a);
    assert!(!a.has_pending() && a.visited(9, 1));
    destroy(a);
    env.cleanup(g, cap);
}

// ---------------------------------------------------------------------
// AC12, AC13: goggles and ropes
// ---------------------------------------------------------------------

#[test]
fun ac12_goggles_last_pickup_plus_nine_steps() {
    let (mut g, cap, mut env) = t::open_game(0, 4);
    let mut a = env.join(&mut g, t::alice(), 0);
    env.walk(&g, &mut a, t::n()); // (0, 1) goggles
    assert!(a.vision() == 1 && a.vision_steps() == 10);
    let mut i = 0;
    while (i < 9) {
        env.walk(&g, &mut a, t::n());
        assert!(a.vision() == 1);
        i = i + 1;
    };
    env.walk(&g, &mut a, t::n()); // 10th step after pickup
    assert!(a.vision() == 0 && a.vision_steps() == 0);
    destroy(a);
    env.cleanup(g, cap);
}

#[test]
fun ac12_second_goggles_reset_to_ten() {
    let (mut g, cap, mut env) = t::open_game(0, 4);
    let mut a = env.join(&mut g, t::alice(), 0);
    env.walk(&g, &mut a, t::n()); // (0, 1) goggles, 10 steps
    env.walk(&g, &mut a, t::n()); // (0, 2), 9
    env.walk(&g, &mut a, t::n()); // (0, 3), 8
    env.walk(&g, &mut a, t::n()); // (0, 4), 7
    env.walk(&g, &mut a, t::n()); // (0, 5), 6
    env.walk(&g, &mut a, t::e()); // (1, 5) goggles again
    assert!(a.vision() == 1 && a.vision_steps() == 10);
    destroy(a);
    env.cleanup(g, cap);
}

#[test]
fun ac13_rope_cap_is_three() {
    let (mut g, cap, mut env) = t::open_game(0, 4);
    let mut a = env.join(&mut g, t::alice(), 4);
    4u64.do!(|_| env.walk(&g, &mut a, t::n())); // (4, 1)..(4, 4) are all ropes
    assert!(a.ropes() == 3);
    destroy(a);
    env.cleanup(g, cap);
}

#[test]
fun ac13_rope_bridges_crevasse_once() {
    let (mut g, cap, mut env) = t::open_game(10, 4);
    let mut a = env.join(&mut g, t::alice(), 5);
    env.walk(&g, &mut a, t::n()); // (5, 1) snow
    env.walk(&g, &mut a, t::n()); // (5, 2) goggles
    env.walk(&g, &mut a, t::n()); // (5, 3) rope
    assert!(a.ropes() == 1);
    env.walk(&g, &mut a, t::n()); // (5, 4) crevasse, bridged
    assert!(a.ropes() == 0 && a.is_active() && a.visited(5, 4));
    assert!(a.stake_value() == 10);
    env.step(&g, &mut a, t::s()); // back to (5, 3)
    env.step(&g, &mut a, t::n()); // onto the bridged crevasse: no pending
    assert!(!a.has_pending() && a.is_active());
    destroy(a);
    env.cleanup(g, cap);
}

// ---------------------------------------------------------------------
// Crevasses, freezes (AC14, AC15)
// ---------------------------------------------------------------------

#[test, expected_failure(abort_code = 23, location = whiteout::game)]
fun crevasse_without_rope_needs_resolve_fatal() {
    let (mut g, _cap, mut env) = t::open_game(10, 4);
    let mut a = env.join(&mut g, t::alice(), 6);
    env.step(&g, &mut a, t::n()); // (6, 1) crevasse
    env.resolve(&g, &mut a);
    abort
}

#[test]
fun ac15_fatal_crevasse_splits_seven_three_four() {
    let (mut g, cap, mut env) = t::open_game(7, 4);
    let mut a = env.join(&mut g, t::alice(), 6);
    env.step(&g, &mut a, t::n());
    let ctx = env.ctx(t::alice());
    let to_well = game::resolve_fatal_internal(&mut g, &mut a, fixtures::sig(6, 1), env.clock(), &ctx);
    assert!(to_well.value() == 3);
    assert!(g.pot_value() == 4);
    assert!(a.explorer_status() == game::explorer_frozen());
    assert!(a.stake_value() == 0 && !a.has_pending() && a.visited(6, 1));
    destroy(to_well);
    destroy(a);
    env.cleanup(g, cap);
}

#[test]
fun ac15_zero_stake_freeze_moves_nothing() {
    let (mut g, cap, mut env) = t::open_game(0, 4);
    let mut a = env.join(&mut g, t::alice(), 6);
    env.step(&g, &mut a, t::n());
    let ctx = env.ctx(t::alice());
    let to_well = game::resolve_fatal_internal(&mut g, &mut a, fixtures::sig(6, 1), env.clock(), &ctx);
    assert!(to_well.value() == 0 && g.pot_value() == 0);
    to_well.destroy_zero();
    destroy(a);
    env.cleanup(g, cap);
}

#[test, expected_failure(abort_code = 11, location = whiteout::game)]
fun resolve_fatal_on_snow_aborts() {
    let (mut g, _cap, mut env) = t::open_game(10, 4);
    let mut a = env.join(&mut g, t::alice(), 9);
    env.step(&g, &mut a, t::n());
    let ctx = env.ctx(t::alice());
    let _b = game::resolve_fatal_internal(&mut g, &mut a, fixtures::sig(9, 1), env.clock(), &ctx);
    abort
}

#[test, expected_failure(abort_code = 1, location = whiteout::game)]
fun resolve_fatal_with_rope_aborts() {
    let (mut g, _cap, mut env) = t::open_game(10, 4);
    let mut a = env.join(&mut g, t::alice(), 5);
    3u64.do!(|_| env.walk(&g, &mut a, t::n())); // picks up a rope at (5, 3)
    env.step(&g, &mut a, t::n()); // (5, 4) crevasse
    let ctx = env.ctx(t::alice());
    let _b = game::resolve_fatal_internal(&mut g, &mut a, fixtures::sig(5, 4), env.clock(), &ctx);
    abort
}

#[test, expected_failure(abort_code = 13, location = whiteout::game)]
fun ac14_freeze_at_deadline_aborts() {
    let (mut g, _cap, mut env) = t::open_game(10, 4);
    let mut a = env.join(&mut g, t::alice(), 9);
    env.step(&g, &mut a, t::n());
    let (_, _, deadline) = a.pending();
    env.set_time(deadline);
    let _b = game::freeze_overdue_internal(&mut g, &mut a, env.clock());
    abort
}

#[test, expected_failure(abort_code = 13, location = whiteout::game)]
fun ac14_freeze_one_ms_early_aborts() {
    let (mut g, _cap, mut env) = t::open_game(10, 4);
    let mut a = env.join(&mut g, t::alice(), 9);
    env.step(&g, &mut a, t::n());
    let (_, _, deadline) = a.pending();
    env.set_time(deadline - 1);
    let _b = game::freeze_overdue_internal(&mut g, &mut a, env.clock());
    abort
}

#[test]
fun ac14_freeze_after_deadline_succeeds() {
    let (mut g, cap, mut env) = t::open_game(10, 4);
    let mut a = env.join(&mut g, t::alice(), 9);
    env.step(&g, &mut a, t::n());
    let (_, _, deadline) = a.pending();
    env.set_time(deadline + 1);
    let to_well = game::freeze_overdue_internal(&mut g, &mut a, env.clock());
    assert!(to_well.value() == 5 && g.pot_value() == 5);
    assert!(a.explorer_status() == game::explorer_frozen() && !a.has_pending());
    assert!(!a.visited(9, 1)); // never resolved
    destroy(to_well);
    destroy(a);
    env.cleanup(g, cap);
}

#[test, expected_failure(abort_code = 22, location = whiteout::game)]
fun freeze_without_pending_aborts() {
    let (mut g, _cap, mut env) = t::open_game(10, 4);
    let mut a = env.join(&mut g, t::alice(), 9);
    let _b = game::freeze_overdue_internal(&mut g, &mut a, env.clock());
    abort
}

#[test]
fun freeze_after_end_sends_everything_to_well() {
    let (mut g, cap, mut env) = t::open_game(9, 4);
    let mut a = env.join(&mut g, t::alice(), 9);
    env.step(&g, &mut a, t::n());
    env.advance(t::duration()); // past ends_at and the deadline
    let to_well = game::freeze_overdue_internal(&mut g, &mut a, env.clock());
    assert!(to_well.value() == 9 && g.pot_value() == 0);
    destroy(to_well);
    destroy(a);
    env.cleanup(g, cap);
}

// ---------------------------------------------------------------------
// AC16, AC17: relic
// ---------------------------------------------------------------------

#[test]
fun ac16_finder_gets_prize_pot_and_stake() {
    let (mut g, cap, mut env) = t::open_game(10, 4);
    // Bob falls into a crevasse: 5 to the well fund, 5 to the pot.
    let mut b = env.join(&mut g, t::bob(), 6);
    env.step(&g, &mut b, t::n());
    let ctx = env.ctx(t::bob());
    let bob_well = game::resolve_fatal_internal(&mut g, &mut b, fixtures::sig(6, 1), env.clock(), &ctx);

    let mut a = env.join(&mut g, t::alice(), 5);
    env.walk_to_relic(&g, &mut a);
    let ctx = env.ctx(t::alice());
    let (prize, payout) = game::claim_relic_internal<SUI, Prize>(
        &mut g,
        &mut a,
        fixtures::sig(5, 12),
        env.clock(),
        &ctx,
    );
    assert!(payout.value() == 15); // own 10 + pot 5
    assert!(g.status() == game::status_ended_found());
    assert!(g.finder() == option::some(t::alice()));
    assert!(g.pot_value() == 0 && !g.has_prize());
    assert!(a.explorer_status() == game::explorer_finder() && a.stake_value() == 0);
    destroy(prize);
    destroy(payout);
    destroy(bob_well);
    destroy(a);
    destroy(b);
    env.cleanup(g, cap);
}

#[test, expected_failure(abort_code = 14, location = whiteout::game)]
fun ac16_second_claim_aborts() {
    let (mut g, _cap, mut env) = t::open_game(10, 4);
    let mut a = env.join(&mut g, t::alice(), 5);
    let mut b = env.join(&mut g, t::bob(), 5);
    env.walk_to_relic(&g, &mut a);
    env.walk_to_relic(&g, &mut b);
    let ctx = env.ctx(t::alice());
    let (p1, s1) = game::claim_relic_internal<SUI, Prize>(&mut g, &mut a, fixtures::sig(5, 12), env.clock(), &ctx);
    destroy(p1);
    destroy(s1);
    let ctx = env.ctx(t::bob());
    let (_p2, _s2) = game::claim_relic_internal<SUI, Prize>(&mut g, &mut b, fixtures::sig(5, 12), env.clock(), &ctx);
    abort
}

#[test]
fun ac16_loser_resolves_relic_and_withdraws() {
    let (mut g, cap, mut env) = t::open_game(10, 4);
    let mut a = env.join(&mut g, t::alice(), 5);
    let mut b = env.join(&mut g, t::bob(), 5);
    env.walk_to_relic(&g, &mut a);
    env.walk_to_relic(&g, &mut b);
    let ctx = env.ctx(t::alice());
    let (p1, s1) = game::claim_relic_internal<SUI, Prize>(&mut g, &mut a, fixtures::sig(5, 12), env.clock(), &ctx);
    env.resolve(&g, &mut b); // the hunt is over: a plain relic resolve
    let ctx = env.ctx(t::bob());
    let back = game::withdraw_stake_internal(&g, &mut b, env.clock(), &ctx);
    assert!(back.value() == 10);
    destroy(p1);
    destroy(s1);
    destroy(back);
    destroy(a);
    destroy(b);
    env.cleanup(g, cap);
}

#[test, expected_failure(abort_code = 12, location = whiteout::game)]
fun resolve_live_relic_aborts() {
    let (mut g, _cap, mut env) = t::open_game(10, 4);
    let mut a = env.join(&mut g, t::alice(), 5);
    env.walk_to_relic(&g, &mut a);
    env.resolve(&g, &mut a);
    abort
}

#[test, expected_failure(abort_code = 14, location = whiteout::game)]
fun ac17_claim_at_ends_at_aborts() {
    let (mut g, _cap, mut env) = t::open_game(10, 4);
    let mut a = env.join(&mut g, t::alice(), 5);
    env.walk_to_relic(&g, &mut a);
    let end = g.ends_at();
    env.set_time(end);
    let ctx = env.ctx(t::alice());
    let (_p, _s) = game::claim_relic_internal<SUI, Prize>(&mut g, &mut a, fixtures::sig(5, 12), env.clock(), &ctx);
    abort
}

#[test]
fun ac17_after_late_claim_resolve_and_withdraw() {
    let (mut g, cap, mut env) = t::open_game(10, 4);
    let mut a = env.join(&mut g, t::alice(), 5);
    env.walk_to_relic(&g, &mut a);
    let end = g.ends_at();
    env.set_time(end);
    env.resolve(&g, &mut a);
    let ctx = env.ctx(t::alice());
    let back = game::withdraw_stake_internal(&g, &mut a, env.clock(), &ctx);
    assert!(back.value() == 10);
    destroy(back);
    destroy(a);
    env.cleanup(g, cap);
}

// ---------------------------------------------------------------------
// AC18, AC20: settlement
// ---------------------------------------------------------------------

#[test, expected_failure(abort_code = 15, location = whiteout::game)]
fun ac18_finalize_one_ms_early_aborts() {
    let (mut g, _cap, mut env) = t::open_game(10, 4);
    let end = g.ends_at();
    env.set_time(end - 1);
    let _b = game::finalize_unclaimed_internal(&mut g, env.clock());
    abort
}

#[test]
fun ac18_finalize_pays_well_and_host_reclaims() {
    let (mut g, cap, mut env) = t::open_game(10, 4);
    let mut b = env.join(&mut g, t::bob(), 6);
    env.step(&g, &mut b, t::n());
    let ctx = env.ctx(t::bob());
    let w1 = game::resolve_fatal_internal(&mut g, &mut b, fixtures::sig(6, 1), env.clock(), &ctx);
    let end = g.ends_at();
    env.set_time(end);
    let w2 = game::finalize_unclaimed_internal(&mut g, env.clock());
    assert!(w1.value() + w2.value() == 10);
    assert!(g.status() == game::status_ended_unclaimed());
    let prize: Prize = game::reclaim_prize(&mut g, &cap);
    assert!(!g.has_prize());
    destroy(prize);
    destroy(w1);
    destroy(w2);
    destroy(b);
    env.cleanup(g, cap);
}

#[test, expected_failure(abort_code = 2, location = whiteout::game)]
fun reclaim_while_open_aborts() {
    let (mut g, cap, mut env) = t::open_game(10, 4);
    let end = g.ends_at();
    env.set_time(end);
    let _p: Prize = game::reclaim_prize(&mut g, &cap);
    abort
}

#[test, expected_failure(abort_code = 2, location = whiteout::game)]
fun finalize_twice_aborts() {
    let (mut g, _cap, mut env) = t::open_game(10, 4);
    let end = g.ends_at();
    env.set_time(end);
    let b1 = game::finalize_unclaimed_internal(&mut g, env.clock());
    b1.destroy_zero();
    let _b2 = game::finalize_unclaimed_internal(&mut g, env.clock());
    abort
}

#[test, expected_failure(abort_code = 18, location = whiteout::game)]
fun ac20_withdraw_with_pending_aborts() {
    let (mut g, _cap, mut env) = t::open_game(10, 4);
    let mut a = env.join(&mut g, t::alice(), 9);
    env.step(&g, &mut a, t::n());
    env.advance(t::duration());
    let ctx = env.ctx(t::alice());
    let _b = game::withdraw_stake_internal(&g, &mut a, env.clock(), &ctx);
    abort
}

#[test, expected_failure(abort_code = 17, location = whiteout::game)]
fun ac20_frozen_cannot_withdraw() {
    let (mut g, _cap, mut env) = t::open_game(10, 4);
    let mut a = env.join(&mut g, t::alice(), 6);
    env.step(&g, &mut a, t::n());
    let ctx = env.ctx(t::alice());
    let w = game::resolve_fatal_internal(&mut g, &mut a, fixtures::sig(6, 1), env.clock(), &ctx);
    destroy(w);
    env.advance(t::duration());
    let ctx = env.ctx(t::alice());
    let _b = game::withdraw_stake_internal(&g, &mut a, env.clock(), &ctx);
    abort
}

#[test, expected_failure(abort_code = 17, location = whiteout::game)]
fun ac20_second_withdraw_aborts() {
    let (mut g, _cap, mut env) = t::open_game(10, 4);
    let mut a = env.join(&mut g, t::alice(), 9);
    env.advance(t::duration());
    let ctx = env.ctx(t::alice());
    let b1 = game::withdraw_stake_internal(&g, &mut a, env.clock(), &ctx);
    assert!(b1.value() == 10);
    destroy(b1);
    let _b2 = game::withdraw_stake_internal(&g, &mut a, env.clock(), &ctx);
    abort
}

#[test, expected_failure(abort_code = 15, location = whiteout::game)]
fun withdraw_before_end_aborts() {
    let (mut g, _cap, mut env) = t::open_game(10, 4);
    let mut a = env.join(&mut g, t::alice(), 9);
    let ctx = env.ctx(t::alice());
    let _b = game::withdraw_stake_internal(&g, &mut a, env.clock(), &ctx);
    abort
}

// ---------------------------------------------------------------------
// Thaw publication
// ---------------------------------------------------------------------

#[test]
fun publish_thaw_after_end() {
    let (mut g, cap, mut env) = t::open_game(0, 4);
    env.advance(t::duration());
    game::publish_thaw(&mut g, &cap, b"thaw-blob", env.clock());
    assert!(g.thaw_blob() == option::some(b"thaw-blob"));
    env.cleanup(g, cap);
}

#[test, expected_failure(abort_code = 15, location = whiteout::game)]
fun publish_thaw_before_end_aborts() {
    let (mut g, cap, env) = t::open_game(0, 4);
    game::publish_thaw(&mut g, &cap, b"thaw-blob", env.clock());
    abort
}
