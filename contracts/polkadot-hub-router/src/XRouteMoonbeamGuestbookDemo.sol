// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract XRouteMoonbeamGuestbookDemo {
    error NoEntries();

    struct Entry {
        address actor;
        bytes32 label;
        uint64 timestamp;
    }

    Entry[] private entries;
    mapping(address => uint256) public checkInCount;

    event CheckedIn(address indexed actor, bytes32 indexed label, uint256 indexed entryIndex, uint64 timestamp);

    function checkIn(bytes32 label) external {
        uint256 entryIndex = entries.length;
        entries.push(Entry({actor: msg.sender, label: label, timestamp: uint64(block.timestamp)}));
        checkInCount[msg.sender] += 1;
        emit CheckedIn(msg.sender, label, entryIndex, uint64(block.timestamp));
    }

    function entryCount() external view returns (uint256) {
        return entries.length;
    }

    function entryAt(uint256 index) external view returns (Entry memory) {
        return entries[index];
    }

    function latestEntry() external view returns (Entry memory) {
        if (entries.length == 0) revert NoEntries();
        return entries[entries.length - 1];
    }
}
