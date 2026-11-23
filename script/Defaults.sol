// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EvaluatorRegistry} from "../src/EvaluatorRegistry.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {ERC8183EvaluatorAdapter} from "../src/ERC8183EvaluatorAdapter.sol";

/// @notice v0 default parameters from specs/SPEC-v0.md plus decided assumptions (docs/ASSUMPTIONS.md).
///         Design choices, not data. Configs are runtime-settable via setConfig() by the owner
///         (versioned, pinned per job); slasherTimelock is fixed at registry deploy.
library Defaults {
    uint64 internal constant SLASHER_TIMELOCK = 48 hours; // R-5
    /// Mainnet-prep caps (USDC atomic units, 6 decimals): 50 USDC per job, 500 USDC total locked.
    uint256 internal constant MAINNET_MAX_PER_JOB = 50e6;
    uint256 internal constant MAINNET_MAX_TOTAL_LOCKED = 500e6;
    uint256 internal constant MOCK_ARBITRATION_FEE = 5e5; // 0.5 mUSDC flat cost, mock arbitrator only (E-17b)
    uint64 internal constant ROUTE_SWEEP_DELAY = 30 days; // A-1a
    uint64 internal constant KEEPER_TIMELOCK = 48 hours; // A-1e: route keeper set / threshold / resolution changes
    uint8 internal constant KEEPER_THRESHOLD = 2; // A-1e v0.1.2: k of n keeper attestations (default 2-of-3)
    uint64 internal constant RECOVERY_HORIZON = 365 days; // v0.1.2: RecoveryVault unclaimed -> treasury after this

    function registryConfig(address treasury) internal pure returns (EvaluatorRegistry.Config memory) {
        return EvaluatorRegistry.Config({
            minStake: 100e6, // 100 USDC
            unbondingPeriod: 7 days,
            exposureMultiplier: 5,
            slashHarmedShareBps: 5000, // 50% harmed party / 50% treasury
            treasury: treasury
        });
    }

    function escrowConfig() internal pure returns (JobEscrow.Config memory) {
        return JobEscrow.Config({
            instantThreshold: 1e6, // 1 USDC
            minChallengeBond: 1e6, // 1 USDC
            evalWindow: 24 hours,
            challengeWindow: 48 hours,
            arbitrationTimeout: 30 days, // ASSUMPTIONS E-15 (decided: keep)
            challengeBondBps: 500, // 5%
            missedVerdictSlashBps: 1000, // 10% of minStake pinned at fund
            wrongVerdictSlashBps: 2500, // 25% of minStake pinned at fund
            materialDiffBps: 2000,
            feeBps: 100, // 1%
            failedChallengeEvaluatorShareBps: 5000, // ASSUMPTIONS E-10 (decided: keep)
            instantBondCoverBps: 10000, // ASSUMPTIONS E-6 (decided: keep)
            evaluatorFeeBps: 50 // 0.5%, ASSUMPTIONS E-18
        });
    }

    function adapterConfig() internal pure returns (ERC8183EvaluatorAdapter.Config memory) {
        return ERC8183EvaluatorAdapter.Config({
            evalWindow: 24 hours,
            challengeWindow: 24 hours, // E-1a: shorter than JobEscrow (kernel expiry bound)
            arbitrationTimeout: 7 days, // E-1a
            expiryMargin: 1 hours, // E-1a: kernel expiredAt >= now + 24h + 24h + 7d + 1h
            minChallengeBond: 1e6,
            challengeBondBps: 500,
            missedVerdictSlashBps: 1000,
            wrongVerdictSlashBps: 2500,
            failedChallengeEvaluatorShareBps: 5000,
            completeThresholdBps: 5000 // payoutBps >= 5000 => kernel.complete (lossy), ASSUMPTIONS E-1
        });
    }
}
