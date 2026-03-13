use std::fmt::{Display, Formatter};
use std::str::FromStr;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ChainKey {
    PolkadotHub,
    Hydration,
    Moonbeam,
    Bifrost,
}

impl ChainKey {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PolkadotHub => "polkadot-hub",
            Self::Hydration => "hydration",
            Self::Moonbeam => "moonbeam",
            Self::Bifrost => "bifrost",
        }
    }
}

impl Display for ChainKey {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for ChainKey {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim() {
            "polkadot-hub" | "asset-hub" => Ok(Self::PolkadotHub),
            "hydration" => Ok(Self::Hydration),
            "moonbeam" => Ok(Self::Moonbeam),
            "bifrost" => Ok(Self::Bifrost),
            other => Err(format!("unsupported chain: {other}")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DeploymentProfile {
    Mainnet,
}

impl DeploymentProfile {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Mainnet => "mainnet",
        }
    }
}

impl Display for DeploymentProfile {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AssetKey {
    Dot,
    Usdt,
    Hdx,
    Vdot,
}

impl AssetKey {
    pub const fn symbol(self) -> &'static str {
        match self {
            Self::Dot => "DOT",
            Self::Usdt => "USDT",
            Self::Hdx => "HDX",
            Self::Vdot => "VDOT",
        }
    }

    pub const fn decimals(self) -> u8 {
        match self {
            Self::Dot => 10,
            Self::Usdt => 6,
            Self::Hdx => 12,
            Self::Vdot => 10,
        }
    }

    pub const fn reserve_chain(self) -> ChainKey {
        match self {
            Self::Dot => ChainKey::PolkadotHub,
            Self::Usdt => ChainKey::PolkadotHub,
            Self::Hdx => ChainKey::Hydration,
            Self::Vdot => ChainKey::Bifrost,
        }
    }

    pub fn one(self) -> u128 {
        pow10(self.decimals())
    }

