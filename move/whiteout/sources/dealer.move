/// The dealer's enclave identity. `Enclave<DEALER>` objects are registered with the
/// vendored Nautilus package against the PCRs of the published dealer build.
///
/// `Cap<DEALER>` lives inside the shared `DealerRegistry` and never leaves it, so
/// exactly one `EnclaveConfig<DEALER>` can ever exist. `game::seal_deal_enclave`
/// only accepts an enclave registered against that pinned config at its current
/// version: a debug build or a build whose PCRs were since rotated cannot deal.
module whiteout::dealer;

use enclave::enclave::{Self, Cap, Enclave, EnclaveConfig};
use std::string::String;
use sui::event;

/// One-time witness; also the type tag of every dealer `Enclave` and `EnclaveConfig`.
public struct DEALER has drop {}

const ENotAdmin: u64 = 31;
const EConfigExists: u64 = 32;
const EBadPcrs: u64 = 33;
const EWrongConfig: u64 = 34;
const EStaleEnclave: u64 = 35;

const PCR_LEN: u64 = 48;

public struct DealerRegistry has key {
    id: UID,
    cap: Cap<DEALER>,
    /// The one dealer config, once created and pinned.
    config_id: Option<ID>,
    /// May create the config and rotate its PCRs (the publisher).
    admin: address,
}

public struct DealerConfigPinned has copy, drop {
    config_id: ID,
}

public struct DealerPcrsRotated has copy, drop {
    config_id: ID,
    version: u64,
    pcr0: vector<u8>,
    pcr1: vector<u8>,
    pcr2: vector<u8>,
}

fun init(otw: DEALER, ctx: &mut TxContext) {
    transfer::share_object(DealerRegistry {
        id: object::new(ctx),
        cap: enclave::new_cap(otw, ctx),
        config_id: option::none(),
        admin: ctx.sender(),
    });
}

/// Creates the one `EnclaveConfig<DEALER>` (shared) with the release PCRs. Call
/// `pin_config` with it next. Refused once a config is pinned.
public fun create_config(
    reg: &DealerRegistry,
    name: String,
    pcr0: vector<u8>,
    pcr1: vector<u8>,
    pcr2: vector<u8>,
    ctx: &mut TxContext,
) {
    assert!(ctx.sender() == reg.admin, ENotAdmin);
    assert!(reg.config_id.is_none(), EConfigExists);
    assert_release_pcrs(&pcr0, &pcr1, &pcr2);
    enclave::create_enclave_config(&reg.cap, name, pcr0, pcr1, pcr2, ctx);
}

/// Pins `config` as the dealer config. `update_name` proves the config belongs to
/// this registry's cap. From then on no other config is accepted.
public fun pin_config(reg: &mut DealerRegistry, config: &mut EnclaveConfig<DEALER>, ctx: &TxContext) {
    assert!(ctx.sender() == reg.admin, ENotAdmin);
    assert!(reg.config_id.is_none(), EConfigExists);
    let name = *config.name();
    enclave::update_name(config, &reg.cap, name);
    let config_id = object::id(config);
    reg.config_id = option::some(config_id);
    event::emit(DealerConfigPinned { config_id });
}

/// Rotates the release PCRs. Every enclave registered before stops being accepted.
public fun update_pcrs(
    reg: &DealerRegistry,
    config: &mut EnclaveConfig<DEALER>,
    pcr0: vector<u8>,
    pcr1: vector<u8>,
    pcr2: vector<u8>,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == reg.admin, ENotAdmin);
    assert_pinned(reg, config);
    assert_release_pcrs(&pcr0, &pcr1, &pcr2);
    enclave::update_pcrs(config, &reg.cap, pcr0, pcr1, pcr2);
    event::emit(DealerPcrsRotated {
        config_id: object::id(config),
        version: config.version(),
        pcr0: *config.pcr0(),
        pcr1: *config.pcr1(),
        pcr2: *config.pcr2(),
    });
}

/// Aborts unless `config` is the pinned dealer config and `e` registered against
/// its current PCRs.
public fun assert_current(reg: &DealerRegistry, config: &EnclaveConfig<DEALER>, e: &Enclave<DEALER>) {
    assert_pinned(reg, config);
    assert!(e.config_version() == config.version(), EStaleEnclave);
}

public fun config_id(reg: &DealerRegistry): Option<ID> { reg.config_id }

public fun admin(reg: &DealerRegistry): address { reg.admin }

fun assert_pinned(reg: &DealerRegistry, config: &EnclaveConfig<DEALER>) {
    assert!(reg.config_id == option::some(object::id(config)), EWrongConfig);
}

/// Debug builds report all-zero PCRs; a release build never does.
fun assert_release_pcrs(pcr0: &vector<u8>, pcr1: &vector<u8>, pcr2: &vector<u8>) {
    assert!(pcr0.length() == PCR_LEN && pcr1.length() == PCR_LEN && pcr2.length() == PCR_LEN, EBadPcrs);
    assert!(!is_zero(pcr0) && !is_zero(pcr1) && !is_zero(pcr2), EBadPcrs);
}

fun is_zero(v: &vector<u8>): bool {
    let mut i = 0;
    while (i < v.length()) {
        if (v[i] != 0) return false;
        i = i + 1;
    };
    true
}

#[test_only]
public fun witness_for_testing(): DEALER { DEALER {} }

#[test_only]
/// A registry with a pinned config, without sharing either. Destroy with `destroy_for_testing`.
public fun new_for_testing(ctx: &mut TxContext): (DealerRegistry, EnclaveConfig<DEALER>) {
    let cap = enclave::new_cap(DEALER {}, ctx);
    let config = enclave::new_config_for_testing(&cap, ctx);
    let reg = DealerRegistry {
        id: object::new(ctx),
        cap,
        config_id: option::some(object::id(&config)),
        admin: ctx.sender(),
    };
    (reg, config)
}

#[test_only]
public fun destroy_for_testing(reg: DealerRegistry, config: EnclaveConfig<DEALER>) {
    let DealerRegistry { id, cap, .. } = reg;
    id.delete();
    enclave::destroy_cap_for_testing(cap);
    enclave::destroy_config_for_testing(config);
}

#[test_only]
public fun bump_version_for_testing(reg: &DealerRegistry, config: &mut EnclaveConfig<DEALER>) {
    enclave::update_pcrs(config, &reg.cap, x"01", x"02", x"03");
}
