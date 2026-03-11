use route_engine::{
    AssetAmount, AssetKey, ChainKey, DeploymentProfile, EngineSettings,
    EvmContractCallExecuteIntent, ExecuteIntent, FeeType, Intent, IntentAction, PlanStep,
    RouteEngine, RouteRegistry, RouteSegmentKind, RuntimeCallExecuteIntent, RuntimeCallOriginKind,
    SubmissionAction, SwapIntent, TransferIntent, VtokenOrderExecuteIntent, VtokenOrderOperation,
    XcmInstruction, XcmWeight,
};

const REFUND_ADDRESS: &str = "0x1111111111111111111111111111111111111111";

fn engine_for_profile(profile: DeploymentProfile) -> RouteEngine {
    RouteEngine::new(
        RouteRegistry::for_profile(profile),
        EngineSettings {
            platform_fee_bps: 10,
            deployment_profile: profile,
        },
    )
}

fn mainnet_engine() -> RouteEngine {
    engine_for_profile(DeploymentProfile::Mainnet)
}

fn paseo_engine() -> RouteEngine {
    engine_for_profile(DeploymentProfile::Paseo)
}

fn integration_engine() -> RouteEngine {
    engine_for_profile(DeploymentProfile::Integration)
}

fn hydration_snakenet_engine() -> RouteEngine {
    engine_for_profile(DeploymentProfile::HydrationSnakenet)
}

fn moonbase_alpha_engine() -> RouteEngine {
    engine_for_profile(DeploymentProfile::MoonbaseAlpha)
}

fn core_multihop_engine() -> RouteEngine {
    engine_for_profile(DeploymentProfile::CoreMultihop)
}

fn bifrost_via_hydration_engine() -> RouteEngine {
    engine_for_profile(DeploymentProfile::BifrostViaHydration)
}

fn bifrost_via_moonbase_alpha_engine() -> RouteEngine {
    engine_for_profile(DeploymentProfile::BifrostViaMoonbeam)
}

#[test]
fn quotes_hydration_swap_over_a_multihop_path() {
    let engine = mainnet_engine();
    let intent = Intent {
        source_chain: ChainKey::PolkadotHub,
        destination_chain: ChainKey::Hydration,
        action: IntentAction::Swap(SwapIntent {
            asset_in: AssetKey::Dot,
            asset_out: AssetKey::Usdt,
            amount_in: AssetKey::Dot.units(100),
            min_amount_out: AssetKey::Usdt.units(490),
            settlement_chain: ChainKey::Hydration,
            recipient: "5FswapRecipient".to_owned(),
        }),
        refund_address: REFUND_ADDRESS.to_owned(),
        deadline: 1_773_185_200,
    };

    let quote = engine.quote(intent).expect("swap quote should build");

    assert_eq!(quote.deployment_profile, DeploymentProfile::Mainnet);
    assert_eq!(
        quote.route,
        vec![ChainKey::PolkadotHub, ChainKey::Hydration]
    );
    assert_eq!(quote.segments.len(), 1);
    assert_eq!(quote.segments[0].kind, RouteSegmentKind::Execution);
    assert_eq!(quote.segments[0].route, quote.route);
    assert_eq!(quote.fees.xcm_fee.amount, 150_000_000);
    assert_eq!(quote.fees.destination_fee.amount, 90_000_000);
    assert_eq!(quote.fees.platform_fee.amount, 1_000_000_000);
    assert_eq!(quote.fees.total_fee.amount, 1_240_000_000);
    assert!(quote.estimated_settlement_fee.is_none());
    assert_eq!(quote.expected_output.asset, AssetKey::Usdt);
    assert_eq!(quote.expected_output.amount, 493_515_000);
    assert_eq!(quote.min_output.expect("min output").amount, 490_000_000);
    assert_eq!(quote.submission.action, SubmissionAction::Swap);
    assert_eq!(quote.submission.asset, AssetKey::Dot);
    assert_eq!(quote.submission.amount, 1_000_000_000_000);
    assert_eq!(quote.submission.xcm_fee, 150_000_000);
    assert_eq!(quote.submission.destination_fee, 90_000_000);
    assert_eq!(quote.submission.min_output_amount, 490_000_000);

    assert_eq!(
        quote.execution_plan.steps[0],
        PlanStep::LockAsset {
            chain: ChainKey::PolkadotHub,
            asset: AssetKey::Dot,
            amount: 1_001_240_000_000,
        }
    );
    assert_eq!(
        quote.execution_plan.steps[1],
        PlanStep::ChargeFee {
            fee_type: FeeType::Platform,
            asset: AssetKey::Dot,
            amount: 1_000_000_000,
        }
    );

    let outer_transfer = first_transfer_instruction(&quote.execution_plan.steps[4]);
    assert_eq!(outer_transfer.destination(), ChainKey::Hydration);
    assert_eq!(outer_transfer.amount(), 1_000_000_000_000);
    assert_eq!(
        outer_transfer.remote_instructions()[0],
        XcmInstruction::BuyExecution {
            asset: AssetKey::Dot,
            amount: 90_000_000,
        }
    );
    assert_eq!(
        outer_transfer.remote_instructions()[1],
        XcmInstruction::ExchangeAsset {
            asset_in: AssetKey::Dot,
            amount_in: 1_000_000_000_000,
            asset_out: AssetKey::Usdt,
            min_amount_out: 490_000_000,
            maximal: true,
        }
    );
    assert_eq!(
        outer_transfer.remote_instructions()[2],
        XcmInstruction::DepositAsset {
            asset: AssetKey::Usdt,
            recipient: "5FswapRecipient".to_owned(),
            asset_count: 2,
        }
    );
}

