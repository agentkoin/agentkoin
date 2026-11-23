// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ISwapRouterV3} from "./interfaces/ISwapRouterV3.sol";

interface IERC3009Receive {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

interface IJobEscrowFundFor {
    function createAndFundFor(
        address client,
        address provider,
        address evaluator,
        uint256 amount,
        uint64 deadline,
        bytes32 specHash
    ) external returns (uint256 jobId);
}

/// @title CrossCurrencySettler
/// @notice Pay-in-one-stablecoin, receive-in-another (AD-009 Phase 1, testnet). The buyer signs one EIP-3009
///         ReceiveWithAuthorization for `amountIn` of `tokenIn` with `nonce = quoteHash(q)`, which binds the whole
///         quote (tokens, amounts, minOut, expiry, recipient, escrow terms) to the buyer's signature.
///         settle(): rejects expired quotes before moving funds, pulls tokenIn, swaps through `router` with
///         amountOutMinimum = minOut, then either pays `recipient` directly (escrow == 0) or opens a JobEscrow job
///         in tokenOut with client = buyer (escrow != 0). If the swap call reverts (minOut not met, no liquidity,
///         router failure) the pulled tokenIn is returned to the buyer in the same transaction.
/// @dev Holds no funds between transactions. No owner, no admin, no fee. Router is immutable.
contract CrossCurrencySettler is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Quote {
        address buyer;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minOut;
        uint24 poolFee;
        uint64 expiry; // unix seconds; settle reverts after this
        bytes32 quoteId; // service-issued identifier, recorded in events and receipts
        address recipient; // seller (direct) or escrow provider
        address escrow; // zero = direct payment to recipient; else JobEscrow whose token == tokenOut
        address evaluator; // escrow mode only
        uint64 deadlineSeconds; // escrow mode only: job deadline = block.timestamp + deadlineSeconds
        bytes32 specHash; // escrow mode only
    }

    /// @notice Buyer's EIP-3009 ReceiveWithAuthorization signature over (buyer -> settler, amountIn, nonce = quoteHash).
    struct Auth {
        uint256 validAfter;
        uint256 validBefore;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "AgentCoinQuote(uint256 chainId,address settler,address router,address buyer,address tokenIn,address tokenOut,uint256 amountIn,uint256 minOut,uint24 poolFee,uint64 expiry,bytes32 quoteId,address recipient,address escrow,address evaluator,uint64 deadlineSeconds,bytes32 specHash)"
    );

    ISwapRouterV3 public immutable router;

    event CrossCurrencySettled(
        bytes32 indexed quoteHash,
        bytes32 indexed quoteId,
        address indexed buyer,
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 amountOut,
        uint256 jobId
    );
    event SwapFailedRefunded(
        bytes32 indexed quoteHash, bytes32 indexed quoteId, address indexed buyer, address tokenIn, uint256 amountIn, bytes reason
    );

    error ZeroAddress();
    error InvalidQuote();
    error QuoteExpired(uint64 expiry, uint256 nowTs);
    error PullMismatch(uint256 expected, uint256 received);
    error MinOutNotMet(uint256 minOut, uint256 received);

    constructor(ISwapRouterV3 router_) {
        if (address(router_) == address(0)) revert ZeroAddress();
        router = router_;
    }

    /// @notice EIP-3009 nonce the buyer must sign for `q`.
    function quoteHash(Quote calldata q) public view returns (bytes32) {
        bytes memory a = abi.encode(QUOTE_TYPEHASH, block.chainid, address(this), address(router), q.buyer, q.tokenIn, q.tokenOut);
        bytes memory b = abi.encode(q.amountIn, q.minOut, q.poolFee, q.expiry, q.quoteId, q.recipient, q.escrow);
        bytes memory c = abi.encode(q.evaluator, q.deadlineSeconds, q.specHash);
        return keccak256(bytes.concat(a, b, c));
    }

    /// @return swapped false when the swap failed and the buyer was refunded
    /// @return amountOut tokenOut received from the swap (0 when refunded)
    /// @return jobId escrow job id (escrow mode), else 0
    function settle(Quote calldata q, Auth calldata a)
        external
        nonReentrant
        returns (bool swapped, uint256 amountOut, uint256 jobId)
    {
        if (block.timestamp > q.expiry) revert QuoteExpired(q.expiry, block.timestamp);
        if (
            q.buyer == address(0) || q.tokenIn == address(0) || q.tokenOut == address(0) || q.recipient == address(0)
                || q.tokenIn == q.tokenOut || q.amountIn == 0 || q.minOut == 0
        ) revert InvalidQuote();
        if (q.escrow != address(0) && (q.evaluator == address(0) || q.deadlineSeconds == 0)) revert InvalidQuote();

        bytes32 qh = quoteHash(q);
        _pull(q, a, qh);
        (swapped, amountOut) = _swap(q, qh);
        if (!swapped) return (false, 0, 0);
        jobId = _payout(q, amountOut);
        emit CrossCurrencySettled(qh, q.quoteId, q.buyer, q.tokenIn, q.amountIn, q.tokenOut, amountOut, jobId);
    }

    function _swap(Quote calldata q, bytes32 qh) internal returns (bool, uint256 amountOut) {
        IERC20 tin = IERC20(q.tokenIn);
        IERC20 tout = IERC20(q.tokenOut);
        tin.forceApprove(address(router), q.amountIn);
        uint256 outBefore = tout.balanceOf(address(this));
        try router.exactInputSingle(
            ISwapRouterV3.ExactInputSingleParams({
                tokenIn: q.tokenIn,
                tokenOut: q.tokenOut,
                fee: q.poolFee,
                recipient: address(this),
                amountIn: q.amountIn,
                amountOutMinimum: q.minOut,
                sqrtPriceLimitX96: 0
            })
        ) returns (uint256) {
            amountOut = tout.balanceOf(address(this)) - outBefore;
        } catch (bytes memory reason) {
            tin.forceApprove(address(router), 0);
            tin.safeTransfer(q.buyer, q.amountIn);
            emit SwapFailedRefunded(qh, q.quoteId, q.buyer, q.tokenIn, q.amountIn, reason);
            return (false, 0);
        }
        tin.forceApprove(address(router), 0);
        // Measured, not trusted from the router: a short fill reverts the whole tx (authorization unused, buyer keeps funds).
        if (amountOut < q.minOut) revert MinOutNotMet(q.minOut, amountOut);
        return (true, amountOut);
    }

    function _payout(Quote calldata q, uint256 amountOut) internal returns (uint256 jobId) {
        IERC20 tout = IERC20(q.tokenOut);
        if (q.escrow == address(0)) {
            tout.safeTransfer(q.recipient, amountOut);
            return 0;
        }
        tout.forceApprove(q.escrow, amountOut);
        jobId = IJobEscrowFundFor(q.escrow).createAndFundFor(
            q.buyer, q.recipient, q.evaluator, amountOut, uint64(block.timestamp) + q.deadlineSeconds, q.specHash
        );
        tout.forceApprove(q.escrow, 0);
    }

    function _pull(Quote calldata q, Auth calldata a, bytes32 qh) internal {
        IERC20 tin = IERC20(q.tokenIn);
        uint256 inBefore = tin.balanceOf(address(this));
        IERC3009Receive(q.tokenIn).receiveWithAuthorization(
            q.buyer, address(this), q.amountIn, a.validAfter, a.validBefore, qh, a.v, a.r, a.s
        );
        uint256 pulled = tin.balanceOf(address(this)) - inBefore;
        if (pulled != q.amountIn) revert PullMismatch(q.amountIn, pulled);
    }
}
