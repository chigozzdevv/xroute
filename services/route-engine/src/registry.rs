use crate::model::{AssetAmount, AssetKey, ChainKey, DeploymentProfile, ExecutionType, RouteHop};
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

impl TransferEdge {
    pub fn to_route_hop(self) -> RouteHop {
        RouteHop {
            source: self.source,
            destination: self.destination,
            asset: self.asset,
            transport_fee: self.transport_fee,
            buy_execution_fee: self.buy_execution_fee,
        }
    }
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExecuteRoute {
    pub destination: ChainKey,
    pub asset: AssetKey,
    pub execution_type: ExecutionType,
    pub execution_budget: AssetAmount,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VdotOrderPricing {
    pub pool_asset_amount: u128,
    pub pool_vasset_amount: u128,
    pub mint_fee_bps: u16,
    pub redeem_fee_bps: u16,
}

#[derive(Debug, Clone)]
pub struct RouteRegistry {
    transfer_edges: Vec<TransferEdge>,
    swap_routes: Vec<SwapRoute>,
    execute_routes: Vec<ExecuteRoute>,
    execute_capabilities: Vec<ExecuteCapability>,
    vdot_order_pricing: Option<VdotOrderPricing>,
}

impl Default for RouteRegistry {
    fn default() -> Self {
        Self::for_profile(DeploymentProfile::Mainnet)
    }
}

impl RouteRegistry {
    pub fn for_profile(_profile: DeploymentProfile) -> Self {
        Self::mainnet()
    }

    fn mainnet() -> Self {
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
                    source: ChainKey::Bifrost,
                    destination: ChainKey::PolkadotHub,
                    asset: AssetKey::Dot,
                    transport_fee: AssetAmount::new(AssetKey::Dot, 170_000_000),
                    buy_execution_fee: AssetAmount::new(AssetKey::Dot, 100_000_000),
                },
                TransferEdge {
                    source: ChainKey::Moonbeam,
                    destination: ChainKey::Bifrost,
                    asset: AssetKey::Bnc,
                    transport_fee: AssetAmount::new(AssetKey::Bnc, 1_000_000_000),
                    buy_execution_fee: AssetAmount::new(AssetKey::Bnc, 500_000_000),
                },
                TransferEdge {
                    source: ChainKey::Bifrost,
                    destination: ChainKey::Moonbeam,
                    asset: AssetKey::Bnc,
                    transport_fee: AssetAmount::new(AssetKey::Bnc, 1_000_000_000),
                    buy_execution_fee: AssetAmount::new(AssetKey::Bnc, 500_000_000),
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
            execute_routes: vec![],
            execute_capabilities: vec![ExecuteCapability {
                destination: ChainKey::Moonbeam,
                asset: AssetKey::Dot,
                execution_type: ExecutionType::Call,
            }],
            vdot_order_pricing: None,
        }
    }

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
                return Some(transfer_path_from_hops(
                    asset,
                    &candidate.route,
                    &candidate.hops,
                ));
            }

