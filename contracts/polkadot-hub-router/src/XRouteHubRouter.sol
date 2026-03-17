// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IXcm, IMoonbeamXcm, MOONBEAM_XCM_PRECOMPILE_ADDRESS} from "./interfaces/IXcm.sol";

contract XRouteHubRouter is AccessControlDefaultAdminRules, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public constant NATIVE_ASSET = address(0);
    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");
    uint48 public constant DEFAULT_ADMIN_TRANSFER_DELAY = 1 days;
    uint16 public constant MAX_PLATFORM_FEE_BPS = 1_000;

    enum ActionType {
        Transfer,
        Swap,
        Execute
    }

    enum DispatchMode {
        Execute,
        Send
    }

    enum IntentStatus {
        None,
        Submitted,
        Dispatched,
        Settled,
        Failed,
        Cancelled,
        Refunded
    }

    struct IntentRequest {
        ActionType actionType;
        address asset;
        address refundAddress;
        uint128 amount;
        uint128 xcmFee;
        uint128 destinationFee;
        uint128 minOutputAmount;
        uint64 deadline;
        bytes32 executionHash;
    }

    struct DispatchRequest {
        DispatchMode mode;
        bytes destination;
        bytes message;
    }

    struct IntentRecord {
        address owner;
        address asset;
        address refundAddress;
        uint128 amount;
        uint128 xcmFee;
        uint128 destinationFee;
        uint128 platformFee;
        uint128 minOutputAmount;
        uint64 deadline;
        ActionType actionType;
        IntentStatus status;
        bytes32 executionHash;
        bytes32 outcomeReference;
        bytes32 resultAssetId;
        bytes32 failureReasonHash;
        uint128 resultAmount;
        uint128 refundAmount;
    }

    error ZeroAddress();
    error InvalidFeeBps();
    error InvalidDeadline();
    error InvalidAmount();
    error InvalidExecutionHash();
    error Unauthorized();
    error IntentNotFound();
    error IntentExpired();
    error InvalidIntentStatus();
    error InvalidDispatchPayload();
    error InvalidOutcomeReference();
    error InvalidFailureReason();
    error InvalidRefundAmount();
    error InsufficientResultAmount();
    error AssetTransferFailed();
    error InvalidNativeValue();
    error UseSetExecutor();

    event IntentSubmitted(
        bytes32 indexed intentId,
        address indexed owner,
        address indexed asset,
        address refundAddress,
        ActionType actionType,
        uint128 amount,
        uint128 totalLocked
    );
    event IntentDispatched(bytes32 indexed intentId, DispatchMode mode, uint64 refTime, uint64 proofSize);
    event IntentSettled(
        bytes32 indexed intentId, bytes32 indexed outcomeReference, bytes32 resultAssetId, uint128 resultAmount
    );
    event IntentFailed(bytes32 indexed intentId, bytes32 indexed outcomeReference, bytes32 failureReasonHash);
    event IntentCancelled(bytes32 indexed intentId);
    event IntentRefunded(bytes32 indexed intentId, uint128 refundAmount);
    event ExecutorUpdated(address indexed executor);
    event TreasuryUpdated(address indexed treasury);
    event PlatformFeeUpdated(uint16 feeBps);

    IXcm public immutable xcm;

    address public executor;
    address public treasury;
    uint16 public platformFeeBps;
    uint256 public nextIntentNonce;

    mapping(bytes32 intentId => IntentRecord) public intents;

    constructor(address xcmPrecompile, address initialExecutor, address initialTreasury, uint16 feeBps)
        AccessControlDefaultAdminRules(DEFAULT_ADMIN_TRANSFER_DELAY, msg.sender)
    {
        if (xcmPrecompile == address(0) || initialExecutor == address(0) || initialTreasury == address(0)) {
            revert ZeroAddress();
        }
        if (feeBps > MAX_PLATFORM_FEE_BPS) revert InvalidFeeBps();

        xcm = IXcm(xcmPrecompile);
        executor = initialExecutor;
        treasury = initialTreasury;
        platformFeeBps = feeBps;
        _grantRole(EXECUTOR_ROLE, initialExecutor);

        emit ExecutorUpdated(initialExecutor);
        emit TreasuryUpdated(initialTreasury);
        emit PlatformFeeUpdated(feeBps);
    }

    function submitIntent(IntentRequest calldata request)
        external
        payable
        whenNotPaused
        nonReentrant
        returns (bytes32 intentId)
    {
        if (request.refundAddress == address(0)) revert ZeroAddress();
        if (request.amount == 0) revert InvalidAmount();
        if (request.deadline <= block.timestamp) revert InvalidDeadline();
        if (request.executionHash == bytes32(0)) revert InvalidExecutionHash();

        uint128 platformFee = _platformFee(request.amount);
        uint128 totalLocked = request.amount + request.xcmFee + request.destinationFee + platformFee;

        intentId = keccak256(
            abi.encode(
                msg.sender,
                nextIntentNonce++,
                request.actionType,
                request.asset,
                request.refundAddress,
                request.amount,
                request.xcmFee,
                request.destinationFee,
                request.minOutputAmount,
                request.deadline,
                request.executionHash
            )
        );

        intents[intentId] = IntentRecord({
            owner: msg.sender,
            asset: request.asset,
            refundAddress: request.refundAddress,
            amount: request.amount,
            xcmFee: request.xcmFee,
            destinationFee: request.destinationFee,
            platformFee: platformFee,
            minOutputAmount: request.minOutputAmount,
            deadline: request.deadline,
            actionType: request.actionType,
            status: IntentStatus.Submitted,
            executionHash: request.executionHash,
            outcomeReference: bytes32(0),
            resultAssetId: bytes32(0),
            failureReasonHash: bytes32(0),
            resultAmount: 0,
            refundAmount: 0
        });

        _receiveAsset(request.asset, msg.sender, totalLocked);

        emit IntentSubmitted(
            intentId,
            msg.sender,
            request.asset,
            request.refundAddress,
            request.actionType,
            request.amount,
            totalLocked
        );
    }

    function dispatchIntent(bytes32 intentId, DispatchRequest calldata request)
        external
        onlyRole(EXECUTOR_ROLE)
        whenNotPaused
        nonReentrant
    {
        IntentRecord storage intent = intents[intentId];
        if (intent.owner == address(0)) revert IntentNotFound();
        if (intent.status != IntentStatus.Submitted) revert InvalidIntentStatus();
        if (block.timestamp > intent.deadline) revert IntentExpired();

        bytes32 executionHash = keccak256(abi.encode(request.mode, request.destination, request.message));
        if (executionHash != intent.executionHash) revert InvalidDispatchPayload();

        intent.status = IntentStatus.Dispatched;

        if (address(xcm) == MOONBEAM_XCM_PRECOMPILE_ADDRESS) {
            if (request.mode == DispatchMode.Execute) {
                uint64 weight = IMoonbeamXcm(address(xcm)).weightMessage(request.message);
                IMoonbeamXcm(address(xcm)).xcmExecute(request.message, weight);
                if (intent.platformFee != 0) {
                    _transferAsset(intent.asset, treasury, intent.platformFee);
                }
                emit IntentDispatched(intentId, request.mode, weight, 0);
                return;
            }
            
            revert InvalidDispatchPayload();
        } else {
            if (request.mode == DispatchMode.Execute) {
                IXcm.Weight memory weight = xcm.weighMessage(request.message);
                xcm.execute(request.message, weight);
                if (intent.platformFee != 0) {
                    _transferAsset(intent.asset, treasury, intent.platformFee);
                }
                emit IntentDispatched(intentId, request.mode, weight.refTime, weight.proofSize);
                return;
            }

            xcm.send(request.destination, request.message);
            if (intent.platformFee != 0) {
                _transferAsset(intent.asset, treasury, intent.platformFee);
            }
            emit IntentDispatched(intentId, request.mode, 0, 0);
        }
    }

    function finalizeSuccess(bytes32 intentId, bytes32 outcomeReference, bytes32 resultAssetId, uint128 resultAmount)
        external
        onlyRole(EXECUTOR_ROLE)
        whenNotPaused
        nonReentrant
    {
        IntentRecord storage intent = intents[intentId];
        if (intent.owner == address(0)) revert IntentNotFound();
        if (intent.status != IntentStatus.Dispatched) revert InvalidIntentStatus();
        if (outcomeReference == bytes32(0)) revert InvalidOutcomeReference();
        if (resultAmount < intent.minOutputAmount) revert InsufficientResultAmount();

        intent.status = IntentStatus.Settled;
        intent.outcomeReference = outcomeReference;
        intent.resultAssetId = resultAssetId;
        intent.failureReasonHash = bytes32(0);
        intent.resultAmount = resultAmount;
        intent.refundAmount = 0;

        emit IntentSettled(intentId, outcomeReference, resultAssetId, resultAmount);
    }

    function finalizeExternalSuccess(
        bytes32 intentId,
        bytes32 outcomeReference,
        bytes32 resultAssetId,
        uint128 resultAmount
    ) external onlyRole(EXECUTOR_ROLE) whenNotPaused nonReentrant {
        IntentRecord storage intent = intents[intentId];
        if (intent.owner == address(0)) revert IntentNotFound();
        if (intent.status != IntentStatus.Submitted) revert InvalidIntentStatus();
        if (outcomeReference == bytes32(0)) revert InvalidOutcomeReference();
        if (resultAmount < intent.minOutputAmount) revert InsufficientResultAmount();

        intent.status = IntentStatus.Settled;
        intent.outcomeReference = outcomeReference;
        intent.resultAssetId = resultAssetId;
        intent.failureReasonHash = bytes32(0);
        intent.resultAmount = resultAmount;
        intent.refundAmount = 0;

        _transferAsset(intent.asset, executor, intent.amount + intent.xcmFee + intent.destinationFee);
        if (intent.platformFee != 0) {
            _transferAsset(intent.asset, treasury, intent.platformFee);
        }

        emit IntentSettled(intentId, outcomeReference, resultAssetId, resultAmount);
    }

    function finalizeFailure(bytes32 intentId, bytes32 outcomeReference, bytes32 failureReasonHash)
        external
        onlyRole(EXECUTOR_ROLE)
        whenNotPaused
        nonReentrant
    {
        IntentRecord storage intent = intents[intentId];
        if (intent.owner == address(0)) revert IntentNotFound();
        if (intent.status != IntentStatus.Dispatched) revert InvalidIntentStatus();
        if (outcomeReference == bytes32(0)) revert InvalidOutcomeReference();
        if (failureReasonHash == bytes32(0)) revert InvalidFailureReason();

        intent.status = IntentStatus.Failed;
        intent.outcomeReference = outcomeReference;
        intent.resultAssetId = bytes32(0);
        intent.failureReasonHash = failureReasonHash;
        intent.resultAmount = 0;
        intent.refundAmount = 0;

        emit IntentFailed(intentId, outcomeReference, failureReasonHash);
    }

    function refundFailedIntent(bytes32 intentId, uint128 refundAmount)
        external
        onlyRole(EXECUTOR_ROLE)
        whenNotPaused
        nonReentrant
    {
        IntentRecord storage intent = intents[intentId];
        if (intent.owner == address(0)) revert IntentNotFound();
        if (intent.status != IntentStatus.Failed) revert InvalidIntentStatus();

        uint128 refundableAmount = _refundableAmount(intent);
        if (refundAmount == 0 || refundAmount != refundableAmount) revert InvalidRefundAmount();

        intent.status = IntentStatus.Refunded;
        intent.refundAmount += refundAmount;

        _transferAsset(intent.asset, intent.refundAddress, refundAmount);

        emit IntentRefunded(intentId, refundAmount);
    }

    function cancelIntent(bytes32 intentId) external whenNotPaused nonReentrant {
        IntentRecord storage intent = intents[intentId];
        if (intent.owner == address(0)) revert IntentNotFound();
        if (intent.status != IntentStatus.Submitted) revert InvalidIntentStatus();
        if (msg.sender != intent.owner && msg.sender != owner()) revert Unauthorized();

        intent.status = IntentStatus.Cancelled;

        uint128 lockedAmount = intent.amount + intent.xcmFee + intent.destinationFee + intent.platformFee;
        _transferAsset(intent.asset, intent.refundAddress, lockedAmount);

        emit IntentCancelled(intentId);
    }

    function grantRole(bytes32 role, address account) public override {
        if (role == EXECUTOR_ROLE) revert UseSetExecutor();
        super.grantRole(role, account);
    }

    function revokeRole(bytes32 role, address account) public override {
        if (role == EXECUTOR_ROLE) revert UseSetExecutor();
        super.revokeRole(role, account);
    }

    function renounceRole(bytes32 role, address callerConfirmation) public override {
        if (role == EXECUTOR_ROLE) revert UseSetExecutor();
        super.renounceRole(role, callerConfirmation);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function setExecutor(address newExecutor) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newExecutor == address(0)) revert ZeroAddress();
        _revokeRole(EXECUTOR_ROLE, executor);
        _grantRole(EXECUTOR_ROLE, newExecutor);
        executor = newExecutor;
        emit ExecutorUpdated(newExecutor);
    }

    function setTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newTreasury == address(0)) revert ZeroAddress();
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    function setPlatformFeeBps(uint16 newFeeBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newFeeBps > MAX_PLATFORM_FEE_BPS) revert InvalidFeeBps();
        platformFeeBps = newFeeBps;
        emit PlatformFeeUpdated(newFeeBps);
    }

    function getIntent(bytes32 intentId) external view returns (IntentRecord memory) {
        return intents[intentId];
    }

    function previewPlatformFee(uint128 amount) external view returns (uint128) {
        return _platformFee(amount);
    }

    function previewLockedAmount(IntentRequest calldata request) external view returns (uint128) {
        return request.amount + request.xcmFee + request.destinationFee + _platformFee(request.amount);
    }

    function previewRefundableAmount(bytes32 intentId) external view returns (uint128) {
        IntentRecord storage intent = intents[intentId];
        if (intent.owner == address(0)) revert IntentNotFound();
        if (intent.status != IntentStatus.Failed) {
            return 0;
        }

        return _refundableAmount(intent);
    }

    function _platformFee(uint128 amount) internal view returns (uint128) {
        if (amount == 0 || platformFeeBps == 0) return 0;

        uint128 fee = uint128((uint256(amount) * platformFeeBps) / 10_000);
        return fee == 0 ? 1 : fee;
    }

    function _refundableAmount(IntentRecord storage intent) internal view returns (uint128) {
        uint128 lockedNetAmount = intent.amount + intent.xcmFee + intent.destinationFee;
        return lockedNetAmount - intent.refundAmount;
    }

    function _receiveAsset(address asset, address from, uint256 amount) internal {
        if (_isNativeAsset(asset)) {
            if (msg.value != amount) revert InvalidNativeValue();
            return;
        }
        if (msg.value != 0) revert InvalidNativeValue();
        IERC20(asset).safeTransferFrom(from, address(this), amount);
    }

    function _transferAsset(address asset, address to, uint256 amount) internal {
        if (amount == 0) return;
        if (_isNativeAsset(asset)) {
            _safeNativeTransfer(to, amount);
            return;
        }
        IERC20(asset).safeTransfer(to, amount);
    }

    function _safeNativeTransfer(address to, uint256 amount) internal {
        (bool success,) = payable(to).call{value: amount}("");
        if (!success) revert AssetTransferFailed();
    }

    function _isNativeAsset(address asset) internal pure returns (bool) {
        return asset == NATIVE_ASSET;
    }
}
