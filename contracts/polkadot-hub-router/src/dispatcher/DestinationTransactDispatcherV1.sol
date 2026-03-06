// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IDestinationTransactDispatcherV1} from "../interfaces/IDestinationTransactDispatcherV1.sol";

contract DestinationTransactDispatcherV1 is IDestinationTransactDispatcherV1 {
    error ZeroAddress();
    error Unauthorized();
    error TargetNotAllowed();
    error TargetHasNoCode();
    error TargetCallFailed(bytes reason);

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event TargetAllowanceUpdated(address indexed target, bool allowed);
    event EvmCallDispatched(address indexed caller, address indexed target, bytes data, bytes result);

    address public owner;
    mapping(address target => bool allowed) public allowedTargets;

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();

        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();

        address previousOwner = owner;
        owner = newOwner;

        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function setTargetAllowed(address target, bool allowed) external onlyOwner {
        if (target == address(0)) revert ZeroAddress();

        allowedTargets[target] = allowed;
        emit TargetAllowanceUpdated(target, allowed);
    }

    function dispatchEvmCall(address target, bytes calldata data) external {
        if (!allowedTargets[target]) revert TargetNotAllowed();
        if (target.code.length == 0) revert TargetHasNoCode();

        (bool success, bytes memory result) = target.call(data);
        if (!success) revert TargetCallFailed(result);

        emit EvmCallDispatched(msg.sender, target, data, result);
    }
}