#[test]
fn quotes_hydration_swap_and_settles_on_polkadot_hub() {
    let engine = mainnet_engine();
    let intent = Intent {
        source_chain: ChainKey::PolkadotHub,
        destination_chain: ChainKey::Hydration,
        action: IntentAction::Swap(SwapIntent {
            asset_in: AssetKey::Dot,
            asset_out: AssetKey::Usdt,
            amount_in: AssetKey::Dot.units(100),
            min_amount_out: AssetKey::Usdt.units(493),
            settlement_chain: ChainKey::PolkadotHub,
            recipient: "5FhubRecipient".to_owned(),
        }),
        refund_address: REFUND_ADDRESS.to_owned(),
        deadline: 1_773_185_200,
    };

    let quote = engine.quote(intent).expect("swap quote should build");

    assert_eq!(
        quote.route,
        vec![
            ChainKey::PolkadotHub,
            ChainKey::Hydration,
            ChainKey::PolkadotHub,
        ]
    );
    assert_eq!(quote.segments.len(), 2);
    assert_eq!(quote.segments[0].kind, RouteSegmentKind::Execution);
    assert_eq!(quote.segments[1].kind, RouteSegmentKind::Settlement);
    assert_eq!(
        quote.segments[1].route,
        vec![ChainKey::Hydration, ChainKey::PolkadotHub]
    );
    assert_eq!(
        quote.estimated_settlement_fee,
        Some(AssetAmount::new(AssetKey::Usdt, 35_000))
    );
    assert_eq!(
        quote.expected_output,
        AssetAmount::new(AssetKey::Usdt, 493_480_000)
    );
    assert_eq!(quote.min_output.expect("min output").amount, 493_000_000);
    assert_eq!(
        quote.execution_plan.steps[5],
        PlanStep::ExpectSettlement {
            chain: ChainKey::PolkadotHub,
            asset: AssetKey::Usdt,
            recipient: "5FhubRecipient".to_owned(),
            minimum_amount: Some(493_000_000),
        }
    );

    let outer_transfer = first_transfer_instruction(&quote.execution_plan.steps[4]);
    assert_eq!(outer_transfer.remote_instructions().len(), 3);
    assert_eq!(
        outer_transfer.remote_instructions()[1],
        XcmInstruction::ExchangeAsset {
            asset_in: AssetKey::Dot,
            amount_in: 1_000_000_000_000,
            asset_out: AssetKey::Usdt,
            min_amount_out: 493_000_000,
            maximal: true,
        }
    );

    let settlement = &outer_transfer.remote_instructions()[2];
    assert_eq!(
        *settlement,
        XcmInstruction::InitiateReserveWithdraw {
            asset_count: 2,
            reserve: ChainKey::PolkadotHub,
            remote_instructions: vec![
                XcmInstruction::BuyExecution {
                    asset: AssetKey::Usdt,
                    amount: 10_000,
                },
                XcmInstruction::DepositAsset {
                    asset: AssetKey::Usdt,
                    recipient: "5FhubRecipient".to_owned(),
                    asset_count: 2,
                },
            ],
        }
    );
}

#[test]
fn quotes_asset_transfer_and_builds_delivery_plan() {
    let engine = mainnet_engine();
    let intent = Intent {
        source_chain: ChainKey::PolkadotHub,
        destination_chain: ChainKey::Hydration,
        action: IntentAction::Transfer(TransferIntent {
            asset: AssetKey::Dot,
            amount: AssetKey::Dot.units(25),
            recipient: "5FtransferRecipient".to_owned(),
        }),
        refund_address: REFUND_ADDRESS.to_owned(),
        deadline: 1_773_185_200,
    };

    let quote = engine.quote(intent).expect("transfer quote should build");

    assert_eq!(quote.deployment_profile, DeploymentProfile::Mainnet);
    assert_eq!(
        quote.route,
        vec![ChainKey::PolkadotHub, ChainKey::Hydration]
    );
    assert_eq!(quote.segments.len(), 1);
    assert_eq!(quote.fees.xcm_fee.amount, 150_000_000);
    assert_eq!(quote.fees.destination_fee.amount, 90_000_000);
    assert_eq!(quote.fees.platform_fee.amount, 250_000_000);
    assert_eq!(quote.fees.total_fee.amount, 490_000_000);
    assert_eq!(quote.expected_output.amount, 250_000_000_000);
    assert_eq!(quote.submission.action, SubmissionAction::Transfer);
    assert_eq!(quote.submission.asset, AssetKey::Dot);
    assert_eq!(quote.submission.amount, 250_000_000_000);
    assert_eq!(quote.submission.xcm_fee, 150_000_000);
    assert_eq!(quote.submission.destination_fee, 90_000_000);
    assert_eq!(quote.submission.min_output_amount, 250_000_000_000);

    let outer_transfer = first_transfer_instruction(&quote.execution_plan.steps[4]);
    assert_eq!(outer_transfer.destination(), ChainKey::Hydration);
    assert_eq!(
        outer_transfer.remote_instructions(),
        &vec![
            XcmInstruction::BuyExecution {
                asset: AssetKey::Dot,
                amount: 90_000_000,
            },
            XcmInstruction::DepositAsset {
                asset: AssetKey::Dot,
                recipient: "5FtransferRecipient".to_owned(),
                asset_count: 1,
            },
        ]
    );
}

