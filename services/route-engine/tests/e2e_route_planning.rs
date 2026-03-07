use route_engine::{
    AssetAmount, AssetKey, CallIntent, ChainKey, DeploymentProfile, DestinationAdapter,
    EngineSettings, FeeType, Intent, IntentAction, PlanStep, RouteEngine, RouteRegistry,
    RouteSegmentKind, StakeIntent, SubmissionAction, SwapIntent, TransferIntent, XcmInstruction,
    XcmWeight, lookup_destination_adapter_deployment,
};

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
        refund_address: "5Frefund".to_owned(),
        deadline: 1_773_185_200,
    };

    let quote = engine.quote(intent).expect("swap quote should build");

    assert_eq!(quote.deployment_profile, DeploymentProfile::Local);
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
        XcmInstruction::Transact {
            adapter: DestinationAdapter::HydrationSwapV1,
            target_address: local_adapter_address(DestinationAdapter::HydrationSwapV1).to_owned(),
            contract_call: outer_transfer.remote_instructions()[1]
                .contract_call()
                .expect("swap contract call")
                .to_owned(),
            fallback_weight: XcmWeight {
                ref_time: 3_500_000_000,
                proof_size: 120_000,
            },
        }
    );
    assert!(outer_transfer.remote_instructions()[1]
        .contract_call()
        .expect("swap contract call")
        .starts_with("0x670b1f29"));
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
        refund_address: "5Frefund".to_owned(),
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
    assert_eq!(outer_transfer.remote_instructions().len(), 2);
    assert!(outer_transfer.remote_instructions()[1]
        .contract_call()
        .expect("swap contract call")
        .contains("00000000000000000000000000000000000000000000000000000000000003e8"));
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
        refund_address: "5Frefund".to_owned(),
        deadline: 1_773_185_200,
    };

    let quote = engine.quote(intent).expect("transfer quote should build");

    assert_eq!(quote.deployment_profile, DeploymentProfile::Local);
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
            },
        ]
    );
}

#[test]
fn quotes_hydration_stake_over_a_multihop_path() {
    let engine = RouteEngine::default();
    let intent = Intent {
        source_chain: ChainKey::PolkadotHub,
        destination_chain: ChainKey::Hydration,
        action: IntentAction::Stake(StakeIntent {
            asset: AssetKey::Dot,
            amount: AssetKey::Dot.units(40),
            validator: "validator-01".to_owned(),
            recipient: "5FstakeRecipient".to_owned(),
        }),
        refund_address: "5Frefund".to_owned(),
        deadline: 1_773_185_200,
    };

    let quote = engine.quote(intent).expect("stake quote should build");

    assert_eq!(quote.deployment_profile, DeploymentProfile::Local);
    assert_eq!(quote.route, vec![ChainKey::PolkadotHub, ChainKey::Hydration]);
    assert_eq!(quote.submission.action, SubmissionAction::Stake);
    assert!(quote.estimated_settlement_fee.is_none());
    assert_eq!(quote.submission.xcm_fee, 150_000_000);
    assert_eq!(quote.submission.destination_fee, 90_000_000);
    assert_eq!(quote.submission.min_output_amount, 0);
    assert!(quote.min_output.is_none());

    let inner_transfer = first_transfer_instruction(&quote.execution_plan.steps[4]);
    assert_eq!(inner_transfer.remote_instructions().len(), 2);
    assert_eq!(
        inner_transfer.remote_instructions()[1],
        XcmInstruction::Transact {
            adapter: DestinationAdapter::HydrationStakeV1,
            target_address: local_adapter_address(DestinationAdapter::HydrationStakeV1).to_owned(),
            contract_call: inner_transfer.remote_instructions()[1]
                .contract_call()
                .expect("stake contract call")
                .to_owned(),
            fallback_weight: XcmWeight {
                ref_time: 4_000_000_000,
                proof_size: 140_000,
            },
        }
    );
    assert!(inner_transfer.remote_instructions()[1]
        .contract_call()
        .expect("stake contract call")
        .starts_with("0xdfabdde3"));
}

#[test]
fn quotes_hydration_call_over_a_multihop_path() {
    let engine = RouteEngine::default();
    let intent = Intent {
        source_chain: ChainKey::PolkadotHub,
        destination_chain: ChainKey::Hydration,
        action: IntentAction::Call(CallIntent {
            asset: AssetKey::Dot,
            amount: AssetKey::Dot.units(5),
            target: "0x1111111111111111111111111111111111111111".to_owned(),
            calldata: "0xdeadbeef".to_owned(),
        }),
        refund_address: "5Frefund".to_owned(),
        deadline: 1_773_185_200,
    };

    let quote = engine.quote(intent).expect("call quote should build");

    assert_eq!(quote.deployment_profile, DeploymentProfile::Local);
    assert_eq!(quote.route, vec![ChainKey::PolkadotHub, ChainKey::Hydration]);
    assert_eq!(quote.submission.action, SubmissionAction::Call);
    assert!(quote.estimated_settlement_fee.is_none());
    assert_eq!(quote.submission.xcm_fee, 150_000_000);
    assert_eq!(quote.submission.destination_fee, 90_000_000);
    assert_eq!(quote.submission.min_output_amount, 0);
    assert_eq!(quote.expected_output.amount, 0);

    let inner_transfer = first_transfer_instruction(&quote.execution_plan.steps[4]);
    assert_eq!(inner_transfer.remote_instructions().len(), 2);
    assert_eq!(
        inner_transfer.remote_instructions()[1],
        XcmInstruction::Transact {
            adapter: DestinationAdapter::HydrationCallV1,
            target_address: local_adapter_address(DestinationAdapter::HydrationCallV1).to_owned(),
            contract_call: inner_transfer.remote_instructions()[1]
                .contract_call()
                .expect("call contract call")
                .to_owned(),
            fallback_weight: XcmWeight {
                ref_time: 3_000_000_000,
                proof_size: 110_000,
            },
        }
    );
    assert!(inner_transfer.remote_instructions()[1]
        .contract_call()
        .expect("call contract call")
        .starts_with("0x7db7dbf6"));
}

#[test]
fn rejects_non_local_profiles_without_published_deployments() {
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
        refund_address: "5Frefund".to_owned(),
        deadline: 1_773_185_200,
    };

    let error = engine.quote(intent).expect_err("testnet deployment should be missing");
    assert_eq!(
        error.to_string(),
        "missing destination adapter deployment for hydration-swap-v1 on hydration (testnet)"
    );
}

fn local_adapter_address(adapter: DestinationAdapter) -> &'static str {
    lookup_destination_adapter_deployment(adapter, ChainKey::Hydration, DeploymentProfile::Local)
        .expect("local deployment")
        .address
}

trait InstructionExt {
    fn contract_call(&self) -> Option<&str>;
}

impl InstructionExt for XcmInstruction {
    fn contract_call(&self) -> Option<&str> {
        match self {
            XcmInstruction::Transact { contract_call, .. } => Some(contract_call.as_str()),
            _ => None,
        }
    }
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
