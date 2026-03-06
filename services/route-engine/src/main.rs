use route_engine::{AssetKey, ChainKey, Intent, IntentAction, RouteEngine, SwapIntent};

fn main() {
    let engine = RouteEngine::default();
    let intent = Intent {
        source_chain: ChainKey::PolkadotHub,
        destination_chain: ChainKey::Hydration,
        action: IntentAction::Swap(SwapIntent {
            asset_in: AssetKey::Dot,
            asset_out: AssetKey::Usdt,
            amount_in: AssetKey::Dot.units(100),
            min_amount_out: AssetKey::Usdt.units(490),
            recipient: "5FxrouteRecipient".to_owned(),
        }),
        refund_address: "5FxrouteRefund".to_owned(),
        deadline: 1_773_185_200,
    };

    match engine.quote(intent) {
        Ok(quote) => println!("{quote:#?}"),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
