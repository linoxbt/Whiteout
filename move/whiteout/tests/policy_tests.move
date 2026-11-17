/// Seal policy (spec section 19, "Policy unit"; AC8, AC9, AC19).
#[test_only, allow(deprecated_usage)]
module whiteout::policy_tests;

use std::unit_test::destroy;
use sui::sui::SUI;
use whiteout::fixtures;
use whiteout::game;
use whiteout::policy;
use whiteout::test_env::{Self as t, Prize};
use whiteout::tiles;

fun id_of(x: u8, y: u8): vector<u8> {
    tiles::encode_identity(fixtures::game_id(), x, y)
}

#[test]
fun own_tile_allowed() {
    let (mut g, cap, mut env) = t::open_game(0, 4);
    let a = env.join(&mut g, t::alice(), 9);
    let ctx = env.ctx(t::alice());
    policy::check_player(&id_of(9, 0), &g, &a, env.clock(), &ctx);
    destroy(a);
    env.cleanup(g, cap);
}

#[test]
fun pending_tile_allowed_after_step() {
    let (mut g, cap, mut env) = t::open_game(0, 4);
    let mut a = env.join(&mut g, t::alice(), 9);
    env.step(&g, &mut a, t::n());
    let ctx = env.ctx(t::alice());
    policy::check_player(&id_of(9, 1), &g, &a, env.clock(), &ctx);
    destroy(a);
    env.cleanup(g, cap);
}

#[test, expected_failure(abort_code = 21, location = whiteout::policy)]
fun ac8_neighbour_denied_at_vision_0() {
    let (mut g, _cap, mut env) = t::open_game(0, 4);
    let a = env.join(&mut g, t::alice(), 9);
    let ctx = env.ctx(t::alice());
    policy::check_player(&id_of(10, 1), &g, &a, env.clock(), &ctx);
    abort
}

#[test]
fun ac8_neighbours_allowed_at_vision_1() {
    let (mut g, cap, mut env) = t::open_game(0, 4);
    let mut a = env.join(&mut g, t::alice(), 0);
    env.walk(&g, &mut a, t::n()); // goggles at (0, 1)
    assert!(a.vision() == 1);
    let ctx = env.ctx(t::alice());
    policy::check_player(&id_of(0, 0), &g, &a, env.clock(), &ctx);
    policy::check_player(&id_of(1, 0), &g, &a, env.clock(), &ctx);
    policy::check_player(&id_of(1, 1), &g, &a, env.clock(), &ctx);
    policy::check_player(&id_of(1, 2), &g, &a, env.clock(), &ctx);
    policy::check_player(&id_of(0, 2), &g, &a, env.clock(), &ctx);
    destroy(a);
    env.cleanup(g, cap);
}

#[test, expected_failure(abort_code = 21, location = whiteout::policy)]
fun ac8_two_away_denied_at_vision_1() {
    let (mut g, _cap, mut env) = t::open_game(0, 4);
    let mut a = env.join(&mut g, t::alice(), 0);
    env.walk(&g, &mut a, t::n()); // goggles at (0, 1)
    let ctx = env.ctx(t::alice());
    policy::check_player(&id_of(0, 3), &g, &a, env.clock(), &ctx);
    abort
}

#[test, expected_failure(abort_code = 16, location = whiteout::policy)]
fun ac9_other_players_explorer_denied() {
    let (mut g, _cap, mut env) = t::open_game(0, 4);
    let a = env.join(&mut g, t::alice(), 9);
    let ctx = env.ctx(t::bob());
    policy::check_player(&id_of(9, 0), &g, &a, env.clock(), &ctx);
    abort
}

#[test, expected_failure(abort_code = 20, location = whiteout::policy)]
fun identity_for_other_game_denied() {
    let (mut g, _cap, mut env) = t::open_game(0, 4);
    let a = env.join(&mut g, t::alice(), 9);
    let ctx = env.ctx(t::alice());
    let id = tiles::encode_identity(fixtures::other_game_id(), 9, 0);
    policy::check_player(&id, &g, &a, env.clock(), &ctx);
    abort
}

