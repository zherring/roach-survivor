// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title RoachToken
/// @notice Fixed-supply ERC20 for $ROACH with no admin privileges.
contract RoachToken is ERC20 {
    uint256 public constant INITIAL_SUPPLY = 1_000_000_000 * 10 ** 18;

    /// @param initialHolder Wallet that receives 100% of the initial token supply.
    constructor(address initialHolder) ERC20("ROACH", "ROACH") {
        require(initialHolder != address(0), "Initial holder cannot be zero");
        _mint(initialHolder, INITIAL_SUPPLY);
    }
}
