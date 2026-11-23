// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {EvaluatorRegistry} from "../src/EvaluatorRegistry.sol";

/// @notice Propose (do NOT execute) the AuthCapture arbiter as a slasher on the live Base Sepolia registry.
///         84532 only. ARBITER from env. Key from DEPLOYER_KEY_FILE, never logged.
contract ProposeArbiterSlasher is Script {
    error UnsupportedChain(uint256 chainId);

    address internal constant REGISTRY = 0x30576DE005df028D1947C56dEcc85a2a5612036a;

    function run() external {
        if (block.chainid != 84532) revert UnsupportedChain(block.chainid);
        address arbiter = vm.envAddress("ARBITER");
        require(arbiter.code.length > 0, "arbiter not deployed");
        uint256 pk =
            vm.parseUint(vm.trim(vm.readFile(vm.envOr("DEPLOYER_KEY_FILE", string(".secrets/testnet-deployer.key")))));
        EvaluatorRegistry reg = EvaluatorRegistry(REGISTRY);
        require(reg.owner() == vm.addr(pk), "not registry owner");
        require(!reg.isSlasher(arbiter), "already slasher");
        (, uint64 existingEta) = reg.pendingSlasher(arbiter);
        require(existingEta == 0, "already pending");

        vm.startBroadcast(pk);
        reg.proposeSlasher(arbiter, true);
        vm.stopBroadcast();

        (bool allowed, uint64 eta) = reg.pendingSlasher(arbiter);
        console2.log("arbiter", arbiter);
        console2.log("allowed", allowed);
        console2.log("eta", eta);
        console2.log("isSlasher still", reg.isSlasher(arbiter));
    }
}
