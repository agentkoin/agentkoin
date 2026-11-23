// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {MockArbitrator} from "../../src/mocks/MockArbitrator.sol";
import {MockERC8183Kernel} from "../../src/mocks/MockERC8183Kernel.sol";
import {IERC8183} from "../../src/interfaces/IERC8183.sol";
import {EvaluatorRegistry} from "../../src/EvaluatorRegistry.sol";
import {IEvaluatorRegistry} from "../../src/interfaces/IEvaluatorRegistry.sol";
import {IArbitrator} from "../../src/interfaces/IArbitrator.sol";
import {ERC8183EvaluatorAdapter} from "../../src/ERC8183EvaluatorAdapter.sol";
import {Defaults} from "../../script/Defaults.sol";
import {AdapterHandler} from "./AdapterHandler.sol";

/// @notice Stateful invariants for ERC8183EvaluatorAdapter + EvaluatorRegistry on the mock kernel.
contract AdapterInvariantTest is Test {
    MockUSDC internal usdc;
    EvaluatorRegistry internal registry;
    MockArbitrator internal arb;
    MockERC8183Kernel internal kernel;
    ERC8183EvaluatorAdapter internal adapter;
    AdapterHandler internal handler;
    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");

    function setUp() public {
        usdc = new MockUSDC();
        arb = new MockArbitrator(admin, Defaults.MOCK_ARBITRATION_FEE);
        address[] memory slashers = new address[](1);
        slashers[0] = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        registry = new EvaluatorRegistry(
            IERC20(address(usdc)), Defaults.registryConfig(treasury), admin, slashers, Defaults.SLASHER_TIMELOCK
        );
        adapter = new ERC8183EvaluatorAdapter(
            IERC20(address(usdc)),
            IEvaluatorRegistry(address(registry)),
            treasury,
            IArbitrator(address(arb)),
            Defaults.adapterConfig(),
            admin
        );
        require(registry.isSlasher(address(adapter)), "slasher");
        kernel = new MockERC8183Kernel(IERC20(address(usdc)), makeAddr("kernelTreasury"), 100, 50);
        handler = new AdapterHandler(usdc, kernel, adapter, registry, arb, admin);
        targetContract(address(handler));
    }

    function _live(ERC8183EvaluatorAdapter.State s) internal pure returns (bool) {
        return s == ERC8183EvaluatorAdapter.State.Active || s == ERC8183EvaluatorAdapter.State.Held
            || s == ERC8183EvaluatorAdapter.State.Disputed;
    }

    /// Adapter holds exactly the bonds + arbitration costs of open disputes (evaluator fees from
    /// the kernel are forwarded in the same call).
    function invariant_AdapterBalanceEqualsHeldDisputeFunds() public view {
        uint256 owed;
        for (uint256 id = 1; id <= adapter.jobCount(); id++) {
            if (adapter.getJob(id).state == ERC8183EvaluatorAdapter.State.Disputed) {
                ERC8183EvaluatorAdapter.Dispute memory d = adapter.getDispute(id);
                owed += d.bond + d.arbFee;
            }
        }
        assertEq(usdc.balanceOf(address(adapter)), owed, "adapter balance != held dispute funds");
    }

    /// Kernel holds exactly the budgets of its Funded/Submitted jobs.
    function invariant_KernelBalanceEqualsOpenBudgets() public view {
        uint256 owed;
        for (uint256 kid = 1; kid <= kernel.jobCounter(); kid++) {
            IERC8183.Job memory kj = kernel.getJob(kid);
            if (kj.status == IERC8183.JobStatus.Funded || kj.status == IERC8183.JobStatus.Submitted) owed += kj.budget;
        }
        assertEq(usdc.balanceOf(address(kernel)), owed, "kernel balance != open budgets");
    }

    /// No double execution: each adapter job drives the kernel at most once, each kernel job
    /// reaches a terminal state at most once, and at most one adapter job per kernel job is live.
    function invariant_NoDoubleExecution() public view {
        for (uint256 id = 1; id <= adapter.jobCount(); id++) {
            assertLe(handler.kernelExecutedEvents(id), 1, "adapter job executed twice");
        }
        for (uint256 kid = 1; kid <= kernel.jobCounter(); kid++) {
            assertLe(handler.kernelTerminalEvents(kid), 1, "kernel job settled twice");
            uint256 live;
            for (uint256 id = 1; id <= adapter.jobCount(); id++) {
                ERC8183EvaluatorAdapter.AdapterJob memory j = adapter.getJob(id);
                if (j.kernelJobId == kid && (j.state == ERC8183EvaluatorAdapter.State.Proposed || _live(j.state))) {
                    live++;
                }
            }
            assertLe(live, 1, "two live assignments for one kernel job");
        }
    }

    /// Registry: balance == sum of stakes; stake + slashed (incl. reimbursements) == deposited;
    /// exposure/openJobs == the adapter jobs that locked them.
    function invariant_StakeAndExposureAccounting() public view {
        uint256 sum;
        for (uint256 i = 0; i < handler.evaluatorCount(); i++) {
            address e = handler.evaluators(i);
            EvaluatorRegistry.Evaluator memory info = registry.evaluatorInfo(e);
            sum += info.stake;
            assertEq(info.stake + info.slashedTotal, handler.staked(e), "stake + slashed != deposited");
            uint256 exp;
            uint32 open;
            for (uint256 id = 1; id <= adapter.jobCount(); id++) {
                ERC8183EvaluatorAdapter.AdapterJob memory j = adapter.getJob(id);
                if (j.evaluator == e && _live(j.state)) {
                    exp += j.budget;
                    open++;
                }
            }
            assertEq(info.exposure, exp, "exposure != live adapter budgets");
            assertEq(info.openJobs, open, "openJobs mismatch");
        }
        assertEq(usdc.balanceOf(address(registry)), sum, "registry balance != sum of stakes");
    }

    /// E-1a: no evaluator ever accepts liability on a kernel job expiring before the windows end.
    function invariant_E1a_NoAcceptBelowMinExpiry() public view {
        assertEq(handler.acceptViolations(), 0, "accepted below min kernel expiry");
    }

    /// E-1c: an eval window is only ever started with at least the pinned required duration left
    ///       before kernel expiry; every refusal released exposure (checked in the accounting
    ///       invariant) and is final.
    function invariant_E1c_NoEvalWindowBelowRequiredExpiry() public view {
        for (uint256 id = 1; id <= adapter.jobCount(); id++) {
            ERC8183EvaluatorAdapter.AdapterJob memory j = adapter.getJob(id);
            if (j.submittedAt != 0) {
                assertGe(
                    kernel.getJob(j.kernelJobId).expiredAt,
                    uint256(j.submittedAt) + adapter.requiredExpiryDuration(j.configVersion),
                    "eval window started below required expiry"
                );
            }
            if (j.state == ERC8183EvaluatorAdapter.State.ExpiryRefused) {
                assertEq(j.submittedAt, 0, "refused job has an eval window");
                assertEq(handler.expiryRiskEvents(id), 1, "refusal without exactly one ExpiryRisk");
            } else {
                assertEq(handler.expiryRiskEvents(id), 0, "ExpiryRisk without refusal (E-1c: no flag-only path)");
            }
        }
    }

    /// E-1c / E-1d: jobs refused for expiry or closed because the kernel job ended are never slashed.
    function invariant_E1c_NoSlashOnRefusedOrEnded() public view {
        for (uint256 id = 1; id <= adapter.jobCount(); id++) {
            ERC8183EvaluatorAdapter.State st = adapter.getJob(id).state;
            if (st == ERC8183EvaluatorAdapter.State.ExpiryRefused || st == ERC8183EvaluatorAdapter.State.KernelEnded) {
                assertEq(handler.slashEvents(id), 0, "refused/ended job was slashed");
            }
        }
    }

    /// Liveness: an accepted assignment whose kernel job ended outside the adapter before any
    /// submission was seen must have an exit that releases the evaluator's exposure.
    /// (Before the closeKernelEnded fix this failed: exposure stayed locked forever.)
    function invariant_NoStrandedExposure() public {
        for (uint256 id = 1; id <= adapter.jobCount(); id++) {
            ERC8183EvaluatorAdapter.AdapterJob memory j = adapter.getJob(id);
            bool proposed = j.state == ERC8183EvaluatorAdapter.State.Proposed;
            if (!(proposed || j.state == ERC8183EvaluatorAdapter.State.Active) || j.submittedAt != 0) continue;
            IERC8183.JobStatus ks = kernel.getJob(j.kernelJobId).status;
            if (ks == IERC8183.JobStatus.Funded || ks == IERC8183.JobStatus.Submitted) continue;
            uint256 snap = vm.snapshotState();
            uint256 before = registry.evaluatorInfo(j.evaluator).exposure;
            adapter.closeKernelEnded(id); // must not revert (E-1d: Proposed too)
            assertEq(
                registry.evaluatorInfo(j.evaluator).exposure,
                proposed ? before : before - j.budget,
                "exposure not released"
            );
            assertEq(adapter.assignmentOf(keccak256(abi.encode(j.kernel, j.kernelJobId))), 0, "slot not cleared");
            vm.revertToState(snap);
        }
    }

    function afterInvariant() public view {
        string[15] memory names = [
            "kCreateAndFund",
            "assign",
            "acceptAssignment",
            "kSubmit",
            "noteSubmission",
            "verdict",
            "timeoutRelease",
            "challenge",
            "giveRuling",
            "resolveStaleDispute",
            "finalize",
            "kClaimRefund",
            "withdrawAssignment",
            "topUpStake",
            "closeKernelEnded"
        ];
        string memory line = "ok:";
        for (uint256 i = 0; i < names.length; i++) {
            line = string.concat(line, " ", names[i], "=", vm.toString(handler.okCalls(names[i])));
        }
        console2.log(line);
        console2.log("expiryRefusals", handler.expiryRefusals());
    }
}
