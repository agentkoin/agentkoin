// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockArbitrator} from "../src/mocks/MockArbitrator.sol";
import {MockIdentityRegistry} from "../src/mocks/MockIdentityRegistry.sol";
import {MockERC8183Kernel} from "../src/mocks/MockERC8183Kernel.sol";
import {EvaluatorRegistry} from "../src/EvaluatorRegistry.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {ERC8183EvaluatorAdapter} from "../src/ERC8183EvaluatorAdapter.sol";
import {EscrowDepositRouteFactory} from "../src/EscrowDepositRoute.sol";
import {IEvaluatorRegistry} from "../src/interfaces/IEvaluatorRegistry.sol";
import {IArbitrator} from "../src/interfaces/IArbitrator.sol";
import {Defaults} from "./Defaults.sol";

/// @notice LOCAL ONLY. Refuses to run unless chainid == 31337 (Anvil).
/// @dev Slashers (escrow, adapter) are fixed in the registry constructor (R-5) using CREATE
///      address prediction; the script asserts the prediction held.
contract DeployLocal is Script {
    error NotLocalChain(uint256 chainId);
    error PredictionMismatch();

    // ERC-8183 reference-style kernel fees for the external kernel mock
    uint256 internal constant KERNEL_PLATFORM_FEE_BP = 100;
    uint256 internal constant KERNEL_EVALUATOR_FEE_BP = 50;

    MockUSDC internal usdc;
    MockArbitrator internal arb;
    EvaluatorRegistry internal registry;
    JobEscrow internal escrow;
    ERC8183EvaluatorAdapter internal adapter;
    MockIdentityRegistry internal identity;
    MockERC8183Kernel internal kernel;
    EscrowDepositRouteFactory internal routes;

    function run() external {
        if (block.chainid != 31337) revert NotLocalChain(block.chainid);
        address deployer = msg.sender;
        address treasury = vm.envOr("TREASURY", deployer);
        uint64 slasherTimelock = uint64(vm.envOr("SLASHER_TIMELOCK", uint256(Defaults.SLASHER_TIMELOCK)));
        uint256 arbFee = vm.envOr("ARBITRATION_FEE", Defaults.MOCK_ARBITRATION_FEE);
        uint64 sweepDelay = uint64(vm.envOr("ROUTE_SWEEP_DELAY", uint256(Defaults.ROUTE_SWEEP_DELAY)));

        vm.startBroadcast();
        usdc = new MockUSDC();
        arb = new MockArbitrator(deployer, arbFee);
        address[] memory slashers = new address[](2);
        {
            uint64 n = vm.getNonce(deployer);
            slashers[0] = vm.computeCreateAddress(deployer, n + 1); // escrow
            slashers[1] = vm.computeCreateAddress(deployer, n + 2); // adapter
        }
        registry = new EvaluatorRegistry(
            IERC20(address(usdc)), Defaults.registryConfig(treasury), deployer, slashers, slasherTimelock
        );
        escrow = _escrow(treasury, deployer);
        adapter = _adapter(treasury, deployer);
        if (address(escrow) != slashers[0] || address(adapter) != slashers[1]) revert PredictionMismatch();
        identity = new MockIdentityRegistry();
        kernel = new MockERC8183Kernel(IERC20(address(usdc)), treasury, KERNEL_PLATFORM_FEE_BP, KERNEL_EVALUATOR_FEE_BP);
        routes = _routeFactory(treasury, deployer, sweepDelay);
        vm.stopBroadcast();
        _write(treasury);
    }

    /// A-1e v0.1.2: keeper set + threshold fixed at deploy (default 2-of-3: public Anvil keys #7, #8, #9,
    ///       which agent/scripts/keeper.mjs uses via --keeper 0|1|2); later changes are timelocked.
    ///       ROUTE_KEEPERS (comma-separated addresses) and KEEPER_THRESHOLD override; k < 2 is only accepted
    ///       on local/test chains (enforced by the factory).
    function _routeFactory(address treasury, address owner, uint64 sweepDelay)
        internal
        returns (EscrowDepositRouteFactory)
    {
        address[] memory dflt = new address[](3);
        dflt[0] = 0x14dC79964da2C08b23698B3D3cc7Ca32193d9955; // Anvil #7
        dflt[1] = 0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f; // Anvil #8
        dflt[2] = 0xa0Ee7A142d267C1f36714E4a8F75612F20a79720; // Anvil #9
        address[] memory keepers = vm.envOr("ROUTE_KEEPERS", ",", dflt);
        EscrowDepositRouteFactory.Config memory cfg = EscrowDepositRouteFactory.Config({
            sweepDelay: sweepDelay,
            treasury: treasury,
            recoveryHorizon: uint64(vm.envOr("RECOVERY_HORIZON", uint256(Defaults.RECOVERY_HORIZON))),
            keeperTimelock: uint64(vm.envOr("KEEPER_TIMELOCK", uint256(Defaults.KEEPER_TIMELOCK))),
            threshold: uint8(vm.envOr("KEEPER_THRESHOLD", uint256(Defaults.KEEPER_THRESHOLD)))
        });
        return new EscrowDepositRouteFactory(IERC20(address(usdc)), address(escrow), owner, cfg, keepers);
    }

    function _escrow(address treasury, address owner) internal returns (JobEscrow) {
        return new JobEscrow(
            IERC20(address(usdc)),
            IEvaluatorRegistry(address(registry)),
            treasury,
            IArbitrator(address(arb)),
            Defaults.escrowConfig(),
            owner, owner, type(uint256).max, type(uint256).max
        );
    }

    function _adapter(address treasury, address owner) internal returns (ERC8183EvaluatorAdapter) {
        return new ERC8183EvaluatorAdapter(
            IERC20(address(usdc)),
            IEvaluatorRegistry(address(registry)),
            treasury,
            IArbitrator(address(arb)),
            Defaults.adapterConfig(),
            owner
        );
    }

    function _write(address treasury) internal {
        string memory o = "deploy";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeAddress(o, "usdc", address(usdc));
        vm.serializeAddress(o, "registry", address(registry));
        vm.serializeAddress(o, "arbitrator", address(arb));
        vm.serializeAddress(o, "treasury", treasury);
        vm.serializeAddress(o, "identityRegistry", address(identity));
        vm.serializeAddress(o, "adapter", address(adapter));
        vm.serializeAddress(o, "externalKernel", address(kernel));
        vm.serializeAddress(o, "depositRouteFactory", address(routes));
        vm.serializeAddress(o, "recoveryVault", address(routes.vault()));
        vm.serializeUint(o, "deployBlock", block.number);
        string memory json = vm.serializeAddress(o, "escrow", address(escrow));
        vm.writeJson(json, "./deployments/local.json");
        console2.log(json);
    }
}
