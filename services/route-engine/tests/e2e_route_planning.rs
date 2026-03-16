use route_engine::{
    AssetKey, CallExecuteIntent, ChainKey, DeploymentProfile, EngineSettings, ExecuteIntent,
    Intent, IntentAction, RouteEngine, RouteRegistry, SwapIntent, TransferIntent,
    VdotOrderExecuteIntent, XcmInstruction, XcmWeight,
};

const REFUND_ADDRESS: &str = "0x1111111111111111111111111111111111111111";

fn mainnet_engine() -> RouteEngine {
    RouteEngine::new(
        RouteRegistry::for_profile(DeploymentProfile::Mainnet),
        EngineSettings {
            platform_fee_bps: 10,
            deployment_profile: DeploymentProfile::Mainnet,
        },
    )
}

#[test]
fn quotes_hub_to_hydration_transfer_on_mainnet() {
    let engine = mainnet_engine();
    let intent = Intent {
        source_chain: ChainKey::PolkadotHub,
        destination_chain: ChainKey::Hydration,
        action: IntentAction::Transfer(TransferIntent {
            asset: AssetKey::Dot,
            amount: AssetKey::Dot.units(10),
            recipient: "5FhydrationRecipient".to_owned(),
        }),
        refund_address: REFUND_ADDRESS.to_owned(),
        deadline: 1_773_185_200,
    };

    let quote = engine
        .quote(intent)
        .expect("mainnet transfer quote should build");
    assert_eq!(quote.deployment_profile, DeploymentProfile::Mainnet);
    assert_eq!(
        quote.route,
        vec![ChainKey::PolkadotHub, ChainKey::Hydration]
    );
    assert_eq!(quote.submission.asset, AssetKey::Dot);
}

#[test]
fn quotes_bifrost_as_a_hub_centered_source_spoke() {
    let engine = mainnet_engine();
    let intent = Intent {
        source_chain: ChainKey::Bifrost,
        destination_chain: ChainKey::Moonbeam,
        action: IntentAction::Execute(ExecuteIntent::Call(CallExecuteIntent {
            asset: AssetKey::Dot,
            max_payment_amount: 250_000_000,
            contract_address: "0x1111111111111111111111111111111111111111".to_owned(),
            calldata: "0xdeadbeef".to_owned(),
            value: 0,
            gas_limit: 250_000,
            fallback_weight: XcmWeight {
                ref_time: 650_000_000,
                proof_size: 12_288,
            },
        })),
        refund_address: REFUND_ADDRESS.to_owned(),
        deadline: 1_773_185_200,
    };

    let quote = engine
        .quote(intent)
        .expect("bifrost execute quote should build");
    assert_eq!(
        quote.route,
        vec![ChainKey::Bifrost, ChainKey::PolkadotHub, ChainKey::Moonbeam]
    );
    assert_eq!(quote.submission.asset, AssetKey::Dot);
}

#[test]
fn quotes_multihop_transfer_from_moonbeam_to_hydration() {
    let engine = mainnet_engine();
    let intent = Intent {
        source_chain: ChainKey::Moonbeam,
        destination_chain: ChainKey::Hydration,
        action: IntentAction::Transfer(TransferIntent {
            asset: AssetKey::Dot,
            amount: AssetKey::Dot.units(25),
            recipient: "5FmoonbeamHydrationRecipient".to_owned(),
        }),
        refund_address: REFUND_ADDRESS.to_owned(),
        deadline: 1_773_185_200,
    };

    let quote = engine
        .quote(intent)
        .expect("multihop transfer should build");
    assert_eq!(
        quote.route,
        vec![
            ChainKey::Moonbeam,
            ChainKey::PolkadotHub,
            ChainKey::Hydration
        ]
    );
}

#[test]
fn quotes_multihop_swap_from_moonbeam_to_hydration_with_hub_settlement() {
    let engine = mainnet_engine();
    let intent = Intent {
        source_chain: ChainKey::Moonbeam,
        destination_chain: ChainKey::Hydration,
        action: IntentAction::Swap(SwapIntent {
            asset_in: AssetKey::Dot,
            asset_out: AssetKey::Usdt,
            amount_in: AssetKey::Dot.units(10),
            min_amount_out: AssetKey::Usdt.units(49),
            settlement_chain: ChainKey::PolkadotHub,
            recipient: "5FhubSwapRecipient".to_owned(),
        }),
        refund_address: REFUND_ADDRESS.to_owned(),
        deadline: 1_773_185_200,
    };

    let quote = engine.quote(intent).expect("multihop swap should build");
    assert_eq!(
        quote.route,
        vec![
            ChainKey::Moonbeam,
            ChainKey::PolkadotHub,
            ChainKey::Hydration,
            ChainKey::PolkadotHub,
        ]
    );
    assert_eq!(quote.expected_output.asset, AssetKey::Usdt);
}

