// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RoachToken} from "src/RoachToken.sol";

contract RoachTokenTest is Test {
    function testInitialSupplyMintedToDesignatedHolder() external {
        address holder = makeAddr("holder");

        RoachToken token = new RoachToken(holder);

        assertEq(token.totalSupply(), RoachToken.INITIAL_SUPPLY());
        assertEq(token.balanceOf(holder), RoachToken.INITIAL_SUPPLY());
    }

    function testRevertsOnZeroAddressMintRecipient() external {
        vm.expectRevert("Initial holder cannot be zero");
        new RoachToken(address(0));
    }
}
