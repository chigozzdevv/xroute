#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DOCKER_CONFIG_DIR="${ROOT_DIR}/testing/lab/.docker"

mkdir -p "${DOCKER_CONFIG_DIR}"
if [ ! -f "${DOCKER_CONFIG_DIR}/config.json" ]; then
  printf '{ "auths": {}, "currentContext": "desktop-linux" }\n' > "${DOCKER_CONFIG_DIR}/config.json"
fi
if [ ! -e "${DOCKER_CONFIG_DIR}/cli-plugins" ] && [ -d "${HOME}/.docker/cli-plugins" ]; then
  ln -s "${HOME}/.docker/cli-plugins" "${DOCKER_CONFIG_DIR}/cli-plugins"
fi

export DOCKER_CONFIG="${DOCKER_CONFIG_DIR}"

command -v docker >/dev/null 2>&1
docker version >/dev/null
docker compose version >/dev/null

echo "docker: ok"
echo "docker compose: ok"
