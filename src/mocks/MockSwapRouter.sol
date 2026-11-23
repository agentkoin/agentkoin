// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ISwapRouterV3} from "../interfaces/ISwapRouterV3.sol";

/// @title MockSwapRouter
/// @notice TEST ONLY. SwapRouter02-compatible exactInputSingle that fills at an owner-set rate from its own token
///         balance (mock liquidity funded with test tokens). Not a DEX, no price discovery. Used by Foundry tests and
///         as the documented fallback if the Base Sepolia Uniswap v3 EURC/USDC pool becomes unusable.
/// @dev rateE18 = tokenOut atomic units per 1e18 tokenIn atomic units. feeBps is deducted from the output.
contract MockSwapRouter is ISwapRouterV3, Ownable {
    using SafeERC20 for IERC20;

    string public constant KIND = "MockSwapRouter (testnet only, owner-set rate, not a DEX)";

    mapping(address => mapping(address => uint256)) public rateE18;
    uint16 public feeBps;
    bool public paused;

    event RateSet(address indexed tokenIn, address indexed tokenOut, uint256 rateE18, string source);
    event Swapped(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, address recipient);

    error Paused();
    error NoRate();
    error TooLittleReceived(uint256 out, uint256 minOut);
    error InsufficientLiquidity(uint256 out, uint256 available);

    constructor(address owner_, uint16 feeBps_) Ownable(owner_) {
        feeBps = feeBps_;
    }

    function setRate(address tokenIn, address tokenOut, uint256 rateE18_, string calldata source) external onlyOwner {
        rateE18[tokenIn][tokenOut] = rateE18_;
        emit RateSet(tokenIn, tokenOut, rateE18_, source);
    }

    function setPaused(bool p) external onlyOwner {
        paused = p;
    }

    function setFeeBps(uint16 f) external onlyOwner {
        feeBps = f;
    }

    /// @notice Owner withdraws mock liquidity.
    function withdraw(IERC20 token, address to, uint256 amount) external onlyOwner {
        token.safeTransfer(to, amount);
    }

    function quoteExactInputSingle(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256) {
        uint256 r = rateE18[tokenIn][tokenOut];
        if (r == 0) revert NoRate();
        uint256 gross = (amountIn * r) / 1e18;
        return gross - (gross * feeBps) / 10_000;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 out) {
        if (paused) revert Paused();
        out = quoteExactInputSingle(p.tokenIn, p.tokenOut, p.amountIn);
        if (out < p.amountOutMinimum) revert TooLittleReceived(out, p.amountOutMinimum);
        uint256 avail = IERC20(p.tokenOut).balanceOf(address(this));
        if (out > avail) revert InsufficientLiquidity(out, avail);
        IERC20(p.tokenIn).safeTransferFrom(msg.sender, address(this), p.amountIn);
        IERC20(p.tokenOut).safeTransfer(p.recipient, out);
        emit Swapped(p.tokenIn, p.tokenOut, p.amountIn, out, p.recipient);
    }
}
