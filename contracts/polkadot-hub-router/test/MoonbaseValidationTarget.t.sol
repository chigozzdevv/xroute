// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MoonbaseValidationTarget} from "../src/MoonbaseValidationTarget.sol";
import {TestBase} from "./helpers/TestBase.sol";

contract MoonbaseValidationTargetTest is TestBase {
    MoonbaseValidationTarget internal target;

    function setUp() public {
        target = new MoonbaseValidationTarget();
    }

    function test_ping_updates_state_and_returns_count() public {
        bytes32 payload = keccak256("xroute");

        uint256 count = target.ping(payload);

        assertEq(count, 1);
        assertEq(target.pingCount(), 1);
        assertEq(target.lastPayload(), payload);
        assertEq(target.lastCaller(), address(this));
    }
}
