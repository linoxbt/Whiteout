#!/bin/sh
# Copyright (c), Mysten Labs, Inc.
# SPDX-License-Identifier: Apache-2.0

# - Setup script for nautilus-server that acts as an init script
# - Sets up Python and library paths
# - Configures loopback network and /etc/hosts
# - Forwards VSOCK port 3000 to localhost:3000
# - Launches nautilus-server
# WHITEOUT: the template's secrets channel (VSOCK 7777, exported into the
# environment) is removed. The dealer reads no environment variables, and nothing
# the parent instance supplies may reach the enclave process.

set -e # Exit immediately if a command exits with a non-zero status
echo "run.sh script is running"
export PYTHONPATH=/lib/python3.11:/usr/local/lib/python3.11/lib-dynload:/usr/local/lib/python3.11/site-packages:/lib
export LD_LIBRARY_PATH=/lib:$LD_LIBRARY_PATH

echo "Script completed."
# Assign an IP address to local loopback
busybox ip addr add 127.0.0.1/32 dev lo
busybox ip link set dev lo up

# Add a hosts record, pointing target site calls to local loopback
echo "127.0.0.1   localhost" > /etc/hosts


# == ATTENTION: code should be generated here that parses allowed_endpoints.yaml and populate domains here ===

cat /etc/hosts

# Run traffic forwarder in background and start the server
# Forwards traffic from 127.0.0.x -> Port 443 at CID 3 Listening on port 800x
# There is a vsock-proxy that listens for this and forwards to the respective domains

# == ATTENTION: code should be generated here that added all hosts to forward traffic ===
# Traffic-forwarder-block

# Listens on Local VSOCK Port 3000 and forwards to localhost 3000
socat VSOCK-LISTEN:3000,reuseaddr,fork TCP:localhost:3000 &

/nautilus-server
