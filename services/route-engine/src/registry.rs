use crate::model::{AssetAmount, AssetKey, ChainKey};

#[derive(Debug, Clone, Copy)]
pub struct TransferRoute {
    pub source: ChainKey,
    pub destination: ChainKey,
    pub asset: AssetKey,
    pub xcm_fee: AssetAmount,
    pub destination_fee: AssetAmount,
}

#[derive(Debug, Clone, Copy)]
pub struct SwapRoute {
    pub source: ChainKey,
    pub destination: ChainKey,
    pub asset_in: AssetKey,
    pub asset_out: AssetKey,
    pub xcm_fee: AssetAmount,
    pub destination_fee: AssetAmount,
    pub price_numerator: u128,
    pub price_denominator: u128,
    pub dex_fee_bps: u16,
}

#[derive(Debug, Clone)]
pub struct RouteRegistry {
    transfer_routes: Vec<TransferRoute>,
    swap_routes: Vec<SwapRoute>,
}

impl Default for RouteRegistry {
    fn default() -> Self {
        Self {
            transfer_routes: vec![
                TransferRoute {
                    source: ChainKey::PolkadotHub,
                    destination: ChainKey::AssetHub,
                    asset: AssetKey::Dot,
                    xcm_fee: AssetAmount::new(AssetKey::Dot, 100_000_000),
                    destination_fee: AssetAmount::new(AssetKey::Dot, 20_000_000),
                },
                TransferRoute {
                    source: ChainKey::PolkadotHub,
                    destination: ChainKey::Hydration,
                    asset: AssetKey::Dot,
                    xcm_fee: AssetAmount::new(AssetKey::Dot, 150_000_000),
                    destination_fee: AssetAmount::new(AssetKey::Dot, 60_000_000),
                },
            ],
            swap_routes: vec![SwapRoute {
                source: ChainKey::PolkadotHub,
                destination: ChainKey::Hydration,
                asset_in: AssetKey::Dot,
                asset_out: AssetKey::Usdt,
                xcm_fee: AssetAmount::new(AssetKey::Dot, 150_000_000),
                destination_fee: AssetAmount::new(AssetKey::Dot, 100_000_000),
                price_numerator: 495,
                price_denominator: 100,
                dex_fee_bps: 30,
            }],
        }
    }
}

impl RouteRegistry {
    pub fn transfer_route(
        &self,
        source: ChainKey,
        destination: ChainKey,
        asset: AssetKey,
    ) -> Option<&TransferRoute> {
        self.transfer_routes.iter().find(|route| {
            route.source == source && route.destination == destination && route.asset == asset
        })
    }

    pub fn swap_route(
        &self,
        source: ChainKey,
        destination: ChainKey,
        asset_in: AssetKey,
        asset_out: AssetKey,
    ) -> Option<&SwapRoute> {
        self.swap_routes.iter().find(|route| {
            route.source == source
                && route.destination == destination
                && route.asset_in == asset_in
                && route.asset_out == asset_out
        })
    }
}