#[test]
fn quotes_bifrost_transfer_and_builds_delivery_plan() {
    let engine = mainnet_engine();
    let intent = Intent {
        source_chain: ChainKey::PolkadotHub,
        destination_chain: ChainKey::Bifrost,
        action: IntentAction::Transfer(TransferIntent {
            asset: AssetKey::Dot,
            amount: AssetKey::Dot.units(25),
            recipient: "5FbifrostRecipient".to_owned(),
        }),
        refund_address: REFUND_ADDRESS.to_owned(),
        deadline: 1_773_185_200,
    };

    let quote = engine.quote(intent).expect("transfer quote should build");

    assert_eq!(
        quote.route,
        vec![ChainKey::PolkadotHub, ChainKey::Moonbeam, ChainKey::Bifrost]
    );
    assert_eq!(quote.segments.len(), 1);
    assert_eq!(quote.fees.xcm_fee.amount, 310_000_000);
    assert_eq!(quote.fees.destination_fee.amount, 190_000_000);
    assert_eq!(quote.submission.action, SubmissionAction::Transfer);

    let outer_transfer = first_transfer_instruction(&quote.execution_plan.steps[4]);
    assert_eq!(outer_transfer.destination(), ChainKey::Moonbeam);
    assert_eq!(
        outer_transfer.remote_instructions(),
        &vec![
            XcmInstruction::BuyExecution {
                asset: AssetKey::Dot,
                amount: 110_000_000,
            },
            XcmInstruction::TransferReserveAsset {
                asset: AssetKey::Dot,
                amount: AssetKey::Dot.units(25),
                destination: ChainKey::Bifrost,
                remote_instructions: vec![
                    XcmInstruction::BuyExecution {
                        asset: AssetKey::Dot,
                        amount: 80_000_000,
                    },
                    XcmInstruction::DepositAsset {
                        asset: AssetKey::Dot,
                        recipient: "5FbifrostRecipient".to_owned(),
                        asset_count: 1,
                    },
                ],
            },
        ]
    );
}

#[test]
fn quotes_multihop_transfer_from_moonbeam_to_hydration() {
    let engine = mainnet_engine();
    let intent = Intent {
        source_chain: ChainKey::Moonbeam,
        destination_chain: ChainKey::Hydration,
        action: IntentAction::Transfer(TransferIntent {
            asset: AssetKey::Dot,
            amount: AssetKey::Dot.units(5),
            recipient: "5FmoonbeamHydrationRecipient".to_owned(),
        }),
        refund_address: REFUND_ADDRESS.to_owned(),
        deadline: 1_773_185_200,
    };

    let quote = engine
        .quote(intent)
        .expect("multihop transfer quote should build");

    assert_eq!(
        quote.route,
        vec![
            ChainKey::Moonbeam,
            ChainKey::PolkadotHub,
            ChainKey::Hydration
        ]
    );
    assert_eq!(quote.segments.len(), 1);
    assert_eq!(quote.submission.action, SubmissionAction::Transfer);
    assert_eq!(quote.fees.xcm_fee.amount, 330_000_000);
    assert_eq!(quote.fees.destination_fee.amount, 200_000_000);

    let outer_transfer = first_transfer_instruction(&quote.execution_plan.steps[4]);
    assert_eq!(outer_transfer.destination(), ChainKey::PolkadotHub);
    assert_eq!(
        outer_transfer.remote_instructions()[0],
        XcmInstruction::BuyExecution {
            asset: AssetKey::Dot,
            amount: 110_000_000,
        }
    );

    let nested_transfer = nested_transfer_instruction(outer_transfer, 1);
    assert_eq!(nested_transfer.destination(), ChainKey::Hydration);
    assert_eq!(
        nested_transfer.remote_instructions(),
        &vec![
            XcmInstruction::BuyExecution {
                asset: AssetKey::Dot,
                amount: 90_000_000,
            },
            XcmInstruction::DepositAsset {
                asset: AssetKey::Dot,
                recipient: "5FmoonbeamHydrationRecipient".to_owned(),
                asset_count: 1,
            },
        ]
    );
}

