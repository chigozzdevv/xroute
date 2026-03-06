// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {XRouteHubRouter} from "../src/XRouteHubRouter.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockXcm} from "./mocks/MockXcm.sol";
import {TestBase} from "./helpers/TestBase.sol";

contract XRouteHubRouterTest is TestBase {
    address internal constant ALICE = address(0xA11CE);
    address internal constant EXECUTOR = address(0xB0B);
    address internal constant TREASURY = address(0xC0FFEE);

    MockERC20 internal token;
    MockXcm internal xcm;
    XRouteHubRouter internal router;

    function setUp() public {
        token = new MockERC20();
        xcm = new MockXcm();
        router = new XRouteHubRouter(address(xcm), EXECUTOR, TREASURY, 10);

        token.mint(ALICE, 2_000 * 10 ** 10);
        xcm.setWeight(250_000, 8_192);

        vm.prank(ALICE);
        token.approve(address(router), type(uint256).max);
    }

    function test_submit_and_dispatch_execute_intent() public {
        bytes memory message = hex"050c000401000003008c864713010000";
        bytes32 executionHash = keccak256(abi.encode(XRouteHubRouter.DispatchMode.Execute, bytes(""), message));

        XRouteHubRouter.IntentRequest memory request = XRouteHubRouter.IntentRequest({
            actionType: XRouteHubRouter.ActionType.Swap,
            asset: address(token),
            amount: 100 * 10 ** 10,
            xcmFee: 150_000_000,
            destinationFee: 100_000_000,
            minOutputAmount: 490 * 10 ** 6,
            deadline: uint64(block.timestamp + 1 days),
            executionHash: executionHash
        });

        uint256 lockedAmount = router.previewLockedAmount(request);

        vm.prank(ALICE);
        bytes32 intentId = router.submitIntent(request);

        assertEq(token.balanceOf(ALICE), 2_000 * 10 ** 10 - lockedAmount);
        assertEq(token.balanceOf(address(router)), lockedAmount);

        XRouteHubRouter.IntentRecord memory intent = router.getIntent(intentId);

        assertEq(intent.owner, ALICE);
        assertEq(intent.asset, address(token));
        assertEq(intent.amount, 100 * 10 ** 10);
        assertEq(intent.xcmFee, 150_000_000);
        assertEq(intent.destinationFee, 100_000_000);
        assertEq(intent.platformFee, 1_000_000_000);
        assertEq(intent.minOutputAmount, 490 * 10 ** 6);
        assertEq(intent.deadline, uint64(block.timestamp + 1 days));
        assertEq(uint256(intent.actionType), uint256(XRouteHubRouter.ActionType.Swap));
        assertEq(uint256(intent.status), uint256(XRouteHubRouter.IntentStatus.Submitted));
        assertEq(intent.executionHash, executionHash);

        vm.prank(EXECUTOR);
        router.dispatchIntent(
            intentId,
            XRouteHubRouter.DispatchRequest({
                mode: XRouteHubRouter.DispatchMode.Execute, destination: "", message: message
            })
        );

        intent = router.getIntent(intentId);

        assertEq(uint256(intent.status), uint256(XRouteHubRouter.IntentStatus.Dispatched));
        assertEq(token.balanceOf(TREASURY), 1_000_000_000);
        assertEq(token.balanceOf(address(router)), lockedAmount - 1_000_000_000);
        assertEq(xcm.executeCount(), 1);
        assertEq(xcm.lastExecutedMessage(), message);
    }

    function test_cancel_returns_full_locked_amount() public {
        bytes memory message = hex"050c000401000003";
        bytes32 executionHash = keccak256(abi.encode(XRouteHubRouter.DispatchMode.Send, hex"00010203", message));

        XRouteHubRouter.IntentRequest memory request = XRouteHubRouter.IntentRequest({
            actionType: XRouteHubRouter.ActionType.Transfer,
            asset: address(token),
            amount: 25 * 10 ** 10,
            xcmFee: 100_000_000,
            destinationFee: 20_000_000,
            minOutputAmount: 25 * 10 ** 10,
            deadline: uint64(block.timestamp + 1 days),
            executionHash: executionHash
        });

        uint256 lockedAmount = router.previewLockedAmount(request);

        vm.prank(ALICE);
        bytes32 intentId = router.submitIntent(request);

        assertEq(token.balanceOf(address(router)), lockedAmount);

        vm.prank(ALICE);
        router.cancelIntent(intentId);

        XRouteHubRouter.IntentRecord memory intent = router.getIntent(intentId);

        assertEq(uint256(intent.status), uint256(XRouteHubRouter.IntentStatus.Cancelled));
        assertEq(token.balanceOf(ALICE), 2_000 * 10 ** 10);
        assertEq(token.balanceOf(address(router)), 0);
    }

    function test_dispatch_reverts_for_uncommitted_payload() public {
        bytes memory message = hex"050c00";
        bytes32 executionHash = keccak256(abi.encode(XRouteHubRouter.DispatchMode.Execute, bytes(""), message));

        XRouteHubRouter.IntentRequest memory request = XRouteHubRouter.IntentRequest({
            actionType: XRouteHubRouter.ActionType.Swap,
            asset: address(token),
            amount: 10 * 10 ** 10,
            xcmFee: 10_000_000,
            destinationFee: 10_000_000,
            minOutputAmount: 1,
            deadline: uint64(block.timestamp + 1 days),
            executionHash: executionHash
        });

        vm.prank(ALICE);
        bytes32 intentId = router.submitIntent(request);

        vm.prank(EXECUTOR);
        vm.expectRevert(XRouteHubRouter.InvalidDispatchPayload.selector);
        router.dispatchIntent(
            intentId,
            XRouteHubRouter.DispatchRequest({
                mode: XRouteHubRouter.DispatchMode.Execute, destination: "", message: hex"1234"
            })
        );
    }
}
