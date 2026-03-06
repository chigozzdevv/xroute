// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IHydrationSwapExecutor} from "../interfaces/IHydrationSwapExecutor.sol";
import {RecipientCodec} from "./RecipientCodec.sol";

interface IMintableToken {
    function mint(address to, uint256 amount) external;
}

contract HydrationSwapExecutorV1 is IHydrationSwapExecutor {
    using RecipientCodec for bytes;

    struct AssetConfig {
        address token;
        uint8 decimals;
        bool enabled;
    }

    struct PairConfig {
        uint128 priceNumerator;
        uint128 priceDenominator;
        uint16 feeBps;
        bool enabled;
    }

    struct SettlementPlan {
        uint8 mode;
        bytes32 assetOutId;
        uint256 reserveChainId;
        uint256 settlementChainId;
        uint256 estimatedFee;
        bytes recipient;
    }

    struct SwapExecution {
        bytes32 assetInId;
        bytes32 assetOutId;
        uint256 amountIn;
        uint256 minAmountOut;
        uint256 grossAmountOut;
        uint256 netAmountOut;
        address recipient;
        uint8 settlementMode;
        uint256 settlementChainId;
        uint256 settlementFee;
    }

    error ZeroAddress();
    error Unauthorized();
    error InvalidFeeBps();
    error InvalidRate();
    error UnsupportedAsset();
    error UnsupportedPair();
    error InvalidSettlementPlan();
    error InsufficientOutput();

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event AdapterUpdated(address indexed adapter);
    event AssetConfigured(bytes32 indexed assetId, address indexed token, uint8 decimals);
    event PairConfigured(
        bytes32 indexed assetInId,
        bytes32 indexed assetOutId,
        uint128 priceNumerator,
        uint128 priceDenominator,
        uint16 feeBps
    );
    event SwapExecuted(
        bytes32 indexed assetInId,
        bytes32 indexed assetOutId,
        uint256 amountIn,
        uint256 grossAmountOut,
        uint256 netAmountOut,
        address recipient,
        uint8 settlementMode,
        uint256 settlementChainId,
        uint256 settlementFee
    );

    address public owner;
    address public adapter;
    SwapExecution public lastExecution;

    mapping(bytes32 assetId => AssetConfig config) public assets;
    mapping(bytes32 assetInId => mapping(bytes32 assetOutId => PairConfig config)) public pairs;

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyAdapter() {
        if (msg.sender != adapter) revert Unauthorized();
        _;
    }

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();

        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();

        address previousOwner = owner;
        owner = newOwner;

        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function setAdapter(address newAdapter) external onlyOwner {
        if (newAdapter == address(0)) revert ZeroAddress();

        adapter = newAdapter;
        emit AdapterUpdated(newAdapter);
    }

    function setAsset(bytes32 assetId, address token, uint8 decimals) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();

        assets[assetId] = AssetConfig({token: token, decimals: decimals, enabled: true});
        emit AssetConfigured(assetId, token, decimals);
    }

    function setPair(bytes32 assetInId, bytes32 assetOutId, uint128 priceNumerator, uint128 priceDenominator, uint16 feeBps)
        external
        onlyOwner
    {
        if (!assets[assetInId].enabled || !assets[assetOutId].enabled) revert UnsupportedAsset();
        if (priceNumerator == 0 || priceDenominator == 0) revert InvalidRate();
        if (feeBps > 10_000) revert InvalidFeeBps();

        pairs[assetInId][assetOutId] = PairConfig({
            priceNumerator: priceNumerator,
            priceDenominator: priceDenominator,
            feeBps: feeBps,
            enabled: true
        });

        emit PairConfigured(assetInId, assetOutId, priceNumerator, priceDenominator, feeBps);
    }

    function previewSwap(bytes32 assetInId, bytes32 assetOutId, uint256 amountIn)
        external
        view
        returns (uint256 grossAmountOut, uint256 netAmountOut)
    {
        return _quoteSwap(assetInId, assetOutId, amountIn);
    }

    function getLastExecution() external view returns (SwapExecution memory execution) {
        return lastExecution;
    }

    function swap(
        bytes32 assetInId,
        bytes32 assetOutId,
        uint256 amountIn,
        uint256 minAmountOut,
        bytes calldata settlementPlan
    ) external onlyAdapter {
        (
            uint8 mode,
            bytes32 plannedAssetOutId,
            uint256 reserveChainId,
            uint256 settlementChainId,
            uint256 estimatedFee,
            bytes memory recipientBytes
        ) = abi.decode(settlementPlan, (uint8, bytes32, uint256, uint256, uint256, bytes));
        SettlementPlan memory plan = SettlementPlan({
            mode: mode,
            assetOutId: plannedAssetOutId,
            reserveChainId: reserveChainId,
            settlementChainId: settlementChainId,
            estimatedFee: estimatedFee,
            recipient: recipientBytes
        });
        if (plan.assetOutId != assetOutId) revert InvalidSettlementPlan();

        (uint256 grossAmountOut, uint256 netAmountOut) = _quoteSwap(assetInId, assetOutId, amountIn);
        if (plan.estimatedFee > netAmountOut) revert InvalidSettlementPlan();

        netAmountOut -= plan.estimatedFee;
        if (netAmountOut < minAmountOut) revert InsufficientOutput();

        address recipient = plan.recipient.decodeAddress();
        IMintableToken(assets[assetOutId].token).mint(recipient, netAmountOut);

        lastExecution = SwapExecution({
            assetInId: assetInId,
            assetOutId: assetOutId,
            amountIn: amountIn,
            minAmountOut: minAmountOut,
            grossAmountOut: grossAmountOut,
            netAmountOut: netAmountOut,
            recipient: recipient,
            settlementMode: plan.mode,
            settlementChainId: plan.settlementChainId,
            settlementFee: plan.estimatedFee
        });

        emit SwapExecuted(
            assetInId,
            assetOutId,
            amountIn,
            grossAmountOut,
            netAmountOut,
            recipient,
            plan.mode,
            plan.settlementChainId,
            plan.estimatedFee
        );
    }

    function _quoteSwap(bytes32 assetInId, bytes32 assetOutId, uint256 amountIn)
        internal
        view
        returns (uint256 grossAmountOut, uint256 netAmountOut)
    {
        PairConfig memory pair = pairs[assetInId][assetOutId];
        AssetConfig memory assetIn = assets[assetInId];
        AssetConfig memory assetOut = assets[assetOutId];

        if (!pair.enabled) revert UnsupportedPair();
        if (!assetIn.enabled || !assetOut.enabled) revert UnsupportedAsset();

        grossAmountOut = amountIn * pair.priceNumerator * (10 ** assetOut.decimals)
            / (pair.priceDenominator * (10 ** assetIn.decimals));
        netAmountOut = grossAmountOut * (10_000 - pair.feeBps) / 10_000;
    }
}
