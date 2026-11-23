// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IERC8183 (subset)
/// @notice The parts of an ERC-8183 (Agentic Commerce Protocol) kernel that the evaluator adapter
///         calls or reads. Function names and the Job struct follow the reference implementation
///         `AgenticCommerce` in ERC-8183 (ethereum/ERCs, ERCS/erc-8183.md).
interface IERC8183 {
    enum JobStatus {
        Open,
        Funded,
        Submitted,
        Completed,
        Rejected,
        Expired
    }

    struct Job {
        uint256 id;
        address client;
        address provider;
        address evaluator;
        string description;
        uint256 budget;
        uint256 expiredAt;
        JobStatus status;
        address hook;
    }

    function paymentToken() external view returns (address);
    function getJob(uint256 jobId) external view returns (Job memory);
    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
    function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
}
