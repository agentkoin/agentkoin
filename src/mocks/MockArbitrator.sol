// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IArbitrator, IArbitrable} from "../interfaces/IArbitrator.sol";

/// @title MockArbitrator
/// @notice TEST ONLY. Records ruling requests; the owner submits rulings by hand.
///         Placeholder for a Kleros (ERC-792) or UMA Optimistic Oracle adapter.
contract MockArbitrator is IArbitrator {
    struct Request {
        address escrow;
        uint256 jobId;
        address challenger;
        uint16 verdictPayoutBps;
        bytes32 reasonHash;
        bool ruled;
    }

    address public immutable owner;
    /// @notice Flat cost per ruling in payment-token units (E-17b: flat mock behind the quote-based
    ///         arbitrationCost interface). Settable by owner. Paid by the arbitrable inside rule().
    uint256 public fee;
    uint256 public disputeCount;
    mapping(uint256 => Request) public requests;

    event RulingRequested(
        uint256 indexed disputeId,
        address indexed escrow,
        uint256 indexed jobId,
        address challenger,
        uint16 verdictPayoutBps
    );
    event RulingGiven(uint256 indexed disputeId, uint16 payoutBps);
    event FeeSet(uint256 fee);

    error NotOwner();
    error AlreadyRuled();

    constructor(address owner_, uint256 fee_) {
        owner = owner_;
        fee = fee_;
        emit FeeSet(fee_);
    }

    function setFee(uint256 fee_) external {
        if (msg.sender != owner) revert NotOwner();
        fee = fee_;
        emit FeeSet(fee_);
    }

    /// @inheritdoc IArbitrator
    function arbitrationCost(uint256, uint256) external view returns (uint256) {
        return fee;
    }

    function requestRuling(uint256 jobId, address challenger, uint16 verdictPayoutBps, bytes32 reasonHash)
        external
        returns (uint256 disputeId)
    {
        disputeId = ++disputeCount;
        requests[disputeId] = Request(msg.sender, jobId, challenger, verdictPayoutBps, reasonHash, false);
        emit RulingRequested(disputeId, msg.sender, jobId, challenger, verdictPayoutBps);
    }

    function giveRuling(uint256 disputeId, uint16 payoutBps) external {
        if (msg.sender != owner) revert NotOwner();
        Request storage r = requests[disputeId];
        if (r.ruled) revert AlreadyRuled();
        r.ruled = true;
        emit RulingGiven(disputeId, payoutBps);
        IArbitrable(r.escrow).rule(r.jobId, payoutBps);
    }
}
