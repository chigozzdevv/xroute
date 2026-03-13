// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {XRouteMoonbeamSlpxAdapter} from "../src/XRouteMoonbeamSlpxAdapter.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockSlpx} from "./mocks/MockSlpx.sol";
import {TestBase} from "./helpers/TestBase.sol";

contract XRouteMoonbeamSlpxAdapterTest is TestBase {
    address internal constant RECIPIENT = address(0xA11CE);
    uint64 internal constant MOONBEAM_DEST_CHAIN_ID = 1284;

    MockERC20 internal dot;
    MockERC20 internal vdot;
    MockSlpx internal slpx;
    XRouteMoonbeamSlpxAdapter internal adapter;

    function setUp() public {
        dot = new MockERC20();
        vdot = new MockERC20();
        slpx = new MockSlpx();
        adapter = new XRouteMoonbeamSlpxAdapter(address(slpx), address(dot), address(vdot), MOONBEAM_DEST_CHAIN_ID);
    }

    function test_mint_vdot_submits_order_with_deposited_dot() public {
        dot.mint(address(adapter), 10 * 10 ** 10);

        adapter.mintVdot(10 * 10 ** 10, RECIPIENT, "xroute", 0);

        assertEq(slpx.orderCount(), 1);
        assertEq(slpx.lastAssetAddress(), address(dot));
        assertEq(slpx.lastAmount(), 10 * 10 ** 10);
        assertEq(slpx.lastDestChainId(), MOONBEAM_DEST_CHAIN_ID);
        assertEq(bytes(slpx.lastRemark()), bytes("xroute"));
        assertEq(slpx.lastChannelId(), 0);
        assertEq(dot.balanceOf(address(slpx)), 10 * 10 ** 10);
        assertEq(dot.balanceOf(address(adapter)), 0);
        assertEq(dot.allowance(address(adapter), address(slpx)), 0);
        assertEq(slpx.lastReceiver(), abi.encodePacked(RECIPIENT));
    }

    function test_redeem_vdot_submits_order_with_deposited_vdot() public {
        vdot.mint(address(adapter), 5 * 10 ** 10);

        adapter.redeemVdot(5 * 10 ** 10, RECIPIENT, "OmniLS", 7);

        assertEq(slpx.orderCount(), 1);
        assertEq(slpx.lastAssetAddress(), address(vdot));
        assertEq(slpx.lastAmount(), 5 * 10 ** 10);
        assertEq(slpx.lastDestChainId(), MOONBEAM_DEST_CHAIN_ID);
        assertEq(bytes(slpx.lastRemark()), bytes("OmniLS"));
        assertEq(slpx.lastChannelId(), 7);
        assertEq(vdot.balanceOf(address(slpx)), 5 * 10 ** 10);
        assertEq(vdot.allowance(address(adapter), address(slpx)), 0);
    }

    function test_reverts_on_invalid_remark() public {
        dot.mint(address(adapter), 10 * 10 ** 10);

        vm.expectRevert(XRouteMoonbeamSlpxAdapter.InvalidRemark.selector);
        adapter.mintVdot(10 * 10 ** 10, RECIPIENT, "", 0);
    }
}
