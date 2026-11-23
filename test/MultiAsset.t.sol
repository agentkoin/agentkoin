// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BaseTest} from "./Base.t.sol";
import {MockEURC} from "../src/mocks/MockEURC.sol";
import {MockSwapRouter} from "../src/mocks/MockSwapRouter.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {EvaluatorRegistry} from "../src/EvaluatorRegistry.sol";
import {IEvaluatorRegistry} from "../src/interfaces/IEvaluatorRegistry.sol";
import {IArbitrator} from "../src/interfaces/IArbitrator.sol";
import {Defaults} from "../script/Defaults.sol";
import {CrossCurrencySettler} from "../src/CrossCurrencySettler.sol";
import {ISwapRouterV3} from "../src/interfaces/ISwapRouterV3.sol";

/// Router that reports success but delivers less than amountOutMinimum (settler must not trust the return value).
contract ShortFillRouter is ISwapRouterV3 {
    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256) {
        IERC20(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
        IERC20(p.tokenOut).transfer(p.recipient, p.amountOutMinimum - 1);
        return p.amountOutMinimum;
    }
}

/// AD-009 Phase 1: EURC escrow instance (same JobEscrow bytecode, token = EURC) and CrossCurrencySettler
/// (buyer pays EURC, seller receives USDC directly or as a USDC escrow job).
contract MultiAssetTest is BaseTest {
    MockEURC internal eurc;
    JobEscrow internal eurcEscrow;
    MockSwapRouter internal router;
    CrossCurrencySettler internal settler;

    uint256 internal buyerPk = 0xB0B;
    address internal buyer;
    address internal seller = makeAddr("seller");

    uint256 internal constant RATE = 1.0175e18; // 1 EURC = 1.0175 USDC (mock; same order as the Base Sepolia pool)

    function setUp() public override {
        super.setUp();
        buyer = vm.addr(buyerPk);
        eurc = new MockEURC();
        eurcEscrow = new JobEscrow(
            IERC20(address(eurc)), IEvaluatorRegistry(address(registry)), treasury, IArbitrator(address(arb)), Defaults.escrowConfig(), owner, owner, type(uint256).max, type(uint256).max
        );
        router = new MockSwapRouter(owner, 0);
        vm.prank(owner);
        router.setRate(address(eurc), address(usdc), RATE, "test fixture");
        usdc.mint(address(router), 1_000 * USDC); // mock liquidity from test tokens
        settler = new CrossCurrencySettler(ISwapRouterV3(address(router)));
        eurc.mint(buyer, 1_000 * USDC);
        eurc.mint(client, 1_000 * USDC);
    }

    // ---------------- helpers ----------------

    function _q(uint256 amountIn, uint256 minOut, address escrow_) internal view returns (CrossCurrencySettler.Quote memory q) {
        q = CrossCurrencySettler.Quote({
            buyer: buyer,
            tokenIn: address(eurc),
            tokenOut: address(usdc),
            amountIn: amountIn,
            minOut: minOut,
            poolFee: 500,
            expiry: uint64(block.timestamp + 300),
            quoteId: keccak256("quote-1"),
            recipient: seller,
            escrow: escrow_,
            evaluator: escrow_ == address(0) ? address(0) : evaluator,
            deadlineSeconds: escrow_ == address(0) ? 0 : 3600,
            specHash: escrow_ == address(0) ? bytes32(0) : SPEC
        });
    }

    function _sign(CrossCurrencySettler.Quote memory q) internal view returns (CrossCurrencySettler.Auth memory a) {
        bytes32 nonce = settler.quoteHash(q);
        uint256 vb = block.timestamp + 600;
        bytes32 sh = keccak256(abi.encode(eurc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), q.buyer, address(settler), q.amountIn, 0, vb, nonce));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(buyerPk, keccak256(abi.encodePacked("\x19\x01", eurc.DOMAIN_SEPARATOR(), sh)));
        a = CrossCurrencySettler.Auth({validAfter: 0, validBefore: vb, v: v, r: r, s: s});
    }

    function _enableEurcEscrowSlasher() internal {
        vm.prank(owner);
        registry.proposeSlasher(address(eurcEscrow), true);
        vm.warp(block.timestamp + Defaults.SLASHER_TIMELOCK + 1);
        registry.executeSlasher(address(eurcEscrow));
    }

    // ---------------- multi-asset escrow (EURC instance) ----------------

    function test_EurcEscrow_RequiresSlasherBeforeUse() public {
        vm.startPrank(client);
        eurc.approve(address(eurcEscrow), type(uint256).max);
        vm.expectRevert();
        eurcEscrow.createAndFund(provider, evaluator, 10 * USDC, uint64(block.timestamp + 3 days), SPEC);
        vm.stopPrank();
    }

    function test_EurcEscrow_HappyPath_PaysInEurc() public {
        _enableEurcEscrowSlasher();
        uint256 usdcEscrowBal = usdc.balanceOf(address(escrow));
        vm.startPrank(client);
        eurc.approve(address(eurcEscrow), type(uint256).max);
        uint256 id = eurcEscrow.createAndFund(provider, evaluator, 100 * USDC, uint64(block.timestamp + 3 days), SPEC);
        vm.stopPrank();
        vm.prank(provider);
        eurcEscrow.submit(id, DELIVERABLE);
        vm.prank(evaluator);
        eurcEscrow.verdict(id, JobEscrow.Outcome.Complete, 10_000, REASON);
        _passChallengeWindow();
        eurcEscrow.finalize(id);
        assertEq(eurc.balanceOf(provider), 98.5e6);
        assertEq(eurc.balanceOf(treasury), 1 * USDC);
        assertEq(eurc.balanceOf(address(eurcEscrow)), 0);
        assertEq(usdc.balanceOf(address(escrow)), usdcEscrowBal, "USDC escrow untouched");
        assertEq(address(eurcEscrow.token()), address(eurc));
    }

    // ---------------- cross-currency settle ----------------

    function test_Swap_Direct_Success() public {
        CrossCurrencySettler.Quote memory q = _q(10_000, 10_000, address(0));
        CrossCurrencySettler.Auth memory a = _sign(q);
        uint256 b0 = eurc.balanceOf(buyer);
        (bool ok, uint256 out, uint256 jobId) = settler.settle(q, a);
        assertTrue(ok);
        assertEq(out, 10_175);
        assertEq(jobId, 0);
        assertEq(usdc.balanceOf(seller), 10_175);
        assertEq(b0 - eurc.balanceOf(buyer), 10_000);
        assertEq(eurc.balanceOf(address(settler)), 0);
        assertEq(usdc.balanceOf(address(settler)), 0);
        assertEq(eurc.allowance(address(settler), address(router)), 0);
    }

    function test_Swap_Escrow_OpensUsdcJobForBuyer_AndFinalizes() public {
        CrossCurrencySettler.Quote memory q = _q(1_000_000, 1_000_000, address(escrow));
        CrossCurrencySettler.Auth memory a = _sign(q);
        (bool ok, uint256 out, uint256 id) = settler.settle(q, a);
        assertTrue(ok);
        assertEq(out, 1_017_500);
        JobEscrow.Job memory j = escrow.getJob(id);
        assertEq(j.client, buyer);
        assertEq(j.provider, seller);
        assertEq(j.amount, out);
        assertEq(usdc.balanceOf(address(settler)), 0);
        vm.prank(seller);
        escrow.submit(id, DELIVERABLE);
        _verdict(id, JobEscrow.Outcome.Complete, 10_000);
        _passChallengeWindow();
        escrow.finalize(id);
        assertGt(usdc.balanceOf(seller), 0);
    }

    function test_Swap_MinOutNotMet_RefundsBuyer() public {
        CrossCurrencySettler.Quote memory q = _q(10_000, 10_176, address(0)); // mock fills 10_175
        CrossCurrencySettler.Auth memory a = _sign(q);
        uint256 b0 = eurc.balanceOf(buyer);
        vm.expectEmit(true, true, true, false, address(settler));
        emit CrossCurrencySettler.SwapFailedRefunded(settler.quoteHash(q), q.quoteId, buyer, address(eurc), 10_000, "");
        (bool ok, uint256 out,) = settler.settle(q, a);
        assertFalse(ok);
        assertEq(out, 0);
        assertEq(eurc.balanceOf(buyer), b0, "buyer refunded in full");
        assertEq(usdc.balanceOf(seller), 0);
        assertEq(eurc.balanceOf(address(settler)), 0);
        assertTrue(eurc.authorizationState(buyer, settler.quoteHash(q)), "authorization consumed; new quote needed");
    }

    function test_Swap_RouterReverts_RefundsBuyer() public {
        vm.prank(owner);
        router.setPaused(true);
        CrossCurrencySettler.Quote memory q = _q(10_000, 10_000, address(0));
        uint256 b0 = eurc.balanceOf(buyer);
        (bool ok,,) = settler.settle(q, _sign(q));
        assertFalse(ok);
        assertEq(eurc.balanceOf(buyer), b0);
    }

    function test_Swap_NoLiquidity_RefundsBuyer() public {
        CrossCurrencySettler.Quote memory q = _q(990 * USDC, 1, address(0)); // needs ~1007 USDC, router holds 1000
        uint256 b0 = eurc.balanceOf(buyer);
        (bool ok,,) = settler.settle(q, _sign(q));
        assertFalse(ok);
        assertEq(eurc.balanceOf(buyer), b0);
    }

    function test_Swap_ExpiredQuote_Rejected_NoFundsMove() public {
        CrossCurrencySettler.Quote memory q = _q(10_000, 10_000, address(0));
        CrossCurrencySettler.Auth memory a = _sign(q);
        vm.warp(q.expiry + 1);
        uint256 b0 = eurc.balanceOf(buyer);
        vm.expectRevert(abi.encodeWithSelector(CrossCurrencySettler.QuoteExpired.selector, q.expiry, block.timestamp));
        settler.settle(q, a);
        assertEq(eurc.balanceOf(buyer), b0);
        assertFalse(eurc.authorizationState(buyer, settler.quoteHash(q)));
    }

    function test_Swap_TamperedQuote_Reverts() public {
        CrossCurrencySettler.Quote memory q = _q(10_000, 10_000, address(0));
        CrossCurrencySettler.Auth memory a = _sign(q);
        q.minOut = 1; // relayer tries to lower the seller floor
        vm.expectRevert();
        settler.settle(q, a);
        q.minOut = 10_000;
        q.recipient = outsider; // or redirect proceeds
        vm.expectRevert();
        settler.settle(q, a);
    }

    function test_Swap_Replay_Reverts() public {
        CrossCurrencySettler.Quote memory q = _q(10_000, 10_000, address(0));
        CrossCurrencySettler.Auth memory a = _sign(q);
        settler.settle(q, a);
        vm.expectRevert();
        settler.settle(q, a);
    }

    function test_Swap_ShortFill_RevertsAtomically() public {
        ShortFillRouter bad = new ShortFillRouter();
        usdc.mint(address(bad), 1_000 * USDC);
        settler = new CrossCurrencySettler(ISwapRouterV3(address(bad)));
        CrossCurrencySettler.Quote memory q = _q(10_000, 10_000, address(0));
        CrossCurrencySettler.Auth memory a = _sign(q);
        uint256 b0 = eurc.balanceOf(buyer);
        vm.expectRevert(abi.encodeWithSelector(CrossCurrencySettler.MinOutNotMet.selector, 10_000, 9_999));
        settler.settle(q, a);
        assertEq(eurc.balanceOf(buyer), b0);
    }

    function test_Swap_InvalidQuote_Reverts() public {
        CrossCurrencySettler.Quote memory q = _q(10_000, 0, address(0));
        CrossCurrencySettler.Auth memory a = _sign(q);
        vm.expectRevert(CrossCurrencySettler.InvalidQuote.selector);
        settler.settle(q, a);
        q = _q(10_000, 10_000, address(escrow));
        q.evaluator = address(0);
        a = _sign(q);
        vm.expectRevert(CrossCurrencySettler.InvalidQuote.selector);
        settler.settle(q, a);
    }

    function test_QuoteHash_IsAbiEncodeOfAllFields() public view {
        CrossCurrencySettler.Quote memory q = _q(10_000, 10_000, address(escrow));
        bytes memory a = abi.encode(settler.QUOTE_TYPEHASH(), block.chainid, address(settler), address(router), q.buyer);
        bytes memory b = abi.encode(q.tokenIn, q.tokenOut, q.amountIn, q.minOut, q.poolFee, q.expiry);
        bytes memory c = abi.encode(q.quoteId, q.recipient, q.escrow, q.evaluator, q.deadlineSeconds, q.specHash);
        bytes32 expect = keccak256(bytes.concat(a, b, c)); // == abi.encode of all 17 static words
        assertEq(settler.quoteHash(q), expect);
    }

    // ---------------- USDC regression ----------------

    function test_UsdcRegression_HappyPathUnchanged() public {
        _enableEurcEscrowSlasher();
        uint256 id = _openAndSubmit(100 * USDC);
        _verdict(id, JobEscrow.Outcome.Complete, 10_000);
        uint256 p0 = usdc.balanceOf(provider);
        _passChallengeWindow();
        escrow.finalize(id);
        assertEq(usdc.balanceOf(provider) - p0, 98.5e6);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(eurc.balanceOf(provider), 0);
    }
}
