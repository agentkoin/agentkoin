// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockERC8183Kernel} from "../src/mocks/MockERC8183Kernel.sol";
import {IERC8183} from "../src/interfaces/IERC8183.sol";
import {ERC8183EvaluatorAdapter} from "../src/ERC8183EvaluatorAdapter.sol";
import {EvaluatorRegistry} from "../src/EvaluatorRegistry.sol";

/// E-1: an external ERC-8183 kernel names the adapter as evaluator.
contract AdapterTest is BaseTest {
    MockERC8183Kernel internal kernel;
    address internal kernelTreasury = makeAddr("kernelTreasury");
    uint256 internal constant BUDGET = 100e6;
    /// E-1a: kernel expiry comfortably above 24h + 24h + 7d + 1h
    uint256 internal constant KEXP = 10 days;

    function setUp() public override {
        super.setUp();
        kernel = new MockERC8183Kernel(IERC20(address(usdc)), kernelTreasury, 100, 50); // 1% platform, 0.5% evaluator
        vm.prank(client);
        usdc.approve(address(kernel), type(uint256).max);
    }

    // ---------------- helpers ----------------

    function _kernelJob(uint256 expiresIn) internal returns (uint256 kid) {
        vm.startPrank(client);
        kid = kernel.createJob(provider, address(adapter), block.timestamp + expiresIn, "translate doc", address(0));
        kernel.setBudget(kid, BUDGET, "");
        kernel.fund(kid, BUDGET, "");
        vm.stopPrank();
    }

    function _assigned(uint256 expiresIn) internal returns (uint256 kid, uint256 id) {
        kid = _kernelJob(expiresIn);
        vm.prank(client);
        id = adapter.assign(address(kernel), kid, evaluator);
        vm.prank(evaluator);
        adapter.acceptAssignment(id);
    }

    function _submitted() internal returns (uint256 kid, uint256 id) {
        (kid, id) = _assigned(KEXP);
        vm.prank(provider);
        kernel.submit(kid, DELIVERABLE, "");
        adapter.noteSubmission(id);
    }

    function _held(uint16 bps) internal returns (uint256 kid, uint256 id) {
        (kid, id) = _submitted();
        vm.prank(evaluator);
        adapter.verdict(id, bps, REASON);
    }

    function _kstatus(uint256 kid) internal view returns (IERC8183.JobStatus) {
        return kernel.getJob(kid).status;
    }

    function _astate(uint256 id) internal view returns (ERC8183EvaluatorAdapter.State) {
        return adapter.getJob(id).state;
    }

    // ---------------- happy path ----------------

    function test_Adapter_HoldsThroughWindow_ThenCompletes() public {
        (uint256 kid, uint256 id) = _held(10_000);
        assertEq(uint8(_astate(id)), uint8(ERC8183EvaluatorAdapter.State.Held));
        assertEq(uint8(_kstatus(kid)), uint8(IERC8183.JobStatus.Submitted)); // not yet on kernel
        assertEq(registry.evaluatorInfo(evaluator).exposure, BUDGET);

        vm.warp(block.timestamp + 24 hours);
        vm.expectRevert(ERC8183EvaluatorAdapter.ChallengeWindowOpen.selector);
        adapter.finalize(id);

        uint256 p0 = usdc.balanceOf(provider);
        uint256 e0 = usdc.balanceOf(evaluator);
        vm.warp(block.timestamp + 1);
        vm.prank(outsider); // permissionless
        adapter.finalize(id);

        assertEq(uint8(_kstatus(kid)), uint8(IERC8183.JobStatus.Completed));
        assertEq(uint8(_astate(id)), uint8(ERC8183EvaluatorAdapter.State.Executed));
        assertEq(usdc.balanceOf(provider) - p0, 98.5e6); // kernel: 1% platform, 0.5% evaluator fee
        assertEq(usdc.balanceOf(evaluator) - e0, 0.5e6); // kernel evaluator fee forwarded
        assertEq(usdc.balanceOf(kernelTreasury), 1e6);
        assertEq(usdc.balanceOf(address(adapter)), 0);
        assertEq(registry.evaluatorInfo(evaluator).exposure, 0);
        assertEq(registry.evaluatorInfo(evaluator).openJobs, 0);
    }

    function test_Adapter_Reject_RefundsClientOnKernel() public {
        (uint256 kid, uint256 id) = _held(0);
        uint256 c0 = usdc.balanceOf(client);
        vm.warp(block.timestamp + 24 hours + 1);
        adapter.finalize(id);
        assertEq(uint8(_kstatus(kid)), uint8(IERC8183.JobStatus.Rejected));
        assertEq(usdc.balanceOf(client) - c0, BUDGET);
    }

    // ---------------- partial mapping (lossy) ----------------

    function test_Adapter_PartialAtThreshold_Completes() public {
        (uint256 kid, uint256 id) = _held(5000);
        assertTrue(adapter.getJob(id).completes);
        vm.warp(block.timestamp + 24 hours + 1);
        adapter.finalize(id);
        assertEq(uint8(_kstatus(kid)), uint8(IERC8183.JobStatus.Completed)); // lossy: 50% verdict pays 100%
    }

    function test_Adapter_PartialBelowThreshold_Rejects() public {
        (uint256 kid, uint256 id) = _held(4999);
        assertFalse(adapter.getJob(id).completes);
        vm.warp(block.timestamp + 24 hours + 1);
        adapter.finalize(id);
        assertEq(uint8(_kstatus(kid)), uint8(IERC8183.JobStatus.Rejected)); // lossy: 49.99% verdict pays 0
    }

    function test_Adapter_ThresholdConfigurable_AndPinnedPerJob() public {
        (, uint256 oldId) = _submitted(); // pinned to v1 (5000)
        ERC8183EvaluatorAdapter.Config memory c = adapter.currentConfig();
        c.completeThresholdBps = 8000;
        vm.prank(owner);
        adapter.setConfig(c);
        assertTrue(adapter.mapsToComplete(1, 6000));
        assertFalse(adapter.mapsToComplete(2, 6000));
        vm.prank(evaluator);
        adapter.verdict(oldId, 6000, REASON);
        assertTrue(adapter.getJob(oldId).completes);

        uint256 kid2 = _kernelJob(KEXP);
        vm.prank(client);
        uint256 id2 = adapter.assign(address(kernel), kid2, evaluator);
        vm.prank(evaluator);
        adapter.acceptAssignment(id2);
        vm.prank(provider);
        kernel.submit(kid2, DELIVERABLE, "");
        vm.prank(evaluator);
        adapter.verdict(id2, 6000, REASON); // verdict notes submission itself
        assertFalse(adapter.getJob(id2).completes);
    }

    function test_Adapter_Config_Validation() public {
        ERC8183EvaluatorAdapter.Config memory c = adapter.currentConfig();
        c.completeThresholdBps = 0;
        vm.prank(owner);
        vm.expectRevert(ERC8183EvaluatorAdapter.InvalidConfig.selector);
        adapter.setConfig(c);
        c.completeThresholdBps = 10_001;
        vm.prank(owner);
        vm.expectRevert(ERC8183EvaluatorAdapter.InvalidConfig.selector);
        adapter.setConfig(c);
        ERC8183EvaluatorAdapter.Config memory cur = adapter.currentConfig();
        vm.prank(outsider);
        vm.expectRevert();
        adapter.setConfig(cur);
    }

    // ---------------- challenge ----------------

    function test_Adapter_Challenge_Overturned_LoserPays() public {
        (uint256 kid, uint256 id) = _held(10_000);
        uint256 c0 = usdc.balanceOf(client);
        vm.prank(client);
        adapter.challenge(id, REASON);
        assertEq(c0 - usdc.balanceOf(client), 5.5e6); // 5 bond + 0.5 arbitration fee
        assertEq(usdc.balanceOf(address(adapter)), 5.5e6); // E-17a: held until ruling
        assertEq(usdc.balanceOf(address(arb)), 0);
        assertEq(uint8(_astate(id)), uint8(ERC8183EvaluatorAdapter.State.Disputed));

        vm.prank(owner);
        arb.giveRuling(1, 0);
        assertEq(usdc.balanceOf(address(arb)), ARB_FEE);

        assertEq(uint8(_kstatus(kid)), uint8(IERC8183.JobStatus.Rejected));
        assertEq(registry.stakeOf(evaluator), 74.5e6); // 0.5 reimbursed + 25 slashed
        // client: -5.5, +0.5 fee back, +5 bond back, +12.5 slash share, +100 kernel refund
        assertEq(usdc.balanceOf(client) - c0, 112.5e6);
        assertEq(registry.evaluatorInfo(evaluator).exposure, 0);
        assertEq(usdc.balanceOf(address(adapter)), 0);
    }

    function test_Adapter_Challenge_SameMappedOutcome_NotOverturned() public {
        (uint256 kid, uint256 id) = _held(10_000);
        uint256 e0 = usdc.balanceOf(evaluator);
        vm.prank(client);
        adapter.challenge(id, REASON);
        vm.prank(owner);
        arb.giveRuling(1, 7000); // still >= 5000 => complete; binary outcome unchanged
        assertEq(uint8(_kstatus(kid)), uint8(IERC8183.JobStatus.Completed));
        assertEq(registry.stakeOf(evaluator), 100e6);
        // 2.5 bond share + 0.5 kernel evaluator fee forwarded
        assertEq(usdc.balanceOf(evaluator) - e0, 3e6);
        assertEq(usdc.balanceOf(treasury), 2.5e6);
        assertEq(usdc.balanceOf(address(adapter)), 0);
    }

    function test_Adapter_Challenge_ByProvider_OverturnReject() public {
        (uint256 kid, uint256 id) = _held(1000);
        uint256 p0 = usdc.balanceOf(provider);
        vm.prank(provider);
        adapter.challenge(id, REASON);
        vm.prank(owner);
        arb.giveRuling(1, 10_000);
        assertEq(uint8(_kstatus(kid)), uint8(IERC8183.JobStatus.Completed));
        // provider: -5.5 +0.5 +5 +12.5 + 98.5 kernel payout
        assertEq(usdc.balanceOf(provider) - p0, 111e6);
    }

    function test_Adapter_Challenge_Guards() public {
        (, uint256 id) = _held(10_000);
        vm.prank(outsider);
        vm.expectRevert(ERC8183EvaluatorAdapter.Unauthorized.selector);
        adapter.challenge(id, REASON);
        vm.prank(address(arb)); // not disputed yet
        vm.expectRevert(
            abi.encodeWithSelector(ERC8183EvaluatorAdapter.WrongState.selector, ERC8183EvaluatorAdapter.State.Held)
        );
        adapter.rule(id, 0);
        vm.prank(client);
        adapter.challenge(id, REASON);
        vm.prank(outsider);
        vm.expectRevert(ERC8183EvaluatorAdapter.Unauthorized.selector);
        adapter.rule(id, 0);
    }

    function test_Adapter_ChallengeWindowClosed() public {
        (, uint256 id) = _held(10_000);
        vm.warp(block.timestamp + 24 hours + 1);
        vm.prank(client);
        vm.expectRevert(ERC8183EvaluatorAdapter.ChallengeWindowClosed.selector);
        adapter.challenge(id, REASON);
    }

    function test_Adapter_StaleDispute_ExecutesHeldVerdict() public {
        (uint256 kid, uint256 id) = _assigned(40 days);
        vm.prank(provider);
        kernel.submit(kid, DELIVERABLE, "");
        vm.prank(evaluator);
        adapter.verdict(id, 10_000, REASON);
        uint256 c0 = usdc.balanceOf(client);
        vm.prank(client);
        adapter.challenge(id, REASON);
        assertEq(usdc.balanceOf(address(adapter)), 5e6 + ARB_FEE); // E-17a: bond + fee held here
        assertEq(usdc.balanceOf(address(arb)), 0);
        vm.warp(block.timestamp + 7 days - 1);
        vm.expectRevert(ERC8183EvaluatorAdapter.ArbitrationTimeoutNotReached.selector);
        adapter.resolveStaleDispute(id);
        vm.warp(block.timestamp + 1);
        vm.expectEmit(true, true, true, true, address(adapter));
        emit ERC8183EvaluatorAdapter.ArbitrationFeeRefunded(id, client, ARB_FEE);
        adapter.resolveStaleDispute(id);
        assertEq(uint8(_kstatus(kid)), uint8(IERC8183.JobStatus.Completed));
        assertEq(usdc.balanceOf(client), c0); // E-17a: bond and arbitration fee both returned
        assertEq(usdc.balanceOf(address(adapter)), 0);
        assertEq(usdc.balanceOf(address(arb)), 0);
        vm.prank(owner); // late ruling cannot change anything
        vm.expectRevert(
            abi.encodeWithSelector(ERC8183EvaluatorAdapter.WrongState.selector, ERC8183EvaluatorAdapter.State.Executed)
        );
        arb.giveRuling(1, 0);
    }

    // ---------------- missed verdict ----------------

    function test_Adapter_TimeoutRelease_SlashesAndRejects() public {
        (uint256 kid, uint256 id) = _submitted();
        vm.warp(block.timestamp + 24 hours);
        vm.expectRevert(ERC8183EvaluatorAdapter.EvalWindowOpen.selector);
        adapter.timeoutRelease(id);
        vm.warp(block.timestamp + 1);
        uint256 c0 = usdc.balanceOf(client);
        uint256 p0 = usdc.balanceOf(provider);
        adapter.timeoutRelease(id);
        assertEq(registry.stakeOf(evaluator), 90e6);
        assertEq(usdc.balanceOf(provider) - p0, 5e6); // harmed party share
        assertEq(uint8(_kstatus(kid)), uint8(IERC8183.JobStatus.Rejected));
        assertEq(usdc.balanceOf(client) - c0, BUDGET);
        assertEq(kernel.getJob(kid).evaluator, address(adapter));
        vm.prank(evaluator);
        vm.expectRevert(
            abi.encodeWithSelector(ERC8183EvaluatorAdapter.WrongState.selector, ERC8183EvaluatorAdapter.State.Executed)
        );
        adapter.verdict(id, 10_000, REASON);
    }

    function test_Adapter_TimeoutNeedsSubmission() public {
        (, uint256 id) = _assigned(KEXP);
        vm.warp(block.timestamp + 5 days);
        vm.expectRevert(ERC8183EvaluatorAdapter.NotSubmitted.selector);
        adapter.timeoutRelease(id);
        vm.expectRevert(ERC8183EvaluatorAdapter.NotSubmitted.selector);
        adapter.noteSubmission(id);
    }

    /// E-22: slash base pinned when the evaluator accepts.
    function test_Adapter_SlashBasePinned() public {
        (, uint256 id) = _submitted();
        EvaluatorRegistry.Config memory rc = registry.config();
        rc.minStake = 50e6;
        vm.prank(owner);
        registry.setConfig(rc);
        vm.warp(block.timestamp + 25 hours);
        adapter.timeoutRelease(id);
        assertEq(registry.stakeOf(evaluator), 90e6); // 10% of pinned 100, not of 50
    }

    // ---------------- assignment guards ----------------

    function test_Adapter_Assign_Guards() public {
        uint256 kid = _kernelJob(KEXP);
        vm.prank(outsider);
        vm.expectRevert(ERC8183EvaluatorAdapter.Unauthorized.selector);
        adapter.assign(address(kernel), kid, evaluator);
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(ERC8183EvaluatorAdapter.EvaluatorNotActive.selector, evaluator2));
        adapter.assign(address(kernel), kid, evaluator2);
        vm.prank(client);
        vm.expectRevert(ERC8183EvaluatorAdapter.InvalidParty.selector);
        adapter.assign(address(kernel), kid, provider);
        vm.prank(client);
        adapter.assign(address(kernel), kid, evaluator);
        vm.prank(client);
        vm.expectRevert(ERC8183EvaluatorAdapter.AlreadyAssigned.selector);
        adapter.assign(address(kernel), kid, evaluator);

        // kernel job naming another evaluator
        vm.startPrank(client);
        uint256 kid2 = kernel.createJob(provider, outsider, block.timestamp + KEXP, "x", address(0));
        vm.expectRevert(ERC8183EvaluatorAdapter.NotAdapterEvaluator.selector);
        adapter.assign(address(kernel), kid2, evaluator);
        // Open (unfunded) job
        uint256 kid3 = kernel.createJob(provider, address(adapter), block.timestamp + KEXP, "x", address(0));
        vm.expectRevert(
            abi.encodeWithSelector(ERC8183EvaluatorAdapter.WrongKernelStatus.selector, IERC8183.JobStatus.Open)
        );
        adapter.assign(address(kernel), kid3, evaluator);
        vm.stopPrank();
    }

    /// E-1a: refuse kernel jobs that could expire before the adapter's worst-case timeline.
    function test_Adapter_Assign_ExpiryTooSoon() public {
        uint256 req = 24 hours + 24 hours + 7 days + 1 hours;
        assertEq(adapter.requiredExpiryDuration(1), req);
        assertEq(adapter.minKernelExpiry(), block.timestamp + req);
        (uint256 bond, uint256 cost, uint256 reqQ, uint256 minExp, uint32 v) = adapter.quote(BUDGET);
        assertEq(bond, 5e6);
        assertEq(cost, ARB_FEE);
        assertEq(reqQ, req);
        assertEq(minExp, block.timestamp + req);
        assertEq(v, 1);
        uint256 kid = _kernelJob(req - 1);
        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(
                ERC8183EvaluatorAdapter.ExpiryTooSoon.selector, block.timestamp + req - 1, block.timestamp + req
            )
        );
        adapter.assign(address(kernel), kid, evaluator);
        // exactly the minimum is accepted
        uint256 kid2 = _kernelJob(req);
        vm.prank(client);
        adapter.assign(address(kernel), kid2, evaluator);
    }

    /// E-1a: the evaluator's opt-in re-checks expiry against the pinned config.
    function test_Adapter_Accept_ExpiryTooSoon() public {
        uint256 req = adapter.requiredExpiryDuration(1);
        uint256 kid = _kernelJob(req);
        vm.prank(client);
        uint256 id = adapter.assign(address(kernel), kid, evaluator);
        vm.warp(block.timestamp + 1);
        vm.prank(evaluator);
        vm.expectRevert(
            abi.encodeWithSelector(
                ERC8183EvaluatorAdapter.ExpiryTooSoon.selector, block.timestamp - 1 + req, block.timestamp + req
            )
        );
        adapter.acceptAssignment(id);
        assertEq(registry.evaluatorInfo(evaluator).exposure, 0);
    }

    /// E-1c: a submission observed with less kernel time left than the required duration is
    ///       refused: no eval window, ExpiryRisk, exposure released, no slash, kernel refund path.
    function test_E1c_LateSubmission_Refused_NoteSubmission() public {
        uint256 req = adapter.requiredExpiryDuration(1);
        (uint256 kid, uint256 id) = _assigned(req + 2 days);
        uint256 expiredAt = kernel.getJob(kid).expiredAt;
        uint256 stake0 = registry.stakeOf(evaluator);
        vm.warp(block.timestamp + 2 days + 1);
        vm.prank(provider);
        kernel.submit(kid, DELIVERABLE, "");
        vm.expectEmit(true, true, true, true, address(adapter));
        emit ERC8183EvaluatorAdapter.ExpiryRisk(id, expiredAt, block.timestamp + req);
        vm.prank(outsider);
        adapter.noteSubmission(id);
        ERC8183EvaluatorAdapter.AdapterJob memory j = adapter.getJob(id);
        assertEq(uint8(j.state), uint8(ERC8183EvaluatorAdapter.State.ExpiryRefused));
        assertEq(j.submittedAt, 0, "no eval window started");
        EvaluatorRegistry.Evaluator memory info = registry.evaluatorInfo(evaluator);
        assertEq(info.exposure, 0);
        assertEq(info.openJobs, 0);
        assertEq(info.stake, stake0, "no slash");
        // no adapter path left: verdict / timeout / close all refuse
        vm.prank(evaluator);
        vm.expectRevert(
            abi.encodeWithSelector(
                ERC8183EvaluatorAdapter.WrongState.selector, ERC8183EvaluatorAdapter.State.ExpiryRefused
            )
        );
        adapter.verdict(id, 10_000, REASON);
        vm.warp(block.timestamp + 30 days);
        vm.expectRevert(
            abi.encodeWithSelector(
                ERC8183EvaluatorAdapter.WrongState.selector, ERC8183EvaluatorAdapter.State.ExpiryRefused
            )
        );
        adapter.timeoutRelease(id);
        assertEq(registry.stakeOf(evaluator), stake0, "no slash after eval window would have ended");
        // kernel refund path
        uint256 c0 = usdc.balanceOf(client);
        kernel.claimRefund(kid);
        assertEq(usdc.balanceOf(client) - c0, BUDGET);
    }

    /// E-1c via verdict: the refusal persists (verdict returns without recording a verdict).
    function test_E1c_LateSubmission_Refused_Verdict() public {
        uint256 req = adapter.requiredExpiryDuration(1);
        (uint256 kid, uint256 id) = _assigned(req + 1 days);
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(provider);
        kernel.submit(kid, DELIVERABLE, "");
        vm.recordLogs();
        vm.prank(evaluator);
        adapter.verdict(id, 10_000, REASON);
        assertEq(uint8(_astate(id)), uint8(ERC8183EvaluatorAdapter.State.ExpiryRefused));
        assertEq(adapter.getJob(id).verdictAt, 0);
        assertEq(registry.evaluatorInfo(evaluator).exposure, 0);
        // the kernel job can still be re-assigned? no: assign enforces the same bound
        vm.prank(client);
        vm.expectRevert();
        adapter.assign(address(kernel), kid, evaluator);
    }

    /// E-1c boundary: exactly the required time left still starts the window.
    function test_E1c_Boundary_ExactRequiredTimeStarts() public {
        uint256 req = adapter.requiredExpiryDuration(1);
        (uint256 kid, uint256 id) = _assigned(req + 1 days);
        vm.warp(block.timestamp + 1 days);
        vm.prank(provider);
        kernel.submit(kid, DELIVERABLE, "");
        adapter.noteSubmission(id);
        assertEq(adapter.getJob(id).submittedAt, block.timestamp);
        assertEq(uint8(_astate(id)), uint8(ERC8183EvaluatorAdapter.State.Active));
    }

    /// E-1d: a Proposed (never accepted) assignment on an ended kernel job is closable by anyone.
    function test_E1d_CloseProposed_OnEndedKernelJob() public {
        uint256 kid = _kernelJob(KEXP);
        vm.prank(client);
        uint256 id = adapter.assign(address(kernel), kid, evaluator);
        vm.expectRevert(
            abi.encodeWithSelector(ERC8183EvaluatorAdapter.WrongKernelStatus.selector, IERC8183.JobStatus.Funded)
        );
        adapter.closeKernelEnded(id);
        vm.warp(block.timestamp + KEXP);
        kernel.claimRefund(kid);
        // an evaluator cannot accept liability on an ended kernel job
        vm.prank(evaluator);
        vm.expectRevert(
            abi.encodeWithSelector(ERC8183EvaluatorAdapter.WrongKernelStatus.selector, IERC8183.JobStatus.Expired)
        );
        adapter.acceptAssignment(id);
        vm.expectEmit(true, true, true, true, address(adapter));
        emit ERC8183EvaluatorAdapter.KernelJobEnded(id, uint8(IERC8183.JobStatus.Expired));
        vm.prank(outsider);
        adapter.closeKernelEnded(id);
        assertEq(uint8(_astate(id)), uint8(ERC8183EvaluatorAdapter.State.KernelEnded));
        assertEq(adapter.assignmentOf(keccak256(abi.encode(address(kernel), kid))), 0, "slot cleared");
        assertEq(registry.evaluatorInfo(evaluator).exposure, 0);
        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(
                ERC8183EvaluatorAdapter.WrongState.selector, ERC8183EvaluatorAdapter.State.KernelEnded
            )
        );
        adapter.withdrawAssignment(id);
    }

    /// E-1a: shorter adapter windows are configurable; the required expiry follows them.
    function test_Adapter_ExpiryWindowsConfigurable() public {
        ERC8183EvaluatorAdapter.Config memory c = adapter.currentConfig();
        assertEq(c.challengeWindow, 24 hours);
        assertEq(c.arbitrationTimeout, 7 days);
        assertEq(c.expiryMargin, 1 hours);
        c.arbitrationTimeout = 3 days;
        c.expiryMargin = 2 hours;
        vm.prank(owner);
        adapter.setConfig(c);
        assertEq(adapter.requiredExpiryDuration(2), 24 hours + 24 hours + 3 days + 2 hours);
        assertEq(adapter.requiredExpiryDuration(1), 24 hours + 24 hours + 7 days + 1 hours);
    }

    function test_Adapter_Assign_TokenMismatch() public {
        MockUSDC other = new MockUSDC();
        MockERC8183Kernel k2 = new MockERC8183Kernel(IERC20(address(other)), kernelTreasury, 0, 0);
        other.mint(client, BUDGET);
        vm.startPrank(client);
        other.approve(address(k2), BUDGET);
        uint256 kid = k2.createJob(provider, address(adapter), block.timestamp + KEXP, "x", address(0));
        k2.setBudget(kid, BUDGET, "");
        k2.fund(kid, BUDGET, "");
        vm.expectRevert(ERC8183EvaluatorAdapter.TokenMismatch.selector);
        adapter.assign(address(k2), kid, evaluator);
        vm.stopPrank();
    }

    /// Opt-in: an assignment the evaluator did not accept carries no liability and can be withdrawn.
    function test_Adapter_UnacceptedAssignment_NoLiability_Withdrawable() public {
        uint256 kid = _kernelJob(KEXP + 3 days); // re-assigned 2 days later; still above the E-1a minimum
        vm.prank(client);
        uint256 id = adapter.assign(address(kernel), kid, evaluator);
        assertEq(registry.evaluatorInfo(evaluator).exposure, 0);
        vm.prank(provider);
        kernel.submit(kid, DELIVERABLE, "");
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(
            abi.encodeWithSelector(ERC8183EvaluatorAdapter.WrongState.selector, ERC8183EvaluatorAdapter.State.Proposed)
        );
        adapter.timeoutRelease(id);
        vm.prank(outsider);
        vm.expectRevert(ERC8183EvaluatorAdapter.Unauthorized.selector);
        adapter.acceptAssignment(id);
        vm.prank(client);
        adapter.withdrawAssignment(id);
        // re-assign to a different staked evaluator
        _stake(evaluator2, 100e6);
        vm.prank(client);
        uint256 id2 = adapter.assign(address(kernel), kid, evaluator2);
        vm.prank(evaluator2);
        adapter.acceptAssignment(id2); // kernel already Submitted: window starts now
        assertEq(adapter.getJob(id2).submittedAt, block.timestamp);
    }

    function test_Adapter_OnlyEvaluatorVerdicts_AndBounds() public {
        (, uint256 id) = _submitted();
        vm.prank(outsider);
        vm.expectRevert(ERC8183EvaluatorAdapter.Unauthorized.selector);
        adapter.verdict(id, 10_000, REASON);
        vm.prank(evaluator);
        vm.expectRevert(ERC8183EvaluatorAdapter.InvalidPayout.selector);
        adapter.verdict(id, 10_001, REASON);
        vm.warp(block.timestamp + 24 hours + 1);
        vm.prank(evaluator);
        vm.expectRevert(ERC8183EvaluatorAdapter.EvalWindowClosed.selector);
        adapter.verdict(id, 10_000, REASON);
    }

    /// The kernel's claimRefund after expiredAt is outside the adapter's control. If the kernel job
    /// expired during a dispute, the ruling still settles stake/bonds; the kernel call fails safely.
    function test_Adapter_KernelExpiredDuringDispute() public {
        (uint256 kid, uint256 id) = _held(10_000);
        vm.prank(client);
        adapter.challenge(id, REASON);
        vm.warp(block.timestamp + KEXP + 1); // arbitrator slow and nobody resolved the stale dispute
        uint256 c0 = usdc.balanceOf(client);
        kernel.claimRefund(kid);
        assertEq(usdc.balanceOf(client) - c0, BUDGET);
        vm.prank(owner);
        arb.giveRuling(1, 0);
        assertEq(uint8(_astate(id)), uint8(ERC8183EvaluatorAdapter.State.KernelCallFailed));
        assertEq(uint8(_kstatus(kid)), uint8(IERC8183.JobStatus.Expired));
        assertEq(registry.stakeOf(evaluator), 74.5e6);
        assertEq(registry.evaluatorInfo(evaluator).exposure, 0);
        assertEq(usdc.balanceOf(address(adapter)), 0);
        assertEq(usdc.balanceOf(address(arb)), ARB_FEE); // ruled => held fee paid to arbitrator
    }

    /// Only the adapter (the kernel's named evaluator) can complete on the kernel.
    function test_Kernel_OnlyEvaluatorCompletes() public {
        (uint256 kid,) = _submitted();
        vm.prank(evaluator);
        vm.expectRevert(MockERC8183Kernel.Unauthorized.selector);
        kernel.complete(kid, REASON, "");
    }

    function test_Kernel_FundBudgetMismatch() public {
        vm.startPrank(client);
        uint256 kid = kernel.createJob(provider, address(adapter), block.timestamp + KEXP, "x", address(0));
        kernel.setBudget(kid, BUDGET, "");
        vm.expectRevert(MockERC8183Kernel.BudgetMismatch.selector);
        kernel.fund(kid, BUDGET - 1, "");
        vm.stopPrank();
    }

    function testFuzz_Adapter_MappingAndConservation(uint16 verdictBps, uint16 rulingBps, bool challenged) public {
        verdictBps = uint16(bound(verdictBps, 0, 10_000));
        rulingBps = uint16(bound(rulingBps, 0, 10_000));
        address arbAddr = address(arb);
        uint256 total0 = usdc.balanceOf(client) + usdc.balanceOf(provider) + usdc.balanceOf(evaluator)
            + usdc.balanceOf(treasury) + usdc.balanceOf(kernelTreasury) + usdc.balanceOf(address(registry))
            + usdc.balanceOf(arbAddr);
        (uint256 kid, uint256 id) = _held(verdictBps);
        bool expectComplete = verdictBps >= 5000;
        if (challenged) {
            vm.prank(client);
            adapter.challenge(id, REASON);
            vm.prank(owner);
            arb.giveRuling(1, rulingBps);
            bool rc = rulingBps >= 5000;
            assertEq(registry.stakeOf(evaluator), rc != expectComplete ? 74.5e6 : 100e6);
            expectComplete = rc;
        } else {
            vm.warp(block.timestamp + 24 hours + 1);
            adapter.finalize(id);
        }
        assertEq(
            uint8(_kstatus(kid)), uint8(expectComplete ? IERC8183.JobStatus.Completed : IERC8183.JobStatus.Rejected)
        );
        uint256 total1 = usdc.balanceOf(client) + usdc.balanceOf(provider) + usdc.balanceOf(evaluator)
            + usdc.balanceOf(treasury) + usdc.balanceOf(kernelTreasury) + usdc.balanceOf(address(registry))
            + usdc.balanceOf(arbAddr);
        assertEq(total1, total0);
        assertEq(usdc.balanceOf(address(adapter)), 0);
        assertEq(usdc.balanceOf(address(kernel)), 0);
        assertEq(registry.evaluatorInfo(evaluator).exposure, 0);
    }

    // ---------------- closeKernelEnded (found by invariant suite) ----------------

    /// Regression: accepted, provider never submits, kernel expires, client claims refund on the
    /// kernel. Previously the adapter job stayed Active forever with exposure/openJobs locked, so
    /// the evaluator could never withdraw stake.
    function test_Adapter_CloseKernelEnded_ReleasesExposure() public {
        (uint256 kid, uint256 id) = _assigned(KEXP);
        assertEq(registry.evaluatorInfo(evaluator).exposure, BUDGET);
        vm.expectRevert(
            abi.encodeWithSelector(ERC8183EvaluatorAdapter.WrongKernelStatus.selector, IERC8183.JobStatus.Funded)
        );
        adapter.closeKernelEnded(id);

        vm.warp(block.timestamp + KEXP);
        kernel.claimRefund(kid);
        uint256 stake0 = registry.evaluatorInfo(evaluator).stake;
        vm.prank(outsider);
        adapter.closeKernelEnded(id);
        assertEq(uint8(_astate(id)), uint8(ERC8183EvaluatorAdapter.State.KernelEnded));
        EvaluatorRegistry.Evaluator memory info = registry.evaluatorInfo(evaluator);
        assertEq(info.exposure, 0);
        assertEq(info.openJobs, 0);
        assertEq(info.stake, stake0, "no slash");

        // evaluator can now exit
        vm.prank(evaluator);
        registry.requestUnstake();
        vm.warp(block.timestamp + registry.config().unbondingPeriod);
        vm.prank(evaluator);
        registry.withdraw();
        assertEq(registry.evaluatorInfo(evaluator).stake, 0);

        vm.expectRevert(
            abi.encodeWithSelector(
                ERC8183EvaluatorAdapter.WrongState.selector, ERC8183EvaluatorAdapter.State.KernelEnded
            )
        );
        adapter.closeKernelEnded(id);
    }

    function test_Adapter_CloseKernelEnded_NotAfterSubmissionSeen() public {
        (, uint256 id) = _submitted();
        vm.expectRevert(
            abi.encodeWithSelector(ERC8183EvaluatorAdapter.WrongState.selector, ERC8183EvaluatorAdapter.State.Active)
        );
        adapter.closeKernelEnded(id);
    }
}
