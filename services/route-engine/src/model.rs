use std::fmt::{Display, Formatter};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ChainKey {
    PolkadotHub,
    Hydration,
    AssetHub,
}

impl ChainKey {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PolkadotHub => "polkadot-hub",
            Self::Hydration => "hydration",
            Self::AssetHub => "asset-hub",
        }
    }
}

impl Display for ChainKey {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AssetKey {
    Dot,
    Usdt,
    Hdx,
}

impl AssetKey {
    pub const fn symbol(self) -> &'static str {
        match self {
            Self::Dot => "DOT",
            Self::Usdt => "USDT",
            Self::Hdx => "HDX",
        }
    }

    pub const fn decimals(self) -> u8 {
        match self {
            Self::Dot => 10,
            Self::Usdt => 6,
            Self::Hdx => 12,
        }
    }

    pub fn one(self) -> u128 {
        pow10(self.decimals())
    }

    pub fn units(self, whole: u128) -> u128 {
        whole.saturating_mul(self.one())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AssetAmount {
    pub asset: AssetKey,
    pub amount: u128,
}

impl AssetAmount {
    pub const fn new(asset: AssetKey, amount: u128) -> Self {
        Self { asset, amount }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Intent {
    pub source_chain: ChainKey,
    pub destination_chain: ChainKey,
    pub action: IntentAction,
    pub refund_address: String,
    pub deadline: u64,
}

impl Intent {
    pub fn canonical_id(&self) -> String {
        let material = match &self.action {
            IntentAction::Transfer(transfer) => format!(
                "transfer|{}|{}|{}|{}|{}|{}|{}",
                self.source_chain.as_str(),
                self.destination_chain.as_str(),
                transfer.asset.symbol(),
                transfer.amount,
                transfer.recipient,
                self.refund_address,
                self.deadline
            ),
            IntentAction::Swap(swap) => format!(
                "swap|{}|{}|{}|{}|{}|{}|{}|{}|{}",
                self.source_chain.as_str(),
                self.destination_chain.as_str(),
                swap.asset_in.symbol(),
                swap.asset_out.symbol(),
                swap.amount_in,
                swap.min_amount_out,
                swap.recipient,
                self.refund_address,
                self.deadline
            ),
            IntentAction::Stake(stake) => format!(
                "stake|{}|{}|{}|{}|{}|{}|{}|{}",
                self.source_chain.as_str(),
                self.destination_chain.as_str(),
                stake.asset.symbol(),
                stake.amount,
                stake.validator,
                stake.recipient,
                self.refund_address,
                self.deadline
            ),
            IntentAction::Call(call) => format!(
                "call|{}|{}|{}|{}|{}|{}|{}|{}",
                self.source_chain.as_str(),
                self.destination_chain.as_str(),
                call.asset.symbol(),
                call.amount,
                call.target,
                call.calldata,
                self.refund_address,
                self.deadline
            ),
        };

        format!("0x{:016x}", fnv1a64(material.as_bytes()))
    }

    pub fn principal_amount(&self) -> AssetAmount {
        match &self.action {
            IntentAction::Transfer(transfer) => AssetAmount::new(transfer.asset, transfer.amount),
            IntentAction::Swap(swap) => AssetAmount::new(swap.asset_in, swap.amount_in),
            IntentAction::Stake(stake) => AssetAmount::new(stake.asset, stake.amount),
            IntentAction::Call(call) => AssetAmount::new(call.asset, call.amount),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IntentAction {
    Transfer(TransferIntent),
    Swap(SwapIntent),
    Stake(StakeIntent),
    Call(CallIntent),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransferIntent {
    pub asset: AssetKey,
    pub amount: u128,
    pub recipient: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SwapIntent {
    pub asset_in: AssetKey,
    pub asset_out: AssetKey,
    pub amount_in: u128,
    pub min_amount_out: u128,
    pub recipient: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StakeIntent {
    pub asset: AssetKey,
    pub amount: u128,
    pub validator: String,
    pub recipient: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallIntent {
    pub asset: AssetKey,
    pub amount: u128,
    pub target: String,
    pub calldata: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Quote {
    pub quote_id: String,
    pub route: Vec<ChainKey>,
    pub fees: FeeBreakdown,
    pub expected_output: AssetAmount,
    pub min_output: Option<AssetAmount>,
    pub submission: SubmissionTerms,
    pub execution_plan: ExecutionPlan,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubmissionTerms {
    pub action: SubmissionAction,
    pub asset: AssetKey,
    pub amount: u128,
    pub xcm_fee: u128,
    pub destination_fee: u128,
    pub min_output_amount: u128,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubmissionAction {
    Transfer,
    Swap,
    Stake,
    Call,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeeBreakdown {
    pub xcm_fee: AssetAmount,
    pub destination_fee: AssetAmount,
    pub platform_fee: AssetAmount,
    pub total_fee: AssetAmount,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionPlan {
    pub route: Vec<ChainKey>,
    pub steps: Vec<PlanStep>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanStep {
    LockAsset {
        chain: ChainKey,
        asset: AssetKey,
        amount: u128,
    },
    ChargeFee {
        fee_type: FeeType,
        asset: AssetKey,
        amount: u128,
    },
    SendXcm {
        origin: ChainKey,
        destination: ChainKey,
        instructions: Vec<XcmInstruction>,
    },
    ExpectSettlement {
        chain: ChainKey,
        asset: AssetKey,
        recipient: String,
        minimum_amount: Option<u128>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FeeType {
    Xcm,
    Destination,
    Platform,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum XcmInstruction {
    TransferReserveAsset {
        asset: AssetKey,
        amount: u128,
        destination: ChainKey,
        remote_instructions: Vec<XcmInstruction>,
    },
    BuyExecution {
        asset: AssetKey,
        amount: u128,
    },
    ExchangeAsset {
        asset_in: AssetKey,
        asset_out: AssetKey,
        min_amount_out: u128,
    },
    DepositAsset {
        asset: AssetKey,
        recipient: String,
    },
}

pub fn pow10(exponent: u8) -> u128 {
    let mut value = 1u128;
    let mut remaining = exponent;
    while remaining > 0 {
        value *= 10;
        remaining -= 1;
    }
    value
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    const OFFSET: u64 = 0xcbf29ce484222325;
    const PRIME: u64 = 0x100000001b3;

    let mut hash = OFFSET;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(PRIME);
    }
    hash
}
