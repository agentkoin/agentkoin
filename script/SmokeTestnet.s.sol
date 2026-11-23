// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EvaluatorRegistry} from "../src/EvaluatorRegistry.sol";
import {JobEscrow} from "../src/JobEscrow.sol";

/// @notice Two-phase smoke test of a DeployTestnet deployment (84532 or 31337 only): one happy path
///         (fund -> submit -> verdict Complete -> finalize) and one reject path (fund -> submit -> verdict
///         Reject -> finalize = refund). Parameterised by env so it runs unchanged on the fork and on testnet.
///   SMOKE_PHASE=open      funds provider/evaluator gas + evaluator stake from the deployer if needed,
///                         evaluator stakes, client (= deployer) creates and funds both jobs, provider submits,
///                         evaluator records Complete / Reject. Writes SMOKE_STATE.
///   SMOKE_PHASE=finalize  after the escrow challengeWindow: finalize both and check the payouts.
/// Env: DEPLOYMENT (json from DeployTestnet), SMOKE_STATE, SMOKE_AMOUNT (default 1 USDC),
///      PROVIDER_GAS_WEI / EVALUATOR_GAS_WEI (helper gas top-ups), *_KEY_FILE (default .secrets/testnet-*.key).
///      Keys are read from files and never logged.
contract SmokeTestnet is Script {
    error UnsupportedChain(uint256 chainId);
    error Check(string what);

    IERC20 internal usdc;
    JobEscrow internal escrow;
    EvaluatorRegistry internal registry;
    uint256 internal kClient;
    uint256 internal kProvider;
    uint256 internal kEval;

    function run() external {
        if (block.chainid != 84532 && block.chainid != 31337) revert UnsupportedChain(block.chainid);
        string memory dep = vm.readFile(vm.envOr("DEPLOYMENT", string("./deployments/base-sepolia.json")));
        usdc = IERC20(vm.parseJsonAddress(dep, ".usdc"));
        escrow = JobEscrow(vm.parseJsonAddress(dep, ".escrow"));
        registry = EvaluatorRegistry(vm.parseJsonAddress(dep, ".registry"));
        kClient = _key("DEPLOYER_KEY_FILE", ".secrets/testnet-deployer.key");
        kProvider = _key("PROVIDER_KEY_FILE", ".secrets/testnet-provider.key");
        kEval = _key("EVALUATOR_KEY_FILE", ".secrets/testnet-evaluator.key");
        string memory phase = vm.envOr("SMOKE_PHASE", string("open"));
        string memory statePath = vm.envOr("SMOKE_STATE", string("./deployments/smoke-state.json"));
        if (keccak256(bytes(phase)) == keccak256("open")) _open(statePath);
        else if (keccak256(bytes(phase)) == keccak256("finalize")) _finalize(statePath);
        else revert Check("SMOKE_PHASE must be open or finalize");
    }

    function _open(string memory statePath) internal {
        address client = vm.addr(kClient);
        address provider = vm.addr(kProvider);
        address evaluator = vm.addr(kEval);
        uint256 amount = vm.envOr("SMOKE_AMOUNT", uint256(1e6));
        // helper gas top-ups: size them from measured gas x price x margin (fork dry run: provider 141,080 gas,
        // evaluator 274,591 gas). Defaults below are 3x at 0.011 gwei.
        uint256 provEth = vm.envOr("PROVIDER_GAS_WEI", uint256(5e12));
        uint256 evalEth = vm.envOr("EVALUATOR_GAS_WEI", uint256(1e13));
        uint256 minStake = registry.minStake();
        console2.log("client  ", client);
        console2.log("provider", provider);
        console2.log("evaluator", evaluator);

        // 1. deployer tops up helper accounts (gas, and the evaluator's stake if not yet staked)
        vm.startBroadcast(kClient);
        if (provider.balance < provEth / 2) _send(provider, provEth);
        if (evaluator.balance < evalEth / 2) _send(evaluator, evalEth);
        bool active = registry.isActive(evaluator);
        if (!active && usdc.balanceOf(evaluator) < minStake) {
            if (!usdc.transfer(evaluator, minStake)) revert Check("usdc transfer");
        }
        vm.stopBroadcast();

        // 2. evaluator stakes
        if (!active) {
            vm.startBroadcast(kEval);
            usdc.approve(address(registry), minStake);
            registry.stake(minStake);
            vm.stopBroadcast();
        }
        if (!registry.isActive(evaluator)) revert Check("evaluator not active");

        // 3. client funds two jobs
        uint64 deadline = uint64(block.timestamp + 1 days);
        vm.startBroadcast(kClient);
        usdc.approve(address(escrow), 2 * amount);
        uint256 jobA =
            escrow.createAndFund(provider, evaluator, amount, deadline, keccak256("agentcoin smoke: happy path"));
        uint256 jobB =
            escrow.createAndFund(provider, evaluator, amount, deadline, keccak256("agentcoin smoke: reject path"));
        vm.stopBroadcast();

        // 4. provider submits both
        vm.startBroadcast(kProvider);
        escrow.submit(jobA, keccak256("deliverable A"));
        escrow.submit(jobB, keccak256("deliverable B"));
        vm.stopBroadcast();

        // 5. evaluator: A Complete, B Reject
        vm.startBroadcast(kEval);
        escrow.verdict(jobA, JobEscrow.Outcome.Complete, 10000, keccak256("meets spec"));
        escrow.verdict(jobB, JobEscrow.Outcome.Reject, 0, keccak256("does not meet spec"));
        vm.stopBroadcast();

        _check(jobA, jobB);
        _writeState(statePath, jobA, jobB, amount, client, provider);
    }

    function _finalize(string memory statePath) internal {
        string memory st = vm.readFile(statePath);
        uint256 jobA = vm.parseJsonUint(st, ".jobA");
        uint256 jobB = vm.parseJsonUint(st, ".jobB");
        uint256 amount = vm.parseJsonUint(st, ".amount");
        uint256 provBefore = vm.parseJsonUint(st, ".providerUsdcBefore");
        uint256 clientBefore = vm.parseJsonUint(st, ".clientUsdcBefore");
        if (block.timestamp <= vm.parseJsonUint(st, ".finalizableAfter")) revert Check("challenge window still open");
        address client = vm.addr(kClient);
        address provider = vm.addr(kProvider);

        vm.startBroadcast(kClient); // anyone may finalize; the client pays the gas
        escrow.finalize(jobA);
        escrow.finalize(jobB);
        vm.stopBroadcast();

        if (escrow.getJob(jobA).state != JobEscrow.State.Settled) revert Check("job A not Settled");
        if (escrow.getJob(jobB).state != JobEscrow.State.Settled) revert Check("job B not Settled");
        JobEscrow.Config memory c = escrow.config(escrow.getJob(jobA).configVersion);
        uint256 net = amount - (amount * c.feeBps) / 10000 - (amount * c.evaluatorFeeBps) / 10000;
        uint256 provGot = usdc.balanceOf(provider) - provBefore;
        uint256 clientGot = usdc.balanceOf(client) - clientBefore;
        console2.log("provider received (happy path, net of fees)", provGot);
        console2.log("client refunded (reject path)", clientGot);
        if (provGot != net) revert Check("provider payout mismatch");
        // the protocol fee of the happy-path job goes to the treasury; on testnet treasury == deployer == client
        uint256 feeToClient = escrow.treasury() == client ? (amount * c.feeBps) / 10000 : 0;
        console2.log("of which protocol fee to treasury (= client on testnet)", feeToClient);
        if (clientGot != amount + feeToClient) revert Check("client refund mismatch");
        console2.log("SMOKE OK");
    }

    function _check(uint256 jobA, uint256 jobB) internal view {
        if (escrow.getJob(jobA).state != JobEscrow.State.Completed) revert Check("job A not Completed");
        if (escrow.getJob(jobB).state != JobEscrow.State.Rejected) revert Check("job B not Rejected");
        console2.log("job A (happy) id", jobA);
        console2.log("job B (reject) id", jobB);
    }

    function _writeState(
        string memory statePath,
        uint256 jobA,
        uint256 jobB,
        uint256 amount,
        address client,
        address provider
    ) internal {
        JobEscrow.Job memory ja = escrow.getJob(jobA);
        uint256 finalizableAfter = uint256(ja.verdictAt) + escrow.config(ja.configVersion).challengeWindow;
        console2.log("finalize possible after unix time", finalizableAfter);
        string memory s = "smoke";
        vm.serializeUint(s, "chainId", block.chainid);
        vm.serializeUint(s, "jobA", jobA);
        vm.serializeUint(s, "jobB", jobB);
        vm.serializeUint(s, "amount", amount);
        vm.serializeUint(s, "finalizableAfter", finalizableAfter);
        vm.serializeUint(s, "providerUsdcBefore", usdc.balanceOf(provider));
        string memory json = vm.serializeUint(s, "clientUsdcBefore", usdc.balanceOf(client));
        vm.writeJson(json, statePath);
    }

    function _send(address to, uint256 v) internal {
        (bool ok,) = payable(to).call{value: v}("");
        if (!ok) revert Check("eth send");
    }

    function _key(string memory envName, string memory dflt) internal view returns (uint256) {
        return vm.parseUint(vm.trim(vm.readFile(vm.envOr(envName, dflt))));
    }
}
