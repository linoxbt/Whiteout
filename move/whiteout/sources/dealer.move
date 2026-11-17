/// The dealer's enclave identity. `Enclave<DEALER>` objects are registered with the
/// vendored Nautilus package against the PCRs of the published dealer build.
module whiteout::dealer;

use enclave::enclave;

/// One-time witness; also the type tag of every dealer `Enclave` and `EnclaveConfig`.
public struct DEALER has drop {}

/// Mints `Cap<DEALER>` to the publisher. The deployment script then calls
/// `enclave::create_enclave_config` with the release PCRs (spec section 13).
fun init(otw: DEALER, ctx: &mut TxContext) {
    let cap = enclave::new_cap(otw, ctx);
    transfer::public_transfer(cap, ctx.sender());
}

#[test_only]
public fun witness_for_testing(): DEALER { DEALER {} }
