// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC8183EvaluatorAdapter} from "../src/ERC8183EvaluatorAdapter.sol";
import {IEvaluatorRegistry} from "../src/interfaces/IEvaluatorRegistry.sol";
import {EvaluatorRegistry} from "../src/EvaluatorRegistry.sol";
import {IArbitrator} from "../src/interfaces/IArbitrator.sol";
import {Defaults} from "./Defaults.sol";

/// @notice Base Sepolia (84532) ONLY: deploy the ACP v2 adapter against the existing registry and call
///         registry.proposeSlasher(adapter, true) (48h timelock). Never calls executeSlasher.
///         Key from the file DEPLOYER_KEY_FILE (never logged). Aborts unless the key derives EXPECTED_DEPLOYER
///         and that address owns the registry. Token = the registry's stake token (adapter must match it).
contract DeployAdapterACPv2 is Script {
    error WrongChain(uint256 chainId);
    error WrongDeployer(address derived);
    error NotRegistryOwner();
    error TokenNotRegistryToken();

    address internal constant EXPECTED_DEPLOYER = 0x78e2C0164A80F3e337AE17e3bA4b8EA2C0Fa488e;
    address internal constant REGISTRY = 0x30576DE005df028D1947C56dEcc85a2a5612036a;
    address internal constant TOKEN = 0x036CbD53842c5426634e7929541eC2318f3dCF7e; // Circle test USDC = registry stake token
    address internal constant ARBITRATOR = 0x3C4587eD99B1969581cA4f041FD9535a0D269736; // MockArbitrator, same as v0.1.2 adapter

    function run() external {
        if (block.chainid != 84532) revert WrongChain(block.chainid);
        uint256 pk = vm.parseUint(vm.trim(vm.readFile(vm.envOr("DEPLOYER_KEY_FILE", string(".secrets/testnet-deployer.key")))));
        address deployer = vm.addr(pk);
        if (deployer != EXPECTED_DEPLOYER) revert WrongDeployer(deployer);
        EvaluatorRegistry reg = EvaluatorRegistry(REGISTRY);
        if (reg.owner() != deployer) revert NotRegistryOwner();
        if (address(reg.token()) != TOKEN) revert TokenNotRegistryToken();

        vm.startBroadcast(pk);
        ERC8183EvaluatorAdapter a = new ERC8183EvaluatorAdapter(
            IERC20(TOKEN), IEvaluatorRegistry(REGISTRY), deployer, IArbitrator(ARBITRATOR), Defaults.adapterConfig(), deployer
        );
        vm.stopBroadcast();
        console2.log("adapter", address(a));
    }
}
