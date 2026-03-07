use route_engine::{
    AssetAmount, AssetKey, ChainKey, DeploymentProfile, EngineSettings, ExecuteIntent,
    ExecutionType, FeeType, Intent, IntentAction, PlanStep, RouteEngine, RouteRegistry,
    RouteSegmentKind, RuntimeCallOriginKind, SubmissionAction, SwapIntent, TransferIntent,
    XcmInstruction, XcmWeight,
};

const REFUND_ADDRESS: &str = "0x1111111111111111111111111111111111111111";

#[test]
fn quotes_hydration_swap_over_a_multihop_path() {
    let engine = RouteEngine::default();
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

    assert_eq!(quote.deployment_profile, DeploymentProfile::Testnet);
    assert_eq!(quote.route, vec![ChainKey::PolkadotHub, ChainKey::Hydration]);
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
    let engine = RouteEngine::default();
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
    let engine = RouteEngine::default();
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

    assert_eq!(quote.deployment_profile, DeploymentProfile::Testnet);
    assert_eq!(quote.route, vec![ChainKey::PolkadotHub, ChainKey::Hydration]);
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
fn quotes_hydration_swap_on_testnet_without_adapter_deployments() {
    let engine = RouteEngine::new(
        RouteRegistry::default(),
        EngineSettings {
            platform_fee_bps: 10,
            deployment_profile: DeploymentProfile::Testnet,
        },
    );
    let intent = Intent {
        source_chain: ChainKey::PolkadotHub,
        destination_chain: ChainKey::Hydration,
        action: IntentAction::Swap(SwapIntent {
            asset_in: AssetKey::Dot,
            asset_out: AssetKey::Usdt,
            amount_in: AssetKey::Dot.units(10),
            min_amount_out: AssetKey::Usdt.units(49),
            settlement_chain: ChainKey::Hydration,
            recipient: "5FswapRecipient".to_owned(),
        }),
        refund_address: REFUND_ADDRESS.to_owned(),
        deadline: 1_773_185_200,
    };

    let quote = engine.quote(intent).expect("testnet swap quote should build");
    assert_eq!(quote.deployment_profile, DeploymentProfile::Testnet);
    let outer_transfer = first_transfer_instruction(&quote.execution_plan.steps[4]);
    assert!(matches!(
        outer_transfer.remote_instructions()[1],
        XcmInstruction::ExchangeAsset { .. }
    ));
}

#[test]
fn quotes_execute_runtime_call_on_hydration() {
    let engine = RouteEngine::default();
    let intent = Intent {
        source_chain: ChainKey::PolkadotHub,
        destination_chain: ChainKey::Hydration,
        action: IntentAction::Execute(ExecuteIntent {
            execution_type: ExecutionType::RuntimeCall,
            asset: AssetKey::Dot,
            max_payment_amount: 90_000_000,
            call_data: "0x01020304".to_owned(),
            origin_kind: RuntimeCallOriginKind::SovereignAccount,
            fallback_weight: XcmWeight {
                ref_time: 250_000_000,
                proof_size: 4_096,
            },
        }),
        refund_address: REFUND_ADDRESS.to_owned(),
        deadline: 1_773_185_200,
    };

    let quote = engine.quote(intent).expect("execute quote should build");

    assert_eq!(quote.deployment_profile, DeploymentProfile::Testnet);
    assert_eq!(quote.route, vec![ChainKey::PolkadotHub, ChainKey::Hydration]);
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
