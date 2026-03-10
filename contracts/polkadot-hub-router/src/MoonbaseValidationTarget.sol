// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract MoonbaseValidationTarget {
    uint256 public pingCount;
    bytes32 public lastPayload;
    address public lastCaller;

    event Ping(address indexed caller, bytes32 indexed payload, uint256 count);

    function ping(bytes32 payload) external returns (uint256 count) {
        pingCount += 1;
        lastPayload = payload;
        lastCaller = msg.sender;

        emit Ping(msg.sender, payload, pingCount);
        return pingCount;
    }
}
