# Copyright (c), Mysten Labs, Inc.
# SPDX-License-Identifier: Apache-2.0
#!/bin/bash

# Gets the enclave id and CID
# expects there to be only one enclave running
ENCLAVE_ID=$(nitro-cli describe-enclaves | jq -r ".[0].EnclaveID")
ENCLAVE_CID=$(nitro-cli describe-enclaves | jq -r ".[0].EnclaveCID")

sleep 5
# Secrets-block
# This section will be populated by configure_enclave.sh based on secret configuration

# WHITEOUT: no secrets are sent to the enclave (run.sh no longer listens on VSOCK 7777).
# Port 3000 is plain HTTP. Browser hosts call /deal from an HTTPS page, so expose it
# to them only through a TLS-terminating proxy on this parent instance (for example
# Caddy or nginx on 443 forwarding to 127.0.0.1:3000); attestation still binds the
# dealer key, but TLS is required for mixed-content rules and transport integrity.
socat TCP4-LISTEN:3000,reuseaddr,fork VSOCK-CONNECT:$ENCLAVE_CID:3000 &

# Additional port configurations will be added here by configure_enclave.sh if needed
