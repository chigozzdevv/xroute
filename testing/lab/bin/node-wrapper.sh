#!/usr/bin/env bash
set -euo pipefail

binary_name="$(basename "$0")"
real_binary="/opt/xroute/bin-real/${binary_name}"
spec_dir="/opt/xroute-lab/state/patched-specs"

if [ ! -x "${real_binary}" ]; then
  echo "missing real binary for ${binary_name}" >&2
  exit 1
fi

patched_args=()
expect_chain_path=0
in_relay_args=0
relay_bootnode=""
mkdir -p "${spec_dir}"

args=("$@")
index=0
while [ "${index}" -lt "${#args[@]}" ]; do
  arg="${args[${index}]}"

  if [ "${expect_chain_path}" = "1" ] && [ -f "${arg}" ]; then
    patched_chain="${spec_dir}/$(basename "${arg}")"
    sed \
      -e 's#/ws/p2p/#/p2p/#g' \
      -e 's#/ws"#"#g' \
      "${arg}" > "${patched_chain}"
    if [ "${in_relay_args}" = "1" ] && [ -z "${relay_bootnode}" ]; then
      relay_bootnode="$(grep -m1 -o '"/ip4[^"]*"' "${patched_chain}" | tr -d '"' || true)"
    fi
    patched_args+=("${patched_chain}")
    expect_chain_path=0
    index=$((index + 1))
    continue
  fi

  case "${arg}" in
    --chain)
      patched_args+=("${arg}")
      expect_chain_path=1
      ;;
    --)
      patched_args+=("${arg}")
      in_relay_args=1
      ;;
    --port)
      if [ "${in_relay_args}" = "1" ] && [ $((index + 1)) -lt "${#args[@]}" ]; then
        relay_port="${args[$((index + 1))]}"
        patched_args+=("--listen-addr" "/ip4/0.0.0.0/tcp/${relay_port}")
        index=$((index + 2))
        continue
      fi
      patched_args+=("${arg}")
      ;;
    /ip4/127.0.0.1/tcp/*)
      rewritten="${arg/\/ip4\/127.0.0.1\//\/ip4\/0.0.0.0\/}"
      patched_args+=("${rewritten/\/ws/}")
      ;;
    /ip4/*/tcp/*/ws/p2p/*)
      patched_args+=("${arg/\/ws\/p2p\//\/p2p\/}")
      ;;
    *)
      patched_args+=("${arg}")
      ;;
  esac
  index=$((index + 1))
done

if [ -n "${relay_bootnode}" ]; then
  patched_args+=("--bootnodes" "${relay_bootnode}")
fi

exec "${real_binary}" "${patched_args[@]}"