#[test]
fn quotes_multihop_execute_evm_contract_call_on_moonbeam() {
    let engine = mainnet_engine();
    let intent = Intent {
        source_chain: ChainKey::Hydration,
        destination_chain: ChainKey::Moonbeam,
        action: IntentAction::Execute(ExecuteIntent::Call(CallExecuteIntent {
            asset: AssetKey::Dot,
            max_payment_amount: 200_000_000,
            contract_address: "0x1111111111111111111111111111111111111111".to_owned(),
            calldata: "0xdeadbeef".to_owned(),
            value: 0,
            gas_limit: 250_000,
            fallback_weight: XcmWeight {
                ref_time: 650_000_000,
                proof_size: 12_288,
            },
        })),
        refund_address: REFUND_ADDRESS.to_owned(),
        deadline: 1_773_185_200,
    };

    let quote = engine
        .quote(intent)
        .expect("mainnet evm execute should build");
    assert_eq!(
        quote.route,
        vec![
            ChainKey::Hydration,
            ChainKey::PolkadotHub,
            ChainKey::Moonbeam
        ]
    );

    match &quote.execution_plan.steps[4] {
        route_engine::PlanStep::SendXcm { instructions, .. } => {
            assert!(instructions.iter().any(|instruction| matches!(instruction, XcmInstruction::InitiateReserveWithdraw { reserve, .. } if *reserve == ChainKey::PolkadotHub)));
        }
        other => panic!("expected SendXcm step, got {other:?}"),
    }
}

#[test]
fn rejects_mint_vdot_order_submission_without_live_pricing() {
    let engine = mainnet_engine();
    let intent = Intent {
        source_chain: ChainKey::Hydration,
        destination_chain: ChainKey::Moonbeam,
        action: IntentAction::Execute(ExecuteIntent::MintVdot(VdotOrderExecuteIntent {
            amount: AssetKey::Dot.units(1),
            max_payment_amount: 200_000_000,
            recipient: "0x1111111111111111111111111111111111111111".to_owned(),
            adapter_address: "0x2222222222222222222222222222222222222222".to_owned(),
            gas_limit: 500_000,
            fallback_weight: XcmWeight {
                ref_time: 650_000_000,
                proof_size: 12_288,
            },
            remark: "xroute".to_owned(),
            channel_id: 0,
        })),
        refund_address: REFUND_ADDRESS.to_owned(),
        deadline: 1_773_185_200,
    };

    let error = engine
        .quote(intent)
        .expect_err("mint-vdot should stay disabled until live pricing is loaded");
    assert!(matches!(
        error,
        route_engine::RouteError::UnsupportedExecuteRoute { .. }
    ));
}

#[test]
fn rejects_redeem_vdot_without_a_supported_execution_budget_asset() {
    let engine = mainnet_engine();
    let intent = Intent {
        source_chain: ChainKey::Bifrost,
        destination_chain: ChainKey::Moonbeam,
        action: IntentAction::Execute(ExecuteIntent::RedeemVdot(VdotOrderExecuteIntent {
            amount: AssetKey::Vdot.units(1),
            max_payment_amount: 200_000_000,
            recipient: "0x1111111111111111111111111111111111111111".to_owned(),
            adapter_address: "0x2222222222222222222222222222222222222222".to_owned(),
            gas_limit: 500_000,
            fallback_weight: XcmWeight {
                ref_time: 650_000_000,
                proof_size: 12_288,
            },
            remark: "xroute".to_owned(),
            channel_id: 0,
        })),
        refund_address: REFUND_ADDRESS.to_owned(),
        deadline: 1_773_185_200,
    };

    let error = engine
        .quote(intent)
        .expect_err("redeem-vdot should be rejected until fee asset support is added");
    assert!(matches!(
        error,
        route_engine::RouteError::UnsupportedExecuteRoute { .. }
    ));
}
