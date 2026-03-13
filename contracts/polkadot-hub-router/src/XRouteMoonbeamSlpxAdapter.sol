// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ISlpx {
    function create_order(
        address assetAddress,
        uint128 amount,
        uint64 dest_chain_id,
        bytes memory receiver,
        string memory remark,
        uint32 channel_id
    ) external payable;
}

contract XRouteMoonbeamSlpxAdapter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    error ZeroAddress();
    error InvalidAmount();
    error InvalidRemark();

    event MintVdotOrderSubmitted(address indexed recipient, uint128 amount, string remark, uint32 channelId);
    event RedeemVdotOrderSubmitted(address indexed recipient, uint128 amount, string remark, uint32 channelId);

    ISlpx public immutable slpx;
    address public immutable dotAsset;
    address public immutable vdotAsset;
    uint64 public immutable destinationChainId;

    constructor(address slpxAddress, address dotAssetAddress, address vdotAssetAddress, uint64 destinationChainId_) {
        if (
            slpxAddress == address(0) || dotAssetAddress == address(0) || vdotAssetAddress == address(0)
                || destinationChainId_ == 0
        ) {
            revert ZeroAddress();
        }

        slpx = ISlpx(slpxAddress);
        dotAsset = dotAssetAddress;
        vdotAsset = vdotAssetAddress;
        destinationChainId = destinationChainId_;
    }

    function mintVdot(uint128 amount, address recipient, string calldata remark, uint32 channelId) external nonReentrant {
        _submitOrder(dotAsset, amount, recipient, remark, channelId);
        emit MintVdotOrderSubmitted(recipient, amount, remark, channelId);
    }

    function redeemVdot(uint128 amount, address recipient, string calldata remark, uint32 channelId)
        external
        nonReentrant
    {
        _submitOrder(vdotAsset, amount, recipient, remark, channelId);
        emit RedeemVdotOrderSubmitted(recipient, amount, remark, channelId);
    }

    function _submitOrder(address asset, uint128 amount, address recipient, string calldata remark, uint32 channelId)
        internal
    {
        if (amount == 0) revert InvalidAmount();
        if (recipient == address(0)) revert ZeroAddress();
        bytes memory remarkBytes = bytes(remark);
        if (remarkBytes.length == 0 || remarkBytes.length > 32) revert InvalidRemark();

        IERC20 token = IERC20(asset);
        token.forceApprove(address(slpx), 0);
        token.forceApprove(address(slpx), uint256(amount));
        slpx.create_order(asset, amount, destinationChainId, abi.encodePacked(recipient), remark, channelId);
        token.forceApprove(address(slpx), 0);
    }
}
