// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IXcm} from "../interfaces/IXcm.sol";

contract MockXcmPrecompile is IXcm {
    Weight public weight;
    bytes public lastDestination;
    bytes public lastMessage;
    bytes public lastExecutedMessage;
    uint256 public executeCount;
    uint256 public sendCount;

    constructor() {
        weight = Weight({refTime: 500_000_000, proofSize: 32_768});
    }

    function setWeight(uint64 refTime, uint64 proofSize) external {
        weight = Weight({refTime: refTime, proofSize: proofSize});
    }

    function execute(bytes calldata message, Weight calldata suppliedWeight) external {
        require(suppliedWeight.refTime == weight.refTime, "refTime");
        require(suppliedWeight.proofSize == weight.proofSize, "proofSize");
        lastExecutedMessage = message;
        executeCount += 1;
    }

    function send(bytes calldata destination, bytes calldata message) external {
        lastDestination = destination;
        lastMessage = message;
        sendCount += 1;
    }

    function weighMessage(bytes calldata message) external view returns (Weight memory returnedWeight) {
        message;
        return weight;
    }
}
