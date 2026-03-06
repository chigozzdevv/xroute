// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {HydrationAdapterBase} from "./HydrationAdapterBase.sol";
import {IHydrationStakeAdapterV1} from "../interfaces/IHydrationStakeAdapterV1.sol";
import {IHydrationStakeExecutor} from "../interfaces/IHydrationStakeExecutor.sol";

contract HydrationStakeAdapterV1 is HydrationAdapterBase, IHydrationStakeAdapterV1 {
    IHydrationStakeExecutor public immutable executor;

    event StakeForwarded(bytes32 indexed assetId, uint256 amount, bytes validator, bytes recipient);

    constructor(address dispatcher_, address executor_) HydrationAdapterBase(dispatcher_) {
        if (executor_ == address(0)) revert ZeroAddress();
        executor = IHydrationStakeExecutor(executor_);
    }

    function executeStake(
        bytes32 assetId,
        uint256 amount,
        bytes calldata validator,
        bytes calldata recipient
    ) external onlyDispatcher {
        executor.stake(assetId, amount, validator, recipient);
        emit StakeForwarded(assetId, amount, validator, recipient);
    }
}
