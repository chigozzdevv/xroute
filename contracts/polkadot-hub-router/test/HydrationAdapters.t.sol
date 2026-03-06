// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {HydrationCallAdapterV1} from "../src/adapters/HydrationCallAdapterV1.sol";
import {HydrationAdapterBase} from "../src/adapters/HydrationAdapterBase.sol";
import {HydrationStakeAdapterV1} from "../src/adapters/HydrationStakeAdapterV1.sol";
import {HydrationSwapAdapterV1} from "../src/adapters/HydrationSwapAdapterV1.sol";
import {DevnetMintableToken} from "../src/devnet/DevnetMintableToken.sol";
import {HydrationStakeExecutorV1} from "../src/executors/HydrationStakeExecutorV1.sol";
import {HydrationSwapExecutorV1} from "../src/executors/HydrationSwapExecutorV1.sol";
import {TestBase} from "./helpers/TestBase.sol";
import {MockCallTarget} from "./mocks/MockCallTarget.sol";

contract HydrationAdaptersTest is TestBase {
    address internal constant DISPATCHER = address(0xD15CA7);
    address internal constant OWNER = address(0xA11CE);
    address internal constant RECIPIENT = address(0xB0B);

    DevnetMintableToken internal dot;
    DevnetMintableToken internal usdt;
    HydrationSwapExecutorV1 internal swapExecutor;
    HydrationStakeExecutorV1 internal stakeExecutor;
    MockCallTarget internal callTarget;
    HydrationSwapAdapterV1 internal swapAdapter;
    HydrationStakeAdapterV1 internal stakeAdapter;
    HydrationCallAdapterV1 internal callAdapter;

    function setUp() public {
        dot = new DevnetMintableToken("Polkadot", "DOT", 10, OWNER);
        usdt = new DevnetMintableToken("Tether", "USDT", 6, OWNER);
        swapExecutor = new HydrationSwapExecutorV1(OWNER);
        stakeExecutor = new HydrationStakeExecutorV1(OWNER);
        callTarget = new MockCallTarget();
        swapAdapter = new HydrationSwapAdapterV1(DISPATCHER, address(swapExecutor));
        stakeAdapter = new HydrationStakeAdapterV1(DISPATCHER, address(stakeExecutor));
        callAdapter = new HydrationCallAdapterV1(DISPATCHER);

        vm.prank(OWNER);
        swapExecutor.setAdapter(address(swapAdapter));
        vm.prank(OWNER);
        stakeExecutor.setAdapter(address(stakeAdapter));
        vm.prank(OWNER);
        swapExecutor.setAsset(bytes32("DOT"), address(dot), 10);
        vm.prank(OWNER);
        swapExecutor.setAsset(bytes32("USDT"), address(usdt), 6);
        vm.prank(OWNER);
        swapExecutor.setPair(bytes32("DOT"), bytes32("USDT"), 495, 100, 30);
        vm.prank(OWNER);
        usdt.setMinter(address(swapExecutor), true);
    }

    function test_swap_adapter_forwards_to_executor() public {
        bytes32 assetInId = bytes32("DOT");
        bytes32 assetOutId = bytes32("USDT");
        bytes memory settlementPlan =
            abi.encode(uint8(2), bytes32("USDT"), uint256(1000), uint256(1000), uint256(35000), bytes("0x0000000000000000000000000000000000000b0b"));

        vm.prank(DISPATCHER);
        swapAdapter.executeSwap(assetInId, assetOutId, 100 * 10 ** 10, 490 * 10 ** 6, settlementPlan);

        HydrationSwapExecutorV1.SwapExecution memory execution = swapExecutor.getLastExecution();
        assertEq(execution.assetInId, assetInId);
        assertEq(execution.assetOutId, assetOutId);
        assertEq(execution.amountIn, 100 * 10 ** 10);
        assertEq(execution.minAmountOut, 490 * 10 ** 6);
        assertEq(execution.grossAmountOut, 495 * 10 ** 6);
        assertEq(execution.netAmountOut, 493_480_000);
        assertEq(execution.recipient, RECIPIENT);
        assertEq(execution.settlementFee, 35_000);
        assertEq(usdt.balanceOf(RECIPIENT), 493_480_000);
    }

    function test_swap_adapter_reverts_for_non_dispatcher() public {
        vm.expectRevert(HydrationAdapterBase.Unauthorized.selector);
        swapAdapter.executeSwap(bytes32("DOT"), bytes32("USDT"), 1, 1, bytes("5Frecipient"));
    }

    function test_stake_adapter_forwards_to_executor() public {
        bytes memory validator = bytes("validator-01");
        bytes memory recipient = bytes("0x0000000000000000000000000000000000000b0b");

        vm.prank(DISPATCHER);
        stakeAdapter.executeStake(bytes32("DOT"), 40 * 10 ** 10, validator, recipient);

        HydrationStakeExecutorV1.StakePosition memory position =
            stakeExecutor.getStakePosition(RECIPIENT, keccak256(validator), bytes32("DOT"));
        assertEq(position.amount, 40 * 10 ** 10);
        assertEq(position.updatedAt > 0, true);
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
