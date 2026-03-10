#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="/opt/xroute-lab/state/zombienet"

rm -rf "${STATE_DIR}"
cd /opt/xroute-lab

exec /opt/xroute/bin/zombienet \
  -l text \
  -d "${STATE_DIR}" \
  spawn /opt/xroute-lab/zombienet/multichain.json
