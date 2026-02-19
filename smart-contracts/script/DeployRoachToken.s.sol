// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {RoachToken} from "src/RoachToken.sol";

/// @notice Deploy script for RoachToken.
/// @dev Set MINT_TO as an environment variable before running.
contract DeployRoachToken is Script {
    function run() external returns (RoachToken token) {
        address mintTo = vm.envAddress("MINT_TO");

        vm.startBroadcast();
        token = new RoachToken(mintTo);
        vm.stopBroadcast();
    }
}