    pub fn units(self, whole: u128) -> u128 {
        whole.saturating_mul(self.one())
    }
}

impl FromStr for AssetKey {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_uppercase().as_str() {
            "DOT" => Ok(Self::Dot),
            "USDT" => Ok(Self::Usdt),
            "HDX" => Ok(Self::Hdx),
            "VDOT" => Ok(Self::Vdot),
            other => Err(format!("unsupported asset: {other}")),
        }
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
                "swap|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
                self.source_chain.as_str(),
                self.destination_chain.as_str(),
                swap.asset_in.symbol(),
                swap.asset_out.symbol(),
                swap.amount_in,
                swap.min_amount_out,
                swap.settlement_chain.as_str(),
                swap.recipient,
                self.refund_address,
                self.deadline
            ),
            IntentAction::Execute(execute) => format!(
                "execute|{}|{}|{}|{}|{}|{}",
                self.source_chain.as_str(),
                self.destination_chain.as_str(),
                execute.execution_type().as_str(),
                execute.canonical_fields(),
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
            IntentAction::Execute(execute) => execute.principal_amount(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IntentAction {
    Transfer(TransferIntent),
    Swap(SwapIntent),
    Execute(ExecuteIntent),
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
    pub settlement_chain: ChainKey,
    pub recipient: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecuteIntent {
    Call(CallExecuteIntent),
    MintVdot(VdotOrderExecuteIntent),
    RedeemVdot(VdotOrderExecuteIntent),
}

impl ExecuteIntent {
    pub fn execution_type(&self) -> ExecutionType {
        match self {
            Self::Call(_) => ExecutionType::Call,
            Self::MintVdot(_) => ExecutionType::MintVdot,
            Self::RedeemVdot(_) => ExecutionType::RedeemVdot,
        }
    }

    pub fn asset(&self) -> AssetKey {
        match self {
            Self::Call(intent) => intent.asset,
            Self::MintVdot(_) => AssetKey::Dot,
            Self::RedeemVdot(_) => AssetKey::Vdot,
        }
    }

    pub fn max_payment_amount(&self) -> u128 {
        match self {
            Self::Call(intent) => intent.max_payment_amount,
            Self::MintVdot(intent) | Self::RedeemVdot(intent) => intent.max_payment_amount,
        }
    }

    pub fn fallback_weight(&self) -> XcmWeight {
        match self {
            Self::Call(intent) => intent.fallback_weight,
            Self::MintVdot(intent) | Self::RedeemVdot(intent) => intent.fallback_weight,
        }
    }

    pub fn gas_limit(&self) -> u64 {
        match self {
            Self::Call(intent) => intent.gas_limit,
            Self::MintVdot(intent) | Self::RedeemVdot(intent) => intent.gas_limit,
        }
    }

    pub fn principal_amount(&self) -> AssetAmount {
        match self {
            Self::Call(intent) => AssetAmount::new(intent.asset, 0),
            Self::MintVdot(intent) => AssetAmount::new(AssetKey::Dot, intent.amount),
            Self::RedeemVdot(intent) => AssetAmount::new(AssetKey::Vdot, intent.amount),
        }
    }

    pub fn submission_amount(&self, execution_budget: u128) -> u128 {
        match self {
            Self::Call(_) => execution_budget,
            Self::MintVdot(intent) | Self::RedeemVdot(intent) => {
                intent.amount.saturating_add(execution_budget)
            }
        }
    }

    pub fn destination_fee_amount(&self, _execution_budget: u128) -> u128 {
        match self {
            Self::Call(_) | Self::MintVdot(_) | Self::RedeemVdot(_) => 0,
        }
    }

    pub fn transfer_amount(&self, execution_budget: u128) -> u128 {
        match self {
            Self::Call(_) => execution_budget,
            Self::MintVdot(intent) | Self::RedeemVdot(intent) => {
                intent.amount.saturating_add(execution_budget)
            }
        }
    }

    pub fn expected_output(&self) -> AssetAmount {
        match self {
            Self::Call(intent) => AssetAmount::new(intent.asset, 0),
            Self::MintVdot(_) => AssetAmount::new(AssetKey::Vdot, 0),
            Self::RedeemVdot(_) => AssetAmount::new(AssetKey::Dot, 0),
        }
    }

    fn canonical_fields(&self) -> String {
        match self {
            Self::Call(intent) => format!(
                "{}|{}|{}|{}|{}|{}|{}|{}",
                intent.asset.symbol(),
                intent.max_payment_amount,
                intent.contract_address,
                intent.calldata,
                intent.value,
                intent.gas_limit,
                intent.fallback_weight.ref_time,
                intent.fallback_weight.proof_size
            ),
            Self::MintVdot(intent) | Self::RedeemVdot(intent) => format!(
                "{}|{}|{}|{}|{}|{}|{}|{}|{}",
                intent.amount,
                intent.max_payment_amount,
                intent.recipient,
                intent.adapter_address,
                intent.gas_limit,
                intent.fallback_weight.ref_time,
                intent.fallback_weight.proof_size,
                intent.remark,
                intent.channel_id
            ),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallExecuteIntent {
    pub asset: AssetKey,
    pub max_payment_amount: u128,
    pub contract_address: String,
    pub calldata: String,
    pub value: u128,
    pub gas_limit: u64,
    pub fallback_weight: XcmWeight,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VdotOrderExecuteIntent {
    pub amount: u128,
    pub max_payment_amount: u128,
    pub recipient: String,
    pub adapter_address: String,
    pub gas_limit: u64,
    pub fallback_weight: XcmWeight,
    pub remark: String,
    pub channel_id: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionType {
    Call,
    MintVdot,
    RedeemVdot,
}

impl ExecutionType {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Call => "call",
            Self::MintVdot => "mint-vdot",
            Self::RedeemVdot => "redeem-vdot",
        }
    }
}

impl FromStr for ExecutionType {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim() {
            "call" => Ok(Self::Call),
            "mint-vdot" => Ok(Self::MintVdot),
            "redeem-vdot" => Ok(Self::RedeemVdot),
            other => Err(format!("unsupported execution type: {other}")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeCallOriginKind {
    SovereignAccount,
    Xcm,
    Native,
    Superuser,
}

impl RuntimeCallOriginKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SovereignAccount => "sovereign-account",
            Self::Xcm => "xcm",
            Self::Native => "native",
            Self::Superuser => "superuser",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Quote {
    pub quote_id: String,
    pub deployment_profile: DeploymentProfile,
    pub route: Vec<ChainKey>,
    pub segments: Vec<RouteSegment>,
    pub fees: FeeBreakdown,
    pub estimated_settlement_fee: Option<AssetAmount>,
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
    Execute,
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct XcmWeight {
    pub ref_time: u64,
    pub proof_size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteSegment {
    pub kind: RouteSegmentKind,
    pub route: Vec<ChainKey>,
    pub hops: Vec<RouteHop>,
    pub xcm_fee: AssetAmount,
    pub destination_fee: AssetAmount,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteSegmentKind {
    Execution,
    Settlement,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RouteHop {
    pub source: ChainKey,
    pub destination: ChainKey,
    pub asset: AssetKey,
    pub transport_fee: AssetAmount,
    pub buy_execution_fee: AssetAmount,
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
    WithdrawAsset {
        asset: AssetKey,
        amount: u128,
    },
    PayFees {
        asset: AssetKey,
        amount: u128,
    },
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
        amount_in: u128,
        asset_out: AssetKey,
        min_amount_out: u128,
        maximal: bool,
    },
    DepositReserveAsset {
        asset_count: u32,
        destination: ChainKey,
        remote_instructions: Vec<XcmInstruction>,
    },
    InitiateTeleport {
        asset_count: u32,
        destination: ChainKey,
        remote_instructions: Vec<XcmInstruction>,
    },
    InitiateTransfer {
        asset: AssetKey,
        amount: u128,
        destination: ChainKey,
        remote_fee_asset: AssetKey,
        remote_fee_amount: u128,
        preserve_origin: bool,
        remote_instructions: Vec<XcmInstruction>,
    },
    InitiateReserveWithdraw {
        asset_count: u32,
        reserve: ChainKey,
        remote_instructions: Vec<XcmInstruction>,
    },
    Transact {
        origin_kind: RuntimeCallOriginKind,
        fallback_weight: XcmWeight,
        call_data: String,
    },
    DepositAsset {
        asset: AssetKey,
        recipient: String,
        asset_count: u32,
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
