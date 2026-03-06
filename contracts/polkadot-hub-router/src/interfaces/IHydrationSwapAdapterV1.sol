// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IHydrationSwapAdapterV1 {
    function executeSwap(
        bytes32 assetInId,
        bytes32 assetOutId,
        uint256 amountIn,
        uint256 minAmountOut,
        bytes calldata recipient
    ) external;
}
