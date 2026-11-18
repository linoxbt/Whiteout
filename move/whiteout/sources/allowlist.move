/// Holder gating (Phase 2). An `Allowlist` is a shared set of addresses, edited
/// only by whoever holds its `AllowlistCap`: for example the Lofi team, filled
/// from a snapshot of Mystic Yeti or $LOFI holders. A game that names a list
/// accepts joins only through `game::join_gated`, and only from members.
module whiteout::allowlist;

use std::string::String;
use sui::event;
use sui::table::{Self, Table};

const ENotAdmin: u64 = 29;
const EBatchTooLarge: u64 = 30;

/// Keeps one call well inside the transaction limits.
const MAX_BATCH: u64 = 1000;

public struct Allowlist has key {
    id: UID,
    name: String,
    members: Table<address, bool>,
    size: u64,
}

public struct AllowlistCap has key, store {
    id: UID,
    list_id: ID,
}

public struct AllowlistCreated has copy, drop {
    list_id: ID,
    name: String,
}

public struct AllowlistChanged has copy, drop {
    list_id: ID,
    added: u64,
    removed: u64,
    size: u64,
}

/// Creates and shares an empty list; returns the cap that edits it.
public fun create(name: String, ctx: &mut TxContext): AllowlistCap {
    let (list, cap) = new(name, ctx);
    transfer::share_object(list);
    cap
}

public(package) fun new(name: String, ctx: &mut TxContext): (Allowlist, AllowlistCap) {
    let list = Allowlist { id: object::new(ctx), name, members: table::new(ctx), size: 0 };
    let list_id = object::id(&list);
    event::emit(AllowlistCreated { list_id, name: list.name });
    (list, AllowlistCap { id: object::new(ctx), list_id })
}

/// Adds addresses. Ones already on the list are skipped.
public fun add(list: &mut Allowlist, cap: &AllowlistCap, members: vector<address>) {
    assert_admin(list, cap);
    assert!(members.length() <= MAX_BATCH, EBatchTooLarge);
    let mut added = 0;
    members.do!(|a| {
        if (!list.members.contains(a)) {
            list.members.add(a, true);
            added = added + 1;
        }
    });
    list.size = list.size + added;
    event::emit(AllowlistChanged { list_id: object::id(list), added, removed: 0, size: list.size });
}

/// Removes addresses. Ones not on the list are skipped.
public fun remove(list: &mut Allowlist, cap: &AllowlistCap, members: vector<address>) {
    assert_admin(list, cap);
    assert!(members.length() <= MAX_BATCH, EBatchTooLarge);
    let mut removed = 0;
    members.do!(|a| {
        if (list.members.contains(a)) {
            list.members.remove(a);
            removed = removed + 1;
        }
    });
    list.size = list.size - removed;
    event::emit(AllowlistChanged { list_id: object::id(list), added: 0, removed, size: list.size });
}

public fun contains(list: &Allowlist, a: address): bool { list.members.contains(a) }

public fun size(list: &Allowlist): u64 { list.size }

public fun name(list: &Allowlist): &String { &list.name }

public fun cap_list_id(cap: &AllowlistCap): ID { cap.list_id }

fun assert_admin(list: &Allowlist, cap: &AllowlistCap) {
    assert!(cap.list_id == object::id(list), ENotAdmin);
}

#[test_only]
public fun destroy_for_testing(list: Allowlist, cap: AllowlistCap) {
    std::unit_test::destroy(list);
    let AllowlistCap { id, .. } = cap;
    id.delete();
}
