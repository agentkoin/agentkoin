// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockArbitrator} from "../src/mocks/MockArbitrator.sol";
import {EvaluatorRegistry} from "../src/EvaluatorRegistry.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {ERC8183EvaluatorAdapter} from "../src/ERC8183EvaluatorAdapter.sol";
import {EscrowDepositRouteFactory} from "../src/EscrowDepositRoute.sol";
import {IEvaluatorRegistry} from "../src/interfaces/IEvaluatorRegistry.sol";
import {IArbitrator} from "../src/interfaces/IArbitrator.sol";
import {Defaults} from "./Defaults.sol";

/// @notice TESTNET deploy of the v0.1.2 system to Base Sepolia (84532), or to a local Anvil (31337).
///         Refuses every other chain id. Uses Circle's official Base Sepolia USDC by default (no MockUSDC); USDC=<addr> or TOKEN_PROFILE=virtuals selects another 6-decimal token for the whole stack.
/// @dev    - Key: read from the file named by DEPLOYER_KEY_FILE (default .secrets/testnet-deployer.key), never logged.
///         - Keepers: k = 1 with the deployer as sole keeper (TESTNET ONLY; the factory allows k < 2 only on
///           31337/1337/11155111/84532). See docs/ASSUMPTIONS.md "Testnet deployment".
///         - Arbitrator: MockArbitrator owned by the deployer (no real arbitrator exists for this system on
///           Base Sepolia). FLAGGED in ASSUMPTIONS.
///         - Not deployed: MockUSDC, MockERC8183Kernel, MockIdentityRegistry (the adapter is deployed because
///           it is a fixed registry slasher; no external kernel is wired on testnet).
///         - Testnet-only parameter overrides (env): MIN_STAKE (default 2 USDC), EVAL_WINDOW (default 1h),
///           CHALLENGE_WINDOW (default 600 s) so the on-chain smoke test can finalize in one session.
///           Everything else is Defaults.sol (spec values).
///         - Writes the addresses to DEPLOY_OUT (default ./deployments/base-sepolia.json on 84532,
///           ./deployments/fork-dryrun.json on 31337). Tx hashes come from forge's broadcast/ log.
contract DeployTestnet is Script {
    error UnsupportedChain(uint256 chainId);
    error PredictionMismatch();
    error NotUsdc();

    address internal constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e; // developers.circle.com

    struct Out {
        address usdc;
        address arb;
        address registry;
        address escrow;
        address adapter;
        address routes;
    }

    /// @dev Virtuals ACP v2 USDC on Base Sepolia (and BSC/Arc testnets): Virtual-Protocol/acp-node-v2
    ///      (commit 392dcc6) src/core/constants.ts USDC_ADDRESSES[baseSepolia.id]. Distinct from Circle's token above.
    address internal constant VIRTUALS_BASE_SEPOLIA_USDC = 0xECc22a8F6fD62388498fBa19813E214605a2BDb3;

    /// @dev Payment token for the whole stack (registry stake, escrow, adapter): env USDC wins, else
    ///      TOKEN_PROFILE=virtuals picks Virtuals' USDC, else Circle's. decimals()==6 is checked on-chain.
    function _paymentToken() internal view returns (address) {
        address explicit = vm.envOr("USDC", address(0));
        if (explicit != address(0)) return explicit;
        string memory profile = vm.envOr("TOKEN_PROFILE", string("circle"));
        if (keccak256(bytes(profile)) == keccak256("virtuals")) return VIRTUALS_BASE_SEPOLIA_USDC;
        return BASE_SEPOLIA_USDC;
    }

    function run() external {
        if (block.chainid != 84532 && block.chainid != 31337) revert UnsupportedChain(block.chainid);
        uint256 pk = _key(vm.envOr("DEPLOYER_KEY_FILE", string(".secrets/testnet-deployer.key")));
        address deployer = vm.addr(pk);
        address usdc = _paymentToken();
        if (usdc.code.length == 0 || IERC20Meta(usdc).decimals() != 6) revert NotUsdc();
        address treasury = vm.envOr("TREASURY", deployer);

        Out memory o;
        o.usdc = usdc;
        vm.startBroadcast(pk);
        o.arb = address(new MockArbitrator(deployer, vm.envOr("ARBITRATION_FEE", Defaults.MOCK_ARBITRATION_FEE)));
        address[] memory slashers = new address[](2);
        {
            uint64 n = vm.getNonce(deployer);
            slashers[0] = vm.computeCreateAddress(deployer, n + 1); // escrow
            slashers[1] = vm.computeCreateAddress(deployer, n + 2); // adapter
        }
        EvaluatorRegistry.Config memory rc = Defaults.registryConfig(treasury);
        rc.minStake = vm.envOr("MIN_STAKE", uint256(2e6));
        o.registry = address(
            new EvaluatorRegistry(
                IERC20(usdc),
                rc,
                deployer,
                slashers,
                uint64(vm.envOr("SLASHER_TIMELOCK", uint256(Defaults.SLASHER_TIMELOCK)))
            )
        );
        JobEscrow.Config memory ec = Defaults.escrowConfig();
        ec.evalWindow = uint64(vm.envOr("EVAL_WINDOW", uint256(1 hours)));
        ec.challengeWindow = uint64(vm.envOr("CHALLENGE_WINDOW", uint256(600)));
        o.escrow = address(
            new JobEscrow(IERC20(usdc), IEvaluatorRegistry(o.registry), treasury, IArbitrator(o.arb), ec, deployer, deployer, type(uint256).max, type(uint256).max)
        );
        o.adapter = address(
            new ERC8183EvaluatorAdapter(
                IERC20(usdc),
                IEvaluatorRegistry(o.registry),
                treasury,
                IArbitrator(o.arb),
                Defaults.adapterConfig(),
                deployer
            )
        );
        if (o.escrow != slashers[0] || o.adapter != slashers[1]) revert PredictionMismatch();
        address[] memory keepers = new address[](1);
        keepers[0] = deployer; // TESTNET ONLY: sole keeper, k = 1
        EscrowDepositRouteFactory.Config memory fc = EscrowDepositRouteFactory.Config({
            sweepDelay: uint64(vm.envOr("ROUTE_SWEEP_DELAY", uint256(Defaults.ROUTE_SWEEP_DELAY))),
            treasury: treasury,
            recoveryHorizon: uint64(vm.envOr("RECOVERY_HORIZON", uint256(Defaults.RECOVERY_HORIZON))),
            keeperTimelock: uint64(vm.envOr("KEEPER_TIMELOCK", uint256(Defaults.KEEPER_TIMELOCK))),
            threshold: 1
        });
        o.routes = address(new EscrowDepositRouteFactory(IERC20(usdc), o.escrow, deployer, fc, keepers));
        vm.stopBroadcast();
        _write(o, deployer, treasury);
    }

    function _key(string memory path) internal view returns (uint256) {
        return vm.parseUint(vm.trim(vm.readFile(path)));
    }

    function _write(Out memory o, address deployer, address treasury) internal {
        string memory j = "deploy";
        vm.serializeUint(j, "chainId", block.chainid);
        vm.serializeAddress(j, "deployer", deployer);
        vm.serializeAddress(j, "treasury", treasury);
        vm.serializeAddress(j, "usdc", o.usdc);
        vm.serializeAddress(j, "arbitrator", o.arb);
        vm.serializeString(j, "arbitratorKind", "MockArbitrator (testnet stand-in, owner = deployer)");
        vm.serializeAddress(j, "registry", o.registry);
        vm.serializeAddress(j, "escrow", o.escrow);
        vm.serializeAddress(j, "adapter", o.adapter);
        vm.serializeAddress(j, "depositRouteFactory", o.routes);
        vm.serializeAddress(j, "recoveryVault", address(EscrowDepositRouteFactory(o.routes).vault()));
        vm.serializeUint(j, "keeperThreshold", EscrowDepositRouteFactory(o.routes).threshold());
        string memory json = vm.serializeUint(j, "deployBlock", block.number);
        string memory dflt =
            block.chainid == 84532 ? "./deployments/base-sepolia.json" : "./deployments/fork-dryrun.json";
        vm.writeJson(json, vm.envOr("DEPLOY_OUT", dflt));
        console2.log(json);
    }
}

interface IERC20Meta {
    function decimals() external view returns (uint8);
}
