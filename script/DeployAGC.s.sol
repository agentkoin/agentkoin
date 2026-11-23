// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AGC} from "../src/AGC.sol";
import {AGCSettlerAdapter, IJobEscrowAGC} from "../src/AGCSettlerAdapter.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {EvaluatorRegistry} from "../src/EvaluatorRegistry.sol";
import {EscrowDepositRouteFactory} from "../src/EscrowDepositRoute.sol";
import {IEvaluatorRegistry} from "../src/interfaces/IEvaluatorRegistry.sol";
import {IArbitrator} from "../src/interfaces/IArbitrator.sol";

/// @notice AD-010 AGC stack, built from the live USDC stack's parameters. Shared by DeployAGC and the fork test.
abstract contract AGCStackBuilder {
    struct Stack {
        AGC agc;
        EvaluatorRegistry registry;
        JobEscrow escrow;
        EscrowDepositRouteFactory factory;
        AGCSettlerAdapter adapter;
    }

    error Precondition(string what);

    /// @notice AD-011: no STOS fee/treasury recipient and no STOS admin on the AGC escrow + registry.
    ///         0x…dEaD has no known key; JobEscrow / EvaluatorRegistry / RecoveryVault reject address(0).
    address internal constant NO_RECIPIENT = 0x000000000000000000000000000000000000dEaD;

    /// @param creator the account whose CREATE nonces deploy the stack (broadcaster, or the test contract)
    /// @param nonce0  creator's nonce before the first CREATE
    function _buildAGCStack(
        address usdc,
        JobEscrow live,
        EscrowDepositRouteFactory liveFactory,
        address owner_,
        address creator,
        uint64 nonce0,
        address vmAddr
    ) internal returns (Stack memory s) {
        return _buildAGCStack(usdc, live, liveFactory, owner_, creator, nonce0, vmAddr, 0);
    }

    /// @param thresholdOverride 0 = the live factory's keeper threshold (1 on Base Sepolia); local Anvil passes 1
    function _buildAGCStack(
        address usdc,
        JobEscrow live,
        EscrowDepositRouteFactory liveFactory,
        address owner_,
        address creator,
        uint64 nonce0,
        address vmAddr,
        uint8 thresholdOverride
    ) internal returns (Stack memory s) {
        if (address(live.token()) != usdc || address(liveFactory.token()) != usdc) {
            revert Precondition("live USDC stack");
        }
        // CREATE order: AGC (n), registry (n+1), escrow (n+2), factory (n+3), adapter (n+4)
        address predictedEscrow = _createAddr(vmAddr, creator, nonce0 + 2);
        s.agc = new AGC(IERC20(usdc));
        // AD-011: registry and escrow owner = NO_RECIPIENT (no setConfig / setTreasury / setArbitrator /
        // proposeSlasher by anyone after deploy). The factory keeps owner_ (keeper set; see AGC_DEPLOY_PLAN.md).
        s.registry = _registry(s.agc, live, predictedEscrow);
        s.escrow = _escrow(s.agc, s.registry, live);
        if (address(s.escrow) != predictedEscrow) revert Precondition("escrow address prediction");
        EscrowDepositRouteFactory.Config memory fc = _factoryConfig(liveFactory);
        if (thresholdOverride != 0) fc.threshold = thresholdOverride;
        if (fc.threshold != 1) revert Precondition("one keeper (owner) needs threshold 1");
        s.factory =
            new EscrowDepositRouteFactory(IERC20(address(s.agc)), address(s.escrow), owner_, fc, _keepers(owner_));
        s.adapter = new AGCSettlerAdapter(s.agc, IJobEscrowAGC(address(s.escrow)));
    }

    function _registry(AGC agc, JobEscrow live, address predictedEscrow) private returns (EvaluatorRegistry) {
        EvaluatorRegistry liveReg = EvaluatorRegistry(address(live.registry()));
        address[] memory slashers = new address[](1);
        slashers[0] = predictedEscrow; // the adapter never calls the registry, so it is not a slasher
        EvaluatorRegistry.Config memory rc = liveReg.config();
        rc.treasury = NO_RECIPIENT; // slash remainder is burned, not paid to a STOS key
        return new EvaluatorRegistry(IERC20(address(agc)), rc, NO_RECIPIENT, slashers, liveReg.slasherTimelock());
    }

    function _escrow(AGC agc, EvaluatorRegistry reg, JobEscrow live) private returns (JobEscrow) {
        JobEscrow.Config memory ec = live.currentConfig();
        ec.feeBps = 0; // AD-011: protocol fee 0
        // evaluatorFeeBps stays the live value (0 today); it is paid to the job's evaluator, never to STOS
        return new JobEscrow(
            IERC20(address(agc)),
            IEvaluatorRegistry(address(reg)),
            NO_RECIPIENT, // treasury: feeBps 0, failed-challenge remainder (unreachable: no arbitrator) burned
            IArbitrator(address(0)), // AD-011: no STOS-ruled arbitrator; challenge() reverts NoArbitrator
            ec,
            NO_RECIPIENT, NO_RECIPIENT, type(uint256).max, type(uint256).max // owner: config, treasury and arbitrator are fixed at deploy
        );
    }

    function _factoryConfig(EscrowDepositRouteFactory f)
        private
        view
        returns (EscrowDepositRouteFactory.Config memory)
    {
        return EscrowDepositRouteFactory.Config({
            sweepDelay: f.sweepDelay(),
            treasury: NO_RECIPIENT, // RecoveryVault release after the horizon goes nowhere STOS controls
            recoveryHorizon: f.vault().horizon(),
            keeperTimelock: f.keeperTimelock(),
            threshold: uint8(f.threshold())
        });
    }

    function _keepers(address owner_) private pure returns (address[] memory k) {
        k = new address[](1);
        k[0] = owner_;
    }

    function _createAddr(address vmAddr, address creator, uint64 nonce) private pure returns (address) {
        return VmCompute(vmAddr).computeCreateAddress(creator, nonce);
    }
}