            if candidate.chain != source
                && candidate.chain != destination
                && !allows_transit(candidate.chain)
            {
                continue;
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

    pub fn execute_budget(
        &self,
        destination: ChainKey,
        asset: AssetKey,
        execution_type: ExecutionType,
    ) -> Option<AssetAmount> {
        self.execute_routes
            .iter()
            .copied()
            .find(|route| {
                route.destination == destination
                    && route.asset == asset
                    && route.execution_type == execution_type
            })
            .map(|route| route.execution_budget)
    }

    pub fn quote_vdot_order(
        &self,
        execution_type: ExecutionType,
        amount: u128,
    ) -> Option<AssetAmount> {
        let pricing = self.vdot_order_pricing?;
        let fee_bps = match execution_type {
            ExecutionType::MintVdot => pricing.mint_fee_bps as u128,
            ExecutionType::RedeemVdot => pricing.redeem_fee_bps as u128,
            _ => return None,
        };
        let net_amount = amount.saturating_sub(amount.saturating_mul(fee_bps) / 10_000);
        let quoted_amount = match execution_type {
            ExecutionType::MintVdot => {
                net_amount.saturating_mul(pricing.pool_vasset_amount) / pricing.pool_asset_amount
            }
            ExecutionType::RedeemVdot => {
                net_amount.saturating_mul(pricing.pool_asset_amount) / pricing.pool_vasset_amount
            }
            _ => unreachable!(),
        };

        Some(match execution_type {
            ExecutionType::MintVdot => AssetAmount::new(AssetKey::Vdot, quoted_amount),
            ExecutionType::RedeemVdot => AssetAmount::new(AssetKey::Dot, quoted_amount),
            _ => unreachable!(),
        })
    }

    pub fn override_transfer_edge(
        &mut self,
        source: ChainKey,
        destination: ChainKey,
        asset: AssetKey,
        transport_fee: u128,
        buy_execution_fee: u128,
    ) -> Result<(), String> {
        let existing = self
            .transfer_edges
            .iter_mut()
            .find(|edge| {
                edge.source == source && edge.destination == destination && edge.asset == asset
            })
            .ok_or_else(|| {
                format!(
                    "missing transfer edge {source} -> {destination} for {}",
                    asset.symbol()
                )
            })?;
        existing.transport_fee = AssetAmount::new(asset, transport_fee);
        existing.buy_execution_fee = AssetAmount::new(asset, buy_execution_fee);
        Ok(())
    }

    pub fn override_swap_route(
        &mut self,
        destination: ChainKey,
        asset_in: AssetKey,
        asset_out: AssetKey,
        price_numerator: u128,
        price_denominator: u128,
        dex_fee_bps: u16,
    ) -> Result<(), String> {
        let existing = self
            .swap_routes
            .iter_mut()
            .find(|route| {
                route.destination == destination
                    && route.asset_in == asset_in
                    && route.asset_out == asset_out
            })
            .ok_or_else(|| {
                format!(
                    "missing swap route on {destination} for {}->{}",
                    asset_in.symbol(),
                    asset_out.symbol()
                )
            })?;
        existing.price_numerator = price_numerator;
        existing.price_denominator = price_denominator;
        existing.dex_fee_bps = dex_fee_bps;
        Ok(())
    }

    pub fn override_execute_route(
        &mut self,
        destination: ChainKey,
        asset: AssetKey,
        execution_type: ExecutionType,
        execution_budget: u128,
    ) -> Result<(), String> {
        if let Some(existing) = self.execute_routes.iter_mut().find(|route| {
            route.destination == destination
                && route.asset == asset
                && route.execution_type == execution_type
        }) {
            existing.execution_budget = AssetAmount::new(asset, execution_budget);
            return Ok(());
        }

        self.execute_routes.push(ExecuteRoute {
            destination,
            asset,
            execution_type,
            execution_budget: AssetAmount::new(asset, execution_budget),
        });
        Ok(())
    }

    pub fn override_vdot_order_pricing(
        &mut self,
        pool_asset_amount: u128,
        pool_vasset_amount: u128,
        mint_fee_bps: u16,
        redeem_fee_bps: u16,
    ) -> Result<(), String> {
        if pool_asset_amount == 0 || pool_vasset_amount == 0 {
            return Err("vdot order pricing pools must be greater than zero".to_owned());
        }

        self.vdot_order_pricing = Some(VdotOrderPricing {
            pool_asset_amount,
            pool_vasset_amount,
            mint_fee_bps,
            redeem_fee_bps,
        });
        Ok(())
    }
}

fn transfer_path_from_hops(
    asset: AssetKey,
    route: &[ChainKey],
    hops: &[TransferEdge],
) -> TransferPath {
    let xcm_fee = hops
        .iter()
        .enumerate()
        .map(|(index, hop)| {
            hop.transport_fee.amount
                + if index + 1 < hops.len() {
                    hop.buy_execution_fee.amount
                } else {
                    0
                }
        })
        .sum::<u128>();
    let destination_fee = hops
        .last()
        .map(|hop| hop.buy_execution_fee.amount)
        .unwrap_or_default();

    TransferPath {
        route: route.to_vec(),
        hops: hops.to_vec(),
        xcm_fee: AssetAmount::new(asset, xcm_fee),
        destination_fee: AssetAmount::new(asset, destination_fee),
    }
}

impl TransferPath {
    pub fn route_hops(&self) -> Vec<RouteHop> {
        self.hops
            .iter()
            .map(|hop| RouteHop {
                source: hop.source,
                destination: hop.destination,
                asset: hop.asset,
                transport_fee: hop.transport_fee,
                buy_execution_fee: hop.buy_execution_fee,
            })
            .collect()
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

fn allows_transit(_chain: ChainKey) -> bool {
    true
}
