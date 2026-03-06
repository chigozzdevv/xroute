// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IHydrationStakeExecutor} from "../../src/interfaces/IHydrationStakeExecutor.sol";

contract MockHydrationStakeExecutor is IHydrationStakeExecutor {
    bytes32 public lastAssetId;
    uint256 public lastAmount;
    bytes public lastValidator;
    bytes public lastRecipient;
    uint256 public callCount;

    function stake(
        bytes32 assetId,
        uint256 amount,
        bytes calldata validator,
        bytes calldata recipient
    ) external {
        lastAssetId = assetId;
        lastAmount = amount;
        lastValidator = validator;
        lastRecipient = recipient;
        callCount += 1;
    }
}
