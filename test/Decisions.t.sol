// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {EvaluatorRegistry} from "../src/EvaluatorRegistry.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {EscrowDepositRoute, EscrowDepositRouteFactory} from "../src/EscrowDepositRoute.sol";
import {Defaults} from "../script/Defaults.sol";

/// Tests for the decided assumptions E-17, E-18, E-22 (escrow) and A-1 (EIP-3009 + deposit route).
contract DecisionsTest is BaseTest {
    // ---------------- E-18 evaluator fee ----------------

    function test_E18_EvaluatorFee_OnComplete() public {
        uint256 id = _openAndSubmit(200 * USDC);
        _verdict(id, JobEscrow.Outcome.Complete, 10_000);
        uint256 e0 = usdc.balanceOf(evaluator);
        _passChallengeWindow();
        vm.expectEmit(true, true, false, true, address(escrow));
        emit JobEscrow.EvaluatorFeePaid(id, evaluator, 1 * USDC);
        escrow.finalize(id);
        assertEq(usdc.balanceOf(evaluator) - e0, 1 * USDC); // 0.5% of 200
        assertEq(usdc.balanceOf(treasury), 2 * USDC); // protocol fee separate: 1% of 200
    }

    function test_E18_NoEvaluatorFee_OnReject() public {
        uint256 id = _openAndSubmit(100 * USDC);
        _verdict(id, JobEscrow.Outcome.Reject, 0);
        uint256 e0 = usdc.balanceOf(evaluator);
        _passChallengeWindow();
        escrow.finalize(id);
        assertEq(usdc.balanceOf(evaluator), e0);
    }

    function test_E18_NoEvaluatorFee_OnInstant() public {
        uint256 id = _open(1 * USDC);
        vm.startPrank(provider);
        escrow.postProviderBond(id, 1 * USDC);
        uint256 p0 = usdc.balanceOf(provider);
        escrow.submit(id, DELIVERABLE);
        vm.stopPrank();
        assertEq(usdc.balanceOf(provider) - p0, 990_000); // 1% protocol fee only
        assertEq(usdc.balanceOf(evaluator), 900 * USDC);
    }

    function test_E18_NoEvaluatorFee_WhenOverturned() public {
        uint256 id = _openAndSubmit(100 * USDC);
        _verdict(id, JobEscrow.Outcome.Reject, 0);
        uint256 e0 = usdc.balanceOf(evaluator);
        vm.prank(provider);
        escrow.challenge(id, REASON);
        vm.prank(owner);
        arb.giveRuling(1, 10_000);
        assertEq(usdc.balanceOf(evaluator), e0);
    }

    function test_E18_FeeSumValidated() public {
        JobEscrow.Config memory c = escrow.currentConfig();
        c.feeBps = 450;
        c.evaluatorFeeBps = 51;
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.FeeCeilingExceeded.selector, 501, 500));
        escrow.setConfig(c);
        c.evaluatorFeeBps = 50;
        vm.prank(owner);
        escrow.setConfig(c);
    }

    function test_E18_Configurable() public {
        JobEscrow.Config memory c = escrow.currentConfig();
        c.evaluatorFeeBps = 0;
        vm.prank(owner);
        escrow.setConfig(c);
        uint256 id = _openAndSubmit(100 * USDC);
        _verdict(id, JobEscrow.Outcome.Complete, 10_000);
        uint256 e0 = usdc.balanceOf(evaluator);
        _passChallengeWindow();
        escrow.finalize(id);
        assertEq(usdc.balanceOf(evaluator), e0);
    }

    // ---------------- E-17 loser pays ----------------

    function test_E17_FeeQuotedAndHeldUntilRuling() public {
        (,,,, uint256 arbFee,,) = escrow.quote(100 * USDC, 0);
        assertEq(arbFee, ARB_FEE);
        assertEq(arb.arbitrationCost(0, 100 * USDC), ARB_FEE);
        uint256 id = _openAndSubmit(100 * USDC);
        _verdict(id, JobEscrow.Outcome.Complete, 10_000);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit JobEscrow.ArbitrationFeeEscrowed(id, client, address(arb), ARB_FEE);
        vm.prank(client);
        escrow.challenge(id, REASON);
        assertEq(escrow.getDispute(id).arbFee, ARB_FEE);
        // E-17a: held in escrow, not yet with the arbitrator
        assertEq(usdc.balanceOf(address(arb)), 0);
        assertEq(usdc.balanceOf(address(escrow)), 100 * USDC + 5 * USDC + ARB_FEE);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit JobEscrow.ArbitrationFeePaid(id, client, address(arb), ARB_FEE);
        vm.prank(owner);
        arb.giveRuling(1, 10_000);
        assertEq(usdc.balanceOf(address(arb)), ARB_FEE);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_E17_MaterialChallenge_FeeReimbursedByEvaluator() public {
        uint256 id = _openAndSubmit(100 * USDC);
        _verdict(id, JobEscrow.Outcome.Complete, 10_000);
        vm.prank(client);
        escrow.challenge(id, REASON);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit JobEscrow.ArbitrationFeeReimbursed(id, client, evaluator, ARB_FEE);
        vm.prank(owner);
        arb.giveRuling(1, 0);
        assertEq(registry.stakeOf(evaluator), 100 * USDC - ARB_FEE - 25 * USDC);
    }

    function test_E17_FailedChallenge_ChallengerBearsFee() public {
        uint256 id = _openAndSubmit(100 * USDC);
        _verdict(id, JobEscrow.Outcome.Complete, 10_000);
        uint256 c0 = usdc.balanceOf(client);
        vm.prank(client);
        escrow.challenge(id, REASON);
        vm.prank(owner);
        arb.giveRuling(1, 10_000);
        assertEq(c0 - usdc.balanceOf(client), 5 * USDC + ARB_FEE);
        assertEq(registry.stakeOf(evaluator), 100 * USDC);
    }

    function test_E17_InstantOverturn_FeeFromProviderBond() public {
        uint256 id = _open(1 * USDC);
        vm.startPrank(provider);
        escrow.postProviderBond(id, 3 * USDC);
        escrow.submit(id, DELIVERABLE);
        vm.stopPrank();
        uint256 c0 = usdc.balanceOf(client);
        vm.prank(client);
        escrow.challenge(id, REASON);
        vm.prank(owner);
        arb.giveRuling(1, 0);
        // -1.5 (bond+fee) +1 compensation +0.5 fee back +1 bond back
        assertEq(usdc.balanceOf(client) - c0, 1 * USDC);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_E17_ZeroFeeArbitrator() public {
        vm.prank(owner);
        arb.setFee(0);
        uint256 id = _openAndSubmit(100 * USDC);
        _verdict(id, JobEscrow.Outcome.Complete, 10_000);
        uint256 c0 = usdc.balanceOf(client);
        vm.prank(client);
        escrow.challenge(id, REASON);
        assertEq(c0 - usdc.balanceOf(client), 5 * USDC);
    }

    // ---------------- E-22 pinned slash base ----------------

    function test_E22_MinStakePinnedAtFund_MissedVerdict() public {
        uint256 id = _openAndSubmit(100 * USDC);
        assertEq(escrow.getJob(id).slashBase, 100 * USDC);
        EvaluatorRegistry.Config memory rc = registry.config();
        rc.minStake = 1_000 * USDC; // raise after fund
        vm.prank(owner);
        registry.setConfig(rc);
        vm.warp(block.timestamp + 25 hours);
        escrow.timeoutRelease(id);
        assertEq(registry.stakeOf(evaluator), 90 * USDC); // 10% of pinned 100, not of 1000
    }

    function test_E22_MinStakePinnedAtFund_Overturn() public {
        uint256 id = _openAndSubmit(100 * USDC);
        EvaluatorRegistry.Config memory rc = registry.config();
        rc.minStake = 10 * USDC;
        vm.prank(owner);
        registry.setConfig(rc);
        _verdict(id, JobEscrow.Outcome.Complete, 10_000);
        vm.prank(client);
        escrow.challenge(id, REASON);
        vm.prank(owner);
        arb.giveRuling(1, 0);
        assertEq(registry.stakeOf(evaluator), 100 * USDC - ARB_FEE - 25 * USDC);
    }

    // ---------------- A-1 EIP-3009 ----------------

    function _signAuth(
        uint256 pk,
        bytes32 typehash,
        address from,
        address to,
        uint256 value,
        uint256 va,
        uint256 vb,
        bytes32 nonce
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(typehash, from, to, value, va, vb, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_A1_EIP3009_TransferWithAuthorization() public {
        (address payer, uint256 pk) = makeAddrAndKey("payer");
        usdc.mint(payer, 10 * USDC);
        bytes32 nonce = keccak256("n1");
        bytes memory sig = _signAuth(
            pk,
            usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(),
            payer,
            outsider,
            3 * USDC,
            0,
            block.timestamp + 1 hours,
            nonce
        );
        vm.prank(evaluator2); // any relayer
        usdc.transferWithAuthorization(payer, outsider, 3 * USDC, 0, block.timestamp + 1 hours, nonce, sig);
        assertEq(usdc.balanceOf(outsider), 3 * USDC);
        assertTrue(usdc.authorizationState(payer, nonce));
        vm.expectRevert(MockUSDC.AuthorizationAlreadyUsed.selector);
        usdc.transferWithAuthorization(payer, outsider, 3 * USDC, 0, block.timestamp + 1 hours, nonce, sig);
    }

    function test_A1_EIP3009_RejectsBadSigExpiryAndValue() public {
        (address payer, uint256 pk) = makeAddrAndKey("payer");
        usdc.mint(payer, 10 * USDC);
        bytes32 th = usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH();
        bytes memory sig =
            _signAuth(pk, th, payer, outsider, 3 * USDC, 0, block.timestamp + 1 hours, bytes32(uint256(1)));
        vm.expectRevert(MockUSDC.InvalidSignature.selector);
        usdc.transferWithAuthorization(
            payer, outsider, 4 * USDC, 0, block.timestamp + 1 hours, bytes32(uint256(1)), sig
        );
        vm.warp(block.timestamp + 2 hours);
        vm.expectRevert(MockUSDC.AuthorizationExpired.selector);
        usdc.transferWithAuthorization(
            payer, outsider, 3 * USDC, 0, block.timestamp - 1 hours, bytes32(uint256(1)), sig
        );
        bytes memory sig2 = _signAuth(
            pk, th, payer, outsider, 1, block.timestamp + 1 hours, block.timestamp + 2 hours, bytes32(uint256(2))
        );
        vm.expectRevert(MockUSDC.AuthorizationNotYetValid.selector);
        usdc.transferWithAuthorization(
            payer, outsider, 1, block.timestamp + 1 hours, block.timestamp + 2 hours, bytes32(uint256(2)), sig2
        );
    }

    function test_A1_EIP3009_ReceiveWithAuthorization_CallerMustBePayee() public {
        (address payer, uint256 pk) = makeAddrAndKey("payer");
        usdc.mint(payer, 10 * USDC);
        bytes32 th = usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH();
        bytes memory sig =
            _signAuth(pk, th, payer, outsider, 2 * USDC, 0, block.timestamp + 1 hours, bytes32(uint256(7)));
        vm.expectRevert(MockUSDC.CallerMustBePayee.selector);
        usdc.receiveWithAuthorization(payer, outsider, 2 * USDC, 0, block.timestamp + 1 hours, bytes32(uint256(7)), sig);
        vm.prank(outsider);
        usdc.receiveWithAuthorization(payer, outsider, 2 * USDC, 0, block.timestamp + 1 hours, bytes32(uint256(7)), sig);
        assertEq(usdc.balanceOf(outsider), 2 * USDC);
    }

    // ---------------- A-1 deposit route ----------------

    function _offer() internal view returns (EscrowDepositRouteFactory.Offer memory) {
        return EscrowDepositRouteFactory.Offer({
            provider: provider, evaluator: evaluator, amount: 2 * USDC, deadlineSeconds: 1 days, specHash: SPEC
        });
    }

    function test_A1_Route_StandardExactPayment_OpensEscrowJob() public {
        EscrowDepositRouteFactory f = _newFactory(Defaults.ROUTE_SWEEP_DELAY, treasury);
        EscrowDepositRouteFactory.Offer memory o = _offer();
        address payTo = f.routeFor(o);
        assertEq(payTo.code.length, 0); // counterfactual

        (address payer, uint256 pk) = makeAddrAndKey("payer");
        usdc.mint(payer, 10 * USDC);
        bytes32 nonce = keccak256("x402-nonce");
        uint256 vb = block.timestamp + 10 minutes;
        bytes memory sig =
            _signAuth(pk, usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), payer, payTo, 2 * USDC, 0, vb, nonce);

        vm.prank(outsider); // facilitator
        (address route, uint256 jobId) = f.settle(o, payer, 2 * USDC, 0, vb, nonce, sig);
        assertEq(route, payTo);
        JobEscrow.Job memory j = escrow.getJob(jobId);
        assertEq(j.client, payer); // refunds and client rights go to the payer
        assertEq(j.provider, provider);
        assertEq(j.evaluator, evaluator);
        assertEq(j.amount, 2 * USDC);
        assertEq(j.deadline, block.timestamp + 1 days);
        assertEq(uint8(j.state), uint8(JobEscrow.State.Funded));
        assertEq(usdc.balanceOf(payer), 8 * USDC);
        assertEq(usdc.balanceOf(route), 0);
        vm.expectRevert(EscrowDepositRoute.AlreadySettled.selector);
        f.settle(o, payer, 2 * USDC, 0, vb, nonce, sig);
    }

    function test_A1_Route_OfferBoundIntoAddress() public {
        EscrowDepositRouteFactory f = _newFactory(Defaults.ROUTE_SWEEP_DELAY, treasury);
        EscrowDepositRouteFactory.Offer memory o = _offer();
        EscrowDepositRouteFactory.Offer memory o2 = _offer();
        o2.provider = outsider;
        assertTrue(f.routeFor(o) != f.routeFor(o2));
        (address payer, uint256 pk) = makeAddrAndKey("payer");
        usdc.mint(payer, 10 * USDC);
        uint256 vb = block.timestamp + 10 minutes;
        // signed for route(o); a facilitator cannot redirect it to route(o2)
        bytes memory sig = _signAuth(
            pk, usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), payer, f.routeFor(o), 2 * USDC, 0, vb, bytes32(uint256(5))
        );
        vm.expectRevert(MockUSDC.InvalidSignature.selector);
        f.settle(o2, payer, 2 * USDC, 0, vb, bytes32(uint256(5)), sig);
        vm.expectRevert(abi.encodeWithSelector(EscrowDepositRoute.WrongValue.selector, 1 * USDC, 2 * USDC));
        f.settle(o, payer, 1 * USDC, 0, vb, bytes32(uint256(5)), sig);
    }

    /// A-1e (v0.1.1): no front-run settle path. An authorization already executed on the token can
    /// no longer be credited by presenting it to settle (the token rejects the used nonce); the
    /// funds are credited only by k-of-n (2-of-3) keeper attestation of the Transfer log.
    function test_A1e_Route_FrontRun_SettleReverts_KeeperAttestOpensJob() public {
        EscrowDepositRouteFactory f = _newFactory(Defaults.ROUTE_SWEEP_DELAY, treasury);
        EscrowDepositRouteFactory.Offer memory o = _offer();
        address payTo = f.routeFor(o);
        (address payer, uint256 pk) = makeAddrAndKey("payer");
        usdc.mint(payer, 10 * USDC);
        uint256 vb = block.timestamp + 10 minutes;
        bytes32 nonce = bytes32(uint256(9));
        bytes memory sig =
            _signAuth(pk, usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), payer, payTo, 2 * USDC, 0, vb, nonce);
        usdc.transferWithAuthorization(payer, payTo, 2 * USDC, 0, vb, nonce, sig); // submitted to the token directly
        assertEq(usdc.balanceOf(payTo), 2 * USDC);
        vm.expectRevert(MockUSDC.AuthorizationAlreadyUsed.selector);
        f.settle(o, payer, 2 * USDC, 0, vb, nonce, sig);
        (uint256 jobId, bool refunded) = _attest2(f, o, keccak256("tx9"), 0, payer, 2 * USDC, false);
        assertFalse(refunded);
        assertEq(escrow.getJob(jobId).client, payer);
        assertEq(usdc.balanceOf(payTo), 0);
    }

    function test_A1e_Route_Attest_RefundsIfJobCannotOpen() public {
        EscrowDepositRouteFactory f = _newFactory(Defaults.ROUTE_SWEEP_DELAY, treasury);
        EscrowDepositRouteFactory.Offer memory o = _offer();
        o.evaluator = evaluator2; // not staked => createAndFundFor reverts
        address payTo = f.routeFor(o);
        (address payer, uint256 pk) = makeAddrAndKey("payer");
        usdc.mint(payer, 10 * USDC);
        uint256 vb = block.timestamp + 10 minutes;
        bytes32 nonce = bytes32(uint256(10));
        bytes memory sig =
            _signAuth(pk, usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), payer, payTo, 2 * USDC, 0, vb, nonce);
        // atomic path: whole settle reverts, payer not charged
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.EvaluatorNotActive.selector, evaluator2));
        f.settle(o, payer, 2 * USDC, 0, vb, nonce, sig);
        assertEq(usdc.balanceOf(payer), 10 * USDC);
        // funds land outside settle; keeper attestation refunds them because the job cannot open
        usdc.transferWithAuthorization(payer, payTo, 2 * USDC, 0, vb, nonce, sig);
        (uint256 jobId, bool refunded) = _attest2(f, o, keccak256("tx10"), 1, payer, 2 * USDC, false);
        assertEq(jobId, 0);
        assertTrue(refunded);
        assertEq(usdc.balanceOf(payer), 10 * USDC);
    }

    function test_A1_CreateAndFundFor_PartyChecksUseClient() public {
        vm.prank(provider);
        vm.expectRevert(JobEscrow.InvalidParty.selector);
        escrow.createAndFundFor(provider, provider, evaluator, 1 * USDC, uint64(block.timestamp + 1 days), SPEC);
        vm.prank(provider); // provider pays for outsider's job (allowed: payer != client)
        uint256 id =
            escrow.createAndFundFor(outsider, client, evaluator, 1 * USDC, uint64(block.timestamp + 1 days), SPEC);
        assertEq(escrow.getJob(id).client, outsider);
    }
}
