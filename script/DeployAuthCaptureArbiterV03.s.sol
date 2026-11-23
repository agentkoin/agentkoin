// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IEvaluatorRegistry} from "../src/interfaces/IEvaluatorRegistry.sol";
import {IArbitrator} from "../src/interfaces/IArbitrator.sol";
import {IAuthCaptureEscrow} from "../src/arbiter/IAuthCaptureEscrow.sol";
import {AgentKoinAuthCaptureArbiterV03} from "../src/arbiter/AgentKoinAuthCaptureArbiterV03.sol";

/// @notice Deploy AgentKoinAuthCaptureArbiterV03 (optional Terms.submitter) on Base Sepolia (84532) only.
///         Same constructor args as v0.2. Immutable; no owner.
///         ARBITRATOR = 0 (challenges disabled; AD-015 Phase 0). Key from DEPLOYER_KEY_FILE
///         (default .secrets/testnet-deployer.key), never logged.
///         Dry run: forge script script/DeployAuthCaptureArbiterV03.s.sol --rpc-url https://sepolia.base.org --skip script/DeployTestnet.s.sol
contract DeployAuthCaptureArbiterV03 is Script {
    error UnsupportedChain(uint256 chainId);

    address internal constant ESCROW_V1_1 = 0xf96815976523E00e65Be8f34cA5e64b4f41EB19c;
    address internal constant REGISTRY = 0x30576DE005df028D1947C56dEcc85a2a5612036a;
    address internal constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address internal constant EXPECTED_DEPLOYER = 0x78e2C0164A80F3e337AE17e3bA4b8EA2C0Fa488e;
    uint256 internal constant MAX_AMOUNT = 1_000_000; // 1 test USDC

    function config() public pure returns (AgentKoinAuthCaptureArbiterV03.Config memory) {
        return AgentKoinAuthCaptureArbiterV03.Config({
            evalWindow: 3600,
            challengeWindow: 600,
            rulingWindow: 3600,
            minMarginSeconds: 3600,
            missedVerdictSlashBps: 1000,
            wrongVerdictSlashBps: 2500,
            materialDiffBps: 2000,
            minChallengeBond: 1_000_000
        });
    }

    function run() external {
        if (block.chainid != 84532) revert UnsupportedChain(block.chainid);
        uint256 pk =
            vm.parseUint(vm.trim(vm.readFile(vm.envOr("DEPLOYER_KEY_FILE", string(".secrets/testnet-deployer.key")))));
        require(vm.addr(pk) == EXPECTED_DEPLOYER, "unexpected deployer");
        require(ESCROW_V1_1.code.length > 0, "escrow missing");
        require(IEvaluatorRegistry(REGISTRY).minStake() > 0, "registry");

        vm.startBroadcast(pk);
        AgentKoinAuthCaptureArbiterV03 a = new AgentKoinAuthCaptureArbiterV03(
            IAuthCaptureEscrow(ESCROW_V1_1),
            IEvaluatorRegistry(REGISTRY),
            IArbitrator(address(0)),
            IERC20(USDC),
            MAX_AMOUNT,
            config()
        );
        vm.stopBroadcast();

        console2.log("deployer", vm.addr(pk));
        console2.log("arbiter", address(a));
        console2.log("escrow", address(a.ESCROW()));
        console2.log("registry", address(a.REGISTRY()));
        console2.log("arbitrator", address(a.ARBITRATOR()));
        console2.log("token", address(a.TOKEN()));
        console2.log("maxAmount", a.MAX_AMOUNT_PER_PAYMENT());
        console2.log("version", a.VERSION());
    }
}
