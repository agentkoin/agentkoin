// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CrossCurrencySettler} from "../../src/CrossCurrencySettler.sol";
import {ISwapRouterV3} from "../../src/interfaces/ISwapRouterV3.sol";

interface IEip3009Domain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

interface IQuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory p)
        external
        returns (uint256 amountOut, uint160, uint32, uint256);
}

/// Local fork of Base Sepolia (read-only RPC; nothing is broadcast). Runs only with FORK_BASE_SEPOLIA_RPC set:
///   FORK_BASE_SEPOLIA_RPC=https://sepolia.base.org forge test --match-path test/fork/CrossCurrencyFork.t.sol
/// Uses the real Circle EURC/USDC tokens, the Uniswap v3 EURC/USDC 0.05% pool via SwapRouter02, and the live
/// AgentCoin USDC JobEscrow (escrow mode).
contract CrossCurrencyForkTest is Test {
    address constant EURC = 0x808456652fdb597867f38412077A9182bf77359F;
    address constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address constant ROUTER = 0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4; // SwapRouter02
    address constant QUOTER = 0xC5290058841028F1614F3A6F0F5816cAd0df5E27; // QuoterV2
    address constant ESCROW = 0x4EaF6d09F8C22980Bb16E719779ACe73A7b1CB3D; // AgentCoin USDC JobEscrow
    address constant EVALUATOR = 0xfb0159725FB6169f676ebFd2FA0Ac2C3A184509a;
    address constant PROVIDER = 0x745528C4E0CBdA5759175A660da06d0aaA72db7F;
    bytes32 constant RECEIVE_TH = 0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8;

    CrossCurrencySettler settler;
    uint256 buyerPk = 0xA11CE;
    address buyer;
    bool enabled;

    function setUp() public {
        string memory rpc = vm.envOr("FORK_BASE_SEPOLIA_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        enabled = true;
        vm.createSelectFork(rpc);
        buyer = vm.addr(buyerPk);
        settler = new CrossCurrencySettler(ISwapRouterV3(ROUTER));
        deal(EURC, buyer, 1_000_000); // 1 test EURC on the local fork only
    }

    function _quote(uint256 amountIn) internal returns (uint256 out) {
        (out,,,) = IQuoterV2(QUOTER).quoteExactInputSingle(
            IQuoterV2.QuoteExactInputSingleParams({tokenIn: EURC, tokenOut: USDC, amountIn: amountIn, fee: 500, sqrtPriceLimitX96: 0})
        );
    }

    function _q(uint256 amountIn, uint256 minOut, address escrow) internal view returns (CrossCurrencySettler.Quote memory) {
        return CrossCurrencySettler.Quote({
            buyer: buyer,
            tokenIn: EURC,
            tokenOut: USDC,
            amountIn: amountIn,
            minOut: minOut,
            poolFee: 500,
            expiry: uint64(block.timestamp + 300),
            quoteId: keccak256("fork"),
            recipient: PROVIDER,
            escrow: escrow,
            evaluator: escrow == address(0) ? address(0) : EVALUATOR,
            deadlineSeconds: escrow == address(0) ? 0 : 3600,
            specHash: escrow == address(0) ? bytes32(0) : keccak256("fork-spec")
        });
    }

    function _sign(CrossCurrencySettler.Quote memory q) internal view returns (CrossCurrencySettler.Auth memory) {
        bytes32 nonce = settler.quoteHash(q);
        uint256 vb = block.timestamp + 600;
        bytes32 sh = keccak256(abi.encode(RECEIVE_TH, q.buyer, address(settler), q.amountIn, 0, vb, nonce));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(buyerPk, keccak256(abi.encodePacked("\x19\x01", IEip3009Domain(EURC).DOMAIN_SEPARATOR(), sh)));
        return CrossCurrencySettler.Auth({validAfter: 0, validBefore: vb, v: v, r: r, s: s});
    }

    function test_Fork_EurcToUsdc_Direct() public {
        if (!enabled) return;
        uint256 expected = _quote(10_000);
        uint256 minOut = expected * 99 / 100;
        uint256 p0 = IERC20(USDC).balanceOf(PROVIDER);
        CrossCurrencySettler.Quote memory q = _q(10_000, minOut, address(0));
        (bool ok, uint256 out,) = settler.settle(q, _sign(q));
        assertTrue(ok);
        assertEq(out, expected);
        assertEq(IERC20(USDC).balanceOf(PROVIDER) - p0, out);
        emit log_named_uint("fork EURC->USDC out for 10000", out);
    }

    function test_Fork_EurcToUsdc_EscrowJob() public {
        if (!enabled) return;
        uint256 expected = _quote(10_000);
        CrossCurrencySettler.Quote memory q = _q(10_000, expected * 99 / 100, ESCROW);
        uint256 g = gasleft();
        (bool ok, uint256 out, uint256 jobId) = settler.settle(q, _sign(q));
        emit log_named_uint("fork settle (escrow mode) gas", g - gasleft());
        assertTrue(ok);
        assertGt(jobId, 0);
        assertEq(out, expected);
    }

    function test_Fork_MinOutTooHigh_Refunds() public {
        if (!enabled) return;
        uint256 expected = _quote(10_000);
        CrossCurrencySettler.Quote memory q = _q(10_000, expected + 1, address(0));
        uint256 b0 = IERC20(EURC).balanceOf(buyer);
        (bool ok,,) = settler.settle(q, _sign(q));
        assertFalse(ok);
        assertEq(IERC20(EURC).balanceOf(buyer), b0);
    }
}
