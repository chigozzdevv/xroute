FROM xroute-multichain-lab-base:stable2512-2

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

WORKDIR /opt/xroute-lab

RUN mkdir -p /opt/xroute/bin-real /opt/xroute-lab/state /opt/xroute-lab/zombienet \
  && mv /opt/xroute/bin/polkadot /opt/xroute/bin-real/polkadot \
  && mv /opt/xroute/bin/polkadot-parachain /opt/xroute/bin-real/polkadot-parachain \
  && mv /opt/xroute/bin/polkadot-execute-worker /opt/xroute/bin-real/polkadot-execute-worker \
  && mv /opt/xroute/bin/polkadot-prepare-worker /opt/xroute/bin-real/polkadot-prepare-worker \
  && mv /opt/xroute/bin/moonbeam /opt/xroute/bin-real/moonbeam \
  && mv /opt/xroute/bin/hydradx /opt/xroute/bin-real/hydradx \
  && mv /opt/xroute/bin/bifrost /opt/xroute/bin-real/bifrost

COPY testing/lab/bin/node-wrapper.sh /opt/xroute/bin/node-wrapper.sh
COPY testing/lab/zombienet/multichain.json /opt/xroute-lab/zombienet/multichain.json
COPY testing/lab/start.sh /opt/xroute-lab/start.sh

RUN chmod +x /opt/xroute/bin/node-wrapper.sh /opt/xroute-lab/start.sh \
  && ln -sf /opt/xroute/bin/node-wrapper.sh /opt/xroute/bin/polkadot \
  && ln -sf /opt/xroute/bin/node-wrapper.sh /opt/xroute/bin/polkadot-parachain \
  && ln -sf /opt/xroute/bin/node-wrapper.sh /opt/xroute/bin/moonbeam \
  && ln -sf /opt/xroute/bin/node-wrapper.sh /opt/xroute/bin/hydradx \
  && ln -sf /opt/xroute/bin/node-wrapper.sh /opt/xroute/bin/bifrost

ENTRYPOINT ["/opt/xroute-lab/start.sh"]
