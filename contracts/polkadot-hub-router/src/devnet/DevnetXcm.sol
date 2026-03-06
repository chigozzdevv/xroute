// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IXcm} from "../interfaces/IXcm.sol";

contract DevnetXcm is IXcm {
    Weight public configuredWeight;
    bytes public lastDestination;
    bytes public lastMessage;
    bytes public lastExecutedMessage;
    uint256 public executeCount;
    uint256 public sendCount;

    event WeightConfigured(uint64 refTime, uint64 proofSize);
    event MessageExecuted(bytes message, uint64 refTime, uint64 proofSize);
    event MessageSent(bytes destination, bytes message);

    constructor(uint64 refTime, uint64 proofSize) {
        configuredWeight = Weight({refTime: refTime, proofSize: proofSize});
        emit WeightConfigured(refTime, proofSize);
    }

    function setWeight(uint64 refTime, uint64 proofSize) external {
        configuredWeight = Weight({refTime: refTime, proofSize: proofSize});
        emit WeightConfigured(refTime, proofSize);
    }

    function execute(bytes calldata message, Weight calldata suppliedWeight) external {
        require(suppliedWeight.refTime == configuredWeight.refTime, "refTime");
        require(suppliedWeight.proofSize == configuredWeight.proofSize, "proofSize");

        lastExecutedMessage = message;
        executeCount += 1;

        emit MessageExecuted(message, suppliedWeight.refTime, suppliedWeight.proofSize);
    }

    function send(bytes calldata destination, bytes calldata message) external {
        lastDestination = destination;
        lastMessage = message;
        sendCount += 1;

        emit MessageSent(destination, message);
    }

    function weighMessage(bytes calldata message) external view returns (Weight memory returnedWeight) {
        message;
        return configuredWeight;
    }
}
