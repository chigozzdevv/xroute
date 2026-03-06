// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface Vm {
    function prank(address caller) external;

    function expectRevert(bytes4 revertData) external;
}

abstract contract TestBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function assertEq(uint256 actual, uint256 expected) internal pure {
        require(actual == expected, "assert eq failed");
    }

    function assertEq(address actual, address expected) internal pure {
        require(actual == expected, "assert eq failed");
    }

    function assertEq(bytes32 actual, bytes32 expected) internal pure {
        require(actual == expected, "assert eq failed");
    }

    function assertEq(bytes4 actual, bytes4 expected) internal pure {
        require(actual == expected, "assert eq failed");
    }

    function assertEq(bytes memory actual, bytes memory expected) internal pure {
        require(keccak256(actual) == keccak256(expected), "assert eq failed");
    }

    function assertEq(bool actual, bool expected) internal pure {
        require(actual == expected, "assert eq failed");
    }
}
