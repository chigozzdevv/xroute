// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "./interfaces/IERC20.sol";
import {IXcm} from "./interfaces/IXcm.sol";

contract XRouteHubRouter {
    enum ActionType {
        Transfer,
        Swap,
        Stake,
        Call
    }

    enum DispatchMode {
        Execute,
        Send
    }

    enum IntentStatus {
        None,
        Submitted,
        Dispatched,
        Cancelled
    }

    struct IntentRequest {
        ActionType actionType;
        address asset;
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
        uint128 amount;
        uint128 xcmFee;
        uint128 destinationFee;
        uint128 platformFee;
        uint128 minOutputAmount;
        uint64 deadline;
        ActionType actionType;
        IntentStatus status;
        bytes32 executionHash;
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
    error AssetTransferFailed();

    event IntentSubmitted(
        bytes32 indexed intentId,
        address indexed owner,
        address indexed asset,
        ActionType actionType,
        uint128 amount,
        uint128 totalLocked
    );
    event IntentDispatched(bytes32 indexed intentId, DispatchMode mode, uint64 refTime, uint64 proofSize);
    event IntentCancelled(bytes32 indexed intentId);
    event ExecutorUpdated(address indexed executor);
    event TreasuryUpdated(address indexed treasury);
    event PlatformFeeUpdated(uint16 feeBps);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    uint16 public constant MAX_PLATFORM_FEE_BPS = 1_000;

    IXcm public immutable xcm;

    address public owner;
    address public executor;
    address public treasury;
    uint16 public platformFeeBps;
    uint256 public nextIntentNonce;

    mapping(bytes32 intentId => IntentRecord) public intents;

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyExecutor() {
        if (msg.sender != executor) revert Unauthorized();
        _;
    }

    constructor(address xcmPrecompile, address initialExecutor, address initialTreasury, uint16 feeBps) {
        if (xcmPrecompile == address(0) || initialExecutor == address(0) || initialTreasury == address(0)) {
            revert ZeroAddress();
        }
        if (feeBps > MAX_PLATFORM_FEE_BPS) revert InvalidFeeBps();

        xcm = IXcm(xcmPrecompile);
        owner = msg.sender;
        executor = initialExecutor;
        treasury = initialTreasury;
        platformFeeBps = feeBps;

        emit OwnershipTransferred(address(0), msg.sender);
        emit ExecutorUpdated(initialExecutor);
        emit TreasuryUpdated(initialTreasury);
        emit PlatformFeeUpdated(feeBps);
    }

    function submitIntent(IntentRequest calldata request) external returns (bytes32 intentId) {
        if (request.asset == address(0)) revert ZeroAddress();
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
            amount: request.amount,
            xcmFee: request.xcmFee,
            destinationFee: request.destinationFee,
            platformFee: platformFee,
            minOutputAmount: request.minOutputAmount,
            deadline: request.deadline,
            actionType: request.actionType,
            status: IntentStatus.Submitted,
            executionHash: request.executionHash
        });

        _safeTransferFrom(request.asset, msg.sender, address(this), totalLocked);

        emit IntentSubmitted(intentId, msg.sender, request.asset, request.actionType, request.amount, totalLocked);
    }

    function dispatchIntent(bytes32 intentId, DispatchRequest calldata request) external onlyExecutor {
        IntentRecord storage intent = intents[intentId];
        if (intent.owner == address(0)) revert IntentNotFound();
        if (intent.status != IntentStatus.Submitted) revert InvalidIntentStatus();
        if (block.timestamp > intent.deadline) revert IntentExpired();

        bytes32 executionHash = keccak256(abi.encode(request.mode, request.destination, request.message));
        if (executionHash != intent.executionHash) revert InvalidDispatchPayload();

        intent.status = IntentStatus.Dispatched;

        if (intent.platformFee != 0) {
            _safeTransfer(intent.asset, treasury, intent.platformFee);
        }

        if (request.mode == DispatchMode.Execute) {
            IXcm.Weight memory weight = xcm.weighMessage(request.message);
            xcm.execute(request.message, weight);
            emit IntentDispatched(intentId, request.mode, weight.refTime, weight.proofSize);
            return;
        }

        xcm.send(request.destination, request.message);
        emit IntentDispatched(intentId, request.mode, 0, 0);
    }

    function cancelIntent(bytes32 intentId) external {
        IntentRecord storage intent = intents[intentId];
        if (intent.owner == address(0)) revert IntentNotFound();
        if (intent.status != IntentStatus.Submitted) revert InvalidIntentStatus();
        if (msg.sender != intent.owner && msg.sender != owner) revert Unauthorized();

        intent.status = IntentStatus.Cancelled;

        uint128 lockedAmount = intent.amount + intent.xcmFee + intent.destinationFee + intent.platformFee;
        _safeTransfer(intent.asset, intent.owner, lockedAmount);

        emit IntentCancelled(intentId);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();

        address previousOwner = owner;
        owner = newOwner;

        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function setExecutor(address newExecutor) external onlyOwner {
        if (newExecutor == address(0)) revert ZeroAddress();
        executor = newExecutor;
        emit ExecutorUpdated(newExecutor);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    function setPlatformFeeBps(uint16 newFeeBps) external onlyOwner {
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

    function _platformFee(uint128 amount) internal view returns (uint128) {
        if (amount == 0 || platformFeeBps == 0) return 0;

        uint128 fee = uint128((uint256(amount) * platformFeeBps) / 10_000);
        return fee == 0 ? 1 : fee;
    }

    function _safeTransfer(address asset, address to, uint256 amount) internal {
        (bool success, bytes memory data) = asset.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert AssetTransferFailed();
        }
    }

    function _safeTransferFrom(address asset, address from, address to, uint256 amount) internal {
        (bool success, bytes memory data) = asset.call(abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert AssetTransferFailed();
        }
    }
}
