// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {HydrationCallAdapterV1} from "../src/adapters/HydrationCallAdapterV1.sol";
import {HydrationStakeAdapterV1} from "../src/adapters/HydrationStakeAdapterV1.sol";
import {HydrationSwapAdapterV1} from "../src/adapters/HydrationSwapAdapterV1.sol";
import {TestBase} from "./helpers/TestBase.sol";

contract DestinationAdapterSelectorsTest is TestBase {
    function test_hydration_swap_adapter_selector_matches_published_spec() public pure {
        bytes4 expected = bytes4(hex"670b1f29");
        require(HydrationSwapAdapterV1.executeSwap.selector == expected, "assert eq failed");
    }

    function test_hydration_stake_adapter_selector_matches_published_spec() public pure {
        bytes4 expected = bytes4(hex"dfabdde3");
        require(HydrationStakeAdapterV1.executeStake.selector == expected, "assert eq failed");
    }

    function test_hydration_call_adapter_selector_matches_published_spec() public pure {
        bytes4 expected = bytes4(hex"7db7dbf6");
        require(HydrationCallAdapterV1.executeCall.selector == expected, "assert eq failed");
    }
}
