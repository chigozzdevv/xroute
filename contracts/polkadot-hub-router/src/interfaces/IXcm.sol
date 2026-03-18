// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

address constant XCM_PRECOMPILE_ADDRESS = address(0xA0000);
address constant MOONBEAM_XCM_PRECOMPILE_ADDRESS = address(0x081A);
address constant MOONBEAM_XCM_UTILS_ADDRESS = address(0x080C);

interface IXcm {
    struct Weight {
        uint64 refTime;
        uint64 proofSize;
    }

    function execute(bytes calldata message, Weight calldata weight) external;

    function send(bytes calldata destination, bytes calldata message) external;

    function weighMessage(bytes calldata message) external view returns (Weight memory weight);
}

interface IMoonbeamXcm {
    struct Multilocation {
        uint8 parents;
        bytes[] interior;
    }

    function weightMessage(bytes calldata message) external view returns (uint64 weight);

    function xcmExecute(bytes calldata message, uint64 maxWeight) external;

    function xcmSend(Multilocation calldata dest, bytes calldata message) external;
}
