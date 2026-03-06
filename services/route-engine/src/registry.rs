use crate::model::{AssetAmount, AssetKey, ChainKey, DestinationAdapter, XcmWeight};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TransferEdge {
    pub source: ChainKey,
    pub destination: ChainKey,
    pub asset: AssetKey,
    pub transport_fee: AssetAmount,
    pub buy_execution_fee: AssetAmount,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransferPath {
    pub route: Vec<ChainKey>,
    pub hops: Vec<TransferEdge>,
    pub xcm_fee: AssetAmount,
    pub destination_fee: AssetAmount,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SwapRoute {
    pub destination: ChainKey,
    pub asset_in: AssetKey,
    pub asset_out: AssetKey,
    pub price_numerator: u128,
    pub price_denominator: u128,
    pub dex_fee_bps: u16,
    pub adapter: DestinationAdapter,
    pub transact_weight: XcmWeight,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StakeRoute {
    pub destination: ChainKey,
    pub asset: AssetKey,
    pub adapter: DestinationAdapter,
    pub transact_weight: XcmWeight,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CallRoute {
    pub destination: ChainKey,
    pub asset: AssetKey,
    pub adapter: DestinationAdapter,
    pub transact_weight: XcmWeight,
}

#[derive(Debug, Clone)]
pub struct RouteRegistry {
    transfer_edges: Vec<TransferEdge>,
    swap_routes: Vec<SwapRoute>,
    stake_routes: Vec<StakeRoute>,
    call_routes: Vec<CallRoute>,
}

impl Default for RouteRegistry {
    fn default() -> Self {
        Self {
            transfer_edges: vec![
                TransferEdge {
                    source: ChainKey::PolkadotHub,
                    destination: ChainKey::AssetHub,
                    asset: AssetKey::Dot,
                    transport_fee: AssetAmount::new(AssetKey::Dot, 100_000_000),
                    buy_execution_fee: AssetAmount::new(AssetKey::Dot, 20_000_000),
                },
                TransferEdge {
                    source: ChainKey::AssetHub,
                    destination: ChainKey::Hydration,
                    asset: AssetKey::Dot,
                    transport_fee: AssetAmount::new(AssetKey::Dot, 80_000_000),
                    buy_execution_fee: AssetAmount::new(AssetKey::Dot, 100_000_000),
                },
                TransferEdge {
                    source: ChainKey::Hydration,
                    destination: ChainKey::AssetHub,
                    asset: AssetKey::Usdt,
                    transport_fee: AssetAmount::new(AssetKey::Usdt, 25_000),
                    buy_execution_fee: AssetAmount::new(AssetKey::Usdt, 10_000),
                },
                TransferEdge {
                    source: ChainKey::Hydration,
                    destination: ChainKey::AssetHub,
                    asset: AssetKey::Hdx,
                    transport_fee: AssetAmount::new(AssetKey::Hdx, 50_000_000_000),
                    buy_execution_fee: AssetAmount::new(AssetKey::Hdx, 20_000_000_000),
                },
            ],
            swap_routes: vec![
                SwapRoute {
                    destination: ChainKey::Hydration,
                    asset_in: AssetKey::Dot,
                    asset_out: AssetKey::Usdt,
                    price_numerator: 495,
                    price_denominator: 100,
                    dex_fee_bps: 30,
                    adapter: DestinationAdapter::HydrationSwapV1,
                    transact_weight: XcmWeight {
                        ref_time: 3_500_000_000,
                        proof_size: 120_000,
                    },
                },
                SwapRoute {
                    destination: ChainKey::Hydration,
                    asset_in: AssetKey::Dot,
                    asset_out: AssetKey::Hdx,
                    price_numerator: 150,
                    price_denominator: 1,
                    dex_fee_bps: 25,
                    adapter: DestinationAdapter::HydrationSwapV1,
                    transact_weight: XcmWeight {
                        ref_time: 3_500_000_000,
                        proof_size: 120_000,
                    },
                },
            ],
            stake_routes: vec![StakeRoute {
                destination: ChainKey::Hydration,
                asset: AssetKey::Dot,
                adapter: DestinationAdapter::HydrationStakeV1,
                transact_weight: XcmWeight {
                    ref_time: 4_000_000_000,
                    proof_size: 140_000,
                },
            }],
            call_routes: vec![CallRoute {
                destination: ChainKey::Hydration,
                asset: AssetKey::Dot,
                adapter: DestinationAdapter::HydrationCallV1,
                transact_weight: XcmWeight {
                    ref_time: 3_000_000_000,
                    proof_size: 110_000,
                },
            }],
        }
    }
}

impl RouteRegistry {
    pub fn best_transfer_path(
        &self,
        source: ChainKey,
        destination: ChainKey,
        asset: AssetKey,
    ) -> Option<TransferPath> {
        let mut best_path: Option<TransferPath> = None;
        let mut current_route = vec![source];
        let mut current_hops = Vec::new();

        self.explore_transfer_paths(
            source,
            destination,
            asset,
            &mut current_route,
            &mut current_hops,
            &mut best_path,
        );

        best_path
    }

    pub fn swap_route(
        &self,
        destination: ChainKey,
        asset_in: AssetKey,
        asset_out: AssetKey,
    ) -> Option<SwapRoute> {
        self.swap_routes.iter().copied().find(|route| {
            route.destination == destination
                && route.asset_in == asset_in
                && route.asset_out == asset_out
        })
    }

    pub fn stake_route(&self, destination: ChainKey, asset: AssetKey) -> Option<StakeRoute> {
        self.stake_routes
            .iter()
            .copied()
            .find(|route| route.destination == destination && route.asset == asset)
    }

    pub fn call_route(&self, destination: ChainKey, asset: AssetKey) -> Option<CallRoute> {
        self.call_routes
            .iter()
            .copied()
            .find(|route| route.destination == destination && route.asset == asset)
    }

    fn explore_transfer_paths(
        &self,
        current: ChainKey,
        destination: ChainKey,
        asset: AssetKey,
        current_route: &mut Vec<ChainKey>,
        current_hops: &mut Vec<TransferEdge>,
        best_path: &mut Option<TransferPath>,
    ) {
        if current == destination {
            let candidate = transfer_path_from_hops(current_route, current_hops);

            if best_path
                .as_ref()
                .map(|existing| candidate.total_cost() < existing.total_cost())
                .unwrap_or(true)
            {
                *best_path = Some(candidate);
            }
            return;
        }

        for edge in self
            .transfer_edges
            .iter()
            .copied()
            .filter(|edge| edge.source == current && edge.asset == asset)
        {
            if current_route.contains(&edge.destination) {
                continue;
            }

            current_route.push(edge.destination);
            current_hops.push(edge);
            self.explore_transfer_paths(
                edge.destination,
                destination,
                asset,
                current_route,
                current_hops,
                best_path,
            );
            current_hops.pop();
            current_route.pop();
        }
    }
}

impl TransferPath {
    pub fn total_cost(&self) -> u128 {
        self.xcm_fee
            .amount
            .saturating_add(self.destination_fee.amount)
    }
}

fn transfer_path_from_hops(route: &[ChainKey], hops: &[TransferEdge]) -> TransferPath {
    let xcm_fee = hops.iter().fold(0u128, |total, hop| {
        total.saturating_add(hop.transport_fee.amount)
    });
    let destination_fee = hops.iter().fold(0u128, |total, hop| {
        total.saturating_add(hop.buy_execution_fee.amount)
    });

    TransferPath {
        route: route.to_vec(),
        hops: hops.to_vec(),
        xcm_fee: AssetAmount::new(AssetKey::Dot, xcm_fee),
        destination_fee: AssetAmount::new(AssetKey::Dot, destination_fee),
    }
}