interface VmCompute {
    function computeCreateAddress(address deployer, uint256 nonce) external pure returns (address);
}

/// @notice AD-010 TESTNET deploy (Base Sepolia 84532 or a local Anvil fork 31337 only). NOT RUN: needs Carter's
///         own approval for the AGC deploy. Five CREATEs, no token transfers, no calls on live contracts.
///         Key from DEPLOYER_KEY_FILE (default .secrets/testnet-deployer.key), never logged.
///         Dry run (no broadcast): forge script script/DeployAGC.s.sol --rpc-url <fork or base sepolia>
contract DeployAGC is Script, AGCStackBuilder {
    error UnsupportedChain(uint256 chainId);

    address internal constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e; // Circle test USDC
    address internal constant USDC_ESCROW = 0x4EaF6d09F8C22980Bb16E719779ACe73A7b1CB3D; // live AgentCoin JobEscrow
    address internal constant USDC_ROUTE_FACTORY = 0x32174eFD01e600E621Cf3f0D19Ff694483B19b95; // live route factory

    function run() external {
        if (block.chainid != 84532 && block.chainid != 31337) revert UnsupportedChain(block.chainid);
        uint256 pk =
            vm.parseUint(vm.trim(vm.readFile(vm.envOr("DEPLOYER_KEY_FILE", string(".secrets/testnet-deployer.key")))));
        address deployer = vm.addr(pk);
        if (USDC.code.length == 0 || USDC_ESCROW.code.length == 0 || USDC_ROUTE_FACTORY.code.length == 0) {
            revert Precondition("code");
        }
        JobEscrow live = JobEscrow(USDC_ESCROW);
        if (live.owner() != deployer) revert Precondition("deployer must be the live stack deployer");

        uint64 n = vm.getNonce(deployer);
        vm.startBroadcast(pk);
        Stack memory s = _buildAGCStack(
            USDC, live, EscrowDepositRouteFactory(USDC_ROUTE_FACTORY), deployer, deployer, n, address(vm)
        );
        vm.stopBroadcast();

        console2.log("AGC", address(s.agc));
        console2.log("EvaluatorRegistry(AGC)", address(s.registry));
        console2.log("JobEscrow(AGC)", address(s.escrow));
        console2.log("EscrowDepositRouteFactory(AGC)", address(s.factory));
        console2.log("AGCSettlerAdapter", address(s.adapter));
    }
}
