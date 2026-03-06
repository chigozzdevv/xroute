// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

library RecipientCodec {
    error InvalidRecipient();

    function decodeAddress(bytes memory recipient) internal pure returns (address decoded) {
        if (recipient.length == 20) {
            assembly {
                decoded := shr(96, mload(add(recipient, 32)))
            }
            return decoded;
        }

        if (recipient.length != 42 || recipient[0] != "0" || recipient[1] != "x") {
            revert InvalidRecipient();
        }

        uint160 value = 0;
        for (uint256 index = 2; index < recipient.length; index++) {
            value = (value << 4) | _decodeNibble(uint8(recipient[index]));
        }

        decoded = address(value);
    }

    function _decodeNibble(uint8 character) private pure returns (uint160) {
        if (character >= uint8(bytes1("0")) && character <= uint8(bytes1("9"))) {
            return character - uint8(bytes1("0"));
        }
        if (character >= uint8(bytes1("a")) && character <= uint8(bytes1("f"))) {
            return character - uint8(bytes1("a")) + 10;
        }
        if (character >= uint8(bytes1("A")) && character <= uint8(bytes1("F"))) {
            return character - uint8(bytes1("A")) + 10;
        }

        revert InvalidRecipient();
    }
}
