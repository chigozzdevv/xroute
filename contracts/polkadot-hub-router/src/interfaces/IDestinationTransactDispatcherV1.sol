// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IDestinationTransactDispatcherV1 {
    function dispatchEvmCall(address target, bytes calldata data) external;
}
