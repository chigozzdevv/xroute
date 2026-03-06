// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IHydrationStakeExecutor} from "../interfaces/IHydrationStakeExecutor.sol";
import {RecipientCodec} from "./RecipientCodec.sol";

contract HydrationStakeExecutorV1 is IHydrationStakeExecutor {
    using RecipientCodec for bytes;

    struct StakePosition {
        uint256 amount;
        uint256 updatedAt;
    }

    error ZeroAddress();
    error Unauthorized();

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event AdapterUpdated(address indexed adapter);
    event StakeRecorded(
        bytes32 indexed assetId,
        bytes32 indexed validatorHash,
        address indexed recipient,
        uint256 amount,
        uint256 totalAmount
    );

    address public owner;
    address public adapter;

    mapping(address recipient => mapping(bytes32 validatorHash => mapping(bytes32 assetId => StakePosition position)))
        private positions;

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyAdapter() {
        if (msg.sender != adapter) revert Unauthorized();
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

    function setAdapter(address newAdapter) external onlyOwner {
        if (newAdapter == address(0)) revert ZeroAddress();

        adapter = newAdapter;
        emit AdapterUpdated(newAdapter);
    }

    function stake(bytes32 assetId, uint256 amount, bytes calldata validator, bytes calldata recipient) external onlyAdapter {
        address recipientAddress = recipient.decodeAddress();
        bytes32 validatorHash = keccak256(validator);
        StakePosition storage position = positions[recipientAddress][validatorHash][assetId];

        position.amount += amount;
        position.updatedAt = block.timestamp;

        emit StakeRecorded(assetId, validatorHash, recipientAddress, amount, position.amount);
    }

    function getStakePosition(address recipient, bytes32 validatorHash, bytes32 assetId)
        external
        view
        returns (StakePosition memory position)
    {
        return positions[recipient][validatorHash][assetId];
    }
}
