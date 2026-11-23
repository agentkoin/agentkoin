// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EvaluatorRegistry} from "../src/EvaluatorRegistry.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {EscrowDepositRouteFactory} from "../src/EscrowDepositRoute.sol";
import {UMAArbitratorAdapter} from "../src/arbitration/UMAArbitratorAdapter.sol";
import {IOptimisticOracleV3} from "../src/arbitration/IExternalArbitration.sol";
import {IEvaluatorRegistry} from "../src/interfaces/IEvaluatorRegistry.sol";
import {IArbitrator} from "../src/interfaces/IArbitrator.sol";
import {Defaults} from "./Defaults.sol";

/// @notice MAINNET deploy of the minimal AgentKoin set (proposal §1.2): UMAArbitratorAdapter, EvaluatorRegistry,
///         JobEscrow (pause + caps), EscrowDepositRouteFactory (+ RecoveryVault). Base mainnet (8453) or a
///         Base Sepolia rehearsal (84532) only. See docs/mainnet/RUNBOOK.md.
/// @dev    DOCUMENTED PATH = SIMULATE: run WITHOUT --broadcast (forge only simulates). Broadcasting on 8453 also
///         requires CONFIRM_MAINNET="deploy to mainnet" in env, which is set only after Carter types those words.
///         Required env: OWNER_SAFE, FEE_RECIPIENT_SAFE, PAUSER_SAFE (non-zero, must have code; ALLOW_EOA=1 for
///         rehearsals only), KEEPERS (comma-separated, >= 2 on 8453), DEPLOYER_KEY_FILE (key never logged).
///         Optional: KEEPER_THRESHOLD (2), UMA_OOV3 (default Base mainnet OOv3; required on 84532),
///         UMA_LIVENESS (7200), UMA_TOKEN_FEE (0), MIN_STAKE (10e6 = 10 USDC, Carter Nov 23), FEE_BPS /
///         EVALUATOR_FEE_BPS (0 / 0, Carter Nov 23: "Escrow fees 0%, like testnet"), DISPUTES_ENABLED (false,
///         Carter Nov 23: "Launch with UMA disputes off"), DEPLOY_OUT (default deployments/<chainid>.json).
///         Disputes off = JobEscrow.arbitrator is address(0): challenge() reverts NoArbitrator before any state
///         change or transfer, so nothing can be frozen; verdict -> finalize and all refunds are unaffected.
///         The UMA adapter is still deployed (owner = OWNER_SAFE) but not allow-listed. To enable later, the
///         owner Safe sends uma.setArbitrable(escrow, true) THEN escrow.setArbitrator(uma).
///         Every owner role is set to OWNER_SAFE in the constructors (no transfer, so no pending accept);
///         the deployer ends with no role, asserted in _assertNoDeployerRoles.
contract DeployMainnet is Script {
    error UnsupportedChain(uint256 chainId);
    error ZeroParam(string name);
    error NotAContract(string name, address who);
    error DeployerHoldsRole(string role);
    error PredictionMismatch();
    error MainnetNotConfirmed();
    error WrongUsdc(address token);
    error NoOracle();
    error DisputesState(string what);

    address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913; // Circle USDC on Base
    address internal constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address internal constant BASE_UMA_OOV3 = 0x2aBf1Bd76655de80eDB3086114315Eec75AF500c; // UMA OOv3 on Base

    struct P {
        address ownerSafe;
        address feeSafe;
        address pauserSafe;
        address usdc;
        address oracle;
        address deployer;
        address[] keepers;
        uint8 threshold;
    }

    struct Out {
        address uma;
        address registry;
        address escrow;
        address factory;
        address vault;
    }

    function run() external returns (Out memory o) {
        P memory p = _params();
        uint256 pk = vm.parseUint(vm.trim(vm.readFile(vm.envString("DEPLOYER_KEY_FILE"))));
        p.deployer = vm.addr(pk);
        for (uint256 i = 0; i < p.keepers.length; i++) {
            if (p.keepers[i] == p.deployer) revert DeployerHoldsRole("keeper");
        }
        if (block.chainid == 8453 && vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            if (keccak256(bytes(vm.envOr("CONFIRM_MAINNET", string("")))) != keccak256("deploy to mainnet")) {
                revert MainnetNotConfirmed();
            }
        }

        vm.startBroadcast(pk);
        o.uma = address(
            new UMAArbitratorAdapter(
                IOptimisticOracleV3(p.oracle),
                IERC20(p.usdc),
                p.ownerSafe, // immutable owner = Safe at construction
                uint64(vm.envOr("UMA_LIVENESS", uint256(2 hours))),
                vm.envOr("UMA_TOKEN_FEE", uint256(0))
            )
        );
        address[] memory slashers = new address[](1);
        slashers[0] = vm.computeCreateAddress(p.deployer, vm.getNonce(p.deployer) + 1); // escrow
        EvaluatorRegistry.Config memory rc = Defaults.registryConfig(p.feeSafe);
        rc.minStake = vm.envOr("MIN_STAKE", uint256(10e6));
        o.registry = address(
            new EvaluatorRegistry(IERC20(p.usdc), rc, p.ownerSafe, slashers, Defaults.SLASHER_TIMELOCK)
        );
        JobEscrow.Config memory ec = Defaults.escrowConfig();
        ec.feeBps = uint16(vm.envOr("FEE_BPS", uint256(0)));
        ec.evaluatorFeeBps = uint16(vm.envOr("EVALUATOR_FEE_BPS", uint256(0)));
        bool disputes = vm.envOr("DISPUTES_ENABLED", false);
        o.escrow = address(
            new JobEscrow(
                IERC20(p.usdc),
                IEvaluatorRegistry(o.registry),
                p.feeSafe,
                IArbitrator(disputes ? o.uma : address(0)), // disputes off: challenge() reverts NoArbitrator
                ec,
                p.ownerSafe,
                p.pauserSafe,
                Defaults.MAINNET_MAX_PER_JOB,
                Defaults.MAINNET_MAX_TOTAL_LOCKED
            )
        );
        if (o.escrow != slashers[0]) revert PredictionMismatch();
        o.factory = address(
            new EscrowDepositRouteFactory(
                IERC20(p.usdc),
                o.escrow,
                p.ownerSafe,
                EscrowDepositRouteFactory.Config({
                    sweepDelay: Defaults.ROUTE_SWEEP_DELAY,
                    treasury: p.feeSafe,
                    recoveryHorizon: Defaults.RECOVERY_HORIZON,
                    keeperTimelock: Defaults.KEEPER_TIMELOCK,
                    threshold: p.threshold
                }),
                p.keepers
            )
        );
        vm.stopBroadcast();
        o.vault = address(EscrowDepositRouteFactory(o.factory).vault());

        _assertNoDeployerRoles(o, p);
        _assertDisputes(o, disputes);
        _write(o, p);
    }

    function _params() internal view returns (P memory p) {
        if (block.chainid == 8453) {
            p.usdc = BASE_USDC;
            p.oracle = vm.envOr("UMA_OOV3", BASE_UMA_OOV3);
        } else if (block.chainid == 84532) {
            p.usdc = BASE_SEPOLIA_USDC;
            p.oracle = vm.envOr("UMA_OOV3", address(0));
        } else {
            revert UnsupportedChain(block.chainid);
        }
        if (p.usdc.code.length == 0 || IERC20Meta(p.usdc).decimals() != 6) revert WrongUsdc(p.usdc);
        if (p.oracle == address(0) || p.oracle.code.length == 0) revert NoOracle();
        bool allowEoa = vm.envOr("ALLOW_EOA", uint256(0)) == 1;
        p.ownerSafe = _safe("OWNER_SAFE", allowEoa);
        p.feeSafe = _safe("FEE_RECIPIENT_SAFE", allowEoa);
        p.pauserSafe = _safe("PAUSER_SAFE", allowEoa);
        p.keepers = vm.envAddress("KEEPERS", ",");
        p.threshold = uint8(vm.envOr("KEEPER_THRESHOLD", uint256(Defaults.KEEPER_THRESHOLD)));
    }

    function _safe(string memory name, bool allowEoa) internal view returns (address a) {
        a = vm.envOr(name, address(0));
        if (a == address(0)) revert ZeroParam(name);
        if (!allowEoa && (a.code.length == 0 || _is7702(a))) revert NotAContract(name, a);
    }

    /// @dev EIP-7702 delegated EOAs have 23 bytes of code 0xef0100||delegate: still an EOA key, refuse it.
    ///      (Seen on the fork: the well-known anvil test accounts are 7702-delegated on Base mainnet.)
    function _is7702(address a) internal view returns (bool) {
        bytes memory c = a.code;
        return c.length == 23 && c[0] == 0xef && c[1] == 0x01 && c[2] == 0x00;
    }

    function _assertNoDeployerRoles(Out memory o, P memory p) internal view {
        JobEscrow e = JobEscrow(o.escrow);
        EvaluatorRegistry r = EvaluatorRegistry(o.registry);
        EscrowDepositRouteFactory f = EscrowDepositRouteFactory(o.factory);
        address d = p.deployer;
        if (e.owner() != p.ownerSafe || e.pendingOwner() != address(0)) revert DeployerHoldsRole("escrow.owner");
        if (e.pauser() != p.pauserSafe) revert DeployerHoldsRole("escrow.pauser");
        if (e.treasury() != p.feeSafe) revert DeployerHoldsRole("escrow.treasury");
        if (r.owner() != p.ownerSafe || r.pendingOwner() != address(0)) revert DeployerHoldsRole("registry.owner");
        if (f.owner() != p.ownerSafe || f.pendingOwner() != address(0)) revert DeployerHoldsRole("factory.owner");
        if (f.isKeeper(d)) revert DeployerHoldsRole("factory.keeper");
        if (UMAArbitratorAdapter(o.uma).owner() != p.ownerSafe) revert DeployerHoldsRole("uma.owner");
        if (r.isSlasher(d)) revert DeployerHoldsRole("registry.slasher");
        if (!r.isSlasher(o.escrow)) revert PredictionMismatch();
        if (e.maxPerJob() != Defaults.MAINNET_MAX_PER_JOB || e.maxTotalLocked() != Defaults.MAINNET_MAX_TOTAL_LOCKED) {
            revert ZeroParam("caps");
        }
        if (d == p.ownerSafe || d == p.feeSafe || d == p.pauserSafe) revert DeployerHoldsRole("safe==deployer");
    }

    /// @dev Disputes off: escrow has no arbitrator (challenge() reverts NoArbitrator) and the UMA adapter does not
    ///      list the escrow. Disputes on: escrow points at the adapter; the owner Safe must still allow-list it
    ///      (until then challenge() reverts NotArbitrable atomically, so nothing freezes either).
    function _assertDisputes(Out memory o, bool disputes) internal view {
        address arb = address(JobEscrow(o.escrow).arbitrator());
        if (UMAArbitratorAdapter(o.uma).isArbitrable(o.escrow)) revert DisputesState("uma lists escrow");
        if (disputes ? arb != o.uma : arb != address(0)) revert DisputesState("escrow.arbitrator");
    }

    function _write(Out memory o, P memory p) internal {
        string memory j = "deploy";
        vm.serializeUint(j, "chainId", block.chainid);
        vm.serializeAddress(j, "deployer", p.deployer);
        vm.serializeAddress(j, "ownerSafe", p.ownerSafe);
        vm.serializeAddress(j, "feeRecipientSafe", p.feeSafe);
        vm.serializeAddress(j, "pauserSafe", p.pauserSafe);
        vm.serializeAddress(j, "usdc", p.usdc);
        vm.serializeAddress(j, "umaOracle", p.oracle);
        vm.serializeAddress(j, "umaArbitratorAdapter", o.uma);
        vm.serializeAddress(j, "registry", o.registry);
        vm.serializeAddress(j, "escrow", o.escrow);
        vm.serializeAddress(j, "depositRouteFactory", o.factory);
        vm.serializeAddress(j, "recoveryVault", o.vault);
        vm.serializeAddress(j, "keepers", p.keepers);
        vm.serializeUint(j, "keeperThreshold", p.threshold);
        vm.serializeUint(j, "maxPerJob", Defaults.MAINNET_MAX_PER_JOB);
        vm.serializeUint(j, "maxTotalLocked", Defaults.MAINNET_MAX_TOTAL_LOCKED);
        vm.serializeUint(j, "feeBps", JobEscrow(o.escrow).currentConfig().feeBps);
        vm.serializeUint(j, "evaluatorFeeBps", JobEscrow(o.escrow).currentConfig().evaluatorFeeBps);
        vm.serializeUint(j, "minStake", EvaluatorRegistry(o.registry).minStake());
        vm.serializeString(
            j,
            "pendingSafeActions",
            "None required. Disputes are off at launch (escrow.arbitrator = 0). To enable later: OWNER_SAFE uma.setArbitrable(escrow,true) then escrow.setArbitrator(uma). No acceptOwnership needed: owners set in constructors."
        );
        vm.serializeAddress(j, "escrowArbitrator", address(JobEscrow(o.escrow).arbitrator()));
        string memory json = vm.serializeUint(j, "deployBlock", block.number);
        string memory out = vm.envOr("DEPLOY_OUT", string.concat("./deployments/", vm.toString(block.chainid), ".json"));
        vm.writeJson(json, out);
        console2.log(json);
    }
}

interface IERC20Meta {
    function decimals() external view returns (uint8);
}
