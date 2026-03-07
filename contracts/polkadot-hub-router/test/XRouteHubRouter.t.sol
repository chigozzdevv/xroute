// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {XRouteHubRouter} from "../src/XRouteHubRouter.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockXcm} from "./mocks/MockXcm.sol";
import {TestBase} from "./helpers/TestBase.sol";

contract XRouteHubRouterTest is TestBase {
    address internal constant ALICE = address(0xA11CE);
    address internal constant REFUND_RECIPIENT = address(0xFEE1);
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
        bytes32 executionHash = _executionHash(XRouteHubRouter.DispatchMode.Execute, "", message);
        XRouteHubRouter.IntentRequest memory request = _swapIntentRequest(executionHash);

        uint256 lockedAmount = router.previewLockedAmount(request);

        vm.prank(ALICE);
        bytes32 intentId = router.submitIntent(request);

        assertEq(token.balanceOf(ALICE), 2_000 * 10 ** 10 - lockedAmount);
        assertEq(token.balanceOf(address(router)), lockedAmount);

        XRouteHubRouter.IntentRecord memory intent = router.getIntent(intentId);

        assertEq(intent.owner, ALICE);
        assertEq(intent.asset, address(token));
        assertEq(intent.refundAddress, REFUND_RECIPIENT);
        assertEq(intent.amount, 100 * 10 ** 10);
        assertEq(intent.xcmFee, 150_000_000);
        assertEq(intent.destinationFee, 100_000_000);
        assertEq(intent.platformFee, 1_000_000_000);
        assertEq(intent.minOutputAmount, 490 * 10 ** 6);
        assertEq(intent.deadline, uint64(block.timestamp + 1 days));
        assertEq(uint256(intent.actionType), uint256(XRouteHubRouter.ActionType.Swap));
        assertEq(uint256(intent.status), uint256(XRouteHubRouter.IntentStatus.Submitted));
        assertEq(intent.executionHash, executionHash);
        assertEq(intent.outcomeReference, bytes32(0));
        assertEq(intent.resultAssetId, bytes32(0));
        assertEq(intent.failureReasonHash, bytes32(0));
        assertEq(intent.resultAmount, 0);
        assertEq(intent.refundAmount, 0);

        vm.prank(EXECUTOR);
        router.dispatchIntent(intentId, _dispatchRequest(XRouteHubRouter.DispatchMode.Execute, "", message));

        intent = router.getIntent(intentId);

        assertEq(uint256(intent.status), uint256(XRouteHubRouter.IntentStatus.Dispatched));
        assertEq(token.balanceOf(TREASURY), 1_000_000_000);
        assertEq(token.balanceOf(address(router)), lockedAmount - 1_000_000_000);
        assertEq(xcm.executeCount(), 1);
        assertEq(xcm.lastExecutedMessage(), message);
    }

    function test_submit_and_dispatch_runtime_execute_intent() public {
        bytes memory message = hex"050c000401000003";
        bytes32 executionHash = _executionHash(XRouteHubRouter.DispatchMode.Execute, "", message);
        XRouteHubRouter.IntentRequest memory request = XRouteHubRouter.IntentRequest({
            actionType: XRouteHubRouter.ActionType.Execute,
            asset: address(token),
            refundAddress: REFUND_RECIPIENT,
            amount: 90_000_000,
            xcmFee: 150_000_000,
            destinationFee: 0,
            minOutputAmount: 0,
            deadline: uint64(block.timestamp + 1 days),
            executionHash: executionHash
        });

        uint256 lockedAmount = router.previewLockedAmount(request);

        vm.prank(ALICE);
        bytes32 intentId = router.submitIntent(request);

        XRouteHubRouter.IntentRecord memory intent = router.getIntent(intentId);
        assertEq(uint256(intent.actionType), uint256(XRouteHubRouter.ActionType.Execute));
        assertEq(intent.amount, 90_000_000);
        assertEq(intent.destinationFee, 0);
        assertEq(intent.minOutputAmount, 0);
        assertEq(token.balanceOf(address(router)), lockedAmount);

        vm.prank(EXECUTOR);
        router.dispatchIntent(intentId, _dispatchRequest(XRouteHubRouter.DispatchMode.Execute, "", message));

        intent = router.getIntent(intentId);
        assertEq(uint256(intent.status), uint256(XRouteHubRouter.IntentStatus.Dispatched));
        assertEq(token.balanceOf(TREASURY), 90_000);
        assertEq(xcm.executeCount(), 1);
        assertEq(xcm.lastExecutedMessage(), message);
    }

    function test_cancel_returns_full_locked_amount() public {
        bytes memory message = hex"050c000401000003";
        bytes32 executionHash = _executionHash(XRouteHubRouter.DispatchMode.Send, hex"00010203", message);

        XRouteHubRouter.IntentRequest memory request = XRouteHubRouter.IntentRequest({
            actionType: XRouteHubRouter.ActionType.Transfer,
            asset: address(token),
            refundAddress: REFUND_RECIPIENT,
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
        assertEq(token.balanceOf(ALICE), 2_000 * 10 ** 10 - lockedAmount);
        assertEq(token.balanceOf(REFUND_RECIPIENT), lockedAmount);
        assertEq(token.balanceOf(address(router)), 0);
    }

    function test_dispatch_reverts_for_uncommitted_payload() public {
        bytes memory message = hex"050c00";
        bytes32 executionHash = _executionHash(XRouteHubRouter.DispatchMode.Execute, "", message);
        XRouteHubRouter.IntentRequest memory request = _swapIntentRequest(executionHash);
        request.amount = 10 * 10 ** 10;
        request.xcmFee = 10_000_000;
        request.destinationFee = 10_000_000;
        request.minOutputAmount = 1;

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

    function test_finalize_success_records_settlement_onchain() public {
        bytes memory message = hex"050c000401000003008c864713010000";
        bytes32 intentId = _submitAndDispatchSwap(message);
        bytes32 outcomeReference = keccak256("hydration-settlement-1");
        bytes32 resultAssetId = keccak256("USDT");

        vm.prank(EXECUTOR);
        router.finalizeSuccess(intentId, outcomeReference, resultAssetId, 493_515_000);

        XRouteHubRouter.IntentRecord memory intent = router.getIntent(intentId);
        assertEq(uint256(intent.status), uint256(XRouteHubRouter.IntentStatus.Settled));
        assertEq(intent.outcomeReference, outcomeReference);
        assertEq(intent.resultAssetId, resultAssetId);
        assertEq(intent.resultAmount, 493_515_000);
        assertEq(intent.failureReasonHash, bytes32(0));
        assertEq(router.previewRefundableAmount(intentId), 0);

        vm.prank(EXECUTOR);
        vm.expectRevert(XRouteHubRouter.InvalidIntentStatus.selector);
        router.finalizeFailure(intentId, keccak256("second-outcome"), keccak256("should-not-work"));
    }

    function test_finalize_failure_and_refund_record_onchain() public {
        bytes memory message = hex"050c000401000003008c864713010000";
        bytes32 intentId = _submitAndDispatchSwap(message);
        bytes32 outcomeReference = keccak256("hydration-failure-1");
        bytes32 failureReasonHash = keccak256("slippage-exceeded");

        vm.prank(EXECUTOR);
        router.finalizeFailure(intentId, outcomeReference, failureReasonHash);

        XRouteHubRouter.IntentRecord memory failedIntent = router.getIntent(intentId);
        assertEq(uint256(failedIntent.status), uint256(XRouteHubRouter.IntentStatus.Failed));
        assertEq(failedIntent.outcomeReference, outcomeReference);
        assertEq(failedIntent.failureReasonHash, failureReasonHash);
        assertEq(router.previewRefundableAmount(intentId), 1_000_250_000_000);

        vm.prank(EXECUTOR);
        router.refundFailedIntent(intentId, 1_000_250_000_000);

        XRouteHubRouter.IntentRecord memory refundedIntent = router.getIntent(intentId);
        assertEq(uint256(refundedIntent.status), uint256(XRouteHubRouter.IntentStatus.Refunded));
        assertEq(refundedIntent.refundAmount, 1_000_250_000_000);
        assertEq(token.balanceOf(ALICE), 20_000_000_000_000 - 1_001_250_000_000);
        assertEq(token.balanceOf(REFUND_RECIPIENT), 1_000_250_000_000);
        assertEq(token.balanceOf(address(router)), 0);
        assertEq(token.balanceOf(TREASURY), 1_000_000_000);
    }

    function test_finalize_success_reverts_below_min_output() public {
        bytes memory message = hex"050c000401000003008c864713010000";
        bytes32 intentId = _submitAndDispatchSwap(message);

        vm.prank(EXECUTOR);
        vm.expectRevert(XRouteHubRouter.InsufficientResultAmount.selector);
        router.finalizeSuccess(intentId, keccak256("hydration-settlement-2"), keccak256("USDT"), 489_999_999);
    }

    function test_refund_reverts_above_refundable_amount() public {
        bytes memory message = hex"050c000401000003008c864713010000";
        bytes32 intentId = _submitAndDispatchSwap(message);

        vm.prank(EXECUTOR);
        router.finalizeFailure(intentId, keccak256("hydration-failure-2"), keccak256("remote-execution-failed"));

        vm.prank(EXECUTOR);
        vm.expectRevert(XRouteHubRouter.InvalidRefundAmount.selector);
        router.refundFailedIntent(intentId, 1_000_250_000_001);
    }

    function _submitAndDispatchSwap(bytes memory message) internal returns (bytes32 intentId) {
        bytes32 executionHash = _executionHash(XRouteHubRouter.DispatchMode.Execute, "", message);
        XRouteHubRouter.IntentRequest memory request = _swapIntentRequest(executionHash);

        vm.prank(ALICE);
        intentId = router.submitIntent(request);

        vm.prank(EXECUTOR);
        router.dispatchIntent(intentId, _dispatchRequest(XRouteHubRouter.DispatchMode.Execute, "", message));
    }

    function _swapIntentRequest(bytes32 executionHash)
        internal
        view
        returns (XRouteHubRouter.IntentRequest memory)
    {
        return XRouteHubRouter.IntentRequest({
            actionType: XRouteHubRouter.ActionType.Swap,
            asset: address(token),
            refundAddress: REFUND_RECIPIENT,
            amount: 100 * 10 ** 10,
            xcmFee: 150_000_000,
            destinationFee: 100_000_000,
            minOutputAmount: 490 * 10 ** 6,
            deadline: uint64(block.timestamp + 1 days),
            executionHash: executionHash
        });
    }

    function _dispatchRequest(XRouteHubRouter.DispatchMode mode, bytes memory destination, bytes memory message)
        internal
        pure
        returns (XRouteHubRouter.DispatchRequest memory)
    {
        return XRouteHubRouter.DispatchRequest({mode: mode, destination: destination, message: message});
    }

    function _executionHash(XRouteHubRouter.DispatchMode mode, bytes memory destination, bytes memory message)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(mode, destination, message));
    }
}
