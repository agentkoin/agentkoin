// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BaseTest} from "./Base.t.sol";
import {AGC} from "../src/AGC.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {EscrowDepositRouteFactory} from "../src/EscrowDepositRoute.sol";
import {CrossCurrencySettler} from "../src/CrossCurrencySettler.sol";
import {ISwapRouterV3} from "../src/interfaces/ISwapRouterV3.sol";
import {MockEURC} from "../src/mocks/MockEURC.sol";
import {MockSwapRouter} from "../src/mocks/MockSwapRouter.sol";
import {AGCStackBuilder} from "../script/DeployAGC.s.sol";

/// AD-011 legal hardening (docs/AD-011_LEGAL_HARDENING_SPEC.md).
///  Fix 1: no STOS admin path forces a job outcome (except the documented arbitrator path on the already-deployed
///         USDC/EURC escrows, asserted here so it is visible); permissionless timeouts.
///  Fix 2: the relayer only forwards what the payer signed: it is never a token transfer party, its balances stay 0,
///         it cannot change amount / recipient / evaluator, and the payer can self-submit every route with the same result.
///  Fix 3: AGC wrap/unwrap 1:1 direct, no fee, no yield; AGC stack: feeBps 0, no STOS treasury, owner or arbitrator.
contract LegalHardeningTest is BaseTest, AGCStackBuilder {
    bytes32 internal constant TRANSFER_SIG = keccak256("Transfer(address,address,uint256)");
    bytes32 internal constant TWA_TH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 internal constant RWA_TH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    uint256 internal constant PRICE = 10_000; // 0.01 test USDC, the live notary price

    address internal relayer = makeAddr("relayer");
    uint256 internal payerPk = 0xA11CE5;
    address internal payer;

    EscrowDepositRouteFactory internal factory;
    MockEURC internal eurc;
    MockSwapRouter internal router;
    CrossCurrencySettler internal settler;
    Stack internal s; // AGC stack built exactly as DeployAGC builds it

    function setUp() public override {
        super.setUp();
        payer = vm.addr(payerPk);
        factory = _newFactoryK(1 days, treasury, 1);
        eurc = new MockEURC();
        router = new MockSwapRouter(owner, 0);
        vm.prank(owner);
        router.setRate(address(eurc), address(usdc), 1e18, "1:1 test fixture");
        usdc.mint(address(router), 1_000 * USDC);
        settler = new CrossCurrencySettler(ISwapRouterV3(address(router)));
        usdc.mint(payer, 100 * USDC);
        eurc.mint(payer, 100 * USDC);

        s = _buildAGCStack(
            address(usdc), escrow, factory, owner, address(this), uint64(vm.getNonce(address(this))), address(vm), 1
        );
        vm.startPrank(evaluator);
        usdc.approve(address(s.agc), type(uint256).max);
        s.agc.wrap(200 * USDC);
        IERC20(address(s.agc)).approve(address(s.registry), type(uint256).max);
        s.registry.stake(s.registry.minStake());
        vm.stopPrank();
    }

    // ---------------- helpers ----------------

    function _offer(address ev) internal view returns (EscrowDepositRouteFactory.Offer memory) {
        return EscrowDepositRouteFactory.Offer({
            provider: provider, evaluator: ev, amount: PRICE, deadlineSeconds: 3600, specHash: SPEC
        });
    }

    function _sig3009(bytes32 domain, bytes32 th, address to, uint256 value, bytes32 nonce, uint256 vb)
        internal
        view
        returns (bytes memory)
    {
        bytes32 sh = keccak256(abi.encode(th, payer, to, value, 0, vb, nonce));
        (uint8 v, bytes32 r, bytes32 ss) = vm.sign(payerPk, keccak256(abi.encodePacked("\x19\x01", domain, sh)));
        return abi.encodePacked(r, ss, v);
    }

    function _quote(address escrow_, address ev) internal view returns (CrossCurrencySettler.Quote memory) {
        return CrossCurrencySettler.Quote({
            buyer: payer,
            tokenIn: address(eurc),
            tokenOut: address(usdc),
            amountIn: PRICE,
            minOut: PRICE,
            poolFee: 500,
            expiry: uint64(block.timestamp + 300),
            quoteId: keccak256("ad011"),
            recipient: provider,
            escrow: escrow_,
            evaluator: ev,
            deadlineSeconds: 3600,
            specHash: SPEC
        });
    }

    function _signQuote(CrossCurrencySettler.Quote memory q)
        internal
        view
        returns (CrossCurrencySettler.Auth memory a)
    {
        uint256 vb = block.timestamp + 600;
        bytes32 sh = keccak256(abi.encode(RWA_TH, q.buyer, address(settler), q.amountIn, 0, vb, settler.quoteHash(q)));
        (uint8 v, bytes32 r, bytes32 ss) =
            vm.sign(payerPk, keccak256(abi.encodePacked("\x19\x01", eurc.DOMAIN_SEPARATOR(), sh)));
        a = CrossCurrencySettler.Auth({validAfter: 0, validBefore: vb, v: v, r: r, s: ss});
    }

    function _relayerBalances() internal view returns (uint256) {
        return usdc.balanceOf(relayer) + eurc.balanceOf(relayer) + IERC20(address(s.agc)).balanceOf(relayer);
    }

    /// D: relayer token balances 0 before and after, and no Transfer log names the relayer as from or to.
    function _assertRelayerNeverParty(Vm.Log[] memory logs) internal view {
        assertEq(_relayerBalances(), 0, "relayer token balance");
        bytes32 r = bytes32(uint256(uint160(relayer)));
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics.length == 3 && logs[i].topics[0] == TRANSFER_SIG) {
                assertTrue(logs[i].topics[1] != r && logs[i].topics[2] != r, "relayer is a transfer party");
            }
        }
    }

    function _jobKey(JobEscrow e, uint256 id) internal view returns (bytes32) {
        JobEscrow.Job memory j = e.getJob(id);
        return keccak256(abi.encode(j.client, j.provider, j.evaluator, j.amount, j.state, j.specHash, j.deadline));
    }

    // ---------------- Fix 2: forward-only relayer, every route ----------------

    function _exactSettle(address submitter, address ev) internal returns (uint256 id, Vm.Log[] memory logs) {
        EscrowDepositRouteFactory.Offer memory o = _offer(ev);
        address route = factory.routeFor(o);
        uint256 vb = block.timestamp + 600;
        bytes memory sig = _sig3009(usdc.DOMAIN_SEPARATOR(), TWA_TH, route, PRICE, keccak256("n1"), vb);
        vm.recordLogs();
        vm.prank(submitter);
        (, id) = factory.settle(o, payer, PRICE, 0, vb, keccak256("n1"), sig);
        logs = vm.getRecordedLogs();
    }

    function test_D_Exact_RelayerNeverHoldsTokens_AndSelfSubmitIsIdentical() public {
        assertEq(_relayerBalances(), 0);
        uint256 snap = vm.snapshotState();
        (uint256 idR, Vm.Log[] memory logs) = _exactSettle(relayer, evaluator);
        _assertRelayerNeverParty(logs);
        bytes32 viaRelayer = _jobKey(escrow, idR);
        assertEq(escrow.getJob(idR).client, payer, "client = authorizer");
        vm.revertToState(snap);
        (uint256 idP,) = _exactSettle(payer, evaluator); // C: self-submit, payer pays own gas
        assertEq(idP, idR);
        assertEq(_jobKey(escrow, idP), viaRelayer, "self-submit gives the same job");
    }

    function test_Fix2_Exact_RelayerCannotAlterAmountRecipientEvaluatorOrPayer() public {
        EscrowDepositRouteFactory.Offer memory o = _offer(evaluator);
        uint256 vb = block.timestamp + 600;
        bytes memory sig = _sig3009(usdc.DOMAIN_SEPARATOR(), TWA_TH, factory.routeFor(o), PRICE, keccak256("n"), vb);
        vm.startPrank(relayer);
        // amount: the route only takes its offer amount
        vm.expectRevert();
        factory.settle(o, payer, PRICE + 1, 0, vb, keccak256("n"), sig);
        // evaluator (or provider/amount/spec) swapped: different route address, the payer's signature names the old one
        EscrowDepositRouteFactory.Offer memory o2 = _offer(evaluator);
        o2.provider = outsider;
        vm.expectRevert();
        factory.settle(o2, payer, PRICE, 0, vb, keccak256("n"), sig);
        // payer swapped
        vm.expectRevert();
        factory.settle(o, outsider, PRICE, 0, vb, keccak256("n"), sig);
        // nonce swapped
        vm.expectRevert();
        factory.settle(o, payer, PRICE, 0, vb, keccak256("other"), sig);
        vm.stopPrank();
        assertEq(usdc.balanceOf(payer), 100 * USDC, "payer not charged");
    }

    function _swapSettle(address submitter, CrossCurrencySettler.Quote memory q)
        internal
        returns (uint256 id, Vm.Log[] memory logs)
    {
        CrossCurrencySettler.Auth memory a = _signQuote(q);
        vm.recordLogs();
        vm.prank(submitter);
        bool ok;
        (ok,, id) = settler.settle(q, a);
        assertTrue(ok, "swapped");
        logs = vm.getRecordedLogs();
    }

    function test_D_Swap_UsdcEscrow_RelayerNeverHoldsTokens_AndSelfSubmitIsIdentical() public {
        CrossCurrencySettler.Quote memory q = _quote(address(escrow), evaluator);
        uint256 snap = vm.snapshotState();
        (uint256 idR, Vm.Log[] memory logs) = _swapSettle(relayer, q);
        _assertRelayerNeverParty(logs);
        bytes32 k = _jobKey(escrow, idR);
        assertEq(escrow.getJob(idR).client, payer);
        vm.revertToState(snap);
        (uint256 idP,) = _swapSettle(payer, q);
        assertEq(_jobKey(escrow, idP), k);
        assertEq(usdc.balanceOf(address(settler)) + eurc.balanceOf(address(settler)), 0, "settler holds nothing");
    }

    function test_D_Swap_AgcAdapter_RelayerNeverHoldsTokens_AndSelfSubmitIsIdentical() public {
        CrossCurrencySettler.Quote memory q = _quote(address(s.adapter), evaluator);
        uint256 snap = vm.snapshotState();
        (uint256 idR, Vm.Log[] memory logs) = _swapSettle(relayer, q);
        _assertRelayerNeverParty(logs);
        bytes32 k = _jobKey(s.escrow, idR);
        assertEq(s.escrow.getJob(idR).client, payer);
        vm.revertToState(snap);
        (uint256 idP,) = _swapSettle(payer, q);
        assertEq(_jobKey(s.escrow, idP), k);
        assertEq(IERC20(address(s.agc)).balanceOf(address(s.adapter)), 0, "adapter holds nothing");
    }

    function test_Fix2_Swap_RelayerCannotAlterSignedQuote() public {
        CrossCurrencySettler.Quote memory q = _quote(address(escrow), evaluator);
        CrossCurrencySettler.Auth memory a = _signQuote(q);
        CrossCurrencySettler.Quote[4] memory bad;
        for (uint256 i; i < 4; i++) {
            bad[i] = q;
        }
        bad[0].minOut = 1;
        bad[1].recipient = outsider;
        bad[2].evaluator = evaluator2;
        bad[3].amountIn = PRICE * 2;
        vm.startPrank(relayer);
        for (uint256 i; i < 4; i++) {
            vm.expectRevert();
            settler.settle(bad[i], a);
        }
        vm.stopPrank();
        assertEq(eurc.balanceOf(payer), 100 * USDC, "payer not charged");
    }

    function test_D_AgcWrapWithAuthorization_Relayed_MintsToPayerOnly() public {
        uint256 vb = block.timestamp + 600;
        bytes memory sig = _sig3009(usdc.DOMAIN_SEPARATOR(), RWA_TH, address(s.agc), 5 * USDC, keccak256("w"), vb);
        vm.recordLogs();
        vm.prank(relayer);
        s.agc.wrapWithAuthorization(payer, 5 * USDC, 0, vb, keccak256("w"), sig);
        _assertRelayerNeverParty(vm.getRecordedLogs());
        assertEq(IERC20(address(s.agc)).balanceOf(payer), 5 * USDC);
    }

    function test_D_AgcExactRoute_RelayerNeverHoldsTokens_AndSelfSubmitIsIdentical() public {
        vm.startPrank(payer);
        usdc.approve(address(s.agc), 1 * USDC);
        s.agc.wrap(1 * USDC);
        vm.stopPrank();
        EscrowDepositRouteFactory.Offer memory o = _offer(evaluator);
        address route = s.factory.routeFor(o);
        uint256 vb = block.timestamp + 600;
        bytes memory sig = _sig3009(s.agc.DOMAIN_SEPARATOR(), TWA_TH, route, PRICE, keccak256("a1"), vb);
        uint256 snap = vm.snapshotState();
        vm.recordLogs();
        vm.prank(relayer);
        (, uint256 idR) = s.factory.settle(o, payer, PRICE, 0, vb, keccak256("a1"), sig);
        _assertRelayerNeverParty(vm.getRecordedLogs());
        bytes32 k = _jobKey(s.escrow, idR);
        vm.revertToState(snap);
        vm.prank(payer);
        (, uint256 idP) = s.factory.settle(o, payer, PRICE, 0, vb, keccak256("a1"), sig);
        assertEq(_jobKey(s.escrow, idP), k);
    }

    function test_D_Finalize_IsPermissionless_RelayerGetsNothing() public {
        (uint256 id,) = _exactSettle(relayer, evaluator);
        vm.prank(provider);
        escrow.submit(id, DELIVERABLE);
        _verdict(id, JobEscrow.Outcome.Complete, 10_000);
        _passChallengeWindow();
        vm.recordLogs();
        vm.prank(relayer);
        escrow.finalize(id);
        _assertRelayerNeverParty(vm.getRecordedLogs());
    }

    // ---------------- Fix 1: no forced outcome by an admin ----------------

    function test_Fix1_OwnerCannotDecideAJob() public {
        (uint256 id,) = _exactSettle(payer, evaluator);
        vm.prank(provider);
        escrow.submit(id, DELIVERABLE);
        vm.startPrank(owner);
        vm.expectRevert(JobEscrow.Unauthorized.selector);
        escrow.verdict(id, JobEscrow.Outcome.Reject, 0, REASON);
        vm.expectRevert(JobEscrow.Unauthorized.selector);
        escrow.complete(id, REASON);
        vm.expectRevert(); // rule(): only the dispute's arbitrator, only while Disputed
        escrow.rule(id, 0);
        // a new config version does not touch this job (pinned at creation)
        uint32 v = escrow.getJob(id).configVersion;
        escrow.setConfig(escrow.currentConfig());
        vm.stopPrank();
        assertEq(escrow.getJob(id).configVersion, v);
        assertGt(escrow.currentConfigVersion(), v);
    }

    function test_Fix1_TimeoutsArePermissionless() public {
        (uint256 id,) = _exactSettle(payer, evaluator);
        (uint256 id2,) = _exactSettle2();
        vm.prank(provider);
        escrow.submit(id, DELIVERABLE);
        vm.warp(block.timestamp + escrow.currentConfig().evalWindow + 1);
        uint256 b = usdc.balanceOf(payer);
        vm.prank(outsider);
        escrow.timeoutRelease(id); // evaluator went dark: client refunded by contract rule
        assertEq(usdc.balanceOf(payer) - b, PRICE);
        vm.warp(block.timestamp + 3601);
        vm.prank(outsider);
        escrow.claimRefund(id2); // provider never delivered
        assertEq(uint8(escrow.getJob(id2).state), uint8(JobEscrow.State.Expired));
    }

    function _exactSettle2() internal returns (uint256 id, Vm.Log[] memory logs) {
        EscrowDepositRouteFactory.Offer memory o = _offer(evaluator);
        uint256 vb = block.timestamp + 600;
        bytes memory sig = _sig3009(usdc.DOMAIN_SEPARATOR(), TWA_TH, factory.routeFor(o), PRICE, keccak256("n2"), vb);
        vm.prank(payer);
        (, id) = factory.settle(o, payer, PRICE, 0, vb, keccak256("n2"), sig);
        logs = new Vm.Log[](0);
    }

    /// Documented, not desired: on the already-deployed USDC/EURC escrows the arbitrator is a MockArbitrator whose owner
    /// is the deployer. After a client/provider challenge, that owner decides the payout. This test keeps it visible.
    function test_Fix1_Documented_ExistingStackArbitratorOwnerRulesChallengedJobs() public {
        (uint256 id,) = _exactSettle(payer, evaluator);
        vm.prank(provider);
        escrow.submit(id, DELIVERABLE);
        _verdict(id, JobEscrow.Outcome.Complete, 10_000);
        assertEq(arb.owner(), owner);
        vm.prank(owner);
        vm.expectRevert(); // owner alone cannot open a dispute
        escrow.challenge(id, REASON);
        assertEq(address(escrow.arbitrator()), address(arb), "existing stack: owner-controlled arbitrator");
        // once the client challenges, the arbitrator owner's ruling decides the split
        vm.startPrank(payer);
        usdc.approve(address(escrow), type(uint256).max);
        escrow.challenge(id, REASON);
        vm.stopPrank();
        uint256 disputeId = escrow.getDispute(id).disputeId;
        vm.prank(owner);
        arb.giveRuling(disputeId, 0);
        assertEq(uint8(escrow.getJob(id).state), uint8(JobEscrow.State.Settled));
        assertEq(escrow.getJob(id).payoutBps, 0, "owner-run arbitrator overturned the verdict");
    }

    function test_Fix1_Fix3_AgcStack_NoAdmin_NoArbitrator_NoStosRecipient_Fee0() public {
        address none = NO_RECIPIENT;
        assertEq(s.escrow.owner(), none, "escrow owner");
        assertEq(s.registry.owner(), none, "registry owner");
        assertEq(s.escrow.treasury(), none, "escrow treasury");
        assertEq(s.registry.config().treasury, none, "registry treasury");
        assertEq(s.factory.vault().treasury(), none, "vault treasury");
        assertEq(address(s.escrow.arbitrator()), address(0), "no arbitrator");
        assertEq(s.escrow.currentConfig().feeBps, 0, "feeBps");
        assertTrue(s.escrow.owner() != owner && s.registry.owner() != owner);
        // challenge cannot route an outcome anywhere; the evaluator's verdict stands, then permissionless finalize
        vm.startPrank(payer);
        usdc.approve(address(s.agc), 1 * USDC);
        s.agc.wrap(1 * USDC);
        IERC20(address(s.agc)).approve(address(s.escrow), PRICE);
        uint256 id = s.escrow.createAndFund(provider, evaluator, PRICE, uint64(block.timestamp + 3600), SPEC);
        vm.stopPrank();
        vm.prank(provider);
        s.escrow.submit(id, DELIVERABLE);
        vm.prank(evaluator);
        s.escrow.verdict(id, JobEscrow.Outcome.Complete, 10_000, REASON);
        vm.prank(payer);
        vm.expectRevert(JobEscrow.NoArbitrator.selector);
        s.escrow.challenge(id, REASON);
        vm.prank(owner);
        vm.expectRevert();
        s.escrow.setArbitrator(arb);
        _passChallengeWindow();
        uint256 p0 = IERC20(address(s.agc)).balanceOf(provider);
        s.escrow.finalize(id);
        uint256 evFee = (PRICE * s.escrow.currentConfig().evaluatorFeeBps) / 10_000; // to the job's evaluator only
        assertEq(IERC20(address(s.agc)).balanceOf(provider) - p0, PRICE - evFee, "no protocol fee");
        assertEq(IERC20(address(s.agc)).balanceOf(none), 0, "nothing to the no-recipient address");
    }

    // ---------------- Fix 3: AGC direct 1:1, no fee, no yield ----------------

    function test_Fix3_AgcWrapUnwrap_Direct_1to1_NoFee_NoYield() public {
        uint256 amt = 123_457;
        uint256 u0 = usdc.balanceOf(payer);
        vm.startPrank(payer);
        usdc.approve(address(s.agc), amt);
        s.agc.wrap(amt); // no STOS approval, no STOS signature
        vm.stopPrank();
        assertEq(IERC20(address(s.agc)).balanceOf(payer), amt, "1:1 mint");
        assertEq(u0 - usdc.balanceOf(payer), amt, "no wrap fee");
        vm.warp(block.timestamp + 365 days);
        vm.roll(block.number + 1_000_000);
        assertEq(IERC20(address(s.agc)).balanceOf(payer), amt, "no yield / rebase");
        vm.prank(payer);
        s.agc.unwrap(amt);
        assertEq(usdc.balanceOf(payer), u0, "1:1 redeem, no fee");
        assertEq(s.agc.totalSupply(), usdc.balanceOf(address(s.agc)) - s.agc.surplus());
        string[9] memory noSuch = [
            "claim()",
            "claimRewards()",
            "earned(address)",
            "rewards(address)",
            "accrueInterest()",
            "rebase()",
            "yield()",
            "interestRate()",
            "setFee(uint256)"
        ];
        for (uint256 i; i < noSuch.length; i++) {
            (bool ok,) = address(s.agc).call(abi.encodeWithSignature(noSuch[i]));
            assertFalse(ok, noSuch[i]);
        }
    }
}
