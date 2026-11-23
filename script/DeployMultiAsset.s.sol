// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {EvaluatorRegistry} from "../src/EvaluatorRegistry.sol";
import {IEvaluatorRegistry} from "../src/interfaces/IEvaluatorRegistry.sol";
import {IArbitrator} from "../src/interfaces/IArbitrator.sol";
import {CrossCurrencySettler} from "../src/CrossCurrencySettler.sol";
import {ISwapRouterV3} from "../src/interfaces/ISwapRouterV3.sol";

/// @notice AD-009 Phase 1 TESTNET deploy (Base Sepolia 84532 or local Anvil/fork 31337 only).
///         1. CrossCurrencySettler(router = Uniswap SwapRouter02 0x94cC...12bc4)
///         2. JobEscrow instance with token = Circle EURC 0x8084...359F, same registry/treasury/arbitrator/owner as the
///            live USDC JobEscrow, config copied from the live escrow's currentConfig()
///         3. registry.proposeSlasher(eurcEscrow, true)  (executeSlasher allowed after the registry's 48 h timelock)
///         Key from DEPLOYER_KEY_FILE (default .secrets/testnet-deployer.key), never logged. No token transfers.
contract DeployMultiAsset is Script {
    error UnsupportedChain(uint256 chainId);
    error Precondition(string what);

    address internal constant EURC = 0x808456652fdb597867f38412077A9182bf77359F; // developers.circle.com
    address internal constant SWAP_ROUTER02 = 0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4; // docs.uniswap.org
    address internal constant USDC_ESCROW = 0x4EaF6d09F8C22980Bb16E719779ACe73A7b1CB3D; // live AgentCoin JobEscrow

    function run() external {
        if (block.chainid != 84532 && block.chainid != 31337) revert UnsupportedChain(block.chainid);
        uint256 pk = vm.parseUint(vm.trim(vm.readFile(vm.envOr("DEPLOYER_KEY_FILE", string(".secrets/testnet-deployer.key")))));
        address deployer = vm.addr(pk);
        if (EURC.code.length == 0 || SWAP_ROUTER02.code.length == 0 || USDC_ESCROW.code.length == 0) revert Precondition("code");
        JobEscrow live = JobEscrow(USDC_ESCROW);
        EvaluatorRegistry registry = EvaluatorRegistry(address(live.registry()));
        if (registry.owner() != deployer || live.owner() != deployer) revert Precondition("deployer must own registry and escrow");
        JobEscrow.Config memory c = live.currentConfig();

        vm.startBroadcast(pk);
        CrossCurrencySettler settler = new CrossCurrencySettler(ISwapRouterV3(SWAP_ROUTER02));
        JobEscrow eurcEscrow = new JobEscrow(
            IERC20(EURC), IEvaluatorRegistry(address(registry)), live.treasury(), IArbitrator(address(live.arbitrator())), c, deployer, deployer, type(uint256).max, type(uint256).max
        );
        registry.proposeSlasher(address(eurcEscrow), true);
        vm.stopBroadcast();

        console2.log("CrossCurrencySettler", address(settler));
        console2.log("JobEscrow(EURC)", address(eurcEscrow));
        console2.log("registry", address(registry));
        console2.log("slasher executable after (unix)", block.timestamp + registry.slasherTimelock());
    }
}
