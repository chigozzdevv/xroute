// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev XCM precompile on Polkadot Asset Hub
address constant XCM_PRECOMPILE_ADDRESS = address(0xA0000);
/// @dev XCM precompile on Moonbeam
address constant MOONBEAM_XCM_PRECOMPILE_ADDRESS = address(0x081A);

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
