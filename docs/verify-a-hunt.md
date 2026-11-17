# Verifying a hunt

Anyone can check a hunt without trusting the host or the developers. The web client's **Verify** page runs these checks; the CLI does the same with `whiteout verify --game <id>` (no key needed).

1. **The package cannot change.** The package's UpgradeCap was destroyed (`make_immutable`), so nobody can change the rules or the Seal policy. The digests are in `deploy/<network>.json`.
2. **Who dealt the map.** `Game.dealer_kind` is `1` (enclave) or `2` (host-dealt). Host-dealt hunts are labelled everywhere and Move forces their stake to zero.
3. **Which enclave.** `Game.enclave_id` names the `Enclave<DEALER>` whose key signed the deal. Its `config_version` should equal the `EnclaveConfig<DEALER>` version, whose PCRs you can rebuild from the tagged source (see `reproducible-build.md`).
4. **The tiles were not swapped.** Download all 576 ciphertexts from the Quilt and recompute `ct_hash`; it must equal `Game.ct_hash`, which the dealer signed. The client refuses to join otherwise.
5. **The ciphertexts use the expected key servers.** Each Seal ciphertext lists its key servers and threshold. They must be the servers pinned in the dealer config.
6. **Every reveal was honest.** Each `TileResolved` event passed an on-chain Ed25519 check against the dealer key.
7. **After the end: the whole map.** The thaw file (`Game.thaw_blob`) has all 576 plaintext tiles; every one must carry valid kind and clue signatures. Or decrypt the map yourself: after the end, `seal_approve_thaw` releases every tile to anyone.

What this does not prove: that a threshold of Seal key servers did not collude, that AWS Nitro is sound, or that each player is a different person (spec section 9).
