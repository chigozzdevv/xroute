// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {HydrationCallAdapterV1} from "../src/adapters/HydrationCallAdapterV1.sol";
import {HydrationAdapterBase} from "../src/adapters/HydrationAdapterBase.sol";
import {HydrationStakeAdapterV1} from "../src/adapters/HydrationStakeAdapterV1.sol";
import {HydrationSwapAdapterV1} from "../src/adapters/HydrationSwapAdapterV1.sol";
import {TestBase} from "./helpers/TestBase.sol";
import {MockCallTarget} from "./mocks/MockCallTarget.sol";
import {MockHydrationStakeExecutor} from "./mocks/MockHydrationStakeExecutor.sol";
import {MockHydrationSwapExecutor} from "./mocks/MockHydrationSwapExecutor.sol";

contract HydrationAdaptersTest is TestBase {
    address internal constant DISPATCHER = address(0xD15CA7);

    MockHydrationSwapExecutor internal swapExecutor;
    MockHydrationStakeExecutor internal stakeExecutor;
    MockCallTarget internal callTarget;
    HydrationSwapAdapterV1 internal swapAdapter;
    HydrationStakeAdapterV1 internal stakeAdapter;
    HydrationCallAdapterV1 internal callAdapter;

    function setUp() public {
        swapExecutor = new MockHydrationSwapExecutor();
        stakeExecutor = new MockHydrationStakeExecutor();
        callTarget = new MockCallTarget();
        swapAdapter = new HydrationSwapAdapterV1(DISPATCHER, address(swapExecutor));
        stakeAdapter = new HydrationStakeAdapterV1(DISPATCHER, address(stakeExecutor));
        callAdapter = new HydrationCallAdapterV1(DISPATCHER);
    }

    function test_swap_adapter_forwards_to_executor() public {
        bytes32 assetInId = bytes32("DOT");
        bytes32 assetOutId = bytes32("USDT");
        bytes memory settlementPlan = abi.encode(uint8(2), bytes32("USDT"), uint256(1000), uint256(1000), uint256(35000), bytes("5FswapRecipient"));

        vm.prank(DISPATCHER);
        swapAdapter.executeSwap(
            assetInId,
            assetOutId,
            100 * 10 ** 10,
            490 * 10 ** 6,
            settlementPlan
        );

        assertEq(swapExecutor.callCount(), 1);
        assertEq(swapExecutor.lastAssetInId(), assetInId);
        assertEq(swapExecutor.lastAssetOutId(), assetOutId);
        assertEq(swapExecutor.lastAmountIn(), 100 * 10 ** 10);
        assertEq(swapExecutor.lastMinAmountOut(), 490 * 10 ** 6);
        assertEq(swapExecutor.lastSettlementPlan(), settlementPlan);
    }

    function test_swap_adapter_reverts_for_non_dispatcher() public {
        vm.expectRevert(HydrationAdapterBase.Unauthorized.selector);
        swapAdapter.executeSwap(bytes32("DOT"), bytes32("USDT"), 1, 1, bytes("5Frecipient"));
    }

    function test_stake_adapter_forwards_to_executor() public {
        bytes memory validator = bytes("validator-01");
        bytes memory recipient = bytes("5FstakeRecipient");

        vm.prank(DISPATCHER);
        stakeAdapter.executeStake(bytes32("DOT"), 40 * 10 ** 10, validator, recipient);

        assertEq(stakeExecutor.callCount(), 1);
        assertEq(stakeExecutor.lastAssetId(), bytes32("DOT"));
        assertEq(stakeExecutor.lastAmount(), 40 * 10 ** 10);
        assertEq(stakeExecutor.lastValidator(), validator);
        assertEq(stakeExecutor.lastRecipient(), recipient);
    }

    function test_call_adapter_executes_target_call() public {
        bytes memory payload = abi.encodeCall(MockCallTarget.setValue, (42));

        vm.prank(DISPATCHER);
        callAdapter.executeCall(bytes32("DOT"), 5 * 10 ** 10, address(callTarget), payload);

        assertEq(callTarget.lastValue(), 42);
    }

    function test_call_adapter_reverts_when_target_call_fails() public {
        bytes memory payload = abi.encodeCall(MockCallTarget.revertAlways, ());
        bytes memory expectedRevert = abi.encodeWithSelector(
            HydrationCallAdapterV1.TargetCallFailed.selector,
            abi.encodeWithSignature("Error(string)", "mock-call-target")
        );

        vm.prank(DISPATCHER);
        vm.expectRevert(expectedRevert);
        callAdapter.executeCall(bytes32("DOT"), 5 * 10 ** 10, address(callTarget), payload);
    }
}
