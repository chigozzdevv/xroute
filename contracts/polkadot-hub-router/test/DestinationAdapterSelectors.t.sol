// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IHydrationCallAdapterV1} from "../src/interfaces/IHydrationCallAdapterV1.sol";
import {IHydrationStakeAdapterV1} from "../src/interfaces/IHydrationStakeAdapterV1.sol";
import {IHydrationSwapAdapterV1} from "../src/interfaces/IHydrationSwapAdapterV1.sol";
import {TestBase} from "./helpers/TestBase.sol";

contract DestinationAdapterSelectorsTest is TestBase {
    function test_hydration_swap_adapter_selector_matches_published_spec() public pure {
        bytes4 expected = bytes4(hex"670b1f29");
        require(IHydrationSwapAdapterV1.executeSwap.selector == expected, "assert eq failed");
    }

    function test_hydration_stake_adapter_selector_matches_published_spec() public pure {
        bytes4 expected = bytes4(hex"dfabdde3");
        require(IHydrationStakeAdapterV1.executeStake.selector == expected, "assert eq failed");
    }

    function test_hydration_call_adapter_selector_matches_published_spec() public pure {
        bytes4 expected = bytes4(hex"7db7dbf6");
        require(IHydrationCallAdapterV1.executeCall.selector == expected, "assert eq failed");
    }
}
