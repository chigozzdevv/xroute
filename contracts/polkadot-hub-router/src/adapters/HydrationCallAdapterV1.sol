// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {HydrationAdapterBase} from "./HydrationAdapterBase.sol";
import {IHydrationCallAdapterV1} from "../interfaces/IHydrationCallAdapterV1.sol";

contract HydrationCallAdapterV1 is HydrationAdapterBase, IHydrationCallAdapterV1 {
    error TargetCallFailed(bytes reason);

    event CallForwarded(bytes32 indexed assetId, uint256 amount, address indexed target, bytes data, bytes result);

    constructor(address dispatcher_) HydrationAdapterBase(dispatcher_) {}

    function executeCall(
        bytes32 assetId,
        uint256 amount,
        address target,
        bytes calldata data
    ) external onlyDispatcher {
        if (target == address(0)) revert ZeroAddress();

        (bool success, bytes memory result) = target.call(data);
        if (!success) revert TargetCallFailed(result);

        emit CallForwarded(assetId, amount, target, data, result);
    }
}
