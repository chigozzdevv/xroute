#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="/opt/xroute-lab/state/zombienet"

rm -rf "${STATE_DIR}"
mkdir -p "$(dirname "${STATE_DIR}")"
cd /opt/xroute-lab

export RUST_LOG="${XROUTE_LAB_RUST_LOG:-info,sc_network=debug,sub_libp2p=debug,libp2p_swarm=debug}"

exec /opt/xroute/bin/zombienet \
  -l text \
  -d "${STATE_DIR}" \
  spawn /opt/xroute-lab/zombienet/multichain.json
