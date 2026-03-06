// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

abstract contract HydrationAdapterBase {
    error ZeroAddress();
    error Unauthorized();

    address public immutable dispatcher;

    constructor(address dispatcher_) {
        if (dispatcher_ == address(0)) revert ZeroAddress();
        dispatcher = dispatcher_;
    }

    modifier onlyDispatcher() {
        if (msg.sender != dispatcher) revert Unauthorized();
        _;
    }
}
