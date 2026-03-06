// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

address constant XCM_PRECOMPILE_ADDRESS = address(0xA0000);

interface IXcm {
    struct Weight {
        uint64 refTime;
        uint64 proofSize;
    }

    function execute(bytes calldata message, Weight calldata weight) external;

    function send(bytes calldata destination, bytes calldata message) external;

    function weighMessage(bytes calldata message) external view returns (Weight memory weight);
}
