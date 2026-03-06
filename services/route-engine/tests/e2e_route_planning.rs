use route_engine::{
    AssetKey, ChainKey, FeeType, Intent, IntentAction, PlanStep, RouteEngine, SubmissionAction,
    SwapIntent, TransferIntent, XcmInstruction,
};

#[test]
fn quotes_hydration_swap_and_builds_remote_swap_plan() {
    let engine = RouteEngine::default();
    let intent = Intent {
        source_chain: ChainKey::PolkadotHub,
        destination_chain: ChainKey::Hydration,
        action: IntentAction::Swap(SwapIntent {
            asset_in: AssetKey::Dot,
            asset_out: AssetKey::Usdt,
            amount_in: AssetKey::Dot.units(100),
            min_amount_out: AssetKey::Usdt.units(490),
            recipient: "5FswapRecipient".to_owned(),
        }),
        refund_address: "5Frefund".to_owned(),
        deadline: 1_773_185_200,
    };

    let quote = engine.quote(intent).expect("swap quote should build");

    assert_eq!(
        quote.route,
        vec![ChainKey::PolkadotHub, ChainKey::Hydration]
    );
    assert_eq!(quote.fees.xcm_fee.amount, 150_000_000);
    assert_eq!(quote.fees.destination_fee.amount, 100_000_000);
    assert_eq!(quote.fees.platform_fee.amount, 1_000_000_000);
    assert_eq!(quote.fees.total_fee.amount, 1_250_000_000);
    assert_eq!(quote.expected_output.asset, AssetKey::Usdt);
    assert_eq!(quote.expected_output.amount, 493_515_000);
    assert_eq!(quote.min_output.expect("min output").amount, 490_000_000);
    assert_eq!(quote.submission.action, SubmissionAction::Swap);
    assert_eq!(quote.submission.asset, AssetKey::Dot);
    assert_eq!(quote.submission.amount, 1_000_000_000_000);
    assert_eq!(quote.submission.xcm_fee, 150_000_000);
    assert_eq!(quote.submission.destination_fee, 100_000_000);
    assert_eq!(quote.submission.min_output_amount, 490_000_000);

    assert_eq!(
        quote.execution_plan.steps[0],
        PlanStep::LockAsset {
            chain: ChainKey::PolkadotHub,
            asset: AssetKey::Dot,
            amount: 1_001_250_000_000,
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

    match &quote.execution_plan.steps[4] {
        PlanStep::SendXcm {
            origin,
            destination,
            instructions,
        } => {
            assert_eq!(*origin, ChainKey::PolkadotHub);
            assert_eq!(*destination, ChainKey::Hydration);
            assert_eq!(instructions.len(), 1);

            match &instructions[0] {
                XcmInstruction::TransferReserveAsset {
                    asset,
                    amount,
                    destination,
                    remote_instructions,
                } => {
                    assert_eq!(*asset, AssetKey::Dot);
                    assert_eq!(*amount, 1_000_000_000_000);
                    assert_eq!(*destination, ChainKey::Hydration);
                    assert_eq!(
                        remote_instructions,
                        &vec![
                            XcmInstruction::BuyExecution {
                                asset: AssetKey::Dot,
                                amount: 100_000_000,
                            },
                            XcmInstruction::ExchangeAsset {
                                asset_in: AssetKey::Dot,
                                asset_out: AssetKey::Usdt,
                                min_amount_out: 490_000_000,
                            },
                            XcmInstruction::DepositAsset {
                                asset: AssetKey::Usdt,
                                recipient: "5FswapRecipient".to_owned(),
                            },
                        ]
                    );
                }
                other => panic!("unexpected instruction: {other:?}"),
            }
        }
        other => panic!("unexpected plan step: {other:?}"),
    }
}

#[test]
fn quotes_asset_transfer_and_builds_delivery_plan() {
    let engine = RouteEngine::default();
    let intent = Intent {
        source_chain: ChainKey::PolkadotHub,
        destination_chain: ChainKey::AssetHub,
        action: IntentAction::Transfer(TransferIntent {
            asset: AssetKey::Dot,
            amount: AssetKey::Dot.units(25),
            recipient: "5FtransferRecipient".to_owned(),
        }),
        refund_address: "5Frefund".to_owned(),
        deadline: 1_773_185_200,
    };

    let quote = engine.quote(intent).expect("transfer quote should build");

    assert_eq!(quote.route, vec![ChainKey::PolkadotHub, ChainKey::AssetHub]);
    assert_eq!(quote.fees.xcm_fee.amount, 100_000_000);
    assert_eq!(quote.fees.destination_fee.amount, 20_000_000);
    assert_eq!(quote.fees.platform_fee.amount, 250_000_000);
    assert_eq!(quote.fees.total_fee.amount, 370_000_000);
    assert_eq!(quote.expected_output.amount, 250_000_000_000);
    assert_eq!(quote.submission.action, SubmissionAction::Transfer);
    assert_eq!(quote.submission.asset, AssetKey::Dot);
    assert_eq!(quote.submission.amount, 250_000_000_000);
    assert_eq!(quote.submission.xcm_fee, 100_000_000);
    assert_eq!(quote.submission.destination_fee, 20_000_000);
    assert_eq!(quote.submission.min_output_amount, 250_000_000_000);

    match &quote.execution_plan.steps[4] {
        PlanStep::SendXcm {
            origin,
            destination,
            instructions,
        } => {
            assert_eq!(*origin, ChainKey::PolkadotHub);
            assert_eq!(*destination, ChainKey::AssetHub);
            assert_eq!(instructions.len(), 1);

            match &instructions[0] {
                XcmInstruction::TransferReserveAsset {
                    asset,
                    amount,
                    destination,
                    remote_instructions,
                } => {
                    assert_eq!(*asset, AssetKey::Dot);
                    assert_eq!(*amount, 250_000_000_000);
                    assert_eq!(*destination, ChainKey::AssetHub);
                    assert_eq!(
                        remote_instructions,
                        &vec![
                            XcmInstruction::BuyExecution {
                                asset: AssetKey::Dot,
                                amount: 20_000_000,
                            },
                            XcmInstruction::DepositAsset {
                                asset: AssetKey::Dot,
                                recipient: "5FtransferRecipient".to_owned(),
                            },
                        ]
                    );
                }
                other => panic!("unexpected instruction: {other:?}"),
            }
        }
        other => panic!("unexpected plan step: {other:?}"),
    }
}
