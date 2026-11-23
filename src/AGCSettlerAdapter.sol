// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AGC} from "./AGC.sol";

interface IJobEscrowAGC {
    function token() external view returns (IERC20);
    function createAndFundFor(
        address client,
        address provider,
        address evaluator,
        uint256 amount,
        uint64 deadline,
        bytes32 specHash
    ) external returns (uint256 jobId);
}

/// @title AGCSettlerAdapter (AD-010, Base Sepolia testnet)
/// @notice Sits in CrossCurrencySettler's `escrow` slot. Pulls the settler's USDC output, wraps it 1:1 into AGC and
///         either opens a job on the AGC JobEscrow (client = buyer) or, when `evaluator == address(this)` ("convert"
///         mode), sends the AGC to `provider` and returns jobId 0. Stateless, no owner; holds nothing between calls.
contract AGCSettlerAdapter {
    using SafeERC20 for IERC20;

    AGC public immutable agc;
    IERC20 public immutable usdc;
    IJobEscrowAGC public immutable escrowAGC;

    error ZeroAddress();
    error EscrowTokenNotAGC();

    constructor(AGC agc_, IJobEscrowAGC escrow_) {
        if (address(agc_) == address(0) || address(escrow_) == address(0)) revert ZeroAddress();
        if (address(escrow_.token()) != address(agc_)) revert EscrowTokenNotAGC();
        agc = agc_;
        usdc = agc_.USDC();
        escrowAGC = escrow_;
    }

    /// @notice Same signature as JobEscrow.createAndFundFor. The caller must have approved `amount` USDC to this adapter.
    function createAndFundFor(
        address client,
        address provider,
        address evaluator,
        uint256 amount,
        uint64 deadline,
        bytes32 specHash
    ) external returns (uint256 jobId) {
        if (provider == address(0)) revert ZeroAddress();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        usdc.forceApprove(address(agc), amount);
        agc.wrapTo(address(this), amount);
        if (evaluator == address(this)) {
            IERC20(address(agc)).safeTransfer(provider, amount);
            return 0;
        }
        IERC20(address(agc)).forceApprove(address(escrowAGC), amount);
        jobId = escrowAGC.createAndFundFor(client, provider, evaluator, amount, deadline, specHash);
        IERC20(address(agc)).forceApprove(address(escrowAGC), 0);
    }
}
