// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Minimal Uniswap v3 SwapRouter02 surface (swap-router-contracts 1.1.0, IV3SwapRouter).
///         Base Sepolia SwapRouter02: 0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4 (docs.uniswap.org).
///         Note: SwapRouter02's ExactInputSingleParams has no deadline field; expiry is enforced by the caller.
interface ISwapRouterV3 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}