#[test]
fn quotes_core_multihop_transfer_from_moonbeam_to_hydration() {
    let engine = core_multihop_engine();
    let intent = Intent {
        source_chain: ChainKey::Moonbeam,
        destination_chain: ChainKey::Hydration,
        action: IntentAction::Transfer(TransferIntent {
            asset: AssetKey::Dot,
            amount: AssetKey::Dot.units(25),
            recipient: "5FcoreMultihopRecipient".to_owned(),
        }),
        refund_address: REFUND_ADDRESS.to_owned(),
        deadline: 1_773_185_200,
    };

    let quote = engine.quote(intent).expect("core multihop transfer should build");

    assert_eq!(quote.deployment_profile, DeploymentProfile::CoreMultihop);
    assert_eq!(
        quote.route,
        vec![ChainKey::Moonbeam, ChainKey::PolkadotHub, ChainKey::Hydration]
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

    let quote = engine
        .quote(intent)
        .expect("multihop swap quote should build");

    assert_eq!(
        quote.route,
        vec![
            ChainKey::Moonbeam,
            ChainKey::PolkadotHub,
            ChainKey::Hydration,
            ChainKey::PolkadotHub,
        ]
    );
    assert_eq!(quote.segments.len(), 2);
    assert_eq!(
        quote.segments[0].route,
        vec![
            ChainKey::Moonbeam,
            ChainKey::PolkadotHub,
            ChainKey::Hydration
        ]
    );
    assert_eq!(
        quote.segments[1].route,
        vec![ChainKey::Hydration, ChainKey::PolkadotHub]
    );

    let outer_transfer = first_transfer_instruction(&quote.execution_plan.steps[4]);
    assert_eq!(outer_transfer.destination(), ChainKey::PolkadotHub);
    let nested_transfer = nested_transfer_instruction(outer_transfer, 1);
    assert_eq!(nested_transfer.destination(), ChainKey::Hydration);
    assert!(matches!(
        nested_transfer.remote_instructions()[1],
        XcmInstruction::ExchangeAsset { .. }
    ));
    assert!(matches!(
        nested_transfer.remote_instructions()[2],
        XcmInstruction::InitiateReserveWithdraw { .. }
    ));
}

#[test]
fn quotes_core_multihop_swap_from_moonbeam_to_hydration_with_hub_settlement() {
    let engine = core_multihop_engine();
    let intent = Intent {
        source_chain: ChainKey::Moonbeam,
        destination_chain: ChainKey::Hydration,
        action: IntentAction::Swap(SwapIntent {
            asset_in: AssetKey::Dot,
            asset_out: AssetKey::Usdt,
            amount_in: AssetKey::Dot.units(10),
            min_amount_out: AssetKey::Usdt.units(49),
            settlement_chain: ChainKey::PolkadotHub,
            recipient: "5FcoreMultihopSwapRecipient".to_owned(),
        }),
        refund_address: REFUND_ADDRESS.to_owned(),
        deadline: 1_773_185_200,
    };

    let quote = engine.quote(intent).expect("core multihop swap should build");

    assert_eq!(quote.deployment_profile, DeploymentProfile::CoreMultihop);
    assert_eq!(
        quote.route,
        vec![
            ChainKey::Moonbeam,
            ChainKey::PolkadotHub,
            ChainKey::Hydration,
            ChainKey::PolkadotHub,
        ]
    );
}

#[test]
fn quotes_pas_transfer_on_paseo_people_route() {
    let engine = paseo_engine();
    let intent = Intent {
        source_chain: ChainKey::PolkadotHub,
        destination_chain: ChainKey::People,
        action: IntentAction::Transfer(TransferIntent {
            asset: AssetKey::Pas,
            amount: AssetKey::Pas.units(10),
            recipient: "5FpeopleRecipient".to_owned(),
        }),
        refund_address: REFUND_ADDRESS.to_owned(),
        deadline: 1_773_185_200,
    };

    let quote = engine
        .quote(intent)
        .expect("paseo transfer quote should build");
    assert_eq!(quote.deployment_profile, DeploymentProfile::Paseo);
    assert_eq!(quote.route, vec![ChainKey::PolkadotHub, ChainKey::People]);
    assert_eq!(quote.submission.asset, AssetKey::Pas);
    match &quote.execution_plan.steps[4] {
        PlanStep::SendXcm { instructions, .. } => {
            assert!(matches!(
                instructions[0],
                XcmInstruction::WithdrawAsset {
                    asset: AssetKey::Pas,
                    ..
                }
            ));
            assert!(matches!(
                instructions[1],
                XcmInstruction::PayFees {
                    asset: AssetKey::Pas,
                    amount: 100_000_000,
                }
            ));
            match &instructions[2] {
                XcmInstruction::InitiateTransfer {
                    asset,
                    amount,
                    destination,
                    remote_fee_asset,
                    remote_fee_amount,
                    preserve_origin,
                    remote_instructions,
                } => {
                    assert_eq!(*asset, AssetKey::Pas);
                    assert_eq!(*amount, AssetKey::Pas.units(10));
                    assert_eq!(*destination, ChainKey::People);
                    assert_eq!(*remote_fee_asset, AssetKey::Pas);
                    assert_eq!(*remote_fee_amount, 100_000_000);
                    assert!(!preserve_origin);
                    assert!(matches!(
                        remote_instructions[0],
                        XcmInstruction::DepositAsset { .. }
                    ));
                }
                other => panic!("unexpected instruction: {other:?}"),
            }
        }
        other => panic!("unexpected plan step: {other:?}"),
    }
}

#[test]
fn quotes_execute_runtime_call_on_hydration() {
    let engine = mainnet_engine();
    let intent = Intent {
        source_chain: ChainKey::PolkadotHub,
        destination_chain: ChainKey::Hydration,
        action: IntentAction::Execute(ExecuteIntent::RuntimeCall(RuntimeCallExecuteIntent {
            asset: AssetKey::Dot,
            max_payment_amount: 90_000_000,
            call_data: "0x01020304".to_owned(),
            origin_kind: RuntimeCallOriginKind::SovereignAccount,
            fallback_weight: XcmWeight {
                ref_time: 250_000_000,
                proof_size: 4_096,
            },
        })),
        refund_address: REFUND_ADDRESS.to_owned(),
        deadline: 1_773_185_200,
    };

    let quote = engine.quote(intent).expect("execute quote should build");

    assert_eq!(quote.deployment_profile, DeploymentProfile::Mainnet);
    assert_eq!(
        quote.route,
        vec![ChainKey::PolkadotHub, ChainKey::Hydration]
    );
    assert_eq!(quote.segments.len(), 1);
    assert_eq!(quote.submission.action, SubmissionAction::Execute);
    assert_eq!(quote.submission.asset, AssetKey::Dot);
    assert_eq!(quote.submission.amount, 90_000_000);
    assert_eq!(quote.submission.destination_fee, 0);
    assert_eq!(quote.expected_output, AssetAmount::new(AssetKey::Dot, 0));
    assert_eq!(quote.min_output, None);

    assert_eq!(
        quote.execution_plan.steps[0],
        PlanStep::LockAsset {
            chain: ChainKey::PolkadotHub,
            asset: AssetKey::Dot,
            amount: 240_090_000,
        }
    );

    let outer_transfer = first_transfer_instruction(&quote.execution_plan.steps[4]);
    assert_eq!(outer_transfer.destination(), ChainKey::Hydration);
    assert_eq!(outer_transfer.amount(), 90_000_000);
    assert_eq!(
        outer_transfer.remote_instructions()[0],
        XcmInstruction::BuyExecution {
            asset: AssetKey::Dot,
            amount: 90_000_000,
        }
    );
    assert_eq!(
        outer_transfer.remote_instructions()[1],
        XcmInstruction::Transact {
            origin_kind: RuntimeCallOriginKind::SovereignAccount,
            fallback_weight: XcmWeight {
                ref_time: 250_000_000,
                proof_size: 4_096,
            },
            call_data: "0x01020304".to_owned(),
        }
    );
}

#[test]
fn quotes_execute_runtime_call_on_moonbeam() {
    let engine = mainnet_engine();
    let intent = Intent {
        source_chain: ChainKey::PolkadotHub,
        destination_chain: ChainKey::Moonbeam,
        action: IntentAction::Execute(ExecuteIntent::RuntimeCall(RuntimeCallExecuteIntent {
            asset: AssetKey::Dot,
            max_payment_amount: 110_000_000,
            call_data: "0x05060708".to_owned(),
            origin_kind: RuntimeCallOriginKind::SovereignAccount,
            fallback_weight: XcmWeight {
                ref_time: 500_000_000,
                proof_size: 8_192,
            },
        })),
        refund_address: REFUND_ADDRESS.to_owned(),
        deadline: 1_773_185_200,
    };

    let quote = engine.quote(intent).expect("execute quote should build");

    assert_eq!(quote.route, vec![ChainKey::PolkadotHub, ChainKey::Moonbeam]);
    assert_eq!(quote.submission.action, SubmissionAction::Execute);
    assert_eq!(quote.submission.amount, 110_000_000);
    assert_eq!(
        quote.execution_plan.steps[0],
        PlanStep::LockAsset {
            chain: ChainKey::PolkadotHub,
            asset: AssetKey::Dot,
            amount: 290_110_000,
        }
    );

    let outer_transfer = first_transfer_instruction(&quote.execution_plan.steps[4]);
    assert_eq!(outer_transfer.destination(), ChainKey::Moonbeam);
    assert_eq!(
        outer_transfer.remote_instructions()[0],
        XcmInstruction::BuyExecution {
            asset: AssetKey::Dot,
            amount: 110_000_000,
        }
    );
    assert_eq!(
        outer_transfer.remote_instructions()[1],
        XcmInstruction::Transact {
            origin_kind: RuntimeCallOriginKind::SovereignAccount,
            fallback_weight: XcmWeight {
                ref_time: 500_000_000,
                proof_size: 8_192,
            },
            call_data: "0x05060708".to_owned(),
        }
    );
}

#[test]
fn quotes_multihop_execute_runtime_call_on_bifrost() {
    let engine = mainnet_engine();
    let intent = Intent {
        source_chain: ChainKey::Moonbeam,
        destination_chain: ChainKey::Bifrost,
        action: IntentAction::Execute(ExecuteIntent::RuntimeCall(RuntimeCallExecuteIntent {
            asset: AssetKey::Dot,
            max_payment_amount: 210_000_000,
            call_data: "0x09080706".to_owned(),
            origin_kind: RuntimeCallOriginKind::SovereignAccount,
            fallback_weight: XcmWeight {
                ref_time: 400_000_000,
                proof_size: 8_192,
            },
        })),
        refund_address: REFUND_ADDRESS.to_owned(),
        deadline: 1_773_185_200,
    };

    let quote = engine
        .quote(intent)
        .expect("multihop execute quote should build");

    assert_eq!(quote.route, vec![ChainKey::Moonbeam, ChainKey::Bifrost]);
    assert_eq!(quote.submission.action, SubmissionAction::Execute);
    assert_eq!(quote.submission.amount, 80_000_000);
    assert_eq!(quote.fees.xcm_fee.amount, 130_000_000);
    assert_eq!(quote.fees.destination_fee.amount, 0);

    let outer_transfer = first_transfer_instruction(&quote.execution_plan.steps[4]);
    assert_eq!(outer_transfer.destination(), ChainKey::Bifrost);
    assert_eq!(
        outer_transfer.remote_instructions()[0],
        XcmInstruction::BuyExecution {
            asset: AssetKey::Dot,
            amount: 80_000_000,
        }
    );
    assert_eq!(
        outer_transfer.remote_instructions()[1],
        XcmInstruction::Transact {
            origin_kind: RuntimeCallOriginKind::SovereignAccount,
            fallback_weight: XcmWeight {
                ref_time: 400_000_000,
                proof_size: 8_192,
            },
            call_data: "0x09080706".to_owned(),
        }
    );
}

#[test]
fn quotes_execute_evm_contract_call_on_moonbeam() {
    let engine = mainnet_engine();
    let intent = Intent {
        source_chain: ChainKey::PolkadotHub,
        destination_chain: ChainKey::Moonbeam,
        action: IntentAction::Execute(ExecuteIntent::EvmContractCall(
            EvmContractCallExecuteIntent {
                asset: AssetKey::Dot,
                max_payment_amount: 110_000_000,
                contract_address: "0x1111111111111111111111111111111111111111".to_owned(),
                calldata: "0xdeadbeef".to_owned(),
                value: 0,
                gas_limit: 250_000,
                fallback_weight: XcmWeight {
                    ref_time: 650_000_000,
                    proof_size: 12_288,
                },
            },
        )),
        refund_address: REFUND_ADDRESS.to_owned(),
        deadline: 1_773_185_200,
    };

    let quote = engine
        .quote(intent)
        .expect("evm contract quote should build");

    assert_eq!(quote.route, vec![ChainKey::PolkadotHub, ChainKey::Moonbeam]);
    assert_eq!(quote.submission.action, SubmissionAction::Execute);
    assert_eq!(quote.submission.amount, 110_000_000);
    assert_eq!(quote.submission.destination_fee, 0);
    assert_eq!(quote.expected_output, AssetAmount::new(AssetKey::Dot, 0));

    let outer_transfer = first_transfer_instruction(&quote.execution_plan.steps[4]);
    assert_eq!(outer_transfer.amount(), 110_000_000);
    match &outer_transfer.remote_instructions()[1] {
        XcmInstruction::Transact { call_data, .. } => {
            assert!(call_data.starts_with("0x6d0001"));
            assert!(call_data.contains("1111111111111111111111111111111111111111"));
            assert!(call_data.ends_with("10deadbeef00"));
        }
        other => panic!("expected transact instruction, got {other:?}"),
    }
}

#[test]
fn quotes_multihop_execute_evm_contract_call_on_moonbeam() {
    let engine = mainnet_engine();
    let intent = Intent {
        source_chain: ChainKey::Hydration,
        destination_chain: ChainKey::Moonbeam,
        action: IntentAction::Execute(ExecuteIntent::EvmContractCall(
            EvmContractCallExecuteIntent {
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
            },
        )),
        refund_address: REFUND_ADDRESS.to_owned(),
        deadline: 1_773_185_200,
    };

    let quote = engine
        .quote(intent)
        .expect("multihop evm quote should build");

    assert_eq!(
        quote.route,
        vec![
            ChainKey::Hydration,
            ChainKey::PolkadotHub,
            ChainKey::Moonbeam
        ]
    );

    let outer_transfer = first_transfer_instruction(&quote.execution_plan.steps[4]);
    assert_eq!(outer_transfer.destination(), ChainKey::PolkadotHub);
    let nested_transfer = nested_transfer_instruction(outer_transfer, 1);
    assert_eq!(nested_transfer.destination(), ChainKey::Moonbeam);
    match &nested_transfer.remote_instructions()[1] {
        XcmInstruction::Transact { call_data, .. } => {
            assert!(call_data.starts_with("0x6d0001"));
            assert!(call_data.contains("1111111111111111111111111111111111111111"));
        }
        other => panic!("expected transact instruction, got {other:?}"),
    }
}

#[test]
fn quotes_core_multihop_execute_evm_contract_call_on_moonbeam() {
    let engine = core_multihop_engine();
    let intent = Intent {
        source_chain: ChainKey::Hydration,
        destination_chain: ChainKey::Moonbeam,
        action: IntentAction::Execute(ExecuteIntent::EvmContractCall(
            EvmContractCallExecuteIntent {
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
            },
        )),
        refund_address: REFUND_ADDRESS.to_owned(),
        deadline: 1_773_185_200,
    };

    let quote = engine
        .quote(intent)
        .expect("core multihop evm execute should build");

    assert_eq!(quote.deployment_profile, DeploymentProfile::CoreMultihop);
    assert_eq!(
        quote.route,
        vec![ChainKey::Hydration, ChainKey::PolkadotHub, ChainKey::Moonbeam]
    );
}

#[test]
fn quotes_execute_vtoken_order_on_bifrost() {
    let engine = mainnet_engine();
    let intent = Intent {
        source_chain: ChainKey::PolkadotHub,
        destination_chain: ChainKey::Bifrost,
        action: IntentAction::Execute(ExecuteIntent::VtokenOrder(VtokenOrderExecuteIntent {
            asset: AssetKey::Dot,
            amount: AssetKey::Dot.units(25),
            max_payment_amount: 200_000_000,
            operation: VtokenOrderOperation::Mint,
            recipient: "5FbifrostRecipient".to_owned(),
            recipient_account_id_hex:
                "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
            channel_id: 7,
            remark: "xroute".to_owned(),
            fallback_weight: XcmWeight {
                ref_time: 600_000_000,
                proof_size: 12_288,
            },
        })),
        refund_address: REFUND_ADDRESS.to_owned(),
        deadline: 1_773_185_200,
    };

    let quote = engine
        .quote(intent)
        .expect("vtoken order quote should build");

    assert_eq!(
        quote.route,
        vec![ChainKey::PolkadotHub, ChainKey::Moonbeam, ChainKey::Bifrost]
    );
    assert_eq!(quote.submission.action, SubmissionAction::Execute);
    assert_eq!(quote.submission.amount, AssetKey::Dot.units(25));
    assert_eq!(quote.submission.destination_fee, 190_000_000);
    assert_eq!(
        quote.expected_output,
        AssetAmount::new(AssetKey::Vdot, AssetKey::Dot.units(25))
    );

    let outer_transfer = first_transfer_instruction(&quote.execution_plan.steps[4]);
    assert_eq!(outer_transfer.destination(), ChainKey::Moonbeam);
    assert_eq!(
        outer_transfer.remote_instructions()[0],
        XcmInstruction::BuyExecution {
            asset: AssetKey::Dot,
            amount: 110_000_000,
        }
    );
    let nested_transfer = nested_transfer_instruction(outer_transfer, 1);
    assert_eq!(nested_transfer.destination(), ChainKey::Bifrost);
    assert_eq!(
        nested_transfer.amount(),
        AssetKey::Dot.units(25) + 190_000_000
    );
    match &nested_transfer.remote_instructions()[1] {
        XcmInstruction::Transact { call_data, .. } => {
            assert!(call_data.starts_with("0x7d000800"));
            assert!(call_data
                .contains("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
            assert!(call_data.ends_with("1878726f75746507000000"));
        }
        other => panic!("expected transact instruction, got {other:?}"),
    }
}

#[test]
fn quotes_execute_vtoken_order_on_bifrost_from_moonbeam() {
    let engine = mainnet_engine();
    let intent = Intent {
        source_chain: ChainKey::Moonbeam,
        destination_chain: ChainKey::Bifrost,
        action: IntentAction::Execute(ExecuteIntent::VtokenOrder(VtokenOrderExecuteIntent {
            asset: AssetKey::Dot,
            amount: AssetKey::Dot.units(3),
            max_payment_amount: 210_000_000,
            operation: VtokenOrderOperation::Mint,
            recipient: "5FmoonbeamBifrostRecipient".to_owned(),
            recipient_account_id_hex:
                "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_owned(),
            channel_id: 3,
            remark: "route".to_owned(),
            fallback_weight: XcmWeight {
                ref_time: 600_000_000,
                proof_size: 12_288,
            },
        })),
        refund_address: REFUND_ADDRESS.to_owned(),
        deadline: 1_773_185_200,
    };

    let quote = engine
        .quote(intent)
        .expect("multihop vtoken quote should build");

    assert_eq!(quote.route, vec![ChainKey::Moonbeam, ChainKey::Bifrost]);
    assert_eq!(
        quote.expected_output,
        AssetAmount::new(AssetKey::Vdot, AssetKey::Dot.units(3))
    );

    let outer_transfer = first_transfer_instruction(&quote.execution_plan.steps[4]);
    assert_eq!(outer_transfer.destination(), ChainKey::Bifrost);
    match &outer_transfer.remote_instructions()[1] {
        XcmInstruction::Transact { call_data, .. } => {
            assert!(call_data.starts_with("0x7d000800"));
            assert!(call_data
                .contains("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));
        }
        other => panic!("expected transact instruction, got {other:?}"),
    }
}

#[test]
fn quotes_execute_vtoken_redeem_on_bifrost() {
    let engine = mainnet_engine();
    let intent = Intent {
        source_chain: ChainKey::Moonbeam,
        destination_chain: ChainKey::Bifrost,
        action: IntentAction::Execute(ExecuteIntent::VtokenOrder(VtokenOrderExecuteIntent {
            asset: AssetKey::Vdot,
            amount: AssetKey::Vdot.units(2),
            max_payment_amount: 100_000_000,
            operation: VtokenOrderOperation::Redeem,
            recipient: "5FhubRedeemRecipient".to_owned(),
            recipient_account_id_hex:
                "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc".to_owned(),
            channel_id: 0,
            remark: String::new(),
            fallback_weight: XcmWeight {
                ref_time: 600_000_000,
                proof_size: 12_288,
            },
        })),
        refund_address: REFUND_ADDRESS.to_owned(),
        deadline: 1_773_185_200,
    };

    let quote = engine
        .quote(intent)
        .expect("vtoken redeem quote should build");

    assert_eq!(quote.route, vec![ChainKey::Moonbeam, ChainKey::Bifrost]);
    assert_eq!(quote.submission.asset, AssetKey::Vdot);
    assert_eq!(
        quote.expected_output,
        AssetAmount::new(AssetKey::Dot, AssetKey::Vdot.units(2))
    );

    match &quote.execution_plan.steps[4] {
        PlanStep::SendXcm { instructions, .. } => {
            assert!(matches!(
                instructions[0],
                XcmInstruction::InitiateTeleport { .. }
            ));
        }
        other => panic!("unexpected plan step: {other:?}"),
    }
}

#[test]
fn quotes_swap_on_hydration_snakenet_profile() {
    let engine = hydration_snakenet_engine();
    let intent = Intent {
        source_chain: ChainKey::PolkadotHub,
        destination_chain: ChainKey::Hydration,
        action: IntentAction::Swap(SwapIntent {
            asset_in: AssetKey::Pas,
            asset_out: AssetKey::Hdx,
            amount_in: AssetKey::Pas.units(10),
            min_amount_out: AssetKey::Hdx.units(1_000),
            settlement_chain: ChainKey::Hydration,
            recipient: "5FsnakenetRecipient".to_owned(),
        }),
        refund_address: REFUND_ADDRESS.to_owned(),
        deadline: 1_773_185_200,
    };

    let quote = engine
        .quote(intent)
        .expect("hydration-snakenet swap quote should build");

    assert_eq!(quote.deployment_profile, DeploymentProfile::HydrationSnakenet);
    assert_eq!(quote.route, vec![ChainKey::PolkadotHub, ChainKey::Hydration]);
    assert_eq!(quote.segments.len(), 1);
    assert_eq!(quote.segments[0].route, vec![ChainKey::PolkadotHub, ChainKey::Hydration]);
    assert_eq!(quote.submission.asset, AssetKey::Pas);
    assert_eq!(quote.expected_output.asset, AssetKey::Hdx);
    assert_eq!(quote.min_output.expect("min output").amount, AssetKey::Hdx.units(1_000));
}

#[test]
fn quotes_execute_evm_contract_call_on_moonbase_alpha_profile() {
    let engine = moonbase_alpha_engine();
    let intent = Intent {
        source_chain: ChainKey::PolkadotHub,
        destination_chain: ChainKey::Moonbeam,
        action: IntentAction::Execute(ExecuteIntent::EvmContractCall(
            EvmContractCallExecuteIntent {
                asset: AssetKey::Dot,
                max_payment_amount: 110_000_000,
                contract_address: "0x1111111111111111111111111111111111111111".to_owned(),
                calldata: "0xdeadbeef".to_owned(),
                value: 0,
                gas_limit: 250_000,
                fallback_weight: XcmWeight {
                    ref_time: 650_000_000,
                    proof_size: 12_288,
                },
            },
        )),
        refund_address: REFUND_ADDRESS.to_owned(),
        deadline: 1_773_185_200,
    };

    let quote = engine
        .quote(intent)
        .expect("moonbase alpha evm quote should build");

    assert_eq!(quote.deployment_profile, DeploymentProfile::MoonbaseAlpha);
    assert_eq!(quote.route, vec![ChainKey::PolkadotHub, ChainKey::Moonbeam]);
}

#[test]
fn quotes_vtoken_order_on_bifrost_via_hydration_profile() {
    let engine = bifrost_via_hydration_engine();
    let intent = Intent {
        source_chain: ChainKey::Hydration,
        destination_chain: ChainKey::Bifrost,
        action: IntentAction::Execute(ExecuteIntent::VtokenOrder(VtokenOrderExecuteIntent {
            asset: AssetKey::Dot,
            max_payment_amount: 105_000_000,
            operation: VtokenOrderOperation::Mint,
            amount: AssetKey::Dot.units(2),
            recipient: "5FbifrostHydrationRecipient".to_owned(),
            recipient_account_id_hex:
                "0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
                    .to_owned(),
            channel_id: 0,
            remark: String::new(),
            fallback_weight: XcmWeight {
                ref_time: 600_000_000,
                proof_size: 10_240,
            },
        })),
        refund_address: REFUND_ADDRESS.to_owned(),
        deadline: 1_773_185_200,
    };

    let quote = engine
        .quote(intent)
        .expect("bifrost via hydration quote should build");

    assert_eq!(quote.deployment_profile, DeploymentProfile::BifrostViaHydration);
    assert_eq!(quote.route, vec![ChainKey::Hydration, ChainKey::Bifrost]);
}

#[test]
fn quotes_vtoken_order_on_bifrost_via_moonbase_alpha_profile() {
    let engine = bifrost_via_moonbase_alpha_engine();
    let intent = Intent {
        source_chain: ChainKey::Moonbeam,
        destination_chain: ChainKey::Bifrost,
        action: IntentAction::Execute(ExecuteIntent::VtokenOrder(VtokenOrderExecuteIntent {
            asset: AssetKey::Dot,
            max_payment_amount: 80_000_000,
            operation: VtokenOrderOperation::Mint,
            amount: AssetKey::Dot.units(2),
            recipient: "5FbifrostMoonbeamRecipient".to_owned(),
            recipient_account_id_hex:
                "0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20"
                    .to_owned(),
            channel_id: 0,
            remark: String::new(),
            fallback_weight: XcmWeight {
                ref_time: 600_000_000,
                proof_size: 10_240,
            },
        })),
        refund_address: REFUND_ADDRESS.to_owned(),
        deadline: 1_773_185_200,
    };

    let quote = engine
        .quote(intent)
        .expect("bifrost via moonbase alpha quote should build");

    assert_eq!(
        quote.deployment_profile,
        DeploymentProfile::BifrostViaMoonbeam
    );
    assert_eq!(quote.route, vec![ChainKey::Moonbeam, ChainKey::Bifrost]);
}

#[test]
fn quotes_full_multihop_transfer_on_integration_profile() {
    let engine = integration_engine();
    let intent = Intent {
        source_chain: ChainKey::PolkadotHub,
        destination_chain: ChainKey::Bifrost,
        action: IntentAction::Transfer(TransferIntent {
            asset: AssetKey::Dot,
            amount: AssetKey::Dot.units(2),
            recipient: "5FintegrationRecipient".to_owned(),
        }),
        refund_address: REFUND_ADDRESS.to_owned(),
        deadline: 1_773_185_200,
    };

    let quote = engine
        .quote(intent)
        .expect("integration multihop quote should build");

    assert_eq!(quote.deployment_profile, DeploymentProfile::Integration);
    assert_eq!(
        quote.route,
        vec![ChainKey::PolkadotHub, ChainKey::Moonbeam, ChainKey::Bifrost]
    );
    assert_eq!(quote.segments[0].route, quote.route);
}

fn first_transfer_instruction(step: &PlanStep) -> &XcmInstruction {
    match step {
        PlanStep::SendXcm { instructions, .. } => match &instructions[0] {
            instruction @ XcmInstruction::TransferReserveAsset { .. } => instruction,
            other => panic!("unexpected instruction: {other:?}"),
        },
        other => panic!("unexpected plan step: {other:?}"),
    }
}

trait TransferInstructionExt {
    fn destination(&self) -> ChainKey;
    fn amount(&self) -> u128;
    fn remote_instructions(&self) -> &[XcmInstruction];
}

impl TransferInstructionExt for XcmInstruction {
    fn destination(&self) -> ChainKey {
        match self {
            XcmInstruction::TransferReserveAsset { destination, .. } => *destination,
            _ => panic!("instruction is not a reserve transfer"),
        }
    }

    fn amount(&self) -> u128 {
        match self {
            XcmInstruction::TransferReserveAsset { amount, .. } => *amount,
            _ => panic!("instruction is not a reserve transfer"),
        }
    }

    fn remote_instructions(&self) -> &[XcmInstruction] {
        match self {
            XcmInstruction::TransferReserveAsset {
                remote_instructions,
                ..
            } => remote_instructions.as_slice(),
            _ => panic!("instruction is not a reserve transfer"),
        }
    }
}

fn nested_transfer_instruction<'a>(
    instruction: &'a XcmInstruction,
    remote_index: usize,
) -> &'a XcmInstruction {
    match &instruction.remote_instructions()[remote_index] {
        nested @ XcmInstruction::TransferReserveAsset { .. } => nested,
        other => panic!("unexpected nested instruction: {other:?}"),
    }
}
