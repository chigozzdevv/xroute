// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IHydrationStakeExecutor {
    function stake(
        bytes32 assetId,
        uint256 amount,
        bytes calldata validator,
        bytes calldata recipient
    ) external;
}
