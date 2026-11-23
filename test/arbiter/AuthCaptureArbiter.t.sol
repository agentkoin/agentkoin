// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {MockArbitrator} from "../../src/mocks/MockArbitrator.sol";
import {EvaluatorRegistry} from "../../src/EvaluatorRegistry.sol";
import {IEvaluatorRegistry} from "../../src/interfaces/IEvaluatorRegistry.sol";
import {IArbitrator} from "../../src/interfaces/IArbitrator.sol";
import {PayoutScheduleLib} from "../../src/PayoutScheduleLib.sol";
import {IAuthCaptureEscrow} from "../../src/arbiter/IAuthCaptureEscrow.sol";
import {AgentKoinAuthCaptureArbiter as Arb} from "../../src/arbiter/AgentKoinAuthCaptureArbiter.sol";
import {AuthCaptureEscrow} from "./vendor/commerce-payments/src/AuthCaptureEscrow.sol";
import {ERC3009PaymentCollector} from "./vendor/commerce-payments/src/collectors/ERC3009PaymentCollector.sol";
import {ArbiterTestBase} from "./ArbiterTestLib.sol";

/// Unit tests: real (vendored, unmodified) Base commerce-payments AuthCaptureEscrow v1.1 +
/// ERC3009PaymentCollector, MockUSDC (EIP-3009), real EvaluatorRegistry, MockArbitrator.
contract AuthCaptureArbiterTest is ArbiterTestBase {
    uint256 constant U = 1e6;
    uint120 constant AMOUNT = 1e6; // 1 USDC = testnet cap
    uint256 constant ARB_FEE = 0.3e6;
    uint256 constant BOND = 0.5e6;

    MockUSDC usdc;
    AuthCaptureEscrow acEscrow;
    IAuthCaptureEscrow escrow;
    ERC3009PaymentCollector collector;
    EvaluatorRegistry registry;
    MockArbitrator arb;
    Arb arbiter;

    uint256 payerKey = 0xA11CE;
    address payer;
    address receiver = makeAddr("receiver");
    address evaluator = makeAddr("evaluator");
    address facilitator = makeAddr("facilitator");
    address outsider = makeAddr("outsider");
    address treasury = makeAddr("treasury");
    address owner = makeAddr("owner");

    uint48 preExp;
    uint48 submitBy;
    uint48 authExp;
    uint32 constant EVAL = 6 hours;

    function _cfg() internal pure returns (Arb.Config memory) {
        return Arb.Config({
            evalWindow: 1 hours,
            challengeWindow: 10 minutes,
            rulingWindow: 1 days,
            minMarginSeconds: 1 hours,
            missedVerdictSlashBps: 1000,
            wrongVerdictSlashBps: 2500,
            materialDiffBps: 2000,
            minChallengeBond: BOND
        });
    }

    function _newArbiter(IArbitrator a) internal returns (Arb x) {
        x = new Arb(escrow, IEvaluatorRegistry(address(registry)), a, IERC20(address(usdc)), AMOUNT, _cfg());
        vm.prank(owner);
        registry.proposeSlasher(address(x), true);
        registry.executeSlasher(address(x));
    }

    function setUp() public {
        vm.warp(1_800_000_000);
        payer = vm.addr(payerKey);
        usdc = new MockUSDC();
        acEscrow = new AuthCaptureEscrow();
        escrow = IAuthCaptureEscrow(address(acEscrow));
        collector = new ERC3009PaymentCollector(address(acEscrow), address(0xCA11));
        registry = new EvaluatorRegistry(
            IERC20(address(usdc)),
            EvaluatorRegistry.Config({
                minStake: 2 * U,
                unbondingPeriod: 7 days,
                exposureMultiplier: 5,
                slashHarmedShareBps: 5000,
                treasury: treasury
            }),
            owner,
            new address[](0),
            0 // slasher timelock 0 in unit tests only
        );
        arb = new MockArbitrator(address(this), ARB_FEE);
        arbiter = _newArbiter(IArbitrator(address(arb)));

        usdc.mint(payer, 10 * U);
        usdc.mint(receiver, 10 * U);
        usdc.mint(evaluator, 2 * U);
        vm.startPrank(evaluator);
        usdc.approve(address(registry), type(uint256).max);
        registry.stake(2 * U);
        vm.stopPrank();
        vm.prank(payer);
        usdc.approve(address(arbiter), type(uint256).max);
        vm.prank(receiver);
        usdc.approve(address(arbiter), type(uint256).max);

        preExp = uint48(block.timestamp + 10 minutes);
        submitBy = uint48(block.timestamp + 1 hours);
        authExp = uint48(block.timestamp + 3 days);
    }

    // ---------------- helpers ----------------

    function _payment(Arb a, uint256 nonce)
        internal
        view
        returns (IAuthCaptureEscrow.PaymentInfo memory p, Arb.Terms memory t)
    {
        t = _terms(evaluator, submitBy, EVAL);
        p = _paymentInfo(a, payer, receiver, address(usdc), AMOUNT, preExp, authExp, t, nonce);
    }

    function _authorize(Arb a, IAuthCaptureEscrow.PaymentInfo memory p) internal returns (bytes32) {
        bytes memory sig = _sign3009(escrow, address(usdc), payerKey, address(collector), p);
        vm.prank(facilitator); // permissionless collect wrapper, as an x402 facilitator relays it
        a.authorize(p, p.maxAmount, address(collector), sig);
        return escrow.getHash(p);
    }

    function _toSubmitted(Arb a) internal returns (IAuthCaptureEscrow.PaymentInfo memory p, bytes32 h) {
        Arb.Terms memory t;
        (p, t) = _payment(a, 1);
        h = _authorize(a, p);
        vm.prank(evaluator);
        a.bindTerms(p, t, 1);
        vm.prank(receiver);
        a.submit(p, keccak256("deliverable"), RD);
    }

    function _toVerdict(Arb a, uint16 mask) internal returns (IAuthCaptureEscrow.PaymentInfo memory p, bytes32 h) {
        (p, h) = _toSubmitted(a);
        uint8 rp = PayoutScheduleLib.requiredPassFromMask(mask, 4);
        vm.prank(evaluator);
        a.verdictScheduled(p, mask, 4, rp, RD, keccak256("receipt"));
    }

    function _held(bytes32 h) internal view returns (uint120 c) {
        (, c,) = escrow.paymentState(h);
    }

    function _vendor(IAuthCaptureEscrow.PaymentInfo memory p)
        internal
        pure
        returns (AuthCaptureEscrow.PaymentInfo memory)
    {
        return abi.decode(abi.encode(p), (AuthCaptureEscrow.PaymentInfo));
    }

    function _assertNoDust(Arb a) internal view {
        assertEq(usdc.balanceOf(address(a)), 0, "no token rests in the arbiter");
        assertEq(usdc.balanceOf(acEscrow.getTokenStore(address(a))), 0, "nothing left held");
    }

    // ---------------- constructor ----------------

    function test_Constructor_RejectsV10EscrowAndBadConfig() public {
        IEvaluatorRegistry r = IEvaluatorRegistry(address(registry));
        vm.expectRevert(Arb.UnsupportedEscrow.selector);
        new Arb(
            IAuthCaptureEscrow(0xBdEA0D1bcC5966192B070Fdf62aB4EF5b4420cff),
            r,
            IArbitrator(address(0)),
            IERC20(address(usdc)),
            AMOUNT,
            _cfg()
        );
        Arb.Config memory c = _cfg();
        c.minMarginSeconds = 0;
        vm.expectRevert(Arb.InvalidConfig.selector);
        new Arb(escrow, r, IArbitrator(address(0)), IERC20(address(usdc)), AMOUNT, c);
        vm.expectRevert(Arb.ZeroAddress.selector);
        new Arb(escrow, r, IArbitrator(address(0)), IERC20(address(0)), AMOUNT, _cfg());
    }

    // ---------------- collect ----------------

    function test_Authorize_PermissionlessForward_RecordsPayment() public {
        (IAuthCaptureEscrow.PaymentInfo memory p,) = _payment(arbiter, 1);
        bytes32 h = _authorize(arbiter, p);
        assertEq(_held(h), AMOUNT);
        assertEq(usdc.balanceOf(payer), 10 * U - AMOUNT);
        assertEq(usdc.balanceOf(address(arbiter)), 0);
        Arb.Payment memory rec = arbiter.getPayment(h);
        assertEq(uint8(rec.state), uint8(Arb.State.Authorized));
        assertEq(rec.amount, AMOUNT);
        assertEq(arbiter.getPaymentInfo(h).salt, p.salt);
    }

    function test_Charge_AlwaysReverts() public {
        (IAuthCaptureEscrow.PaymentInfo memory p,) = _payment(arbiter, 1);
        vm.expectRevert(Arb.ChargeNotSupported.selector);
        arbiter.charge(p, AMOUNT, address(collector), "", 0, address(0));
    }

    function test_Authorize_TypedErrors() public {
        IAuthCaptureEscrow.PaymentInfo memory p;
        (p,) = _payment(arbiter, 1);
        p.operator = outsider;
        vm.expectRevert(Arb.WrongOperator.selector);
        arbiter.authorize(p, AMOUNT, address(collector), "");

        (p,) = _payment(arbiter, 1);
        p.token = address(0xBEEF);
        vm.expectRevert(Arb.TokenNotAllowed.selector);
        arbiter.authorize(p, AMOUNT, address(collector), "");

        (p,) = _payment(arbiter, 1);
        vm.expectRevert(Arb.AmountTooHigh.selector);
        arbiter.authorize(p, AMOUNT + 1, address(collector), "");

        (p,) = _payment(arbiter, 1);
        p.maxFeeBps = 1;
        vm.expectRevert(Arb.FeeNotZero.selector);
        arbiter.authorize(p, AMOUNT, address(collector), "");

        (p,) = _payment(arbiter, 1);
        p.feeReceiver = outsider;
        vm.expectRevert(Arb.FeeNotZero.selector);
        arbiter.authorize(p, AMOUNT, address(collector), "");

        (p,) = _payment(arbiter, 1);
        p.refundExpiry = authExp + 1;
        vm.expectRevert(Arb.RefundExpiryMismatch.selector);
        arbiter.authorize(p, AMOUNT, address(collector), "");

        // floor lifecycle (1h eval + 10m challenge + 1d ruling + 1h margin) cannot fit
        (p,) = _payment(arbiter, 1);
        p.authorizationExpiry = uint48(block.timestamp + 1 days);
        p.refundExpiry = p.authorizationExpiry;
        vm.expectRevert(Arb.DeadlineTooShort.selector);
        arbiter.authorize(p, AMOUNT, address(collector), "");
    }

    // ---------------- bind ----------------

    function test_BindTerms_TypedErrors() public {
        (IAuthCaptureEscrow.PaymentInfo memory p, Arb.Terms memory t) = _payment(arbiter, 1);
        _authorize(arbiter, p);

        vm.prank(evaluator);
        vm.expectRevert(Arb.SaltMismatch.selector);
        arbiter.bindTerms(p, t, 2);

        Arb.Terms memory other = _terms(evaluator, submitBy, EVAL + 1);
        vm.prank(evaluator);
        vm.expectRevert(Arb.SaltMismatch.selector);
        arbiter.bindTerms(p, other, 1);

        vm.prank(outsider);
        vm.expectRevert(Arb.Unauthorized.selector);
        arbiter.bindTerms(p, t, 1);

        // evaluator == receiver (salt committed to it)
        _bindExpect(_terms(receiver, submitBy, EVAL), 10, receiver, Arb.EvaluatorConflict.selector);
        // inactive evaluator
        _bindExpect(_terms(outsider, submitBy, EVAL), 11, outsider, Arb.EvaluatorInactive.selector);
        // evalWindow below floor
        _bindExpect(_terms(evaluator, submitBy, 59 minutes), 12, evaluator, Arb.InvalidTerms.selector);
        // non-monotone table
        Arb.Terms memory bad = _terms(evaluator, submitBy, EVAL);
        bad.bpsTable = 0x09c42710; // [10000, 2500]
        _bindExpect(bad, 13, evaluator, Arb.InvalidTerms.selector);
        // windows do not fit before authorizationExpiry
        _bindExpect(_terms(evaluator, uint48(authExp - 1 days), EVAL), 14, evaluator, Arb.DeadlineTooShort.selector);

        // submitBy already passed
        vm.warp(submitBy + 1);
        vm.prank(evaluator);
        vm.expectRevert(Arb.SubmitWindowClosed.selector);
        arbiter.bindTerms(p, t, 1);
    }

    function _bindExpect(Arb.Terms memory t, uint256 nonce, address caller, bytes4 err) internal {
        IAuthCaptureEscrow.PaymentInfo memory p =
            _paymentInfo(arbiter, payer, receiver, address(usdc), AMOUNT, preExp, authExp, t, nonce);
        _authorize(arbiter, p);
        vm.prank(caller);
        vm.expectRevert(err);
        arbiter.bindTerms(p, t, nonce);
    }

    function test_BindTerms_LocksExposure_NotSlasherReverts() public {
        (IAuthCaptureEscrow.PaymentInfo memory p, Arb.Terms memory t) = _payment(arbiter, 1);
        bytes32 h = _authorize(arbiter, p);
        vm.prank(evaluator);
        arbiter.bindTerms(p, t, 1);
        assertEq(registry.evaluatorInfo(evaluator).exposure, AMOUNT);
        assertEq(uint8(arbiter.getPayment(h).state), uint8(Arb.State.Bound));
        assertEq(arbiter.getPayment(h).bindingMode, 1);

        Arb rogue = new Arb(
            escrow,
            IEvaluatorRegistry(address(registry)),
            IArbitrator(address(0)),
            IERC20(address(usdc)),
            AMOUNT,
            _cfg()
        );
        (p, t) = _payment(rogue, 2);
        _authorize(rogue, p);
        vm.prank(evaluator);
        vm.expectRevert(EvaluatorRegistry.NotSlasher.selector);
        rogue.bindTerms(p, t, 2);
    }

    // ---------------- verdict -> finalize ----------------

    function test_HappyPath_Mask15_Full() public {
        (IAuthCaptureEscrow.PaymentInfo memory p, bytes32 h) = _toVerdict(arbiter, 0xF);
        assertEq(arbiter.getPayment(h).payoutBps, 10_000);
        vm.expectRevert(Arb.ChallengeWindowOpen.selector);
        arbiter.finalize(p);
        vm.warp(block.timestamp + 10 minutes + 1);
        vm.prank(outsider);
        arbiter.finalize(p);
        assertEq(usdc.balanceOf(receiver), 10 * U + AMOUNT);
        assertEq(usdc.balanceOf(payer), 10 * U - AMOUNT);
        assertEq(registry.evaluatorInfo(evaluator).exposure, 0);
        assertEq(registry.evaluatorInfo(evaluator).openJobs, 0);
        assertEq(uint8(arbiter.getPayment(h).state), uint8(Arb.State.Finalized));
        _assertNoDust(arbiter);
    }

    function test_PartialPath_Job2Shape_Mask7_7500() public {
        (IAuthCaptureEscrow.PaymentInfo memory p, bytes32 h) = _toVerdict(arbiter, 0x7);
        assertEq(arbiter.getPayment(h).payoutBps, 7500);
        vm.warp(block.timestamp + 10 minutes + 1);
        arbiter.finalize(p);
        assertEq(usdc.balanceOf(receiver), 10 * U + 0.75e6);
        assertEq(usdc.balanceOf(payer), 10 * U - 0.75e6);
        (,, uint120 refundable) = escrow.paymentState(h);
        assertEq(refundable, 0.75e6);
        _assertNoDust(arbiter);
    }

    function test_Reject_Mask0_VoidOnly() public {
        (IAuthCaptureEscrow.PaymentInfo memory p,) = _toVerdict(arbiter, 0);
        vm.warp(block.timestamp + 10 minutes + 1);
        arbiter.finalize(p);
        assertEq(usdc.balanceOf(receiver), 10 * U);
        assertEq(usdc.balanceOf(payer), 10 * U);
        _assertNoDust(arbiter);
    }

    /// AD-014 amendment: `error` is not `pass`.
    function test_ErrorCriterion_CountsAsNotPass() public {
        (IAuthCaptureEscrow.PaymentInfo memory p, bytes32 h) = _toSubmitted(arbiter);
        bool[] memory req = new bool[](4);
        req[0] = req[1] = req[2] = req[3] = true;
        PayoutScheduleLib.CriterionResult[] memory res = new PayoutScheduleLib.CriterionResult[](4);
        res[1] = PayoutScheduleLib.CriterionResult.Error;
        (uint8 rp, uint8 rt, uint16 mask) = PayoutScheduleLib.requiredCounts(req, res);
        assertEq(rp, 3);
        vm.prank(evaluator);
        arbiter.verdictScheduled(p, mask, rt, rp, RD, keccak256("r"));
        assertEq(arbiter.getPayment(h).payoutBps, 7500);
    }

    function test_Verdict_TypedErrors() public {
        (IAuthCaptureEscrow.PaymentInfo memory p,) = _toSubmitted(arbiter);
        vm.prank(outsider);
        vm.expectRevert(Arb.Unauthorized.selector);
        arbiter.verdictScheduled(p, 0xF, 4, 4, RD, keccak256("r"));
        vm.startPrank(evaluator);
        vm.expectRevert(Arb.RequiredTotalMismatch.selector);
        arbiter.verdictScheduled(p, 0x7, 3, 3, RD, keccak256("r"));
        vm.expectRevert(Arb.InvalidPassMask.selector);
        arbiter.verdictScheduled(p, 0x1F, 4, 4, RD, keccak256("r"));
        vm.expectRevert(Arb.RequiredPassMismatch.selector);
        arbiter.verdictScheduled(p, 0x3, 4, 3, RD, keccak256("r"));
        vm.expectRevert(Arb.ZeroHash.selector);
        arbiter.verdictScheduled(p, 0xF, 4, 4, RD, bytes32(0));
        vm.warp(block.timestamp + EVAL + 1);
        vm.expectRevert(Arb.EvalWindowClosed.selector);
        arbiter.verdictScheduled(p, 0xF, 4, 4, RD, keccak256("r"));
        vm.stopPrank();
    }

    function test_Submit_OnlyReceiver_BeforeSubmitBy() public {
        (IAuthCaptureEscrow.PaymentInfo memory p, Arb.Terms memory t) = _payment(arbiter, 1);
        _authorize(arbiter, p);
        vm.prank(evaluator);
        arbiter.bindTerms(p, t, 1);
        vm.prank(payer);
        vm.expectRevert(Arb.Unauthorized.selector);
        arbiter.submit(p, keccak256("d"), RD);
        vm.warp(submitBy + 1);
        vm.prank(receiver);
        vm.expectRevert(Arb.SubmitWindowClosed.selector);
        arbiter.submit(p, keccak256("d"), RD);
    }

    // ---------------- liveness ----------------

    function test_MissedVerdict_FullVoidAndSlash() public {
        (IAuthCaptureEscrow.PaymentInfo memory p, bytes32 h) = _toSubmitted(arbiter);
        vm.expectRevert(Arb.EvalWindowOpen.selector);
        arbiter.timeoutRelease(p);
        vm.warp(block.timestamp + EVAL + 1);
        vm.prank(outsider);
        arbiter.timeoutRelease(p);
        uint256 slash = (2 * U * 1000) / 10_000; // 0.2 USDC, as job 2
        assertEq(registry.stakeOf(evaluator), 2 * U - slash);
        assertEq(usdc.balanceOf(receiver), 10 * U + slash / 2, "harmed party = receiver");
        assertEq(usdc.balanceOf(treasury), slash / 2);
        assertEq(usdc.balanceOf(payer), 10 * U, "full refund");
        assertEq(registry.evaluatorInfo(evaluator).openJobs, 0);
        assertEq(uint8(arbiter.getPayment(h).state), uint8(Arb.State.Voided));
        _assertNoDust(arbiter);
    }

    function test_VoidUnbound_AndVoidNoSubmit() public {
        (IAuthCaptureEscrow.PaymentInfo memory p, Arb.Terms memory t) = _payment(arbiter, 1);
        _authorize(arbiter, p);
        vm.expectRevert(Arb.SubmitWindowOpen.selector);
        arbiter.voidUnbound(p, t, 1);
        vm.warp(submitBy + 1);
        vm.expectRevert(Arb.SaltMismatch.selector);
        arbiter.voidUnbound(p, t, 2);
        arbiter.voidUnbound(p, t, 1);
        assertEq(usdc.balanceOf(payer), 10 * U);

        vm.warp(1_800_000_000);
        (p, t) = _payment(arbiter, 2);
        _authorize(arbiter, p);
        vm.prank(evaluator);
        arbiter.bindTerms(p, t, 2);
        vm.expectRevert(Arb.SubmitWindowOpen.selector);
        arbiter.voidNoSubmit(p);
        vm.warp(submitBy + 1);
        arbiter.voidNoSubmit(p);
        assertEq(usdc.balanceOf(payer), 10 * U);
        assertEq(registry.stakeOf(evaluator), 2 * U, "no slash");
        assertEq(registry.evaluatorInfo(evaluator).openJobs, 0);
        _assertNoDust(arbiter);
    }

    function test_AfterAuthExpiry_PayerReclaims_FinalizeReleasesWithoutCapture() public {
        (IAuthCaptureEscrow.PaymentInfo memory p, bytes32 h) = _toVerdict(arbiter, 0xF);
        vm.warp(authExp);
        vm.prank(payer);
        acEscrow.reclaim(_vendor(p));
        assertEq(usdc.balanceOf(payer), 10 * U);
        arbiter.finalize(p); // does not revert; releases exposure, captures nothing
        assertEq(usdc.balanceOf(receiver), 10 * U);
        assertEq(registry.evaluatorInfo(evaluator).openJobs, 0);
        assertEq(uint8(arbiter.getPayment(h).state), uint8(Arb.State.Finalized));
    }

    function test_AfterAuthExpiry_FinalizeVoidsHeldToPayer() public {
        (IAuthCaptureEscrow.PaymentInfo memory p,) = _toVerdict(arbiter, 0xF);
        vm.warp(authExp + 1);
        arbiter.finalize(p);
        assertEq(usdc.balanceOf(payer), 10 * U);
        assertEq(usdc.balanceOf(receiver), 10 * U);
        _assertNoDust(arbiter);
    }

    // ---------------- challenge ----------------

    function test_Challenge_NoArbitrator_Disabled() public {
        Arb noArb = _newArbiter(IArbitrator(address(0)));
        (IAuthCaptureEscrow.PaymentInfo memory p,) = _toVerdict(noArb, 0x7);
        vm.prank(payer);
        vm.expectRevert(Arb.NoArbitrator.selector);
        noArb.challenge(p, keccak256("c"));
    }

    function test_Challenge_AccessAndWindow() public {
        (IAuthCaptureEscrow.PaymentInfo memory p,) = _toVerdict(arbiter, 0x7);
        vm.prank(outsider);
        vm.expectRevert(Arb.Unauthorized.selector);
        arbiter.challenge(p, keccak256("c"));
        vm.prank(evaluator);
        vm.expectRevert(Arb.Unauthorized.selector);
        arbiter.challenge(p, keccak256("c"));
        vm.warp(block.timestamp + 10 minutes + 1);
        vm.prank(payer);
        vm.expectRevert(Arb.ChallengeWindowClosed.selector);
        arbiter.challenge(p, keccak256("c"));
    }

    function test_Challenge_Overturn_RuledBpsAndSlash() public {
        (IAuthCaptureEscrow.PaymentInfo memory p, bytes32 h) = _toVerdict(arbiter, 0x7); // 7500
        vm.prank(payer);
        arbiter.challenge(p, keccak256("c"));
        assertEq(usdc.balanceOf(address(arbiter)), BOND + ARB_FEE);
        vm.expectRevert(Arb.Unauthorized.selector);
        arbiter.rule(uint256(h), 2500);

        vm.expectRevert(Arb.InvalidPayout.selector);
        arb.giveRuling(1, 3000); // not a table entry (MockArbitrator forwards to rule)
        arb.giveRuling(1, 2500); // |7500-2500| = 5000 > 2000 => overturned

        assertEq(usdc.balanceOf(receiver), 10 * U + 0.25e6, "finalized at ruled bps");
        uint256 slash = (2 * U * 2500) / 10_000; // 0.5
        // payer: -1 + 0.75 (void) - bond - fee + bond + fee reimbursed from stake + harmed share of slash
        assertEq(usdc.balanceOf(payer), 10 * U - 0.25e6 + slash / 2);
        assertEq(registry.stakeOf(evaluator), 2 * U - ARB_FEE - slash);
        assertEq(usdc.balanceOf(address(arb)), ARB_FEE);
        assertEq(uint8(arbiter.getPayment(h).state), uint8(Arb.State.Finalized));
        _assertNoDust(arbiter);
    }

    function test_Challenge_Upheld_BondToEvaluator() public {
        (IAuthCaptureEscrow.PaymentInfo memory p,) = _toVerdict(arbiter, 0x7);
        vm.prank(receiver);
        arbiter.challenge(p, keccak256("c"));
        arb.giveRuling(1, 7500);
        assertEq(usdc.balanceOf(evaluator), BOND);
        assertEq(registry.stakeOf(evaluator), 2 * U);
        assertEq(usdc.balanceOf(receiver), 10 * U - BOND - ARB_FEE + 0.75e6);
        _assertNoDust(arbiter);
    }

    function test_Challenge_StaleDispute_RefundsChallenger_SettlesPerVerdict() public {
        (IAuthCaptureEscrow.PaymentInfo memory p, bytes32 h) = _toVerdict(arbiter, 0x7);
        vm.prank(payer);
        arbiter.challenge(p, keccak256("c"));
        vm.expectRevert(Arb.RulingWindowOpen.selector);
        arbiter.resolveStaleDispute(p);
        vm.warp(block.timestamp + 1 days + 1);
        vm.expectRevert(Arb.RulingWindowClosed.selector);
        arb.giveRuling(1, 2500);
        arbiter.resolveStaleDispute(p);
        assertEq(usdc.balanceOf(payer), 10 * U - 0.75e6);
        assertEq(usdc.balanceOf(receiver), 10 * U + 0.75e6);
        assertLt(block.timestamp, authExp, "stale resolution fits before authorizationExpiry");
        assertEq(uint8(arbiter.getPayment(h).state), uint8(Arb.State.Finalized));
        _assertNoDust(arbiter);
    }

    /// Worst case: submit at submitBy, verdict at the end of evalWindow, challenge at the end of the
    /// challenge window, stale resolution right after the ruling window: still before authorizationExpiry.
    function test_DeadlineFit_WorstCaseStillCaptures() public {
        uint48 tightExp = uint48(submitBy + arbiter.lifecycleSpan(EVAL));
        Arb.Terms memory t = _terms(evaluator, submitBy, EVAL);
        IAuthCaptureEscrow.PaymentInfo memory p =
            _paymentInfo(arbiter, payer, receiver, address(usdc), AMOUNT, preExp, tightExp, t, 77);
        _authorize(arbiter, p);
        vm.prank(evaluator);
        arbiter.bindTerms(p, t, 77);
        vm.warp(submitBy);
        vm.prank(receiver);
        arbiter.submit(p, keccak256("d"), RD);
        vm.warp(submitBy + EVAL);
        vm.prank(evaluator);
        arbiter.verdictScheduled(p, 0xF, 4, 4, RD, keccak256("r"));
        vm.warp(block.timestamp + 10 minutes);
        vm.prank(payer);
        arbiter.challenge(p, keccak256("c"));
        vm.warp(block.timestamp + 1 days + 1);
        arbiter.resolveStaleDispute(p);
        assertEq(usdc.balanceOf(receiver), 10 * U + AMOUNT, "captured before authorizationExpiry");
    }

    // ---------------- invariants (fuzzed) ----------------

    /// I2: no path calls ESCROW.refund — the refund selector is not in the arbiter's runtime bytecode.
    function test_I2_NoRefundSelectorInBytecode() public view {
        string memory pi =
            "(address,address,address,address,uint120,uint48,uint48,uint48,uint16,uint16,address,uint256)";
        bytes4 refundSel = bytes4(keccak256(abi.encodePacked("refund(", pi, ",uint256,address,bytes)")));
        bytes4 captureSel = bytes4(keccak256(abi.encodePacked("capture(", pi, ",uint256,uint256,address)")));
        assertEq(captureSel, IAuthCaptureEscrow.capture.selector);
        assertTrue(_hasPush4(address(arbiter).code, captureSel), "positive control: capture selector present");
        assertFalse(_hasPush4(address(arbiter).code, refundSel), "refund selector absent");
    }

    function _hasPush4(bytes memory code, bytes4 sel) internal pure returns (bool) {
        for (uint256 i = 0; i + 4 < code.length; i++) {
            if (code[i] == 0x63 && bytes4(bytes.concat(code[i + 1], code[i + 2], code[i + 3], code[i + 4])) == sel) {
                return true;
            }
        }
        return false;
    }

    /// I1/I3/I4/I6 over random lifecycle paths. path: 0 finalize, 1 timeout, 2 voidNoSubmit,
    /// 3 challenge+rule, 4 challenge+stale, 5 expiry+reclaim+finalize.
    /// forge-config: default.fuzz.runs = 10000
    function testFuzz_Invariants_AllPaths(uint8 path, uint16 mask, uint16 ruleIdx) public {
        path = uint8(bound(path, 0, 5));
        mask = uint16(bound(mask, 0, 15));
        uint256 payer0 = usdc.balanceOf(payer);
        uint256 recv0 = usdc.balanceOf(receiver);
        (IAuthCaptureEscrow.PaymentInfo memory p, Arb.Terms memory t) = _payment(arbiter, 1);
        bytes32 h = _authorize(arbiter, p);
        vm.prank(evaluator);
        arbiter.bindTerms(p, t, 1);
        if (path == 2) {
            vm.warp(submitBy + 1);
            arbiter.voidNoSubmit(p);
        } else {
            vm.prank(receiver);
            arbiter.submit(p, keccak256("d"), RD);
            if (path == 1) {
                vm.warp(block.timestamp + EVAL + 1);
                arbiter.timeoutRelease(p);
            } else {
                uint8 rp = PayoutScheduleLib.requiredPassFromMask(mask, 4);
                vm.prank(evaluator);
                arbiter.verdictScheduled(p, mask, 4, rp, RD, keccak256("r"));
                if (path == 0) {
                    vm.warp(block.timestamp + 10 minutes + 1);
                    arbiter.finalize(p);
                } else if (path == 3 || path == 4) {
                    vm.prank(payer);
                    arbiter.challenge(p, keccak256("c"));
                    if (path == 3) {
                        arb.giveRuling(1, PayoutScheduleLib.entryAt(JOB2_TABLE, uint8(ruleIdx % 5)));
                    } else {
                        vm.warp(block.timestamp + 1 days + 1);
                        arbiter.resolveStaleDispute(p);
                    }
                } else {
                    vm.warp(authExp);
                    vm.prank(payer);
                    acEscrow.reclaim(_vendor(p)); // I6
                    arbiter.finalize(p);
                }
            }
        }
        // I1: payment conservation. Non-payment flows (challenge bond/fee, slash shares) are added back.
        (, uint120 held, uint120 captured) = escrow.paymentState(h);
        assertEq(held, 0);
        int256 payerNet = int256(payer0) - int256(usdc.balanceOf(payer)) + _payerExtras(path, h);
        assertEq(payerNet, int256(uint256(captured)), "payer net == captured");
        assertEq(
            usdc.balanceOf(receiver) - recv0 - _receiverExtras(path), captured, "receiver got captured, fee 0 (I4)"
        );
        assertLe(captured, AMOUNT);
        _assertNoDust(arbiter);
        assertEq(registry.evaluatorInfo(evaluator).openJobs, 0);
    }

    /// Signed non-payment token flow to the payer (only path 3 has one: payer is the challenger).
    function _payerExtras(uint8 path, bytes32 h) internal view returns (int256) {
        if (path != 3) return 0;
        Arb.Payment memory rec = arbiter.getPayment(h);
        uint16 v = PayoutScheduleLib.entryAt(JOB2_TABLE, PayoutScheduleLib.requiredPassFromMask(rec.passMask, 4));
        uint16 r = rec.payoutBps;
        bool overturned = (r > v ? r - v : v - r) > 2000;
        // overturned: bond back + fee reimbursed from stake + harmed share of the 0.5 slash; upheld: loses bond + fee
        return overturned ? int256((2 * U * 2500) / 10_000 / 2) : -int256(BOND + ARB_FEE);
    }

    function _receiverExtras(uint8 path) internal view returns (uint256) {
        if (path == 1) return (2 * U * 1000) / 10_000 / 2; // harmed share of missed-verdict slash
        return 0;
    }

    // ---------------- v0.2: resultDigest, OutsideVerdict signatures, BuyerAcceptance ----------------

    uint256 constant EVAL2_KEY = 0xE7A1;
    bytes32 constant RD_SWAPPED = 0xfbfeab25f0fc8ec486588c260ea2aff84f1d5753d9a637e130ca2ee3534145a8; // sha256("agentkoin sample result bytes v2 (swapped)")

    function _stakeKeyedEvaluator() internal returns (address ev) {
        ev = vm.addr(EVAL2_KEY);
        usdc.mint(ev, 2 * U);
        vm.startPrank(ev);
        usdc.approve(address(registry), type(uint256).max);
        registry.stake(2 * U);
        vm.stopPrank();
    }

    function _toSubmittedKeyed()
        internal
        returns (IAuthCaptureEscrow.PaymentInfo memory p, bytes32 h, Arb.Terms memory t)
    {
        address ev = _stakeKeyedEvaluator();
        t = _terms(ev, submitBy, EVAL);
        p = _paymentInfo(arbiter, payer, receiver, address(usdc), AMOUNT, preExp, authExp, t, 7);
        h = _authorize(arbiter, p);
        vm.prank(ev);
        arbiter.bindTerms(p, t, 7);
        vm.prank(receiver);
        arbiter.submit(p, keccak256("deliverable"), RD);
    }

    function _verdict(bytes32 h, Arb.Terms memory t, bytes32 digest, uint16 mask, uint16 bps)
        internal
        pure
        returns (Arb.OutsideVerdict memory v)
    {
        v = Arb.OutsideVerdict({
            paymentInfoHash: h,
            termsHash: _th(t),
            deliverableHash: keccak256("deliverable"),
            resultDigest: digest,
            passMask: mask,
            payoutBps: bps,
            reasonHash: keccak256("receipt")
        });
    }

    function _th(Arb.Terms memory t) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "AgentKoinTerms(address evaluator,bytes32 criteriaHash,bytes32 scheduleHash,uint8 requiredTotal,uint256 bpsTable,uint48 submitBy,uint32 evalWindow)"
                ),
                t.evaluator,
                t.criteriaHash,
                t.scheduleHash,
                t.requiredTotal,
                t.bpsTable,
                t.submitBy,
                t.evalWindow
            )
        );
    }

    function _sig(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _acceptance(bytes32 h, bytes32 th, bytes32 digest, uint8 decision)
        internal
        pure
        returns (Arb.BuyerAcceptance memory)
    {
        return Arb.BuyerAcceptance({
            paymentInfoHash: h, termsHash: th, resultDigest: digest, decision: decision, noteHash: keccak256("note")
        });
    }

    function test_V02_TypehashesAndDomain() public view {
        assertEq(RD, sha256("agentkoin sample result bytes v1"));
        assertEq(RD_SWAPPED, sha256("agentkoin sample result bytes v2 (swapped)"));
        assertEq(
            arbiter.OUTSIDE_VERDICT_TYPEHASH(),
            keccak256(
                "OutsideVerdict(bytes32 paymentInfoHash,bytes32 termsHash,bytes32 deliverableHash,bytes32 resultDigest,uint16 passMask,uint16 payoutBps,bytes32 reasonHash)"
            )
        );
        assertEq(
            arbiter.BUYER_ACCEPTANCE_TYPEHASH(),
            keccak256(
                "BuyerAcceptance(bytes32 paymentInfoHash,bytes32 termsHash,bytes32 resultDigest,uint8 decision,bytes32 noteHash)"
            )
        );
        assertTrue(arbiter.OUTSIDE_VERDICT_TYPEHASH() != arbiter.BUYER_ACCEPTANCE_TYPEHASH());
        bytes32 ds = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("x402 outside-verdict"),
                keccak256("0.2"),
                block.chainid,
                address(arbiter)
            )
        );
        assertEq(arbiter.domainSeparator(), ds);
    }

    /// A verdict alone settles the hold; the outcome says the buyer recorded nothing.
    function test_V02_VerdictWithoutBuyerAcceptance_Captures_ReportsNotAccepted() public {
        (IAuthCaptureEscrow.PaymentInfo memory p, bytes32 h) = _toVerdict(arbiter, 0xF);
        vm.warp(block.timestamp + 10 minutes + 1);
        vm.expectEmit(true, false, false, true, address(arbiter));
        emit Arb.Finalized(h, AMOUNT, 0, Arb.BuyerDecision.None);
        arbiter.finalize(p);
        assertEq(usdc.balanceOf(receiver), 10 * U + AMOUNT, "captured on verdict alone");
        Arb.Outcome memory o = arbiter.outcome(h);
        assertEq(uint8(o.state), uint8(Arb.State.Finalized));
        assertTrue(o.verdictRecorded);
        assertEq(o.payoutBps, 10_000);
        assertEq(o.resultDigest, RD);
        assertEq(uint8(o.buyerDecision), uint8(Arb.BuyerDecision.None));
        assertFalse(o.buyerAccepted, "capture never implies buyer acceptance");
        Arb.AcceptanceRecord memory r = arbiter.getBuyerAcceptance(h);
        assertEq(uint8(r.decision), uint8(Arb.BuyerDecision.None));
        assertEq(r.recordedAt, 0);
    }

    /// Payer-signed acceptance relayed by a third party: own record, first one final, no money effect.
    function test_V02_BuyerAcceptance_SignedRelay_SeparateRecord_NoSettlementEffect() public {
        (IAuthCaptureEscrow.PaymentInfo memory p, bytes32 h) = _toVerdict(arbiter, 0x7); // 7500
        bytes32 th = arbiter.getPayment(h).termsHash;
        Arb.BuyerAcceptance memory a = _acceptance(h, th, RD, 1);
        bytes memory sig = _sig(payerKey, arbiter.buyerAcceptanceDigest(a));
        vm.expectEmit(true, true, false, true, address(arbiter));
        emit Arb.BuyerAcceptanceRecorded(h, payer, Arb.BuyerDecision.Accepted, RD, keccak256("note"));
        vm.prank(outsider);
        arbiter.recordBuyerAcceptance(p, a, sig);

        Arb.AcceptanceRecord memory r = arbiter.getBuyerAcceptance(h);
        assertEq(uint8(r.decision), uint8(Arb.BuyerDecision.Accepted));
        assertEq(r.resultDigest, RD);
        assertEq(r.recordedAt, block.timestamp);
        // The verdict record is untouched.
        assertEq(arbiter.getPayment(h).payoutBps, 7500);
        assertEq(arbiter.getPayment(h).passMask, 0x7);

        Arb.BuyerAcceptance memory again = _acceptance(h, th, RD, 2);
        bytes memory sig2 = _sig(payerKey, arbiter.buyerAcceptanceDigest(again));
        vm.expectRevert(Arb.AcceptanceAlreadyRecorded.selector);
        arbiter.recordBuyerAcceptance(p, again, sig2);

        vm.warp(block.timestamp + 10 minutes + 1);
        vm.expectEmit(true, false, false, true, address(arbiter));
        emit Arb.Finalized(
            h, (uint256(AMOUNT) * 7500) / 10_000, AMOUNT - (uint256(AMOUNT) * 7500) / 10_000, Arb.BuyerDecision.Accepted
        );
        arbiter.finalize(p);
        assertTrue(arbiter.outcome(h).buyerAccepted);
    }

    /// A buyer rejection is recorded but does not override the verdict (that is the challenge path's job).
    function test_V02_BuyerRejection_DirectCall_RecordedButVerdictSettles() public {
        (IAuthCaptureEscrow.PaymentInfo memory p, bytes32 h) = _toVerdict(arbiter, 0xF);
        bytes32 th = arbiter.getPayment(h).termsHash;
        vm.prank(payer);
        arbiter.recordBuyerAcceptance(p, _acceptance(h, th, RD, 2), "");
        vm.warp(block.timestamp + 10 minutes + 1);
        arbiter.finalize(p);
        assertEq(usdc.balanceOf(receiver), 10 * U + AMOUNT);
        Arb.Outcome memory o = arbiter.outcome(h);
        assertEq(uint8(o.buyerDecision), uint8(Arb.BuyerDecision.Rejected));
        assertFalse(o.buyerAccepted);
        // Still possible after Finalized for a payment with no record (late acceptance).
    }

    function test_V02_BuyerAcceptance_TypedErrors() public {
        (IAuthCaptureEscrow.PaymentInfo memory p, bytes32 h) = _toSubmitted(arbiter);
        bytes32 th = arbiter.getPayment(h).termsHash;
        Arb.BuyerAcceptance memory a = _acceptance(h, th, RD_SWAPPED, 1);
        vm.expectRevert(abi.encodeWithSelector(Arb.ResultDigestMismatch.selector, RD, RD_SWAPPED));
        vm.prank(payer);
        arbiter.recordBuyerAcceptance(p, a, "");

        a = _acceptance(h, th, RD, 0);
        vm.expectRevert(Arb.InvalidDecision.selector);
        vm.prank(payer);
        arbiter.recordBuyerAcceptance(p, a, "");
        a = _acceptance(h, th, RD, 3);
        vm.expectRevert(Arb.InvalidDecision.selector);
        vm.prank(payer);
        arbiter.recordBuyerAcceptance(p, a, "");

        a = _acceptance(h, keccak256("other terms"), RD, 1);
        vm.expectRevert(Arb.VerdictFieldMismatch.selector);
        vm.prank(payer);
        arbiter.recordBuyerAcceptance(p, a, "");

        a = _acceptance(h, th, RD, 1);
        bytes memory wrong = _sig(0xBAD, arbiter.buyerAcceptanceDigest(a));
        vm.expectRevert(Arb.BadSignature.selector);
        vm.prank(outsider);
        arbiter.recordBuyerAcceptance(p, a, wrong);
        vm.expectRevert(Arb.BadSignature.selector);
        vm.prank(receiver); // the seller cannot accept on the buyer's behalf
        arbiter.recordBuyerAcceptance(p, a, "");

        // Before submit there is no result to accept.
        (IAuthCaptureEscrow.PaymentInfo memory p2, Arb.Terms memory t2) = _payment(arbiter, 2);
        bytes32 h2 = _authorize(arbiter, p2);
        vm.prank(evaluator);
        arbiter.bindTerms(p2, t2, 2);
        vm.expectRevert(abi.encodeWithSelector(Arb.WrongState.selector, Arb.State.Bound));
        vm.prank(payer);
        arbiter.recordBuyerAcceptance(p2, _acceptance(h2, _th(t2), bytes32(0), 1), "");

        // Accepted while Submitted (before any verdict) is allowed and stays separate.
        vm.prank(payer);
        arbiter.recordBuyerAcceptance(p, a, "");
        assertFalse(arbiter.outcome(h).verdictRecorded);
        assertTrue(arbiter.outcome(h).buyerAccepted);
    }

    /// The receiver commits resultDigest at submit; a verdict naming any other digest (a swapped artifact) reverts.
    function test_V02_ResultDigest_CommittedAtSubmit_MismatchRejected() public {
        (IAuthCaptureEscrow.PaymentInfo memory p, bytes32 h) = _toSubmitted(arbiter);
        assertEq(arbiter.getPayment(h).resultDigest, RD);
        vm.expectRevert(abi.encodeWithSelector(Arb.ResultDigestMismatch.selector, RD, RD_SWAPPED));
        vm.prank(evaluator);
        arbiter.verdictScheduled(p, 0xF, 4, 4, RD_SWAPPED, keccak256("r"));
        vm.expectEmit(true, true, false, true, address(arbiter));
        emit Arb.Verdict(h, evaluator, 0xF, 10_000, RD, keccak256("r"));
        vm.prank(evaluator);
        arbiter.verdictScheduled(p, 0xF, 4, 4, RD, keccak256("r"));
        assertEq(arbiter.outcome(h).resultDigest, RD);
    }

    function test_V02_Submit_RequiresResultDigest() public {
        (IAuthCaptureEscrow.PaymentInfo memory p, Arb.Terms memory t) = _payment(arbiter, 3);
        bytes32 h = _authorize(arbiter, p);
        vm.prank(evaluator);
        arbiter.bindTerms(p, t, 3);
        vm.expectRevert(Arb.ZeroHash.selector);
        vm.prank(receiver);
        arbiter.submit(p, keccak256("d"), bytes32(0));
        vm.expectEmit(true, false, false, true, address(arbiter));
        emit Arb.Submitted(h, keccak256("d"), RD);
        vm.prank(receiver);
        arbiter.submit(p, keccak256("d"), RD);
    }

    /// EIP-712 OutsideVerdict signed by the evaluator, relayed by anyone; every field is checked.
    function test_V02_VerdictBySig_RelayAndTypedErrors() public {
        (IAuthCaptureEscrow.PaymentInfo memory p, bytes32 h, Arb.Terms memory t) = _toSubmittedKeyed();

        Arb.OutsideVerdict memory v = _verdict(h, t, RD_SWAPPED, 0x7, 7500);
        bytes memory s = _sig(EVAL2_KEY, arbiter.verdictDigest(v));
        vm.expectRevert(abi.encodeWithSelector(Arb.ResultDigestMismatch.selector, RD, RD_SWAPPED));
        arbiter.verdictBySig(p, v, s);

        v = _verdict(h, t, RD, 0x7, 5000); // wrong table entry for 3 passes
        s = _sig(EVAL2_KEY, arbiter.verdictDigest(v));
        vm.expectRevert(Arb.InvalidPayout.selector);
        arbiter.verdictBySig(p, v, s);

        v = _verdict(h, t, RD, 0x7, 7500);
        s = _sig(0xBAD, arbiter.verdictDigest(v));
        vm.expectRevert(Arb.BadSignature.selector);
        arbiter.verdictBySig(p, v, s);

        v.termsHash = keccak256("other");
        s = _sig(EVAL2_KEY, arbiter.verdictDigest(v));
        vm.expectRevert(Arb.VerdictFieldMismatch.selector);
        arbiter.verdictBySig(p, v, s);

        v = _verdict(h, t, RD, 0x7, 7500);
        v.deliverableHash = keccak256("other deliverable");
        s = _sig(EVAL2_KEY, arbiter.verdictDigest(v));
        vm.expectRevert(Arb.VerdictFieldMismatch.selector);
        arbiter.verdictBySig(p, v, s);

        v = _verdict(h, t, RD, 0x7, 7500);
        s = _sig(EVAL2_KEY, arbiter.verdictDigest(v));
        vm.expectEmit(true, true, false, true, address(arbiter));
        emit Arb.Verdict(h, t.evaluator, 0x7, 7500, RD, keccak256("receipt"));
        vm.prank(outsider);
        arbiter.verdictBySig(p, v, s);
        assertEq(uint8(arbiter.getPayment(h).state), uint8(Arb.State.Verdict));

        // Replay of the same signature cannot record a second verdict.
        vm.expectRevert(abi.encodeWithSelector(Arb.WrongState.selector, Arb.State.Verdict));
        arbiter.verdictBySig(p, v, s);

        vm.warp(block.timestamp + 10 minutes + 1);
        arbiter.finalize(p);
        assertEq(usdc.balanceOf(receiver), 10 * U + (uint256(AMOUNT) * 7500) / 10_000);
        assertFalse(arbiter.outcome(h).buyerAccepted);
    }

    /// zambodotdev #4324: an acceptance is bound to the committed resultDigest on both paths, so an acceptance
    /// for digest X cannot be recorded against a payment whose committed digest is Y.
    function test_V02_BuyerAcceptance_BoundToCommittedDigest_BothPaths() public {
        (IAuthCaptureEscrow.PaymentInfo memory p, bytes32 h) = _toVerdict(arbiter, 0xF);
        bytes32 th = arbiter.getPayment(h).termsHash;
        assertEq(arbiter.getPayment(h).resultDigest, RD);

        // Signed path: payer signs an acceptance of the swapped digest; relaying it reverts.
        Arb.BuyerAcceptance memory x = _acceptance(h, th, RD_SWAPPED, 1);
        bytes memory sx = _sig(payerKey, arbiter.buyerAcceptanceDigest(x));
        vm.expectRevert(abi.encodeWithSelector(Arb.ResultDigestMismatch.selector, RD, RD_SWAPPED));
        vm.prank(outsider);
        arbiter.recordBuyerAcceptance(p, x, sx);

        // A signature over the committed digest cannot be re-pointed at another digest.
        Arb.BuyerAcceptance memory y = _acceptance(h, th, RD, 1);
        bytes memory sy = _sig(payerKey, arbiter.buyerAcceptanceDigest(y));
        assertTrue(
            arbiter.buyerAcceptanceDigest(x) != arbiter.buyerAcceptanceDigest(y), "digest is in the signed struct"
        );
        vm.expectRevert(abi.encodeWithSelector(Arb.ResultDigestMismatch.selector, RD, RD_SWAPPED));
        vm.prank(outsider);
        arbiter.recordBuyerAcceptance(p, x, sy);

        // Direct payer path: same rule.
        vm.expectRevert(abi.encodeWithSelector(Arb.ResultDigestMismatch.selector, RD, RD_SWAPPED));
        vm.prank(payer);
        arbiter.recordBuyerAcceptance(p, x, "");
        assertEq(uint8(arbiter.getBuyerAcceptance(h).decision), uint8(Arb.BuyerDecision.None), "nothing recorded");

        // Matching digest records (signed path), bound to RD.
        vm.prank(outsider);
        arbiter.recordBuyerAcceptance(p, y, sy);
        Arb.AcceptanceRecord memory r = arbiter.getBuyerAcceptance(h);
        assertEq(uint8(r.decision), uint8(Arb.BuyerDecision.Accepted));
        assertEq(r.resultDigest, RD);
    }

    function test_V02_BuyerAcceptance_DirectPayerMatchingDigestRecords() public {
        (IAuthCaptureEscrow.PaymentInfo memory p, bytes32 h) = _toSubmitted(arbiter);
        Arb.BuyerAcceptance memory a = _acceptance(h, arbiter.getPayment(h).termsHash, RD, 1); // before prank
        vm.prank(payer);
        arbiter.recordBuyerAcceptance(p, a, "");
        assertEq(arbiter.getBuyerAcceptance(h).resultDigest, RD);
        assertTrue(arbiter.outcome(h).buyerAccepted);
    }
}
