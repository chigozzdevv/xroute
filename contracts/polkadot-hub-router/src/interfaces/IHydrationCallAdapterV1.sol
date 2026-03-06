// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IHydrationCallAdapterV1 {
    function executeCall(
        bytes32 assetId,
        uint256 amount,
        address target,
        bytes calldata data
    ) external;
}
