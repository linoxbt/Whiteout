# Reproducing the dealer's PCRs

The dealer image is built with the Nautilus template's StageX Containerfile: a full-source, deterministic toolchain. Building the same commit gives the same `nitro.pcrs`.

```
git checkout <release tag>
cd enclave/whiteout-dealer
make NETWORK=testnet        # or mainnet
cat out/nitro.pcrs
```

Compare PCR0–PCR2 with the `EnclaveConfig<DEALER>` object on-chain (the Verify page shows them). They depend on:

- the Rust source in `src/nautilus-server`, built with `--locked` from `Cargo.lock`;
- `src/nautilus-server/config/<network>.json`: package ID, Seal key servers, their public keys and the threshold;
- the pinned StageX images in the Containerfile.

A request to `/deal` can only carry a game ID (unknown fields are rejected), so none of the above can be changed at run time.
