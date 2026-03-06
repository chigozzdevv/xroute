// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {HydrationAdapterBase} from "./HydrationAdapterBase.sol";
import {IHydrationSwapAdapterV1} from "../interfaces/IHydrationSwapAdapterV1.sol";
import {IHydrationSwapExecutor} from "../interfaces/IHydrationSwapExecutor.sol";

contract HydrationSwapAdapterV1 is HydrationAdapterBase, IHydrationSwapAdapterV1 {
    IHydrationSwapExecutor public immutable executor;

    event SwapForwarded(
        bytes32 indexed assetInId,
        bytes32 indexed assetOutId,
        uint256 amountIn,
        uint256 minAmountOut,
        bytes recipient
    );

    constructor(address dispatcher_, address executor_) HydrationAdapterBase(dispatcher_) {
        if (executor_ == address(0)) revert ZeroAddress();
        executor = IHydrationSwapExecutor(executor_);
    }

    function executeSwap(
        bytes32 assetInId,
        bytes32 assetOutId,
        uint256 amountIn,
        uint256 minAmountOut,
        bytes calldata recipient
    ) external onlyDispatcher {
        executor.swap(assetInId, assetOutId, amountIn, minAmountOut, recipient);
        emit SwapForwarded(assetInId, assetOutId, amountIn, minAmountOut, recipient);
    }
}
