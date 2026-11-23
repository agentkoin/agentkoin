// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Minimal ERC-792 arbitrator surface used by KlerosArbitratorAdapter (Kleros Court v1/v2 style).
/// @dev Only the calls the adapter makes. Fees are paid in native currency at createDispute.
interface IERC792Arbitrator {
    function createDispute(uint256 choices, bytes calldata extraData) external payable returns (uint256 disputeID);
    function arbitrationCost(bytes calldata extraData) external view returns (uint256 cost);
}

/// @notice ERC-792 arbitrable callback.
interface IERC792Arbitrable {
    function rule(uint256 disputeID, uint256 ruling) external;
}

/// @notice Minimal UMA Optimistic Oracle V3 surface used by UMAArbitratorAdapter.
interface IOptimisticOracleV3 {
    function assertTruth(
        bytes calldata claim,
        address asserter,
        address callbackRecipient,
        address escalationManager,
        uint64 liveness,
        IERC20 currency,
        uint256 bond,
        bytes32 identifier,
        bytes32 domainId
    ) external returns (bytes32 assertionId);
    function getMinimumBond(address currency) external view returns (uint256);
    function defaultIdentifier() external view returns (bytes32);
}

/// @notice UMA OOv3 callback recipient.
interface IOptimisticOracleV3CallbackRecipient {
    function assertionResolvedCallback(bytes32 assertionId, bool assertedTruthfully) external;
    function assertionDisputedCallback(bytes32 assertionId) external;
}