#[test, expected_failure(abort_code = 17, location = whiteout::policy)]
fun frozen_explorer_denied() {
    let (mut g, _cap, mut env) = t::open_game(10, 4);
    let mut a = env.join(&mut g, t::alice(), 6);
    env.step(&g, &mut a, t::n());
    let ctx = env.ctx(t::alice());
    let w = game::resolve_fatal_internal(&mut g, &mut a, fixtures::sig(6, 1), env.clock(), &ctx);
    destroy(w);
    policy::check_player(&id_of(6, 1), &g, &a, env.clock(), &ctx);
    abort
}

#[test]
fun ac19_any_tile_after_ends_at() {
    let (mut g, cap, mut env) = t::open_game(0, 4);
    let a = env.join(&mut g, t::alice(), 9);
    env.advance(t::duration());
    // Bob, with Alice's Explorer, far from it: the thaw.
    let ctx = env.ctx(t::bob());
    policy::check_player(&id_of(23, 23), &g, &a, env.clock(), &ctx);
    policy::check_thaw(&id_of(23, 23), &g, env.clock());
    destroy(a);
    env.cleanup(g, cap);
}

#[test]
fun ac19_any_tile_after_relic_claim() {
    let (mut g, cap, mut env) = t::open_game(0, 4);
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
    policy::check_thaw(&id_of(0, 23), &g, env.clock());
    // The finder's Explorer is no longer active, but the thaw branch comes first.
    policy::check_player(&id_of(0, 23), &g, &a, env.clock(), &ctx);
    destroy(prize);
    destroy(payout);
    destroy(a);
    env.cleanup(g, cap);
}

#[test, expected_failure(abort_code = 15, location = whiteout::policy)]
fun thaw_before_end_denied() {
    let (g, _cap, env) = t::open_game(0, 4);
    policy::check_thaw(&id_of(9, 0), &g, env.clock());
    abort
}

#[test, expected_failure(abort_code = 1, location = whiteout::tiles)]
fun identity_33_bytes_aborts() {
    let (mut g, _cap, mut env) = t::open_game(0, 4);
    let a = env.join(&mut g, t::alice(), 9);
    let ctx = env.ctx(t::alice());
    let mut id = id_of(9, 0);
    id.pop_back();
    policy::check_player(&id, &g, &a, env.clock(), &ctx);
    abort
}

#[test, expected_failure(abort_code = 1, location = whiteout::tiles)]
fun identity_35_bytes_aborts() {
    let (mut g, _cap, mut env) = t::open_game(0, 4);
    let a = env.join(&mut g, t::alice(), 9);
    let ctx = env.ctx(t::alice());
    let mut id = id_of(9, 0);
    id.push_back(0);
    policy::check_player(&id, &g, &a, env.clock(), &ctx);
    abort
}

#[test, expected_failure(abort_code = 1, location = whiteout::tiles)]
fun identity_off_grid_aborts() {
    let (g, _cap, env) = t::open_game(0, 4);
    policy::check_thaw(&tiles::encode_identity(fixtures::game_id(), 24, 0), &g, env.clock());
    abort
}

#[test]
fun identity_round_trips() {
    let id = id_of(17, 9);
    assert!(id.length() == 34);
    let (gid, x, y) = tiles::decode_identity(&id);
    assert!(gid == fixtures::game_id() && x == 17 && y == 9);
}

#[test]
fun chebyshev_distance() {
    assert!(tiles::chebyshev(3, 3, 3, 3) == 0);
    assert!(tiles::chebyshev(3, 3, 4, 4) == 1);
    assert!(tiles::chebyshev(3, 3, 1, 4) == 2);
    assert!(tiles::chebyshev(0, 23, 23, 0) == 23);
}
