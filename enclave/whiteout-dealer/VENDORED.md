# Nautilus template files

`Containerfile`, `Makefile`, `*.sh`, `rust-toolchain.toml`, `src/nautilus-server/run.sh` and
`src/nautilus-server/traffic_forwarder.py` are copied from https://github.com/MystenLabs/nautilus
at commit `0104d627c66cd2d27a46f3c17af537e3c4576d74`, unchanged except where marked `WHITEOUT:`.
They give the reproducible StageX build that produces the enclave image and its PCRs.

The Rust server in `src/nautilus-server` is Whiteout's own: the template's attestation endpoint
(`common.rs`) plus the dealer app in `src/apps/whiteout`. Build it with `ENCLAVE_APP=whiteout`.
