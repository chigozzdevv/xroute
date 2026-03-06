// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IHydrationSwapExecutor} from "../../src/interfaces/IHydrationSwapExecutor.sol";

contract MockHydrationSwapExecutor is IHydrationSwapExecutor {
    bytes32 public lastAssetInId;
    bytes32 public lastAssetOutId;
    uint256 public lastAmountIn;
    uint256 public lastMinAmountOut;
    bytes public lastRecipient;
    uint256 public callCount;

    function swap(
        bytes32 assetInId,
        bytes32 assetOutId,
        uint256 amountIn,
        uint256 minAmountOut,
        bytes calldata recipient
    ) external {
        lastAssetInId = assetInId;
        lastAssetOutId = assetOutId;
        lastAmountIn = amountIn;
        lastMinAmountOut = minAmountOut;
        lastRecipient = recipient;
        callCount += 1;
    }
}
