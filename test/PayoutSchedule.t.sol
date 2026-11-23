// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {PayoutScheduleLib} from "../src/PayoutScheduleLib.sol";
import {IEvaluatorRegistry} from "../src/interfaces/IEvaluatorRegistry.sol";
import {IArbitrator} from "../src/interfaces/IArbitrator.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrantToken} from "./mocks/ReentrantToken.sol";
import {EvaluatorRegistry} from "../src/EvaluatorRegistry.sol";
import {MockArbitrator} from "../src/mocks/MockArbitrator.sol";
import {Defaults} from "../script/Defaults.sol";

/// @notice JobEscrow v0.6 payout schedules (AD-014 + docs/AD-014-amendments.md).
contract PayoutScheduleTest is BaseTest {
    bytes32 internal constant DOC = keccak256("schedule-doc");

    function setUp() public override {
        super.setUp();
        // Live config(2) values: fee 0, evalWindow 3600, challengeWindow 600.
        vm.prank(owner);
        escrow.setConfig(_liveConfig());
    }

    function _liveConfig() internal pure returns (JobEscrow.Config memory) {
        return JobEscrow.Config({
            instantThreshold: 1e6,
            minChallengeBond: 1e6,
            evalWindow: 3600,
            challengeWindow: 600,
            arbitrationTimeout: 2_592_000,
            challengeBondBps: 500,
            missedVerdictSlashBps: 1000,
            wrongVerdictSlashBps: 2500,
            materialDiffBps: 2000,
            feeBps: 0,
            failedChallengeEvaluatorShareBps: 5000,
            instantBondCoverBps: 10_000,
            evaluatorFeeBps: 0
        });
    }

    function _pack(uint16[] memory xs) internal pure returns (uint256) {
        return PayoutScheduleLib.packTable(xs);
    }

    function _linearTable() internal pure returns (uint256) {
        uint16[] memory xs = new uint16[](5);
        xs[0] = 0;
        xs[1] = 2500;
        xs[2] = 5000;
        xs[3] = 7500;
        xs[4] = 10_000;
        return _pack(xs);
    }

    function _linear() internal pure returns (JobEscrow.PayoutSchedule memory s) {
        s.docHash = DOC;
        s.requiredTotal = 4;
        s.bpsTable = _linearTable();
    }

    function _sched(bytes32 doc, uint8 n, uint256 table) internal pure returns (JobEscrow.PayoutSchedule memory s) {
        s.docHash = doc;
        s.requiredTotal = n;
        s.bpsTable = table;
    }

    function _openScheduled(uint256 amount) internal returns (uint256 id) {
        vm.prank(client);
        id = escrow.createAndFundScheduled(
            provider, evaluator, amount, uint64(block.timestamp + 3 days), SPEC, _linear()
        );
    }

    function _openSubmitScheduled(uint256 amount) internal returns (uint256 id) {
        id = _openScheduled(amount);
        vm.prank(provider);
        escrow.submit(id, DELIVERABLE);
    }

    function _passShortWindow() internal {
        vm.warp(block.timestamp + 600 + 1);
    }

    function counts(bool[] calldata required, PayoutScheduleLib.CriterionResult[] calldata results)
        external
        pure
        returns (uint8, uint8, uint16)
    {
        return PayoutScheduleLib.requiredCounts(required, results);
    }

    // ---------------- packing / counting (amendments 1–2) ----------------

    function test_PackTable_LinearFour_MatchesSpecConstant() public pure {
        assertEq(_linearTable(), 0x27101d4c138809c40000);
        assertEq(PayoutScheduleLib.entryAt(_linearTable(), 0), 0);
        assertEq(PayoutScheduleLib.entryAt(_linearTable(), 1), 2500);
        assertEq(PayoutScheduleLib.entryAt(_linearTable(), 2), 5000);
        assertEq(PayoutScheduleLib.entryAt(_linearTable(), 3), 7500);
        assertEq(PayoutScheduleLib.entryAt(_linearTable(), 4), 10_000);
    }

    function test_RequiredPass_ExcludesFailNotEvaluatedAndError() public pure {
        // criteria order: required, optional, required, required, required
        bool[] memory req = new bool[](5);
        req[0] = true;
        req[1] = false; // optional pass must be ignored
        req[2] = true;
        req[3] = true;
        req[4] = true;
        PayoutScheduleLib.CriterionResult[] memory r = new PayoutScheduleLib.CriterionResult[](5);
        r[0] = PayoutScheduleLib.CriterionResult.Pass;
        r[1] = PayoutScheduleLib.CriterionResult.Pass;
        r[2] = PayoutScheduleLib.CriterionResult.Fail;
        r[3] = PayoutScheduleLib.CriterionResult.NotEvaluated;
        r[4] = PayoutScheduleLib.CriterionResult.Error;
        (uint8 pass, uint8 total, uint16 mask) = PayoutScheduleLib.requiredCounts(req, r);
        assertEq(total, 4);
        assertEq(pass, 1); // only the first required row
        assertEq(mask, uint16(1)); // bit 0 only; optional does not occupy a bit
        assertEq(PayoutScheduleLib.requiredPassFromMask(mask, total), 1);
    }

    function test_RequiredCounts_CapsAt15() public {
        bool[] memory req = new bool[](16);
        PayoutScheduleLib.CriterionResult[] memory r = new PayoutScheduleLib.CriterionResult[](16);
        for (uint256 i = 0; i < 16; i++) {
            req[i] = true;
            r[i] = PayoutScheduleLib.CriterionResult.Pass;
        }
        vm.expectRevert(bytes("too many required"));
        this.counts(req, r);

        bool[] memory req15 = new bool[](15);
        PayoutScheduleLib.CriterionResult[] memory r15 = new PayoutScheduleLib.CriterionResult[](15);
        for (uint256 i = 0; i < 15; i++) {
            req15[i] = true;
            r15[i] = PayoutScheduleLib.CriterionResult.Pass;
        }
        (uint8 pass, uint8 total, uint16 mask) = PayoutScheduleLib.requiredCounts(req15, r15);
        assertEq(total, 15);
        assertEq(pass, 15);
        assertEq(mask, uint16((uint256(1) << 15) - 1));
    }

    function test_RequiredPass_AllPass_And_ZeroPass() public pure {
        bool[] memory req = new bool[](3);
        req[0] = true;
        req[1] = true;
        req[2] = true;
        PayoutScheduleLib.CriterionResult[] memory r = new PayoutScheduleLib.CriterionResult[](3);
        r[0] = PayoutScheduleLib.CriterionResult.Pass;
        r[1] = PayoutScheduleLib.CriterionResult.Pass;
        r[2] = PayoutScheduleLib.CriterionResult.Pass;
        (uint8 pass, uint8 total, uint16 mask) = PayoutScheduleLib.requiredCounts(req, r);
        assertEq(total, 3);
        assertEq(pass, 3);
        assertEq(mask, uint16(7));
        r[0] = PayoutScheduleLib.CriterionResult.Fail;
        r[1] = PayoutScheduleLib.CriterionResult.NotEvaluated;
        r[2] = PayoutScheduleLib.CriterionResult.Error;
        (pass, total, mask) = PayoutScheduleLib.requiredCounts(req, r);
        assertEq(total, 3);
        assertEq(pass, 0);
        assertEq(mask, uint16(0));
    }

    // ---------------- create validation ----------------

    function test_CreateScheduled_LinearTable_RoundTripAndEvent() public {
        JobEscrow.PayoutSchedule memory s = _linear();
        vm.expectEmit(true, false, false, true);
        emit JobEscrow.ScheduleCommitted(escrow.jobCount() + 1, s.docHash, s.requiredTotal, s.bpsTable);
        vm.prank(client);
        uint256 id =
            escrow.createAndFundScheduled(provider, evaluator, 500_000, uint64(block.timestamp + 3 days), SPEC, s);
        JobEscrow.PayoutSchedule memory g = escrow.getSchedule(id);
        assertEq(g.docHash, s.docHash);
        assertEq(g.requiredTotal, 4);
        assertEq(g.bpsTable, s.bpsTable);
        assertEq(uint256(escrow.getJob(id).state), uint256(JobEscrow.State.Funded));
        assertEq(escrow.getJob(id).amount, 500_000);
    }

    function test_CreateScheduled_RevertsInvalid() public {
        uint64 dl = uint64(block.timestamp + 3 days);
        JobEscrow.PayoutSchedule memory s = _linear();

        s.docHash = bytes32(0);
        vm.prank(client);
        vm.expectRevert(JobEscrow.InvalidSchedule.selector);
        escrow.createJobScheduled(provider, evaluator, 1e6, dl, SPEC, s);

        s = _linear();
        s.requiredTotal = 0;
        vm.prank(client);
        vm.expectRevert(JobEscrow.InvalidSchedule.selector);
        escrow.createJobScheduled(provider, evaluator, 1e6, dl, SPEC, s);

        s = _linear();
        s.requiredTotal = 16;
        vm.prank(client);
        vm.expectRevert(JobEscrow.InvalidSchedule.selector);
        escrow.createJobScheduled(provider, evaluator, 1e6, dl, SPEC, s);

        s = _linear();
        uint16[] memory xs = new uint16[](5);
        xs[0] = 0;
        xs[1] = 2500;
        xs[2] = 10_001;
        xs[3] = 10_001;
        xs[4] = 10_001;
        s.bpsTable = _pack(xs);
        vm.prank(client);
        vm.expectRevert(JobEscrow.InvalidSchedule.selector);
        escrow.createJobScheduled(provider, evaluator, 1e6, dl, SPEC, s);

        s = _linear();
        xs = new uint16[](5);
        xs[0] = 0;
        xs[1] = 5000;
        xs[2] = 2500; // decreasing
        xs[3] = 7500;
        xs[4] = 10_000;
        s.bpsTable = _pack(xs);
        vm.prank(client);
        vm.expectRevert(JobEscrow.InvalidSchedule.selector);
        escrow.createJobScheduled(provider, evaluator, 1e6, dl, SPEC, s);

        s = _linear();
        s.bpsTable = _linearTable() | (uint256(1) << (16 * 5)); // non-zero entry above n
        vm.prank(client);
        vm.expectRevert(JobEscrow.InvalidSchedule.selector);
        escrow.createJobScheduled(provider, evaluator, 1e6, dl, SPEC, s);
    }

    function test_UnscheduledGetSchedule_IsZero() public {
        vm.prank(client);
        uint256 id = escrow.createAndFund(provider, evaluator, 1e6, uint64(block.timestamp + 3 days), SPEC);
        // the above is from this contract, so it uses the current (live) config; still unscheduled
        JobEscrow.PayoutSchedule memory g = escrow.getSchedule(id);
        assertEq(g.docHash, bytes32(0));
        assertEq(g.requiredTotal, 0);
        assertEq(g.bpsTable, 0);
    }

    // ---------------- verdictScheduled math (boundaries + every mask) ----------------

    function test_VerdictScheduled_EveryMask_N4() public {
        for (uint16 mask = 0; mask < 16; mask++) {
            uint256 id = _openSubmitScheduled(500_000);
            uint8 pass = PayoutScheduleLib.requiredPassFromMask(mask, 4);
            uint16 expectBps = PayoutScheduleLib.entryAt(_linearTable(), pass);
            JobEscrow.Outcome expectOut = expectBps == 10_000
                ? JobEscrow.Outcome.Complete
                : (expectBps == 0 ? JobEscrow.Outcome.Reject : JobEscrow.Outcome.Partial);
            (JobEscrow.Outcome viewOut, uint16 viewBps) = escrow.scheduledPayout(id, mask);
            assertEq(uint256(viewOut), uint256(expectOut));
            assertEq(viewBps, expectBps);
            vm.prank(evaluator);
            escrow.verdictScheduled(id, mask, 4, pass, REASON);
            JobEscrow.Job memory j = escrow.getJob(id);
            assertEq(j.payoutBps, expectBps);
            assertEq(uint256(j.outcome), uint256(expectOut));
            assertEq(j.reasonHash, REASON);
        }
    }

    function test_VerdictScheduled_Mask0_Reject_ZeroPass() public {
        uint256 id = _openSubmitScheduled(500_000);
        vm.prank(evaluator);
        vm.expectEmit(true, false, false, true);
        emit JobEscrow.ScheduledVerdict(id, 0, 0, 0);
        escrow.verdictScheduled(id, 0, 4, 0, REASON);
        assertEq(uint256(escrow.getJob(id).state), uint256(JobEscrow.State.Rejected));
        assertEq(escrow.getJob(id).payoutBps, 0);
    }

    function test_VerdictScheduled_Mask7_Partial7500() public {
        uint256 id = _openSubmitScheduled(500_000);
        vm.prank(evaluator);
        escrow.verdictScheduled(id, 7, 4, 3, REASON); // 0b0111, 3 passes
        JobEscrow.Job memory j = escrow.getJob(id);
        assertEq(uint256(j.state), uint256(JobEscrow.State.Partial));
        assertEq(uint256(j.outcome), uint256(JobEscrow.Outcome.Partial));
        assertEq(j.payoutBps, 7500);
    }

    function test_VerdictScheduled_MaskF_Complete() public {
        uint256 id = _openSubmitScheduled(500_000);
        vm.prank(evaluator);
        escrow.verdictScheduled(id, 0xF, 4, 4, REASON);
        assertEq(uint256(escrow.getJob(id).state), uint256(JobEscrow.State.Completed));
        assertEq(escrow.getJob(id).payoutBps, 10_000);
    }

    function test_VerdictScheduled_PartialOnePass_And_AllButOne() public {
        uint256 id = _openSubmitScheduled(500_000);
        vm.prank(evaluator);
        escrow.verdictScheduled(id, 1, 4, 1, REASON);
        assertEq(escrow.getJob(id).payoutBps, 2500);

        id = _openSubmitScheduled(500_000);
        vm.prank(evaluator);
        escrow.verdictScheduled(id, 0xE, 4, 3, REASON); // 3 bits, still 7500
        assertEq(escrow.getJob(id).payoutBps, 7500);
    }

    // ---------------- reverts (amendment 3 + original) ----------------

    function test_VerdictScheduled_RequiredTotalMismatch_Reverts() public {
        uint256 id = _openSubmitScheduled(500_000);
        vm.prank(evaluator);
        vm.expectRevert(JobEscrow.RequiredTotalMismatch.selector);
        escrow.verdictScheduled(id, 7, 3, 3, REASON); // record says 3 required, job committed 4
        vm.prank(evaluator);
        vm.expectRevert(JobEscrow.RequiredTotalMismatch.selector);
        escrow.verdictScheduled(id, 7, 5, 3, REASON);
    }

    function test_VerdictScheduled_RequiredPassMismatch_Reverts() public {
        uint256 id = _openSubmitScheduled(500_000);
        // mask 7 has popcount 3; claiming 2 or 4 must revert
        vm.prank(evaluator);
        vm.expectRevert(JobEscrow.RequiredPassMismatch.selector);
        escrow.verdictScheduled(id, 7, 4, 2, REASON);
        vm.prank(evaluator);
        vm.expectRevert(JobEscrow.RequiredPassMismatch.selector);
        escrow.verdictScheduled(id, 7, 4, 4, REASON);
        // mask 0, claiming 1
        vm.prank(evaluator);
        vm.expectRevert(JobEscrow.RequiredPassMismatch.selector);
        escrow.verdictScheduled(id, 0, 4, 1, REASON);
    }

    function test_VerdictScheduled_InvalidPassMask_Reverts() public {
        uint256 id = _openSubmitScheduled(500_000);
        vm.prank(evaluator);
        vm.expectRevert(JobEscrow.InvalidPassMask.selector);
        escrow.verdictScheduled(id, 0x10, 4, 1, REASON); // bit 4 set, n=4
    }

    function test_VerdictScheduled_ZeroReason_WrongCaller_WrongState_Window_NotScheduled() public {
        uint256 id = _openSubmitScheduled(500_000);
        vm.prank(evaluator);
        vm.expectRevert(JobEscrow.ZeroHash.selector);
        escrow.verdictScheduled(id, 7, 4, 3, bytes32(0));

        vm.prank(outsider);
        vm.expectRevert(JobEscrow.Unauthorized.selector);
        escrow.verdictScheduled(id, 7, 4, 3, REASON);

        vm.prank(evaluator);
        vm.warp(block.timestamp + 3600 + 1);
        vm.expectRevert(JobEscrow.EvalWindowClosed.selector);
        escrow.verdictScheduled(id, 7, 4, 3, REASON);

        // unscheduled
        vm.warp(block.timestamp - 3600 - 1);
        vm.prank(client);
        uint256 plain =
            escrow.createAndFund(provider, evaluator, 1e6, uint64(block.timestamp + 3 days), keccak256("plain"));
        vm.prank(provider);
        escrow.submit(plain, DELIVERABLE);
        vm.prank(evaluator);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.NotScheduled.selector, plain));
        escrow.verdictScheduled(plain, 0, 0, 0, REASON);

        // wrong state: already verdicted scheduled job
        uint256 id2 = _openSubmitScheduled(500_000);
        vm.prank(evaluator);
        escrow.verdictScheduled(id2, 7, 4, 3, REASON);
        vm.prank(evaluator);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.WrongState.selector, JobEscrow.State.Partial));
        escrow.verdictScheduled(id2, 7, 4, 3, REASON);
    }

    function test_PlainVerdictAndAliases_OnScheduledJob_Revert() public {
        uint256 id = _openSubmitScheduled(500_000);
        vm.prank(evaluator);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.ScheduledJob.selector, id));
        escrow.verdict(id, JobEscrow.Outcome.Partial, 7500, REASON);
        vm.prank(evaluator);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.ScheduledJob.selector, id));
        escrow.complete(id, REASON);
        vm.prank(evaluator);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.ScheduledJob.selector, id));
        escrow.reject(id, REASON);
    }

    // ---------------- instant path disabled for scheduled ----------------

    function test_ScheduledJob_WithBond_DoesNotInstantRelease() public {
        uint256 id;
        vm.prank(client);
        id = escrow.createAndFundScheduled(provider, evaluator, 1e6, uint64(block.timestamp + 3 days), SPEC, _linear());
        vm.prank(provider);
        escrow.postProviderBond(id, 1e6);
        vm.prank(provider);
        escrow.submit(id, DELIVERABLE);
        JobEscrow.Job memory j = escrow.getJob(id);
        assertEq(uint256(j.state), uint256(JobEscrow.State.Submitted));
        assertFalse(j.instant);
        assertEq(usdc.balanceOf(address(escrow)), 2e6); // amount + bond still locked
    }

    function test_UnscheduledJob_WithBond_StillInstant() public {
        uint256 id;
        vm.prank(client);
        id = escrow.createAndFund(provider, evaluator, 1e6, uint64(block.timestamp + 3 days), keccak256("u"));
        vm.prank(provider);
        escrow.postProviderBond(id, 1e6);
        uint256 before = usdc.balanceOf(provider);
        vm.prank(provider);
        escrow.submit(id, DELIVERABLE);
        assertEq(uint256(escrow.getJob(id).state), uint256(JobEscrow.State.Completed));
        assertTrue(escrow.getJob(id).instant);
        // fee 0 under live config, so provider received the full 1e6 (bond still in escrow until finalize)
        assertEq(usdc.balanceOf(provider), before + 1e6);
    }

    // ---------------- finalize: refund remainder, fees 0, funds conserved ----------------

    function test_Finalize_Partial7500_RefundsRemainder_FeeZero() public {
        uint256 amount = 500_000;
        vm.prank(client);
        uint256 id = escrow.createAndFundScheduled(
            provider, evaluator, amount, uint64(block.timestamp + 3 days), SPEC, _linear()
        );
        vm.prank(provider);
        escrow.postProviderBond(id, 100_000);
        vm.prank(provider);
        escrow.submit(id, DELIVERABLE);

        uint256 c0 = usdc.balanceOf(client);
        uint256 p0 = usdc.balanceOf(provider);
        uint256 t0 = usdc.balanceOf(treasury);
        uint256 e0 = usdc.balanceOf(evaluator);
        uint256 escrow0 = usdc.balanceOf(address(escrow));

        vm.prank(evaluator);
        escrow.verdictScheduled(id, 7, 4, 3, REASON);
        _passShortWindow();
        escrow.finalize(id);

        assertEq(uint256(escrow.getJob(id).state), uint256(JobEscrow.State.Settled));
        assertEq(usdc.balanceOf(provider), p0 + 375_000 + 100_000); // 75% + bond
        assertEq(usdc.balanceOf(client), c0 + 125_000);
        assertEq(usdc.balanceOf(treasury), t0); // feeBps 0
        assertEq(usdc.balanceOf(evaluator), e0); // evaluatorFeeBps 0
        assertEq(usdc.balanceOf(address(escrow)), escrow0 - amount - 100_000);
        // conservation: all token that left escrow landed on client+provider
        assertEq(
            (usdc.balanceOf(client) - c0) + (usdc.balanceOf(provider) - p0) + (usdc.balanceOf(treasury) - t0)
                + (usdc.balanceOf(evaluator) - e0),
            escrow0 - usdc.balanceOf(address(escrow))
        );
        assertEq(registry.availableExposure(evaluator) > 0, true);
    }

    function test_Finalize_Reject_RefundsAllToClient() public {
        uint256 amount = 500_000;
        uint256 id = _openSubmitScheduled(amount);
        uint256 c0 = usdc.balanceOf(client);
        uint256 p0 = usdc.balanceOf(provider);
        vm.prank(evaluator);
        escrow.verdictScheduled(id, 0, 4, 0, REASON);
        _passShortWindow();
        escrow.finalize(id);
        assertEq(usdc.balanceOf(client), c0 + amount);
        assertEq(usdc.balanceOf(provider), p0);
    }

    function test_Finalize_Complete_PaysProviderInFull() public {
        uint256 amount = 500_000;
        uint256 id = _openSubmitScheduled(amount);
        uint256 c0 = usdc.balanceOf(client);
        uint256 p0 = usdc.balanceOf(provider);
        vm.prank(evaluator);
        escrow.verdictScheduled(id, 0xF, 4, 4, REASON);
        _passShortWindow();
        escrow.finalize(id);
        assertEq(usdc.balanceOf(provider), p0 + amount);
        assertEq(usdc.balanceOf(client), c0);
    }

    function test_Finalize_BeforeChallengeWindow_Reverts() public {
        uint256 id = _openSubmitScheduled(500_000);
        vm.prank(evaluator);
        escrow.verdictScheduled(id, 7, 4, 3, REASON);
        vm.expectRevert(JobEscrow.ChallengeWindowOpen.selector);
        escrow.finalize(id);
    }

    // ---------------- arbitration constrained to the table ----------------

    function test_Rule_TableValue_Settles_OutsideTable_Reverts() public {
        uint256 id = _openSubmitScheduled(500_000);
        vm.prank(evaluator);
        escrow.verdictScheduled(id, 7, 4, 3, REASON); // 7500
        vm.prank(client);
        escrow.challenge(id, keccak256("c"));

        // 4000 is not in {0,2500,5000,7500,10000}
        vm.prank(address(arb));
        vm.expectRevert(JobEscrow.InvalidPayout.selector);
        escrow.rule(id, 4000);

        // 5000 is in the table; |7500-5000|=2500 > materialDiff 2000 => overturned
        vm.prank(address(arb));
        escrow.rule(id, 5000);
        assertEq(uint256(escrow.getJob(id).state), uint256(JobEscrow.State.Settled));
        assertEq(escrow.getJob(id).payoutBps, 5000);
    }

    function test_ResolveStaleDispute_SettlesPerVerdict() public {
        uint256 id = _openSubmitScheduled(500_000);
        uint256 p0 = usdc.balanceOf(provider);
        uint256 c0 = usdc.balanceOf(client);
        vm.prank(evaluator);
        escrow.verdictScheduled(id, 7, 4, 3, REASON);
        vm.prank(client);
        escrow.challenge(id, keccak256("c"));
        vm.warp(block.timestamp + 2_592_000);
        escrow.resolveStaleDispute(id);
        assertEq(uint256(escrow.getJob(id).state), uint256(JobEscrow.State.Settled));
        assertEq(escrow.getJob(id).payoutBps, 7500);
        assertEq(usdc.balanceOf(provider), p0 + 375_000);
        assertEq(usdc.balanceOf(client), c0 + 125_000);
    }

    // ---------------- fuzz: valid table + mask, conservation ----------------

    function testFuzz_ScheduledPayout_MatchesTable(uint16 raw0, uint16 raw1, uint16 raw2, uint16 raw3, uint16 mask)
        public
    {
        uint16[4] memory steps;
        steps[0] = uint16(bound(raw0, 0, 10_000));
        steps[1] = uint16(bound(raw1, steps[0], 10_000));
        steps[2] = uint16(bound(raw2, steps[1], 10_000));
        steps[3] = uint16(bound(raw3, steps[2], 10_000));
        uint16[] memory xs = new uint16[](4);
        xs[0] = steps[0];
        xs[1] = steps[1];
        xs[2] = steps[2];
        xs[3] = steps[3];
        JobEscrow.PayoutSchedule memory s = _sched(DOC, 3, _pack(xs));
        uint256 amount = 400_000;
        vm.prank(client);
        uint256 id = escrow.createAndFundScheduled(
            provider, evaluator, amount, uint64(block.timestamp + 3 days), keccak256(abi.encode(mask, steps)), s
        );
        mask = uint16(uint256(mask) & 7); // restrict to n=3
        uint8 pass = PayoutScheduleLib.requiredPassFromMask(mask, 3);
        uint16 bps = PayoutScheduleLib.entryAt(s.bpsTable, pass);

        uint256 c0 = usdc.balanceOf(client);
        uint256 p0 = usdc.balanceOf(provider);
        uint256 t0 = usdc.balanceOf(treasury);
        uint256 e0 = usdc.balanceOf(evaluator);
        uint256 x0 = usdc.balanceOf(address(escrow));

        vm.prank(provider);
        escrow.submit(id, DELIVERABLE);
        vm.prank(evaluator);
        escrow.verdictScheduled(id, mask, 3, pass, REASON);
        assertEq(escrow.getJob(id).payoutBps, bps);
        _passShortWindow();
        escrow.finalize(id);

        uint256 paid = (amount * uint256(bps)) / 10_000;
        assertEq(usdc.balanceOf(provider), p0 + paid);
        assertEq(usdc.balanceOf(client), c0 + (amount - paid));
        assertEq(usdc.balanceOf(treasury), t0);
        assertEq(usdc.balanceOf(evaluator), e0);
        assertEq(usdc.balanceOf(address(escrow)), x0 - amount);
    }

    // ---------------- reentrancy: finalize during payout is blocked ----------------

    function test_Reentrancy_FinalizeDuringScheduledPayout_Blocked() public {
        ReentrantToken tok = new ReentrantToken();
        uint64 n = vm.getNonce(address(this));
        address[] memory slashers = new address[](1);
        slashers[0] = vm.computeCreateAddress(address(this), n + 1);
        EvaluatorRegistry reg = new EvaluatorRegistry(
            IERC20(address(tok)), Defaults.registryConfig(treasury), owner, slashers, Defaults.SLASHER_TIMELOCK
        );
        JobEscrow e = new JobEscrow(
            IERC20(address(tok)),
            IEvaluatorRegistry(address(reg)),
            treasury,
            IArbitrator(address(arb)),
            _liveConfig(),
            owner, owner, type(uint256).max, type(uint256).max
        );
        tok.mint(client, 1_000_000);
        tok.mint(evaluator, 200_000_000);
        vm.startPrank(evaluator);
        tok.approve(address(reg), type(uint256).max);
        reg.stake(100_000_000);
        vm.stopPrank();
        vm.startPrank(client);
        tok.approve(address(e), type(uint256).max);
        uint256 id =
            e.createAndFundScheduled(provider, evaluator, 500_000, uint64(block.timestamp + 3 days), SPEC, _linear());
        vm.stopPrank();
        vm.prank(provider);
        e.submit(id, DELIVERABLE);
        vm.prank(evaluator);
        e.verdictScheduled(id, 7, 4, 3, REASON);
        _passShortWindow();
        tok.arm(address(e), address(e), abi.encodeWithSelector(JobEscrow.finalize.selector, id));
        e.finalize(id);
        assertTrue(tok.attempted());
        assertFalse(tok.lastOk());
        assertEq(uint256(e.getJob(id).state), uint256(JobEscrow.State.Settled));
    }
}
