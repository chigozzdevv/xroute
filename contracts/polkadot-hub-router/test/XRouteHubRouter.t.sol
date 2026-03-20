// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IAccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/extensions/IAccessControlDefaultAdminRules.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {XRouteHubRouter} from "../src/XRouteHubRouter.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockXcm} from "./mocks/MockXcm.sol";
import {TestBase} from "./helpers/TestBase.sol";

contract XRouteHubRouterTest is TestBase {
    address internal constant ALICE = address(0xA11CE);
    address internal constant REFUND_RECIPIENT = address(0xFEE1);
    address internal constant EXECUTOR = address(0xB0B);
    address internal constant NEW_EXECUTOR = address(0xBEEF);
    address internal constant TREASURY = address(0xC0FFEE);
    address internal constant NEW_TREASURY = address(0xCAFE);
    address internal constant NEW_ADMIN = address(0xDAD);

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
        assertEq(token.balanceOf(TREASURY), 0);
        assertEq(token.balanceOf(address(router)), lockedAmount);
        assertEq(xcm.executeCount(), 1);
        assertEq(xcm.lastExecutedMessage(), message);
    }

    function test_submit_and_dispatch_native_transfer_intent() public {
        bytes memory message = hex"050c000401000003";
        bytes32 executionHash = _executionHash(XRouteHubRouter.DispatchMode.Execute, "", message);
        XRouteHubRouter.IntentRequest memory request = XRouteHubRouter.IntentRequest({
            actionType: XRouteHubRouter.ActionType.Transfer,
            asset: address(0),
            refundAddress: REFUND_RECIPIENT,
            amount: 25 * 10 ** 10,
            xcmFee: 100_000_000,
            destinationFee: 20_000_000,
            minOutputAmount: 25 * 10 ** 10,
            deadline: uint64(block.timestamp + 1 days),
            executionHash: executionHash
        });

        uint256 lockedAmount = router.previewLockedAmount(request);
        vm.deal(ALICE, lockedAmount);

        vm.prank(ALICE);
        bytes32 intentId = router.submitIntent{value: lockedAmount}(request);

        assertEq(address(router).balance, lockedAmount);

        vm.prank(EXECUTOR);
        router.dispatchIntent(intentId, _dispatchRequest(XRouteHubRouter.DispatchMode.Execute, "", message));

        XRouteHubRouter.IntentRecord memory intent = router.getIntent(intentId);
        assertEq(uint256(intent.status), uint256(XRouteHubRouter.IntentStatus.Dispatched));
        assertEq(TREASURY.balance, 0);
        assertEq(address(router).balance, lockedAmount);
    }

    function test_finalize_external_success_reimburses_executor_from_escrow() public {
        bytes memory message = hex"050c000401000003";
        bytes32 executionHash = _executionHash(XRouteHubRouter.DispatchMode.Execute, "", message);
        XRouteHubRouter.IntentRequest memory request = XRouteHubRouter.IntentRequest({
            actionType: XRouteHubRouter.ActionType.Transfer,
            asset: address(0),
            refundAddress: REFUND_RECIPIENT,
            amount: 25 * 10 ** 10,
            xcmFee: 100_000_000,
            destinationFee: 20_000_000,
            minOutputAmount: 25 * 10 ** 10,
            deadline: uint64(block.timestamp + 1 days),
            executionHash: executionHash
        });

        uint256 lockedAmount = router.previewLockedAmount(request);
        vm.deal(ALICE, lockedAmount);

        vm.prank(ALICE);
        bytes32 intentId = router.submitIntent{value: lockedAmount}(request);

        vm.prank(EXECUTOR);
        router.finalizeExternalSuccess(intentId, keccak256("source-xcm"), keccak256("DOT"), 25 * 10 ** 10);

        XRouteHubRouter.IntentRecord memory intent = router.getIntent(intentId);
        assertEq(uint256(intent.status), uint256(XRouteHubRouter.IntentStatus.Settled));
        assertEq(intent.outcomeReference, keccak256("source-xcm"));
        assertEq(intent.resultAssetId, keccak256("DOT"));
        assertEq(intent.resultAmount, 25 * 10 ** 10);
        assertEq(EXECUTOR.balance, 25 * 10 ** 10 + 100_000_000 + 20_000_000);
        assertEq(TREASURY.balance, 250_000_000);
        assertEq(address(router).balance, 0);
    }

    function test_finalize_external_success_reimburses_executor_after_dispatch_without_xcm() public {
        bytes memory message = hex"050c000401000003";
        bytes32 executionHash = _executionHash(XRouteHubRouter.DispatchMode.Execute, "", message);
        XRouteHubRouter.IntentRequest memory request = XRouteHubRouter.IntentRequest({
            actionType: XRouteHubRouter.ActionType.Transfer,
            asset: address(0),
            refundAddress: REFUND_RECIPIENT,
            amount: 25 * 10 ** 10,
            xcmFee: 100_000_000,
            destinationFee: 20_000_000,
            minOutputAmount: 25 * 10 ** 10,
            deadline: uint64(block.timestamp + 1 days),
            executionHash: executionHash
        });

        uint256 lockedAmount = router.previewLockedAmount(request);
        vm.deal(ALICE, lockedAmount);

        vm.prank(ALICE);
        bytes32 intentId = router.submitIntent{value: lockedAmount}(request);

        vm.prank(EXECUTOR);
        router.dispatchIntentWithoutXcm(intentId, _dispatchRequest(XRouteHubRouter.DispatchMode.Execute, "", message), 500_000);

        vm.prank(EXECUTOR);
        router.finalizeExternalSuccess(intentId, keccak256("source-xcm"), keccak256("DOT"), 25 * 10 ** 10);

        XRouteHubRouter.IntentRecord memory intent = router.getIntent(intentId);
        assertEq(uint256(intent.status), uint256(XRouteHubRouter.IntentStatus.Settled));
        assertEq(EXECUTOR.balance, 25 * 10 ** 10 + 100_000_000 + 20_000_000);
        assertEq(TREASURY.balance, 250_000_000);
        assertEq(address(router).balance, 0);
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
        assertEq(token.balanceOf(TREASURY), 0);
        assertEq(token.balanceOf(address(router)), lockedAmount);
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

    function test_pause_blocks_submit_until_unpaused() public {
        bytes memory message = hex"050c000401000003008c864713010000";
        bytes32 executionHash = _executionHash(XRouteHubRouter.DispatchMode.Execute, "", message);
        XRouteHubRouter.IntentRequest memory request = _swapIntentRequest(executionHash);

        router.pause();
        assertEq(router.paused(), true);

        vm.prank(ALICE);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        router.submitIntent(request);

        router.unpause();
        assertEq(router.paused(), false);

        vm.prank(ALICE);
        bytes32 intentId = router.submitIntent(request);

        XRouteHubRouter.IntentRecord memory intent = router.getIntent(intentId);
        assertEq(uint256(intent.status), uint256(XRouteHubRouter.IntentStatus.Submitted));
    }

    function test_set_executor_rotates_executor_role() public {
        bytes memory message = hex"050c000401000003008c864713010000";
        bytes32 executionHash = _executionHash(XRouteHubRouter.DispatchMode.Execute, "", message);
        XRouteHubRouter.IntentRequest memory request = _swapIntentRequest(executionHash);
        bytes32 executorRole = router.EXECUTOR_ROLE();

        vm.prank(ALICE);
        bytes32 intentId = router.submitIntent(request);

        router.setExecutor(NEW_EXECUTOR);

        assertEq(router.executor(), NEW_EXECUTOR);

        vm.prank(EXECUTOR);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, EXECUTOR, executorRole
            )
        );
        router.dispatchIntent(intentId, _dispatchRequest(XRouteHubRouter.DispatchMode.Execute, "", message));

        vm.prank(NEW_EXECUTOR);
        router.dispatchIntent(intentId, _dispatchRequest(XRouteHubRouter.DispatchMode.Execute, "", message));

        XRouteHubRouter.IntentRecord memory intent = router.getIntent(intentId);
        assertEq(uint256(intent.status), uint256(XRouteHubRouter.IntentStatus.Dispatched));
    }

    function test_default_admin_transfer_requires_delay() public {
        router.beginDefaultAdminTransfer(NEW_ADMIN);

        (address pendingAdmin, uint48 acceptSchedule) = router.pendingDefaultAdmin();
        assertEq(pendingAdmin, NEW_ADMIN);

        vm.prank(NEW_ADMIN);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControlDefaultAdminRules.AccessControlEnforcedDefaultAdminDelay.selector, acceptSchedule
            )
        );
        router.acceptDefaultAdminTransfer();

        vm.warp(uint256(acceptSchedule) + 1);

        vm.prank(NEW_ADMIN);
        router.acceptDefaultAdminTransfer();

        assertEq(router.owner(), NEW_ADMIN);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, address(this), bytes32(0)
            )
        );
        router.setTreasury(NEW_TREASURY);

        vm.prank(NEW_ADMIN);
        router.setTreasury(NEW_TREASURY);

        assertEq(router.treasury(), NEW_TREASURY);
    }

    function test_executor_role_cannot_be_granted_directly() public {
        bytes32 executorRole = router.EXECUTOR_ROLE();

        vm.expectRevert(XRouteHubRouter.UseSetExecutor.selector);
        router.grantRole(executorRole, NEW_EXECUTOR);
    }

    function test_submit_native_reverts_for_wrong_value() public {
        bytes memory message = hex"050c000401000003";
        bytes32 executionHash = _executionHash(XRouteHubRouter.DispatchMode.Execute, "", message);
        XRouteHubRouter.IntentRequest memory request = XRouteHubRouter.IntentRequest({
            actionType: XRouteHubRouter.ActionType.Transfer,
            asset: address(0),
            refundAddress: REFUND_RECIPIENT,
            amount: 25 * 10 ** 10,
            xcmFee: 100_000_000,
            destinationFee: 20_000_000,
            minOutputAmount: 25 * 10 ** 10,
            deadline: uint64(block.timestamp + 1 days),
            executionHash: executionHash
        });

        uint256 lockedAmount = router.previewLockedAmount(request);
        vm.deal(ALICE, lockedAmount);

        vm.prank(ALICE);
        vm.expectRevert(XRouteHubRouter.InvalidNativeValue.selector);
        router.submitIntent{value: lockedAmount - 1}(request);
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
        assertEq(token.balanceOf(TREASURY), 1_000_000_000);

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
        assertEq(router.previewRefundableAmount(intentId), 1_001_250_000_000);

        vm.prank(EXECUTOR);
        router.refundFailedIntent(intentId, 1_001_250_000_000);

        XRouteHubRouter.IntentRecord memory refundedIntent = router.getIntent(intentId);
        assertEq(uint256(refundedIntent.status), uint256(XRouteHubRouter.IntentStatus.Refunded));
        assertEq(refundedIntent.refundAmount, 1_001_250_000_000);
        assertEq(token.balanceOf(ALICE), 20_000_000_000_000 - 1_001_250_000_000);
        assertEq(token.balanceOf(REFUND_RECIPIENT), 1_001_250_000_000);
        assertEq(token.balanceOf(address(router)), 0);
        assertEq(token.balanceOf(TREASURY), 0);
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
        router.refundFailedIntent(intentId, 1_001_250_000_001);
    }

    function test_refund_reverts_for_partial_refund_amount() public {
        bytes memory message = hex"050c000401000003008c864713010000";
        bytes32 intentId = _submitAndDispatchSwap(message);

        vm.prank(EXECUTOR);
        router.finalizeFailure(intentId, keccak256("hydration-failure-3"), keccak256("remote-execution-failed"));

        vm.prank(EXECUTOR);
        vm.expectRevert(XRouteHubRouter.InvalidRefundAmount.selector);
        router.refundFailedIntent(intentId, 1_001_249_999_999);
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
