// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {EvaluatorRegistry} from "../src/EvaluatorRegistry.sol";

/// @notice Base Sepolia ONLY. registry.proposeSlasher(ADAPTER, true) from the registry owner (key file, never logged).
///         Never calls executeSlasher.
contract ProposeSlasherAdapterACPv2 is Script {
    error WrongChain(uint256 chainId);
    error WrongDeployer(address derived);

    address internal constant EXPECTED_DEPLOYER = 0x78e2C0164A80F3e337AE17e3bA4b8EA2C0Fa488e;
    address internal constant REGISTRY = 0x30576DE005df028D1947C56dEcc85a2a5612036a;
    address internal constant ADAPTER = 0xc8eD835872CFEe62Bc5E55Ee4B537B2817f48B8B;

    function run() external {
        if (block.chainid != 84532) revert WrongChain(block.chainid);
        uint256 pk = vm.parseUint(vm.trim(vm.readFile(vm.envOr("DEPLOYER_KEY_FILE", string(".secrets/testnet-deployer.key")))));
        if (vm.addr(pk) != EXPECTED_DEPLOYER) revert WrongDeployer(vm.addr(pk));
        vm.startBroadcast(pk);
        EvaluatorRegistry(REGISTRY).proposeSlasher(ADAPTER, true);
        vm.stopBroadcast();
        console2.log("proposed", ADAPTER);
    }
}
