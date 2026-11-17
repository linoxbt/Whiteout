/// The Seal access policy (MD1, MD2, MD10). Read-only.
///
/// Key servers evaluate `seal_approve*` in a dry run and release the key for
/// identity `game_id ‖ x ‖ y` only if the call does not abort. Both functions live
/// in the game package because Seal derives keys from the package ID.
module whiteout::policy;

use sui::clock::Clock;
use whiteout::game::{Self, Game, Explorer};
use whiteout::tiles;

const ENotEnded: u64 = 15;
const ENotYours: u64 = 16;
const EInactive: u64 = 17;
const EWrongGame: u64 = 20;
const ENoAccess: u64 = 21;

/// During play: the sender's own active Explorer must be within its vision radius
/// of the tile. After the game ends every tile is open (the thaw).
entry fun seal_approve<T>(
    id: vector<u8>,
    g: &Game<T>,
    e: &Explorer<T>,
    clock: &Clock,
    ctx: &TxContext,
) {
    check_player(&id, g, e, clock, ctx);
}

/// The thaw on its own, with no Explorer argument, so a game nobody joined can
/// still be revealed and spectators need no Explorer ID.
entry fun seal_approve_thaw<T>(id: vector<u8>, g: &Game<T>, clock: &Clock) {
    check_thaw(&id, g, clock);
}

public(package) fun check_player<T>(
    id: &vector<u8>,
    g: &Game<T>,
    e: &Explorer<T>,
    clock: &Clock,
    ctx: &TxContext,
) {
    let (gid, x, y) = tiles::decode_identity(id);
    assert!(gid == object::id(g), EWrongGame);
    if (game::is_ended(g, clock)) return;
    assert!(e.game_id() == gid, EWrongGame);
    assert!(e.owner() == ctx.sender(), ENotYours);
    assert!(e.is_active(), EInactive);
    assert!(tiles::chebyshev(e.x(), e.y(), x, y) <= e.vision(), ENoAccess);
}

public(package) fun check_thaw<T>(id: &vector<u8>, g: &Game<T>, clock: &Clock) {
    let (gid, _, _) = tiles::decode_identity(id);
    assert!(gid == object::id(g), EWrongGame);
    assert!(game::is_ended(g, clock), ENotEnded);
}
