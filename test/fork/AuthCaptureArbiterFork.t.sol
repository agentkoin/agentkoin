// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EvaluatorRegistry} from "../../src/EvaluatorRegistry.sol";
import {IEvaluatorRegistry} from "../../src/interfaces/IEvaluatorRegistry.sol";
import {IArbitrator} from "../../src/interfaces/IArbitrator.sol";
import {MockArbitrator} from "../../src/mocks/MockArbitrator.sol";
import {IAuthCaptureEscrow} from "../../src/arbiter/IAuthCaptureEscrow.sol";
import {AgentKoinAuthCaptureArbiter as Arb} from "../../src/arbiter/AgentKoinAuthCaptureArbiter.sol";
import {ArbiterTestBase} from "../arbiter/ArbiterTestLib.sol";

/// Local Anvil fork of Base Sepolia (read-only RPC; nothing is broadcast).
///   FORK_BASE_SEPOLIA_RPC=https://sepolia.base.org forge test --match-path test/fork/AuthCaptureArbiterFork.t.sol -vv
/// Uses the LIVE canonical commerce-payments v1.1 AuthCaptureEscrow + ERC3009PaymentCollector, Circle test
/// USDC (real EIP-3009 receiveWithAuthorization) and the live AgentKoin EvaluatorRegistry. Arbiters are
/// deployed only inside the fork; the registry owner is impersonated in the fork for propose/executeSlasher.
/// Keys are anvil defaults (well-known, never funded on a real network).
contract AuthCaptureArbiterForkTest is ArbiterTestBase {
    address constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address constant AC_ESCROW = 0xf96815976523E00e65Be8f34cA5e64b4f41EB19c; // commerce-payments v1.1
    address constant ERC3009_COLLECTOR = 0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88; // v1.1
    address constant REGISTRY = 0x30576DE005df028D1947C56dEcc85a2a5612036a;
    address constant OWNER = 0x78e2C0164A80F3e337AE17e3bA4b8EA2C0Fa488e;

    uint256 constant PAYER_KEY = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d; // anvil #1
    address constant EVALUATOR = 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC; // anvil #2

    IAuthCaptureEscrow escrow = IAuthCaptureEscrow(AC_ESCROW);
    EvaluatorRegistry registry = EvaluatorRegistry(REGISTRY);
    MockArbitrator arb;
    Arb arbiter;
    address payer;
    address receiver = makeAddr("fork-receiver");
    uint120 constant AMOUNT = 1e6;
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
            minChallengeBond: 0.5e6
        });
    }

    function setUp() public {
        string memory rpc = vm.envOr("FORK_BASE_SEPOLIA_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        assertEq(block.chainid, 84532);
        assertGt(AC_ESCROW.code.length, 0);
        assertGt(ERC3009_COLLECTOR.code.length, 0);
        assertEq(address(registry.token()), USDC);

        payer = vm.addr(PAYER_KEY);
        arb = new MockArbitrator(address(this), 0);
        arbiter = new Arb(escrow, IEvaluatorRegistry(REGISTRY), IArbitrator(address(arb)), IERC20(USDC), AMOUNT, _cfg());
        vm.prank(OWNER);
        registry.proposeSlasher(address(arbiter), true);
        vm.warp(block.timestamp + registry.slasherTimelock());
        registry.executeSlasher(address(arbiter));
        assertTrue(registry.isSlasher(address(arbiter)));

        uint256 minStake = registry.minStake();
        deal(USDC, payer, 10e6);
        deal(USDC, EVALUATOR, minStake);
        vm.startPrank(EVALUATOR);
        IERC20(USDC).approve(REGISTRY, minStake);
        registry.stake(minStake);
        vm.stopPrank();
        assertTrue(registry.isActive(EVALUATOR));
        vm.prank(payer);
        IERC20(USDC).approve(address(arbiter), type(uint256).max);
    }

    function _submitted(uint256 nonce) internal returns (IAuthCaptureEscrow.PaymentInfo memory p, bytes32 h) {
        uint48 t0 = uint48(block.timestamp);
        Arb.Terms memory t = _terms(EVALUATOR, t0 + 1 hours, EVAL);
        p = _paymentInfo(arbiter, payer, receiver, USDC, AMOUNT, t0 + 10 minutes, t0 + 3 days, t, nonce);
        bytes memory sig = _sign3009(escrow, USDC, PAYER_KEY, ERC3009_COLLECTOR, p);
        vm.prank(makeAddr("facilitator"));
        arbiter.authorize(p, AMOUNT, ERC3009_COLLECTOR, sig);
        h = escrow.getHash(p);
        (, uint120 c,) = escrow.paymentState(h);
        assertEq(c, AMOUNT, "held in live AuthCaptureEscrow");
        vm.prank(EVALUATOR);
        arbiter.bindTerms(p, t, nonce);
        vm.prank(receiver);
        arbiter.submit(p, keccak256("deliverable"), RD);
    }

    function _verdictFinalize(IAuthCaptureEscrow.PaymentInfo memory p, uint16 mask, uint8 rp) internal {
        vm.prank(EVALUATOR);
        arbiter.verdictScheduled(p, mask, 4, rp, RD, keccak256("fork-receipt"));
        vm.warp(block.timestamp + 10 minutes + 1);
        arbiter.finalize(p);
    }

    function testFork_Mask15_FullCapture() public {
        (IAuthCaptureEscrow.PaymentInfo memory p, bytes32 h) = _submitted(1);
        _verdictFinalize(p, 0xF, 4);
        assertEq(IERC20(USDC).balanceOf(receiver), AMOUNT);
        assertEq(IERC20(USDC).balanceOf(payer), 10e6 - AMOUNT);
        (, uint120 c, uint120 r) = escrow.paymentState(h);
        assertEq(c, 0);
        assertEq(r, AMOUNT);
        assertEq(IERC20(USDC).balanceOf(address(arbiter)), 0);
    }

    function testFork_Mask7_Partial7500_CaptureThenVoid() public {
        (IAuthCaptureEscrow.PaymentInfo memory p,) = _submitted(2);
        _verdictFinalize(p, 0x7, 3);
        assertEq(IERC20(USDC).balanceOf(receiver), 0.75e6);
        assertEq(IERC20(USDC).balanceOf(payer), 10e6 - 0.75e6);
    }

    function testFork_Mask0_VoidOnly() public {
        (IAuthCaptureEscrow.PaymentInfo memory p,) = _submitted(3);
        _verdictFinalize(p, 0, 0);
        assertEq(IERC20(USDC).balanceOf(receiver), 0);
        assertEq(IERC20(USDC).balanceOf(payer), 10e6);
    }

    function testFork_MissedVerdict_SlashOnLiveRegistry_FullVoid() public {
        (IAuthCaptureEscrow.PaymentInfo memory p,) = _submitted(4);
        uint256 stakeBefore = registry.stakeOf(EVALUATOR);
        vm.warp(block.timestamp + EVAL + 1);
        arbiter.timeoutRelease(p);
        assertEq(registry.stakeOf(EVALUATOR), stakeBefore - (registry.minStake() * 1000) / 10_000);
        assertEq(IERC20(USDC).balanceOf(payer), 10e6);
    }

    function testFork_Challenge_Overturn_RuledBps() public {
        (IAuthCaptureEscrow.PaymentInfo memory p,) = _submitted(5);
        vm.prank(EVALUATOR);
        arbiter.verdictScheduled(p, 0x7, 4, 3, RD, keccak256("r")); // 7500
        vm.prank(payer);
        arbiter.challenge(p, keccak256("c"));
        uint256 stakeBefore = registry.stakeOf(EVALUATOR);
        arb.giveRuling(1, 2500);
        assertEq(IERC20(USDC).balanceOf(receiver), 0.25e6);
        assertEq(registry.stakeOf(EVALUATOR), stakeBefore - (registry.minStake() * 2500) / 10_000);
        assertEq(IERC20(USDC).balanceOf(address(arbiter)), 0);
    }
}
