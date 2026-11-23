// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AGCStackBuilder} from "./DeployAGC.s.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {EscrowDepositRouteFactory} from "../src/EscrowDepositRoute.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// @notice LOCAL ONLY (Anvil 31337): AGC stack over deployments/local.json, the notary evaluator (Anvil #3) wraps and
///         stakes 100 AGC. Writes deployments/local-agc.json. Public Anvil dev keys only.
contract DeployAGCLocal is Script, AGCStackBuilder {
    uint256 internal constant DEPLOYER = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80; // Anvil #0
    uint256 internal constant EVALUATOR = 0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6; // Anvil #3

    function run() external {
        require(block.chainid == 31337, "local only");
        string memory j = vm.readFile("deployments/local.json");
        address usdc = vm.parseJsonAddress(j, ".usdc");
        JobEscrow live = JobEscrow(vm.parseJsonAddress(j, ".escrow"));
        EscrowDepositRouteFactory f = EscrowDepositRouteFactory(vm.parseJsonAddress(j, ".depositRouteFactory"));
        address deployer = vm.addr(DEPLOYER);
        uint64 n = vm.getNonce(deployer);
        vm.startBroadcast(DEPLOYER);
        Stack memory s = _buildAGCStack(usdc, live, f, deployer, deployer, n, address(vm), 1);
        MockUSDC(usdc).mint(vm.addr(EVALUATOR), 100e6);
        vm.stopBroadcast();
        vm.startBroadcast(EVALUATOR);
        IERC20(usdc).approve(address(s.agc), 100e6);
        s.agc.wrap(100e6);
        IERC20(address(s.agc)).approve(address(s.registry), 100e6);
        s.registry.stake(100e6);
        vm.stopBroadcast();
        string memory o = "agc";
        vm.serializeAddress(o, "AGC_ADDRESS", address(s.agc));
        vm.serializeAddress(o, "AGC_REGISTRY", address(s.registry));
        vm.serializeAddress(o, "AGC_ESCROW", address(s.escrow));
        vm.serializeAddress(o, "AGC_ROUTE_FACTORY", address(s.factory));
        string memory out = vm.serializeAddress(o, "AGC_ADAPTER", address(s.adapter));
        vm.writeJson(out, "deployments/local-agc.json");
        console2.log("AGC", address(s.agc));
    }
}
