// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockSlpx {
    address public lastAssetAddress;
    uint128 public lastAmount;
    uint64 public lastDestChainId;
    bytes public lastReceiver;
    string public lastRemark;
    uint32 public lastChannelId;
    uint256 public orderCount;

    function create_order(
        address assetAddress,
        uint128 amount,
        uint64 dest_chain_id,
        bytes memory receiver,
        string memory remark,
        uint32 channel_id
    ) external payable {
        lastAssetAddress = assetAddress;
        lastAmount = amount;
        lastDestChainId = dest_chain_id;
        lastReceiver = receiver;
        lastRemark = remark;
        lastChannelId = channel_id;
        orderCount += 1;

        IERC20(assetAddress).transferFrom(msg.sender, address(this), amount);
    }
}
