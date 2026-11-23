// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {MockArbitrator} from "../../src/mocks/MockArbitrator.sol";
import {EvaluatorRegistry} from "../../src/EvaluatorRegistry.sol";
import {IEvaluatorRegistry} from "../../src/interfaces/IEvaluatorRegistry.sol";
import {IArbitrator} from "../../src/interfaces/IArbitrator.sol";
import {IAuthCaptureEscrow} from "../../src/arbiter/IAuthCaptureEscrow.sol";
import {AgentKoinAuthCaptureArbiter as Arb02} from "../../src/arbiter/AgentKoinAuthCaptureArbiter.sol";
import {AgentKoinAuthCaptureArbiterV03 as Arb} from "../../src/arbiter/AgentKoinAuthCaptureArbiterV03.sol";
import {AuthCaptureEscrow} from "./vendor/commerce-payments/src/AuthCaptureEscrow.sol";
import {ERC3009PaymentCollector} from "./vendor/commerce-payments/src/collectors/ERC3009PaymentCollector.sol";
import {ArbiterTestBase} from "./ArbiterTestLib.sol";

/// v0.3 (optional Terms.submitter) on the vendored, unmodified AuthCaptureEscrow v1.1 + ERC3009PaymentCollector,
/// MockUSDC, real EvaluatorRegistry, MockArbitrator. `DEPOSIT` stands in for a keyless Stripe deposit address:
/// it has no key in this test; vm.prank(DEPOSIT) is used only to show that even the receiver cannot submit.
contract AuthCaptureArbiterV03Test is ArbiterTestBase {
    uint256 constant U = 1e6;
    uint120 constant AMOUNT = 1e6;
    uint256 constant ARB_FEE = 0.3e6;
    uint256 constant BOND = 0.5e6;
    uint32 constant EVAL = 6 hours;
    address constant DEPOSIT = 0x00000000000000000000000000000000de905171;
    bytes32 constant RD_SWAPPED = 0x6c52e64ac6b53e1d0c6cd3d1b9b0b9e7d41cf79bf3b1b1c6f0f0e3a3f6cbd0a1;

    MockUSDC usdc;
    AuthCaptureEscrow acEscrow;
    IAuthCaptureEscrow escrow;
    ERC3009PaymentCollector collector;
    EvaluatorRegistry registry;
    MockArbitrator arb;
    Arb v3;
    Arb v3NoArb;
    Arb02 v2;

    uint256 payerKey = 0xA11CE;
    uint256 evalKey = 0xE7A1;
    uint256 sellerKey = 0x5E11E4;
    address payer;
    address evaluator;
    address seller;
    address receiverEoa = makeAddr("receiverEoa");
    address stranger = makeAddr("stranger");
    address owner = makeAddr("owner");
    uint48 preExp;
    uint48 submitBy;
    uint48 authExp;

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

    function _register(address a) internal {
        vm.prank(owner);
        registry.proposeSlasher(a, true);
        registry.executeSlasher(a);
    }

    function setUp() public {
        vm.warp(1_800_000_000);
        payer = vm.addr(payerKey);
        evaluator = vm.addr(evalKey);
        seller = vm.addr(sellerKey);
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
                treasury: makeAddr("treasury")
            }),
            owner,
            new address[](0),
            0
        );
        arb = new MockArbitrator(address(this), ARB_FEE);
        Arb.Config memory c = _cfg();
        v3 = new Arb(
            escrow, IEvaluatorRegistry(address(registry)), IArbitrator(address(arb)), IERC20(address(usdc)), AMOUNT, c
        );
        v3NoArb = new Arb(
            escrow, IEvaluatorRegistry(address(registry)), IArbitrator(address(0)), IERC20(address(usdc)), AMOUNT, c
        );
        v2 = new Arb02(
            escrow,
            IEvaluatorRegistry(address(registry)),
            IArbitrator(address(0)),
            IERC20(address(usdc)),
            AMOUNT,
            abi.decode(abi.encode(c), (Arb02.Config))
        );
        _register(address(v3));
        _register(address(v3NoArb));
        _register(address(v2));

        usdc.mint(payer, 10 * U);
        usdc.mint(evaluator, 2 * U);
        usdc.mint(seller, 2 * U);
        vm.startPrank(evaluator);
        usdc.approve(address(registry), type(uint256).max);
        registry.stake(2 * U);
        vm.stopPrank();
        vm.prank(payer);
        usdc.approve(address(v3), type(uint256).max);
        vm.prank(seller);
        usdc.approve(address(v3), type(uint256).max);

        preExp = uint48(block.timestamp + 10 minutes);
        submitBy = uint48(block.timestamp + 1 hours);
        authExp = uint48(block.timestamp + 3 days);
    }

    // ---------------- helpers ----------------

    function _t(address submitter_) internal view returns (Arb.Terms memory) {
        return Arb.Terms({
            evaluator: evaluator,
            criteriaHash: keccak256("criteria.json"),
            scheduleHash: keccak256("schedule.json"),
            requiredTotal: 4,
            bpsTable: JOB2_TABLE,
            submitBy: submitBy,
            evalWindow: EVAL,
            submitter: submitter_
        });
    }

    function _p(Arb a, address receiver, Arb.Terms memory t, uint256 nonce)
        internal
        view
        returns (IAuthCaptureEscrow.PaymentInfo memory)
    {
        return IAuthCaptureEscrow.PaymentInfo({
            operator: address(a),
            payer: payer,
            receiver: receiver,
            token: address(usdc),
            maxAmount: AMOUNT,
            preApprovalExpiry: preExp,
            authorizationExpiry: authExp,
            refundExpiry: authExp,
            minFeeBps: 0,
            maxFeeBps: 0,
            feeReceiver: address(0),
            salt: a.termsSalt(a.termsHash(t), nonce)
        });
    }

    function _authBind(Arb a, address receiver, address submitter_, uint256 nonce)
        internal
        returns (IAuthCaptureEscrow.PaymentInfo memory p, bytes32 h, Arb.Terms memory t)
    {
        t = _t(submitter_);
        p = _p(a, receiver, t, nonce);
        bytes memory sig = _sign3009(escrow, address(usdc), payerKey, address(collector), p);
        vm.prank(stranger); // permissionless relay
        a.authorize(p, p.maxAmount, address(collector), sig);
        h = escrow.getHash(p);
        vm.prank(evaluator);
        a.bindTerms(p, t, nonce);
    }

    /// receiver = keyless deposit address, submitter = seller EOA, submitted by the seller.
    function _submittedZeroHop(Arb a, uint256 nonce)
        internal
        returns (IAuthCaptureEscrow.PaymentInfo memory p, bytes32 h, Arb.Terms memory t)
    {
        (p, h, t) = _authBind(a, DEPOSIT, seller, nonce);
        vm.prank(seller);
        a.submit(p, keccak256("deliverable"), RD);
    }

    function _verdict(bytes32 h, Arb.Terms memory t, uint16 mask, uint16 bps)
        internal
        view
        returns (Arb.OutsideVerdict memory)
    {
        return Arb.OutsideVerdict({
            paymentInfoHash: h,
            termsHash: v3.termsHash(t),
            deliverableHash: keccak256("deliverable"),
            resultDigest: RD,
            passMask: mask,
            payoutBps: bps,
            reasonHash: keccak256("receipt")
        });
    }

    function _sig(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _finalize(Arb a, IAuthCaptureEscrow.PaymentInfo memory p) internal {
        vm.warp(block.timestamp + 10 minutes + 1);
        vm.prank(stranger);
        a.finalize(p);
    }

    // ---------------- constants and domains ----------------

    function test_V03_Constants_TypehashAndDomain() public view {
        assertEq(v3.VERSION(), "0.3");
        assertEq(v3.EIP712_NAME(), "x402 outside-verdict");
        assertEq(v3.EIP712_VERSION(), "0.3");
        assertEq(
            v3.TERMS_TYPEHASH(),
            keccak256(
                "AgentKoinTerms(address evaluator,bytes32 criteriaHash,bytes32 scheduleHash,uint8 requiredTotal,uint256 bpsTable,uint48 submitBy,uint32 evalWindow,address submitter)"
            )
        );
        assertTrue(v3.TERMS_TYPEHASH() != v2.TERMS_TYPEHASH());
        assertEq(v3.OUTSIDE_VERDICT_TYPEHASH(), v2.OUTSIDE_VERDICT_TYPEHASH());
        assertEq(v3.BUYER_ACCEPTANCE_TYPEHASH(), v2.BUYER_ACCEPTANCE_TYPEHASH());
        (, string memory name, string memory version, uint256 chainId, address vc,,) = v3.eip712Domain();
        assertEq(name, "x402 outside-verdict");
        assertEq(version, "0.3");
        assertEq(chainId, block.chainid);
        assertEq(vc, address(v3));
        bytes32 ds = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("x402 outside-verdict"),
                keccak256("0.3"),
                block.chainid,
                address(v3)
            )
        );
        assertEq(v3.domainSeparator(), ds);
        assertTrue(v3.domainSeparator() != v2.domainSeparator());
        // Same address, different version: still distinct.
        bytes32 ds02SameAddr = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("x402 outside-verdict"),
                keccak256("0.2"),
                block.chainid,
                address(v3)
            )
        );
        assertTrue(ds != ds02SameAddr);
    }

    function test_V03_TermsHashBindsSubmitter() public view {
        Arb.Terms memory a = _t(address(0));
        Arb.Terms memory b = _t(seller);
        Arb.Terms memory c = _t(stranger);
        assertTrue(v3.termsHash(a) != v3.termsHash(b));
        assertTrue(v3.termsHash(b) != v3.termsHash(c));
        assertEq(v3.hashTerms(b), v3.termsHash(b));
        bytes32 manual = keccak256(
            abi.encode(
                v3.TERMS_TYPEHASH(),
                b.evaluator,
                b.criteriaHash,
                b.scheduleHash,
                b.requiredTotal,
                b.bpsTable,
                b.submitBy,
                b.evalWindow,
                b.submitter
            )
        );
        assertEq(v3.termsHash(b), manual);
        IAuthCaptureEscrow.PaymentInfo memory p = _p(v3, DEPOSIT, b, 1);
        assertEq(v3.effectiveSubmitter(p, b), seller);
        assertEq(v3.effectiveSubmitter(p, a), DEPOSIT);
    }

    // ---------------- submitter == 0: v0.2 behaviour ----------------

    function test_V03_ZeroSubmitter_ReceiverSubmitsAndSettles() public {
        (IAuthCaptureEscrow.PaymentInfo memory p, bytes32 h,) = _authBind(v3, receiverEoa, address(0), 1);
        assertEq(v3.getPayment(h).submitter, receiverEoa);
        vm.expectRevert(Arb.Unauthorized.selector);
        vm.prank(payer);
        v3.submit(p, keccak256("deliverable"), RD);
        vm.expectRevert(Arb.Unauthorized.selector);
        vm.prank(stranger);
        v3.submit(p, keccak256("deliverable"), RD);
        vm.expectRevert(Arb.Unauthorized.selector);
        vm.prank(seller);
        v3.submit(p, keccak256("deliverable"), RD);
        vm.expectEmit(true, true, false, true, address(v3));
        emit Arb.Submitted(h, receiverEoa, keccak256("deliverable"), RD);
        vm.prank(receiverEoa);
        v3.submit(p, keccak256("deliverable"), RD);
        vm.prank(evaluator);
        v3.verdictScheduled(p, 0xF, 4, 4, RD, keccak256("r"));
        _finalize(v3, p);
        assertEq(usdc.balanceOf(receiverEoa), AMOUNT);
    }

    // ---------------- submitter != 0: zero-hop to a keyless receiver ----------------

    function test_V03_Submitter_OnlySubmitterMaySubmit() public {
        (IAuthCaptureEscrow.PaymentInfo memory p, bytes32 h,) = _authBind(v3, DEPOSIT, seller, 2);
        assertEq(v3.getPayment(h).submitter, seller);
        address[3] memory bad = [DEPOSIT, payer, stranger];
        for (uint256 i; i < bad.length; i++) {
            vm.expectRevert(Arb.Unauthorized.selector);
            vm.prank(bad[i]);
            v3.submit(p, keccak256("deliverable"), RD);
        }
        vm.expectEmit(true, true, false, true, address(v3));
        emit Arb.Submitted(h, seller, keccak256("deliverable"), RD);
        vm.prank(seller);
        v3.submit(p, keccak256("deliverable"), RD);
        assertEq(uint8(v3.getPayment(h).state), uint8(Arb.State.Submitted));
    }

    function test_V03_ZeroHop_DirectVerdict_CapturesToReceiver() public {
        (IAuthCaptureEscrow.PaymentInfo memory p, bytes32 h,) = _submittedZeroHop(v3, 3);
        vm.expectRevert(abi.encodeWithSelector(Arb.ResultDigestMismatch.selector, RD, RD_SWAPPED));
        vm.prank(evaluator);
        v3.verdictScheduled(p, 0xF, 4, 4, RD_SWAPPED, keccak256("r"));
        vm.prank(evaluator);
        v3.verdictScheduled(p, 0xF, 4, 4, RD, keccak256("r"));
        uint256 sellerBefore = usdc.balanceOf(seller);
        vm.expectEmit(true, true, false, true, address(usdc));
        emit IERC20.Transfer(acEscrow.getTokenStore(address(v3)), DEPOSIT, AMOUNT); // single hop: token store -> receiver
        _finalize(v3, p);
        assertEq(usdc.balanceOf(DEPOSIT), AMOUNT, "paid to info.receiver");
        assertEq(usdc.balanceOf(seller), sellerBefore, "submitter receives nothing");
        assertFalse(v3.outcome(h).buyerAccepted);
    }

    function test_V03_ZeroHop_VerdictBySig_Partial() public {
        (IAuthCaptureEscrow.PaymentInfo memory p, bytes32 h, Arb.Terms memory t) = _submittedZeroHop(v3, 4);
        Arb.OutsideVerdict memory v = _verdict(h, t, 0x7, 7500);
        vm.prank(stranger);
        v3.verdictBySig(p, v, _sig(evalKey, v3.verdictDigest(v)));
        _finalize(v3, p);
        assertEq(usdc.balanceOf(DEPOSIT), 0.75e6);
        assertEq(usdc.balanceOf(payer), 10 * U - 0.75e6);
    }

    function test_V03_WrongSubmitterTerms_Rejected() public {
        (IAuthCaptureEscrow.PaymentInfo memory p, bytes32 h, Arb.Terms memory t) = _submittedZeroHop(v3, 5);
        // A verdict over terms naming a different submitter has a different termsHash.
        Arb.Terms memory other = t;
        other = _t(stranger);
        Arb.OutsideVerdict memory v = _verdict(h, other, 0xF, 10_000);
        bytes memory s = _sig(evalKey, v3.verdictDigest(v));
        vm.expectRevert(Arb.VerdictFieldMismatch.selector);
        v3.verdictBySig(p, v, s);

        // Binding terms whose submitter differs from the buyer-signed salt fails.
        Arb.Terms memory signed = _t(seller);
        IAuthCaptureEscrow.PaymentInfo memory p2 = _p(v3, DEPOSIT, signed, 6);
        bytes memory sig = _sign3009(escrow, address(usdc), payerKey, address(collector), p2);
        v3.authorize(p2, p2.maxAmount, address(collector), sig);
        vm.expectRevert(Arb.SaltMismatch.selector);
        vm.prank(evaluator);
        v3.bindTerms(p2, _t(stranger), 6);
        vm.expectRevert(Arb.SaltMismatch.selector);
        vm.prank(evaluator);
        v3.bindTerms(p2, _t(address(0)), 6);
    }

    function _ds(string memory version, address vc) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("x402 outside-verdict"),
                keccak256(bytes(version)),
                block.chainid,
                vc
            )
        );
    }

    function _structHash(Arb.OutsideVerdict memory v) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                v3.OUTSIDE_VERDICT_TYPEHASH(),
                v.paymentInfoHash,
                v.termsHash,
                v.deliverableHash,
                v.resultDigest,
                v.passMask,
                v.payoutBps,
                v.reasonHash
            )
        );
    }

    function test_V03_RejectsV02DomainSignature() public {
        (IAuthCaptureEscrow.PaymentInfo memory p, bytes32 h, Arb.Terms memory t) = _submittedZeroHop(v3, 7);
        Arb.OutsideVerdict memory v = _verdict(h, t, 0xF, 10_000);
        assertEq(v3.verdictDigest(v), keccak256(abi.encodePacked("\x19\x01", _ds("0.3", address(v3)), _structHash(v))));
        // Same struct, same verifyingContract, version "0.2": rejected.
        bytes32 d02 = keccak256(abi.encodePacked("\x19\x01", _ds("0.2", address(v3)), _structHash(v)));
        vm.expectRevert(Arb.BadSignature.selector);
        v3.verdictBySig(p, v, _sig(evalKey, d02));
        // A signature produced by the deployed-style v0.2 contract's digest function is also rejected.
        Arb02.OutsideVerdict memory w = abi.decode(abi.encode(v), (Arb02.OutsideVerdict));
        bytes memory s02 = _sig(evalKey, v2.verdictDigest(w)); // computed before expectRevert (it is a call)
        vm.expectRevert(Arb.BadSignature.selector);
        v3.verdictBySig(p, v, s02);
        bytes memory s03 = _sig(evalKey, v3.verdictDigest(v));
        v3.verdictBySig(p, v, s03);
    }

    function _v02Submitted() internal returns (IAuthCaptureEscrow.PaymentInfo memory q, Arb02.OutsideVerdict memory w) {
        Arb02.Terms memory t2 = Arb02.Terms({
            evaluator: evaluator,
            criteriaHash: keccak256("criteria.json"),
            scheduleHash: keccak256("schedule.json"),
            requiredTotal: 4,
            bpsTable: JOB2_TABLE,
            submitBy: submitBy,
            evalWindow: EVAL
        });
        q = _p(v3, receiverEoa, _t(address(0)), 8);
        q.operator = address(v2);
        q.salt = v2.termsSalt(v2.termsHash(t2), 8);
        bytes memory s3009 = _sign3009(escrow, address(usdc), payerKey, address(collector), q);
        v2.authorize(q, q.maxAmount, address(collector), s3009);
        vm.prank(evaluator);
        v2.bindTerms(q, t2, 8);
        vm.prank(receiverEoa);
        v2.submit(q, keccak256("deliverable"), RD);
        w = Arb02.OutsideVerdict({
            paymentInfoHash: escrow.getHash(q),
            termsHash: v2.termsHash(t2),
            deliverableHash: keccak256("deliverable"),
            resultDigest: RD,
            passMask: 0xF,
            payoutBps: 10_000,
            reasonHash: keccak256("receipt")
        });
    }

    function test_V02_RejectsV03DomainSignature() public {
        (IAuthCaptureEscrow.PaymentInfo memory q, Arb02.OutsideVerdict memory w) = _v02Submitted();
        Arb.OutsideVerdict memory asV3 = abi.decode(abi.encode(w), (Arb.OutsideVerdict));
        bytes32 d03 = keccak256(abi.encodePacked("\x19\x01", _ds("0.3", address(v2)), _structHash(asV3)));
        bytes memory bad = _sig(evalKey, d03);
        vm.expectRevert(Arb02.BadSignature.selector);
        v2.verdictBySig(q, w, bad);
        bytes memory good = _sig(evalKey, v2.verdictDigest(w));
        v2.verdictBySig(q, w, good);
        vm.warp(block.timestamp + 10 minutes + 1);
        v2.finalize(q);
        assertEq(usdc.balanceOf(receiverEoa), AMOUNT);
    }

    // ---------------- role separation ----------------

    function test_V03_EvaluatorCannotBeSubmitter() public {
        // receiver is the keyless deposit address; the seller tries to judge itself via submitter = evaluator.
        Arb.Terms memory t = _t(evaluator);
        IAuthCaptureEscrow.PaymentInfo memory p = _p(v3, DEPOSIT, t, 9);
        v3.authorize(
            p, p.maxAmount, address(collector), _sign3009(escrow, address(usdc), payerKey, address(collector), p)
        );
        vm.expectRevert(Arb.EvaluatorConflict.selector);
        vm.prank(evaluator);
        v3.bindTerms(p, t, 9);
        // And the v0.2 checks remain: evaluator == receiver.
        Arb.Terms memory t2 = _t(seller);
        IAuthCaptureEscrow.PaymentInfo memory p2 = _p(v3, evaluator, t2, 10);
        v3.authorize(
            p2, p2.maxAmount, address(collector), _sign3009(escrow, address(usdc), payerKey, address(collector), p2)
        );
        vm.expectRevert(Arb.EvaluatorConflict.selector);
        vm.prank(evaluator);
        v3.bindTerms(p2, t2, 10);
    }

    // ---------------- buyer acceptance, refund, timeout, reclaim, challenge with a submitter ----------------

    function test_V03_BuyerAcceptance_BoundToDigest_WithSubmitter() public {
        (IAuthCaptureEscrow.PaymentInfo memory p, bytes32 h, Arb.Terms memory t) = _submittedZeroHop(v3, 11);
        bytes32 th = v3.termsHash(t);
        Arb.BuyerAcceptance memory bad = Arb.BuyerAcceptance(h, th, RD_SWAPPED, 1, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(Arb.ResultDigestMismatch.selector, RD, RD_SWAPPED));
        vm.prank(payer);
        v3.recordBuyerAcceptance(p, bad, "");
        Arb.BuyerAcceptance memory a = Arb.BuyerAcceptance(h, th, RD, 1, keccak256("note"));
        bytes memory s = _sig(payerKey, v3.buyerAcceptanceDigest(a));
        vm.expectRevert(Arb.BadSignature.selector); // the seller (submitter) cannot accept for the buyer
        vm.prank(seller);
        v3.recordBuyerAcceptance(p, a, "");
        vm.prank(stranger);
        v3.recordBuyerAcceptance(p, a, s);
        assertTrue(v3.outcome(h).buyerAccepted);
        vm.prank(evaluator);
        v3.verdictScheduled(p, 0xF, 4, 4, RD, keccak256("r"));
        _finalize(v3, p);
        assertEq(usdc.balanceOf(DEPOSIT), AMOUNT);
    }

    function test_V03_Reject_FullRefundToPayer() public {
        (IAuthCaptureEscrow.PaymentInfo memory p,,) = _submittedZeroHop(v3, 12);
        vm.prank(evaluator);
        v3.verdictScheduled(p, 0, 4, 0, RD, keccak256("r"));
        _finalize(v3, p);
        assertEq(usdc.balanceOf(DEPOSIT), 0);
        assertEq(usdc.balanceOf(payer), 10 * U);
    }

    function test_V03_NoSubmit_Void_And_MissedVerdict_Slash() public {
        (IAuthCaptureEscrow.PaymentInfo memory p,,) = _authBind(v3, DEPOSIT, seller, 13);
        vm.warp(submitBy + 1);
        vm.expectRevert(Arb.SubmitWindowClosed.selector);
        vm.prank(seller);
        v3.submit(p, keccak256("deliverable"), RD);
        v3.voidNoSubmit(p);
        assertEq(usdc.balanceOf(payer), 10 * U);

        preExp = uint48(block.timestamp + 10 minutes);
        submitBy = uint48(block.timestamp + 1 hours);
        (IAuthCaptureEscrow.PaymentInfo memory q,,) = _submittedZeroHop(v3, 14);
        uint256 sellerBefore = usdc.balanceOf(seller);
        vm.warp(block.timestamp + EVAL + 1);
        v3.timeoutRelease(q);
        uint256 slash = (2 * U * 1000) / 10_000;
        assertEq(usdc.balanceOf(payer), 10 * U, "full void");
        assertEq(usdc.balanceOf(seller), sellerBefore + slash / 2, "harmed share goes to the submitter");
        assertEq(usdc.balanceOf(DEPOSIT), 0, "nothing lands on the keyless receiver");
    }

    function test_V03_MissedVerdict_ZeroSubmitter_SlashPaysReceiver() public {
        (IAuthCaptureEscrow.PaymentInfo memory p,,) = _authBind(v3, receiverEoa, address(0), 18);
        vm.prank(receiverEoa);
        v3.submit(p, keccak256("deliverable"), RD);
        vm.warp(block.timestamp + EVAL + 1);
        v3.timeoutRelease(p);
        assertEq(usdc.balanceOf(receiverEoa), (2 * U * 1000) / 10_000 / 2, "v0.2 behaviour: harmed = info.receiver");
        assertEq(usdc.balanceOf(payer), 10 * U);
    }

    function _authorizeOnly(address receiver, Arb.Terms memory t, uint256 nonce)
        internal
        returns (IAuthCaptureEscrow.PaymentInfo memory p)
    {
        p = _p(v3, receiver, t, nonce);
        bytes memory sig = _sign3009(escrow, address(usdc), payerKey, address(collector), p);
        v3.authorize(p, p.maxAmount, address(collector), sig);
    }

    function test_V03_SubmitterCannotBePayer() public {
        Arb.Terms memory t = _t(payer);
        IAuthCaptureEscrow.PaymentInfo memory p = _authorizeOnly(DEPOSIT, t, 19);
        vm.expectRevert(Arb.SubmitterIsPayer.selector);
        vm.prank(evaluator);
        v3.bindTerms(p, t, 19);
    }

    function test_V03_ZeroSubmitter_ReceiverIsPayer_Rejected() public {
        Arb.Terms memory t = _t(address(0));
        IAuthCaptureEscrow.PaymentInfo memory p = _authorizeOnly(payer, t, 20);
        vm.expectRevert(Arb.SubmitterIsPayer.selector);
        vm.prank(evaluator);
        v3.bindTerms(p, t, 20);
    }

    function test_V03_AfterAuthExpiry_PayerReclaims() public {
        (IAuthCaptureEscrow.PaymentInfo memory p, bytes32 h,) = _submittedZeroHop(v3, 15);
        vm.prank(evaluator);
        v3.verdictScheduled(p, 0xF, 4, 4, RD, keccak256("r"));
        vm.warp(authExp);
        vm.prank(payer);
        acEscrow.reclaim(abi.decode(abi.encode(p), (AuthCaptureEscrow.PaymentInfo)));
        assertEq(usdc.balanceOf(payer), 10 * U);
        v3.finalize(p);
        assertEq(uint8(v3.getPayment(h).state), uint8(Arb.State.Finalized));
        assertEq(usdc.balanceOf(DEPOSIT), 0);
    }

    function test_V03_Challenge_BySubmitter_Overturn_PaysReceiver() public {
        (IAuthCaptureEscrow.PaymentInfo memory p,,) = _submittedZeroHop(v3, 16);
        vm.prank(evaluator);
        v3.verdictScheduled(p, 0x1, 4, 1, RD, keccak256("r")); // 2500
        vm.expectRevert(Arb.Unauthorized.selector);
        vm.prank(stranger);
        v3.challenge(p, keccak256("c"));
        uint256 sellerBefore = usdc.balanceOf(seller);
        vm.prank(seller); // the keyless receiver cannot challenge; its submitter can
        v3.challenge(p, keccak256("c"));
        arb.giveRuling(1, 10_000); // |2500 - 10000| > 2000 => overturned
        assertEq(usdc.balanceOf(DEPOSIT), AMOUNT, "ruled capture pays info.receiver");
        uint256 slash = (2 * U * 2500) / 10_000;
        // seller paid bond + fee; got the bond back, the fee reimbursed from stake, and the challenger's slash share
        assertEq(usdc.balanceOf(seller), sellerBefore + slash / 2);
    }

    function test_V03_Challenge_DisabledWithoutArbitrator() public {
        vm.prank(payer);
        usdc.approve(address(v3NoArb), type(uint256).max);
        (IAuthCaptureEscrow.PaymentInfo memory p,,) = _submittedZeroHop(v3NoArb, 17);
        vm.prank(evaluator);
        v3NoArb.verdictScheduled(p, 0x7, 4, 3, RD, keccak256("r"));
        vm.expectRevert(Arb.NoArbitrator.selector);
        vm.prank(seller);
        v3NoArb.challenge(p, keccak256("c"));
        _finalize(v3NoArb, p);
        assertEq(usdc.balanceOf(DEPOSIT), 0.75e6);
    }
}
