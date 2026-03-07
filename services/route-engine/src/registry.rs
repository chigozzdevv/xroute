use crate::model::{AssetAmount, AssetKey, ChainKey, ExecutionType, RouteHop};
use std::cmp::Ordering;
use std::collections::BinaryHeap;

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
}

#[derive(Debug, Clone)]
pub struct RouteRegistry {
    transfer_edges: Vec<TransferEdge>,
    swap_routes: Vec<SwapRoute>,
    execute_capabilities: Vec<ExecuteCapability>,
}

impl Default for RouteRegistry {
    fn default() -> Self {
        Self {
            transfer_edges: vec![
                TransferEdge {
                    source: ChainKey::PolkadotHub,
                    destination: ChainKey::Hydration,
                    asset: AssetKey::Dot,
                    transport_fee: AssetAmount::new(AssetKey::Dot, 150_000_000),
                    buy_execution_fee: AssetAmount::new(AssetKey::Dot, 90_000_000),
                },
                TransferEdge {
                    source: ChainKey::Hydration,
                    destination: ChainKey::PolkadotHub,
                    asset: AssetKey::Dot,
                    transport_fee: AssetAmount::new(AssetKey::Dot, 150_000_000),
                    buy_execution_fee: AssetAmount::new(AssetKey::Dot, 90_000_000),
                },
                TransferEdge {
                    source: ChainKey::Hydration,
                    destination: ChainKey::PolkadotHub,
                    asset: AssetKey::Usdt,
                    transport_fee: AssetAmount::new(AssetKey::Usdt, 25_000),
                    buy_execution_fee: AssetAmount::new(AssetKey::Usdt, 10_000),
                },
                TransferEdge {
                    source: ChainKey::Hydration,
                    destination: ChainKey::PolkadotHub,
                    asset: AssetKey::Hdx,
                    transport_fee: AssetAmount::new(AssetKey::Hdx, 50_000_000_000),
                    buy_execution_fee: AssetAmount::new(AssetKey::Hdx, 20_000_000_000),
                },
                TransferEdge {
                    source: ChainKey::PolkadotHub,
                    destination: ChainKey::Moonbeam,
                    asset: AssetKey::Dot,
                    transport_fee: AssetAmount::new(AssetKey::Dot, 180_000_000),
                    buy_execution_fee: AssetAmount::new(AssetKey::Dot, 110_000_000),
                },
                TransferEdge {
                    source: ChainKey::Moonbeam,
                    destination: ChainKey::PolkadotHub,
                    asset: AssetKey::Dot,
                    transport_fee: AssetAmount::new(AssetKey::Dot, 180_000_000),
                    buy_execution_fee: AssetAmount::new(AssetKey::Dot, 110_000_000),
                },
                TransferEdge {
                    source: ChainKey::PolkadotHub,
                    destination: ChainKey::Bifrost,
                    asset: AssetKey::Dot,
                    transport_fee: AssetAmount::new(AssetKey::Dot, 170_000_000),
                    buy_execution_fee: AssetAmount::new(AssetKey::Dot, 100_000_000),
                },
                TransferEdge {
                    source: ChainKey::PolkadotHub,
                    destination: ChainKey::Bifrost,
                    asset: AssetKey::Vdot,
                    transport_fee: AssetAmount::new(AssetKey::Vdot, 170_000_000),
                    buy_execution_fee: AssetAmount::new(AssetKey::Vdot, 100_000_000),
                },
                TransferEdge {
                    source: ChainKey::Bifrost,
                    destination: ChainKey::PolkadotHub,
                    asset: AssetKey::Dot,
                    transport_fee: AssetAmount::new(AssetKey::Dot, 170_000_000),
                    buy_execution_fee: AssetAmount::new(AssetKey::Dot, 100_000_000),
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
                },
                SwapRoute {
                    destination: ChainKey::Hydration,
                    asset_in: AssetKey::Dot,
                    asset_out: AssetKey::Hdx,
                    price_numerator: 150,
                    price_denominator: 1,
                    dex_fee_bps: 25,
                },
            ],
            execute_capabilities: vec![
                ExecuteCapability {
                    destination: ChainKey::Hydration,
                    asset: AssetKey::Dot,
                    execution_type: ExecutionType::RuntimeCall,
                },
                ExecuteCapability {
                    destination: ChainKey::Moonbeam,
                    asset: AssetKey::Dot,
                    execution_type: ExecutionType::RuntimeCall,
                },
                ExecuteCapability {
                    destination: ChainKey::Moonbeam,
                    asset: AssetKey::Dot,
                    execution_type: ExecutionType::EvmContractCall,
                },
                ExecuteCapability {
                    destination: ChainKey::Bifrost,
                    asset: AssetKey::Dot,
                    execution_type: ExecutionType::RuntimeCall,
                },
                ExecuteCapability {
                    destination: ChainKey::Bifrost,
                    asset: AssetKey::Dot,
                    execution_type: ExecutionType::VtokenOrder,
                },
                ExecuteCapability {
                    destination: ChainKey::Bifrost,
                    asset: AssetKey::Vdot,
                    execution_type: ExecutionType::VtokenOrder,
                },
            ],
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
        let mut frontier = BinaryHeap::new();
        frontier.push(PathCandidate::seed(source));

        while let Some(candidate) = frontier.pop() {
            if candidate.chain == destination {
                return Some(transfer_path_from_hops(asset, &candidate.route, &candidate.hops));
            }

            for edge in self
                .transfer_edges
                .iter()
                .copied()
                .filter(|edge| edge.source == candidate.chain && edge.asset == asset)
            {
                if candidate.route.contains(&edge.destination) {
                    continue;
                }

                let next_cost = candidate
                    .total_cost
                    .saturating_add(edge.transport_fee.amount)
                    .saturating_add(edge.buy_execution_fee.amount);
                let mut next_route = candidate.route.clone();
                next_route.push(edge.destination);
                let mut next_hops = candidate.hops.clone();
                next_hops.push(edge);

                frontier.push(PathCandidate {
                    chain: edge.destination,
                    route: next_route,
                    hops: next_hops,
                    total_cost: next_cost,
                });
            }
        }

        None
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

    pub fn supports_execute(
        &self,
        destination: ChainKey,
        asset: AssetKey,
        execution_type: ExecutionType,
    ) -> bool {
        self.execute_capabilities.iter().any(|capability| {
            capability.destination == destination
                && capability.asset == asset
                && capability.execution_type == execution_type
        })
    }

}

impl TransferPath {
    pub fn total_cost(&self) -> u128 {
        self.xcm_fee
            .amount
            .saturating_add(self.destination_fee.amount)
    }
}

fn transfer_path_from_hops(asset: AssetKey, route: &[ChainKey], hops: &[TransferEdge]) -> TransferPath {
    let xcm_fee = hops.iter().fold(0u128, |total, hop| {
        total.saturating_add(hop.transport_fee.amount)
    });
    let destination_fee = hops.iter().fold(0u128, |total, hop| {
        total.saturating_add(hop.buy_execution_fee.amount)
    });

    TransferPath {
        route: route.to_vec(),
        hops: hops.to_vec(),
        xcm_fee: AssetAmount::new(asset, xcm_fee),
        destination_fee: AssetAmount::new(asset, destination_fee),
    }
}

impl TransferEdge {
    pub const fn to_route_hop(self) -> RouteHop {
        RouteHop {
            source: self.source,
            destination: self.destination,
            asset: self.asset,
            transport_fee: self.transport_fee,
            buy_execution_fee: self.buy_execution_fee,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExecuteCapability {
    pub destination: ChainKey,
    pub asset: AssetKey,
    pub execution_type: ExecutionType,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PathCandidate {
    chain: ChainKey,
    route: Vec<ChainKey>,
    hops: Vec<TransferEdge>,
    total_cost: u128,
}

impl PathCandidate {
    fn seed(source: ChainKey) -> Self {
        Self {
            chain: source,
            route: vec![source],
            hops: Vec::new(),
            total_cost: 0,
        }
    }
}

impl Ord for PathCandidate {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .total_cost
            .cmp(&self.total_cost)
            .then_with(|| other.route.len().cmp(&self.route.len()))
            .then_with(|| route_key(&other.route).cmp(&route_key(&self.route)))
    }
}

impl PartialOrd for PathCandidate {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

fn route_key(route: &[ChainKey]) -> String {
    route
        .iter()
        .map(|chain| chain.as_str())
        .collect::<Vec<_>>()
        .join(">")
}
