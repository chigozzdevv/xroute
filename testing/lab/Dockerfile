FROM ubuntu:24.04

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG DEBIAN_FRONTEND=noninteractive
ARG ZOMBIENET_VERSION=v1.3.138
ARG POLKADOT_SDK_TAG=polkadot-stable2512-1
ARG MOONBEAM_TAG=v0.50.4
ARG HYDRADX_TAG=v45.0.0
ARG BIFROST_TAG=bifrost-v0.23.3

RUN apt-get update && apt-get install -y \
  bash \
  ca-certificates \
  curl \
  jq \
  libssl3 \
  xz-utils \
  && update-ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/xroute-lab

RUN mkdir -p /opt/xroute/bin /opt/xroute-lab/state /opt/xroute-lab/zombienet

RUN curl -L --fail --retry 5 --retry-delay 2 \
  "https://github.com/paritytech/zombienet/releases/download/${ZOMBIENET_VERSION}/zombienet-linux-x64" \
  -o /opt/xroute/bin/zombienet \
  && chmod +x /opt/xroute/bin/zombienet

RUN curl -L --fail --retry 5 --retry-delay 2 \
  "https://github.com/paritytech/polkadot-sdk/releases/download/${POLKADOT_SDK_TAG}/polkadot" \
  -o /opt/xroute/bin/polkadot \
  && curl -L --fail --retry 5 --retry-delay 2 \
  "https://github.com/paritytech/polkadot-sdk/releases/download/${POLKADOT_SDK_TAG}/polkadot-parachain" \
  -o /opt/xroute/bin/polkadot-parachain \
  && curl -L --fail --retry 5 --retry-delay 2 \
  "https://github.com/paritytech/polkadot-sdk/releases/download/${POLKADOT_SDK_TAG}/polkadot-execute-worker" \
  -o /opt/xroute/bin/polkadot-execute-worker \
  && curl -L --fail --retry 5 --retry-delay 2 \
  "https://github.com/paritytech/polkadot-sdk/releases/download/${POLKADOT_SDK_TAG}/polkadot-prepare-worker" \
  -o /opt/xroute/bin/polkadot-prepare-worker \
  && chmod +x /opt/xroute/bin/polkadot /opt/xroute/bin/polkadot-parachain /opt/xroute/bin/polkadot-execute-worker /opt/xroute/bin/polkadot-prepare-worker

RUN curl -L --fail --retry 5 --retry-delay 2 \
  "https://github.com/moonbeam-foundation/moonbeam/releases/download/${MOONBEAM_TAG}/moonbeam" \
  -o /opt/xroute/bin/moonbeam \
  && chmod +x /opt/xroute/bin/moonbeam

RUN curl -L --fail --retry 5 --retry-delay 2 \
  "https://github.com/galacticcouncil/hydration-node/releases/download/${HYDRADX_TAG}/hydradx" \
  -o /opt/xroute/bin/hydradx \
  && chmod +x /opt/xroute/bin/hydradx

RUN curl -L --fail --retry 5 --retry-delay 2 \
  "https://github.com/bifrost-io/bifrost/releases/download/${BIFROST_TAG}/bifrost" \
  -o /opt/xroute/bin/bifrost \
  && chmod +x /opt/xroute/bin/bifrost

COPY testing/lab/zombienet/multichain.json /opt/xroute-lab/zombienet/multichain.json
COPY testing/lab/start.sh /opt/xroute-lab/start.sh

RUN chmod +x /opt/xroute-lab/start.sh

ENTRYPOINT ["/opt/xroute-lab/start.sh"]
