// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {EvaluatorRegistry} from "../src/EvaluatorRegistry.sol";
import {IArbitrator} from "../src/interfaces/IArbitrator.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract JobEscrowTest is BaseTest {
    // ------------------------------------------------------------ happy / partial / reject

    function test_HappyPath_Complete() public {
        uint256 id = _openAndSubmit(100 * USDC);
        assertEq(uint8(_state(id)), uint8(JobEscrow.State.Submitted));
        _verdict(id, JobEscrow.Outcome.Complete, 10_000);
        assertEq(uint8(_state(id)), uint8(JobEscrow.State.Completed));

        uint256 p0 = usdc.balanceOf(provider);
        _passChallengeWindow();
        escrow.finalize(id);

        assertEq(usdc.balanceOf(provider) - p0, 98.5e6); // 100 - 1 protocol fee - 0.5 evaluator fee
        assertEq(usdc.balanceOf(treasury), 1 * USDC);
        assertEq(usdc.balanceOf(evaluator), 900 * USDC + USDC / 2); // 1000 minted - 100 staked + 0.5 fee
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(uint8(_state(id)), uint8(JobEscrow.State.Settled));
        EvaluatorRegistry.Evaluator memory e = registry.evaluatorInfo(evaluator);
        assertEq(e.exposure, 0);
        assertEq(e.openJobs, 0);
    }

    function test_Erc8183Aliases_CompleteAndReject() public {
        uint256 a = _openAndSubmit(10 * USDC);
        uint256 b = _openAndSubmit(10 * USDC);
        vm.startPrank(evaluator);
        escrow.complete(a, REASON);
        escrow.reject(b, REASON);
        vm.stopPrank();
        assertEq(uint8(_state(a)), uint8(JobEscrow.State.Completed));
        assertEq(uint8(_state(b)), uint8(JobEscrow.State.Rejected));
    }

    function test_PartialPath() public {
        uint256 id = _openAndSubmit(100 * USDC);
        _verdict(id, JobEscrow.Outcome.Partial, 6000);
        uint256 c0 = usdc.balanceOf(client);
        uint256 p0 = usdc.balanceOf(provider);
        _passChallengeWindow();
        escrow.finalize(id);
        assertEq(usdc.balanceOf(provider) - p0, 59_100_000); // 60 - 1% fee - 0.5% evaluator fee
        assertEq(usdc.balanceOf(treasury), 600_000);
        assertEq(usdc.balanceOf(client) - c0, 40 * USDC);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_RejectPath_FullRefundNoFee() public {
        uint256 c0 = usdc.balanceOf(client);
        uint256 id = _openAndSubmit(100 * USDC);
        _verdict(id, JobEscrow.Outcome.Reject, 0);
        _passChallengeWindow();
        escrow.finalize(id);
        assertEq(usdc.balanceOf(client), c0);
        assertEq(usdc.balanceOf(treasury), 0);
    }

    function test_Verdict_InvalidPayoutCombos() public {
        uint256 id = _openAndSubmit(100 * USDC);
        vm.startPrank(evaluator);
        vm.expectRevert(JobEscrow.InvalidPayout.selector);
        escrow.verdict(id, JobEscrow.Outcome.Complete, 9000, REASON);
        vm.expectRevert(JobEscrow.InvalidPayout.selector);
        escrow.verdict(id, JobEscrow.Outcome.Reject, 1, REASON);
        vm.expectRevert(JobEscrow.InvalidPayout.selector);
        escrow.verdict(id, JobEscrow.Outcome.Partial, 0, REASON);
        vm.expectRevert(JobEscrow.InvalidPayout.selector);
        escrow.verdict(id, JobEscrow.Outcome.Partial, 10_000, REASON);
        vm.expectRevert(JobEscrow.InvalidOutcome.selector);
        escrow.verdict(id, JobEscrow.Outcome.None, 0, REASON);
        vm.stopPrank();
    }

    function test_DoubleVerdict_Reverts() public {
        uint256 id = _openAndSubmit(100 * USDC);
        _verdict(id, JobEscrow.Outcome.Complete, 10_000);
        vm.prank(evaluator);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.WrongState.selector, JobEscrow.State.Completed));
        escrow.verdict(id, JobEscrow.Outcome.Reject, 0, REASON);
    }

    function test_Finalize_BeforeWindow_Reverts() public {
        uint256 id = _openAndSubmit(100 * USDC);
        _verdict(id, JobEscrow.Outcome.Complete, 10_000);
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(JobEscrow.ChallengeWindowOpen.selector);
        escrow.finalize(id);
    }

    function test_Finalize_Twice_Reverts() public {
        uint256 id = _openAndSubmit(100 * USDC);
        _verdict(id, JobEscrow.Outcome.Complete, 10_000);
        _passChallengeWindow();
        escrow.finalize(id);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.WrongState.selector, JobEscrow.State.Settled));
        escrow.finalize(id);
    }

    // ------------------------------------------------------------ instant path

    function test_InstantPath_ReleasesOnSubmit() public {
        uint256 id = _open(1 * USDC);
        vm.prank(provider);
        escrow.postProviderBond(id, 1 * USDC);
        uint256 p0 = usdc.balanceOf(provider);
        vm.prank(provider);
        escrow.submit(id, DELIVERABLE);

        JobEscrow.Job memory j = escrow.getJob(id);
        assertTrue(j.instant);
        assertEq(uint8(j.state), uint8(JobEscrow.State.Completed));
        assertEq(usdc.balanceOf(provider) - p0, 990_000);
        assertEq(usdc.balanceOf(treasury), 10_000);
        assertEq(usdc.balanceOf(address(escrow)), 1 * USDC); // only the bond remains

        _passChallengeWindow();
        escrow.finalize(id);
        assertEq(usdc.balanceOf(provider) - p0, 1_990_000); // + bond back
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_InstantPath_WithoutBond_UsesVerdictPath() public {
        uint256 id = _openAndSubmit(1 * USDC);
        JobEscrow.Job memory j = escrow.getJob(id);
        assertFalse(j.instant);
        assertEq(uint8(j.state), uint8(JobEscrow.State.Submitted));
    }

    function test_InstantPath_AboveThreshold_UsesVerdictPath() public {
        uint256 id = _open(1 * USDC + 1);
        vm.startPrank(provider);
        escrow.postProviderBond(id, 10 * USDC);
        escrow.submit(id, DELIVERABLE);
        vm.stopPrank();
        assertEq(uint8(_state(id)), uint8(JobEscrow.State.Submitted));
    }

    function test_InstantChallenge_ClientCompensatedFromProviderBond() public {
        uint256 id = _open(1 * USDC);
        vm.startPrank(provider);
        escrow.postProviderBond(id, 1 * USDC);
        escrow.submit(id, DELIVERABLE);
        vm.stopPrank();
        uint256 c0 = usdc.balanceOf(client);

        vm.prank(client);
        escrow.challenge(id, REASON); // bond = minChallengeBond = 1 USDC, + 0.5 arbitration fee
        assertEq(c0 - usdc.balanceOf(client), 1.5e6);
        vm.prank(owner);
        arb.giveRuling(1, 0);

        // bond returned + 1 USDC compensation from provider bond; the bond is exhausted by the
        // compensation so the 0.5 fee reimbursement (paid from the remaining provider bond) is 0
        assertEq(usdc.balanceOf(client) - c0, USDC / 2);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(registry.stakeOf(evaluator), 100 * USDC); // no verdict, no evaluator slash
    }

    function test_InstantChallenge_FailedChallenge_BondToProviderAndTreasury() public {
        uint256 id = _open(1 * USDC);
        vm.startPrank(provider);
        escrow.postProviderBond(id, 1 * USDC);
        escrow.submit(id, DELIVERABLE);
        vm.stopPrank();
        vm.prank(client);
        escrow.challenge(id, REASON);
        uint256 p0 = usdc.balanceOf(provider);
        vm.prank(owner);
        arb.giveRuling(1, 10_000);
        // bond split 50/50 provider/treasury, provider bond returned
        assertEq(usdc.balanceOf(provider) - p0, 500_000 + 1 * USDC);
        assertEq(usdc.balanceOf(treasury), 10_000 + 500_000);
    }

    function test_InstantChallenge_ProviderCannotChallenge() public {
        uint256 id = _open(1 * USDC);
        vm.startPrank(provider);
        escrow.postProviderBond(id, 1 * USDC);
        escrow.submit(id, DELIVERABLE);
        vm.expectRevert(JobEscrow.Unauthorized.selector);
        escrow.challenge(id, REASON);
        vm.stopPrank();
    }

    // ------------------------------------------------------------ missed verdict

    function test_MissedVerdict_TimeoutSlashAndRefund() public {
        uint256 c0 = usdc.balanceOf(client);
        uint256 id = _openAndSubmit(100 * USDC);
        uint256 p0 = usdc.balanceOf(provider);
        vm.warp(block.timestamp + 24 hours + 1);
        vm.prank(outsider);
        escrow.timeoutRelease(id);

        assertEq(uint8(_state(id)), uint8(JobEscrow.State.Expired));
        assertEq(usdc.balanceOf(client), c0);
        assertEq(registry.stakeOf(evaluator), 90 * USDC); // 10% of minStake
        assertEq(usdc.balanceOf(provider) - p0, 5 * USDC); // 50% harmed party
        assertEq(usdc.balanceOf(treasury), 5 * USDC);
        assertEq(registry.evaluatorInfo(evaluator).openJobs, 0);
    }

    function test_MissedVerdict_TimeoutBeforeWindow_Reverts() public {
        uint256 id = _openAndSubmit(100 * USDC);
        vm.warp(block.timestamp + 24 hours);
        vm.expectRevert(JobEscrow.EvalWindowOpen.selector);
        escrow.timeoutRelease(id);
    }

    function test_VerdictAfterEvalWindow_Reverts() public {
        uint256 id = _openAndSubmit(100 * USDC);
        vm.warp(block.timestamp + 24 hours + 1);
        vm.prank(evaluator);
        vm.expectRevert(JobEscrow.EvalWindowClosed.selector);
        escrow.verdict(id, JobEscrow.Outcome.Complete, 10_000, REASON);
    }

    // ------------------------------------------------------------ challenges

    function test_Challenge_Overturned_SlashesEvaluatorAndProviderBond() public {
        uint256 id = _open(100 * USDC);
        vm.startPrank(provider);
        escrow.postProviderBond(id, 20 * USDC);
        escrow.submit(id, DELIVERABLE);
        vm.stopPrank();
        _verdict(id, JobEscrow.Outcome.Complete, 10_000);

        uint256 c0 = usdc.balanceOf(client);
        uint256 p0 = usdc.balanceOf(provider);
        vm.prank(client);
        escrow.challenge(id, REASON);
        assertEq(uint8(_state(id)), uint8(JobEscrow.State.Disputed));
        assertEq(escrow.getDispute(id).bond, 5 * USDC);

        vm.prank(owner);
        arb.giveRuling(1, 0);

        assertEq(uint8(_state(id)), uint8(JobEscrow.State.Settled));
        assertEq(registry.stakeOf(evaluator), 74.5e6); // 0.5 fee reimbursement + 25% of minStake slashed
        // client: -5.5 bond+fee, +0.5 fee back, +5 bond back, +12.5 slash share, +20 provider bond, +100 refund
        assertEq(usdc.balanceOf(client) - c0, 132_500_000);
        assertEq(usdc.balanceOf(provider), p0); // nothing paid, bond lost
        assertEq(usdc.balanceOf(treasury), 12_500_000);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_Challenge_Upheld_BondToEvaluatorAndTreasury() public {
        uint256 id = _openAndSubmit(100 * USDC);
        _verdict(id, JobEscrow.Outcome.Complete, 10_000);
        uint256 c0 = usdc.balanceOf(client);
        uint256 e0 = usdc.balanceOf(evaluator);
        uint256 p0 = usdc.balanceOf(provider);
        vm.prank(client);
        escrow.challenge(id, REASON);
        vm.prank(owner);
        arb.giveRuling(1, 9000); // diff 1000 <= 2000: not material

        assertEq(registry.stakeOf(evaluator), 100 * USDC);
        // 2.5 bond share + 0.45 evaluator fee (0.5% of 90 gross; verdict stands)
        assertEq(usdc.balanceOf(evaluator) - e0, 2_950_000);
        // ruling is still applied: 90% payout - 1% fee - 0.5% evaluator fee
        assertEq(usdc.balanceOf(provider) - p0, 88_650_000);
        assertEq(usdc.balanceOf(treasury), 2_500_000 + 900_000);
        assertEq(usdc.balanceOf(address(arb)), ARB_FEE); // challenger lost: fee stays with arbitrator
        assertEq(usdc.balanceOf(client) + 5.5e6, c0 + 10 * USDC); // paid bond + fee, got 10% refund
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_Challenge_ByProviderOnReject_Overturned() public {
        uint256 id = _openAndSubmit(100 * USDC);
        _verdict(id, JobEscrow.Outcome.Reject, 0);
        uint256 p0 = usdc.balanceOf(provider);
        vm.prank(provider);
        escrow.challenge(id, REASON);
        vm.prank(owner);
        arb.giveRuling(1, 10_000);
        // E-17: 0.5 arbitration fee reimbursed from evaluator stake, then 25 slashed
        assertEq(registry.stakeOf(evaluator), 74.5e6);
        // provider: -5.5 bond+fee, +0.5 fee back, +5 bond back, +12.5 slash share, +99 payout (no evaluator fee: overturned)
        assertEq(usdc.balanceOf(provider) - p0, 111_500_000);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_Challenge_AfterWindow_Reverts() public {
        uint256 id = _openAndSubmit(100 * USDC);
        _verdict(id, JobEscrow.Outcome.Complete, 10_000);
        _passChallengeWindow();
        vm.prank(client);
        vm.expectRevert(JobEscrow.ChallengeWindowClosed.selector);
        escrow.challenge(id, REASON);
    }

    function test_Challenge_Twice_Reverts() public {
        uint256 id = _openAndSubmit(100 * USDC);
        _verdict(id, JobEscrow.Outcome.Partial, 5000);
        vm.prank(client);
        escrow.challenge(id, REASON);
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.WrongState.selector, JobEscrow.State.Disputed));
        escrow.challenge(id, REASON);
    }

    function test_Challenge_NoArbitrator_Reverts() public {
        vm.prank(owner);
        escrow.setArbitrator(IArbitrator(address(0)));
        uint256 id = _openAndSubmit(100 * USDC);
        _verdict(id, JobEscrow.Outcome.Complete, 10_000);
        vm.prank(client);
        vm.expectRevert(JobEscrow.NoArbitrator.selector);
        escrow.challenge(id, REASON);
    }

    function test_Rule_OnlyArbitrator() public {
        uint256 id = _openAndSubmit(100 * USDC);
        _verdict(id, JobEscrow.Outcome.Complete, 10_000);
        vm.prank(client);
        escrow.challenge(id, REASON);
        vm.prank(client);
        vm.expectRevert(JobEscrow.Unauthorized.selector);
        escrow.rule(id, 0);
        vm.prank(owner); // escrow owner is not the arbitrator either
        vm.expectRevert(JobEscrow.Unauthorized.selector);
        escrow.rule(id, 0);
    }

    function test_Rule_NotDisputed_Reverts() public {
        uint256 id = _openAndSubmit(100 * USDC);
        vm.prank(address(arb));
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.WrongState.selector, JobEscrow.State.Submitted));
        escrow.rule(id, 0);
    }

    function test_StaleDispute_SettlesPerVerdict() public {
        uint256 id = _openAndSubmit(100 * USDC);
        _verdict(id, JobEscrow.Outcome.Complete, 10_000);
        uint256 c0 = usdc.balanceOf(client);
        vm.prank(client);
        escrow.challenge(id, REASON);
        vm.warp(block.timestamp + 30 days - 1);
        vm.expectRevert(JobEscrow.ArbitrationTimeoutNotReached.selector);
        escrow.resolveStaleDispute(id);
        vm.warp(block.timestamp + 1);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit JobEscrow.ArbitrationFeeRefunded(id, client, ARB_FEE);
        escrow.resolveStaleDispute(id);
        assertEq(usdc.balanceOf(client), c0); // E-17a: bond and held arbitration fee both returned
        assertEq(usdc.balanceOf(address(arb)), 0);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(uint8(_state(id)), uint8(JobEscrow.State.Settled));
        // late ruling cannot change anything
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.WrongState.selector, JobEscrow.State.Settled));
        arb.giveRuling(1, 0);
    }

    function test_ArbitratorChange_DoesNotAffectOpenDispute() public {
        uint256 id = _openAndSubmit(100 * USDC);
        _verdict(id, JobEscrow.Outcome.Complete, 10_000);
        vm.prank(client);
        escrow.challenge(id, REASON);
        vm.prank(owner);
        escrow.setArbitrator(IArbitrator(address(0)));
        vm.prank(owner);
        arb.giveRuling(1, 10_000); // original arbitrator still authorised
        assertEq(uint8(_state(id)), uint8(JobEscrow.State.Settled));
    }

    // ------------------------------------------------------------ cancel / expiry

    function test_Cancel_Open() public {
        vm.prank(client);
        uint256 id = escrow.createJob(provider, evaluator, 10 * USDC, uint64(block.timestamp + 1 days), SPEC);
        vm.prank(client);
        escrow.cancel(id);
        assertEq(uint8(_state(id)), uint8(JobEscrow.State.Cancelled));
    }

    function test_Cancel_FundedNotAccepted_Refunds() public {
        uint256 c0 = usdc.balanceOf(client);
        uint256 id = _open(10 * USDC);
        vm.prank(client);
        escrow.cancel(id);
        assertEq(usdc.balanceOf(client), c0);
        assertEq(registry.evaluatorInfo(evaluator).exposure, 0);
    }

    function test_Cancel_AfterAccept_BeforeDeadline_Reverts() public {
        uint256 id = _open(10 * USDC);
        vm.prank(provider);
        escrow.accept(id);
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.WrongState.selector, JobEscrow.State.Funded));
        escrow.cancel(id);
    }

    function test_ClaimRefund_AfterDeadline() public {
        uint256 c0 = usdc.balanceOf(client);
        uint256 id = _open(10 * USDC);
        vm.prank(provider);
        escrow.accept(id);
        vm.expectRevert(JobEscrow.DeadlineNotReached.selector);
        escrow.claimRefund(id);
        vm.warp(block.timestamp + 3 days);
        vm.prank(outsider);
        escrow.claimRefund(id);
        assertEq(uint8(_state(id)), uint8(JobEscrow.State.Expired));
        assertEq(usdc.balanceOf(client), c0);
    }

    function test_Submit_AfterDeadline_Reverts() public {
        uint256 id = _open(10 * USDC);
        vm.warp(block.timestamp + 3 days);
        vm.prank(provider);
        vm.expectRevert(JobEscrow.DeadlinePassed.selector);
        escrow.submit(id, DELIVERABLE);
    }

    function test_Cancel_ReturnsProviderBond() public {
        uint256 id = _open(10 * USDC);
        uint256 p0 = usdc.balanceOf(provider);
        vm.prank(provider);
        escrow.postProviderBond(id, 3 * USDC);
        vm.prank(client);
        escrow.cancel(id);
        assertEq(usdc.balanceOf(provider), p0);
    }

    // ------------------------------------------------------------ unauthorized / validation

    function test_Unauthorized_Calls() public {
        vm.prank(client);
        uint256 id = escrow.createJob(provider, evaluator, 10 * USDC, uint64(block.timestamp + 1 days), SPEC);

        vm.prank(outsider);
        vm.expectRevert(JobEscrow.Unauthorized.selector);
        escrow.fund(id);

        vm.prank(client);
        escrow.fund(id);

        vm.prank(outsider);
        vm.expectRevert(JobEscrow.Unauthorized.selector);
        escrow.cancel(id);

        vm.prank(client);
        vm.expectRevert(JobEscrow.Unauthorized.selector);
        escrow.submit(id, DELIVERABLE);

        vm.prank(outsider);
        vm.expectRevert(JobEscrow.Unauthorized.selector);
        escrow.accept(id);

        vm.prank(outsider);
        vm.expectRevert(JobEscrow.Unauthorized.selector);
        escrow.postProviderBond(id, 1);

        vm.prank(provider);
        escrow.submit(id, DELIVERABLE);

        vm.prank(client);
        vm.expectRevert(JobEscrow.Unauthorized.selector);
        escrow.verdict(id, JobEscrow.Outcome.Complete, 10_000, REASON);

        vm.prank(provider);
        vm.expectRevert(JobEscrow.Unauthorized.selector);
        escrow.complete(id, REASON);

        _verdict(id, JobEscrow.Outcome.Complete, 10_000);
        vm.prank(outsider);
        vm.expectRevert(JobEscrow.Unauthorized.selector);
        escrow.challenge(id, REASON);

        vm.prank(evaluator);
        vm.expectRevert(JobEscrow.Unauthorized.selector);
        escrow.challenge(id, REASON);
    }

    function test_Unauthorized_Admin() public {
        JobEscrow.Config memory c = escrow.currentConfig();
        vm.startPrank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, outsider));
        escrow.setConfig(c);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, outsider));
        escrow.setTreasury(outsider);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, outsider));
        escrow.setArbitrator(IArbitrator(address(0)));
        vm.stopPrank();
    }

    function test_Unauthorized_DirectSlash() public {
        vm.prank(outsider);
        vm.expectRevert(EvaluatorRegistry.NotSlasher.selector);
        registry.slash(evaluator, 0, 100 * USDC, outsider, 1);
        vm.prank(outsider);
        vm.expectRevert(EvaluatorRegistry.NotSlasher.selector);
        registry.lockExposure(evaluator, 0, 1);
    }

    function test_CreateJob_Validation() public {
        uint64 dl = uint64(block.timestamp + 1 days);
        vm.startPrank(client);
        vm.expectRevert(JobEscrow.ZeroAddress.selector);
        escrow.createJob(address(0), evaluator, 1, dl, SPEC);
        vm.expectRevert(JobEscrow.InvalidParty.selector);
        escrow.createJob(provider, client, 1, dl, SPEC);
        vm.expectRevert(JobEscrow.InvalidParty.selector);
        escrow.createJob(provider, provider, 1, dl, SPEC);
        vm.expectRevert(JobEscrow.ZeroAmount.selector);
        escrow.createJob(provider, evaluator, 0, dl, SPEC);
        vm.expectRevert(JobEscrow.DeadlineInPast.selector);
        escrow.createJob(provider, evaluator, 1, uint64(block.timestamp), SPEC);
        vm.expectRevert(JobEscrow.ZeroHash.selector);
        escrow.createJob(provider, evaluator, 1, dl, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.EvaluatorNotActive.selector, evaluator2));
        escrow.createJob(provider, evaluator2, 1, dl, SPEC); // not staked
        vm.stopPrank();
    }

    function test_InvalidConfig_Reverts() public {
        JobEscrow.Config memory c = escrow.currentConfig();
        c.challengeBondBps = 10_001;
        vm.prank(owner);
        vm.expectRevert(JobEscrow.InvalidConfig.selector);
        escrow.setConfig(c);
    }

    // ------------------------------------------------------------ exposure / config pinning

    function test_ExposureCap() public {
        _open(400 * USDC); // cap = 100 * 5 = 500
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(EvaluatorRegistry.ExposureCapExceeded.selector, 101 * USDC, 100 * USDC));
        escrow.createAndFund(provider, evaluator, 101 * USDC, uint64(block.timestamp + 1 days), SPEC);
        _open(100 * USDC); // exactly at cap
        assertEq(registry.availableExposure(evaluator), 0);
    }

    function test_ExposureCap_FreedAfterSettlement() public {
        uint256 id = _openAndSubmit(500 * USDC);
        _verdict(id, JobEscrow.Outcome.Complete, 10_000);
        vm.prank(client);
        vm.expectRevert();
        escrow.createAndFund(provider, evaluator, 1, uint64(block.timestamp + 5 days), SPEC);
        _passChallengeWindow();
        escrow.finalize(id);
        _open(500 * USDC);
    }

    function test_ConfigPinnedPerJob() public {
        uint256 id = _openAndSubmit(100 * USDC);
        JobEscrow.Config memory c = escrow.currentConfig();
        c.feeBps = 400;
        c.challengeWindow = 1 hours;
        vm.prank(owner);
        escrow.setConfig(c);
        assertEq(escrow.currentConfigVersion(), 2);
        _verdict(id, JobEscrow.Outcome.Complete, 10_000);
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(JobEscrow.ChallengeWindowOpen.selector); // still 48h for this job
        escrow.finalize(id);
        _passChallengeWindow();
        uint256 p0 = usdc.balanceOf(provider);
        escrow.finalize(id);
        assertEq(usdc.balanceOf(provider) - p0, 98.5e6); // old 1% fee + 0.5% evaluator fee
    }

    function test_Quote() public view {
        (uint256 fee, uint256 evalFee, uint256 net, uint256 bond, uint256 arbFee, bool instant, uint32 v) =
            escrow.quote(100 * USDC, 0);
        assertEq(fee, 1 * USDC);
        assertEq(evalFee, USDC / 2);
        assertEq(net, 98.5e6);
        assertEq(bond, 5 * USDC);
        assertEq(arbFee, ARB_FEE);
        assertFalse(instant);
        assertEq(v, 1);
        (,,, bond,, instant,) = escrow.quote(1 * USDC, 1 * USDC);
        assertEq(bond, 1 * USDC);
        assertTrue(instant);
    }

    function test_NonexistentJob_Reverts() public {
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.JobNotFound.selector, 99));
        escrow.finalize(99);
    }
}
