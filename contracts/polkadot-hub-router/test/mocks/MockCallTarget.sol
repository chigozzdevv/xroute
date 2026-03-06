// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract MockCallTarget {
    uint256 public lastValue;

    function setValue(uint256 value) external returns (bytes32) {
        lastValue = value;
        return keccak256(abi.encode(value));
    }

    function revertAlways() external pure {
        revert("mock-call-target");
    }
}
