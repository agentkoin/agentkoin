// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {MockArbitrator} from "../../src/mocks/MockArbitrator.sol";
import {EvaluatorRegistry} from "../../src/EvaluatorRegistry.sol";
import {JobEscrow} from "../../src/JobEscrow.sol";
import {EscrowDepositRoute, EscrowDepositRouteFactory} from "../../src/EscrowDepositRoute.sol";
import {IEvaluatorRegistry} from "../../src/interfaces/IEvaluatorRegistry.sol";
import {IArbitrator} from "../../src/interfaces/IArbitrator.sol";
import {Defaults} from "../../script/Defaults.sol";
import {EscrowHandler} from "./EscrowHandler.sol";
import {RecoveryVault} from "../../src/RecoveryVault.sol";

/// @notice Stateful invariants for JobEscrow + EvaluatorRegistry + EscrowDepositRoute.
contract EscrowInvariantTest is Test {
    MockUSDC internal usdc;
    EvaluatorRegistry internal registry;
    JobEscrow internal escrow;
    MockArbitrator internal arb;
    EscrowDepositRouteFactory internal factory;
    EscrowHandler internal handler;
    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address[4] internal pool =
        [makeAddr("keeperMalicious"), makeAddr("keeper1"), makeAddr("keeper2"), makeAddr("keeper3")];
    /// shorter than the 365d default so horizon releases happen within a run
    uint64 internal constant INV_HORIZON = 60 days;

    function setUp() public {
        usdc = new MockUSDC();
        arb = new MockArbitrator(admin, Defaults.MOCK_ARBITRATION_FEE);
        address[] memory slashers = new address[](1);
        slashers[0] = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        registry = new EvaluatorRegistry(
            IERC20(address(usdc)), Defaults.registryConfig(treasury), admin, slashers, Defaults.SLASHER_TIMELOCK
        );
        escrow = new JobEscrow(
            IERC20(address(usdc)),
            IEvaluatorRegistry(address(registry)),
            treasury,
            IArbitrator(address(arb)),
            Defaults.escrowConfig(),
            admin, admin, type(uint256).max, type(uint256).max
        );
        require(registry.isSlasher(address(escrow)), "slasher");
        // 2-of-3 at deploy: pool[0] (malicious), pool[1], pool[2]; pool[3] is added/removed mid-run
        address[] memory keepers = new address[](3);
        (keepers[0], keepers[1], keepers[2]) = (pool[0], pool[1], pool[2]);
        factory = new EscrowDepositRouteFactory(
            IERC20(address(usdc)),
            address(escrow),
            admin,
            EscrowDepositRouteFactory.Config({
                sweepDelay: Defaults.ROUTE_SWEEP_DELAY,
                treasury: treasury,
                recoveryHorizon: INV_HORIZON,
                keeperTimelock: Defaults.KEEPER_TIMELOCK,
                threshold: Defaults.KEEPER_THRESHOLD
            }),
            keepers
        );
        handler = new EscrowHandler(usdc, escrow, registry, arb, factory, admin, pool);
        targetContract(address(handler));
    }

    function _holdsAmount(JobEscrow.Job memory j) internal pure returns (bool) {
        JobEscrow.State s = j.state;
        if (s == JobEscrow.State.Funded || s == JobEscrow.State.Submitted) return true;
        if (
            s == JobEscrow.State.Completed || s == JobEscrow.State.Rejected || s == JobEscrow.State.Partial
                || s == JobEscrow.State.Disputed
        ) return !j.instant; // instant jobs paid the provider at submit
        return false;
    }

    function _exposureLocked(JobEscrow.State s) internal pure returns (bool) {
        return s == JobEscrow.State.Funded || s == JobEscrow.State.Submitted || s == JobEscrow.State.Completed
            || s == JobEscrow.State.Rejected || s == JobEscrow.State.Partial || s == JobEscrow.State.Disputed;
    }

    /// Conservation: escrow token balance == sum of outstanding obligations.
    function invariant_EscrowBalanceEqualsObligations() public view {
        uint256 owed;
        uint256 n = escrow.jobCount();
        for (uint256 id = 1; id <= n; id++) {
            JobEscrow.Job memory j = escrow.getJob(id);
            if (_holdsAmount(j)) owed += j.amount;
            owed += j.providerBond; // zeroed when returned or fully slashed
            if (j.state == JobEscrow.State.Disputed) {
                JobEscrow.Dispute memory d = escrow.getDispute(id);
                owed += d.bond + d.arbFee; // E-17a: fee held until ruling
            }
        }
        assertEq(usdc.balanceOf(address(escrow)), owed, "escrow balance != obligations");
    }

    /// No double payout: the job amount leaves escrow at most once in total; terminal funded
    /// jobs paid out exactly their amount; at most one payment, one refund, one terminal event.
    function invariant_NoDoublePayout() public view {
        uint256 n = escrow.jobCount();
        for (uint256 id = 1; id <= n; id++) {
            JobEscrow.Job memory j = escrow.getJob(id);
            uint256 paid = handler.paidFromAmount(id);
            assertLe(paid, j.amount, "paid more than job amount");
            assertLe(handler.paymentEvents(id), 1, "provider paid twice");
            assertLe(handler.refundEvents(id), 1, "client refunded twice");
            assertLe(handler.settleEvents(id), 1, "terminal transition twice");
            bool terminal = j.state == JobEscrow.State.Settled || j.state == JobEscrow.State.Expired;
            if (terminal || (j.instant && j.state != JobEscrow.State.None)) {
                assertEq(paid, j.amount, "terminal/instant job not fully paid out");
            }
            if (j.state == JobEscrow.State.Open || (j.state == JobEscrow.State.Funded)) {
                assertEq(paid, 0, "unsettled job paid");
            }
        }
    }

    /// Registry: balance == sum of stakes; stake + slashed == total staked (no underflow, no
    /// leakage); exposure and openJobs match the jobs that locked them.
    function invariant_RegistryStakeAccounting() public view {
        uint256 sumStake;
        uint256 n = escrow.jobCount();
        for (uint256 i = 0; i < handler.evaluatorCount(); i++) {
            address e = handler.evaluators(i);
            EvaluatorRegistry.Evaluator memory info = registry.evaluatorInfo(e);
            sumStake += info.stake;
            assertEq(info.stake + info.slashedTotal, handler.staked(e), "stake + slashed != deposited");
            uint256 exp;
            uint32 open;
            for (uint256 id = 1; id <= n; id++) {
                JobEscrow.Job memory j = escrow.getJob(id);
                if (j.evaluator == e && _exposureLocked(j.state)) {
                    exp += j.amount;
                    open++;
                }
            }
            assertEq(info.exposure, exp, "exposure != open job amounts");
            assertEq(info.openJobs, open, "openJobs mismatch");
        }
        assertEq(usdc.balanceOf(address(registry)), sumStake, "registry balance != sum of stakes");
    }

    /// Routes: balance == all Transfers in - (credits + sweeps); no credited payment stays in a route.
    function invariant_RouteAccounting() public view {
        for (uint256 i = 0; i < handler.routeCount(); i++) {
            address r = handler.routes(i);
            assertEq(usdc.balanceOf(r), handler.routeIn(r) - handler.routeOut(r), "route balance mismatch");
        }
    }

    /// Deterministic smoke of the handler's vault path (the random runs reach it only occasionally):
    /// lagging keepers -> sweep into the vault -> 2-of-3 claim paid from the vault -> invariants hold.
    function test_HandlerVaultClaimPath() public {
        handler.payerTransfer(0, 0, 3e6);
        handler.startSweep(0, false);
        handler.sweep(0);
        assertEq(handler.positiveSweeps(), 1);
        handler.claimFromVault(0);
        assertEq(handler.vaultClaims(), 1);
        assertEq(handler.creditBelowK(), 0);
        invariant_Vault_BalanceEqualsUnclaimed();
        invariant_A1e_CreditNeverExceedsTransfer();
        invariant_A1c_AttributableFundsRecoverable();
    }

    /// A-1c/A-1e (v0.1.2): attributable funds are never lost before the vault horizon: every
    /// uncredited out-of-band deposit is still covered by the route balance plus the route's unclaimed
    /// vault funds (plus what the vault released to the treasury after the horizon).
    function invariant_A1c_AttributableFundsRecoverable() public view {
        RecoveryVault v = factory.vault();
        for (uint256 i = 0; i < handler.routeCount(); i++) {
            address r = handler.routes(i);
            assertGe(
                usdc.balanceOf(r) + v.unclaimed(r) + handler.vaultReleased(r),
                handler.pendingUncredited(r),
                "attributable funds lost"
            );
        }
    }

    /// A-1e: no credited amount ever exceeds the actual Transfer into the route: per transfer id
    /// (txHash, logIndex) credited <= its value, and per route total credited (atomic + attested,
    /// from the route or the vault) <= total attributable Transfers in. The route's own attestedTotal
    /// agrees with the handler. On-chain claim status matches the handler's view of every deposit.
    function invariant_A1e_CreditNeverExceedsTransfer() public view {
        assertEq(handler.overCreditedTransfers(), 0, "transfer id credited above its value");
        assertEq(handler.statusMismatches(), 0, "claim status mismatch");
        for (uint256 i = 0; i < handler.routeCount(); i++) {
            address r = handler.routes(i);
            assertLe(handler.routeCredited(r), handler.routeTransferredIn(r), "route credited > transferred in");
            if (r.code.length != 0) {
                assertLe(EscrowDepositRoute(r).attestedTotal(), handler.routeCredited(r), "attestedTotal");
            }
        }
    }

    /// A-1e v0.1.2: no credit with fewer than k matching current-epoch attestations, and the
    /// malicious keeper's wrong attestations never complete a credit (they only freeze).
    function invariant_A1e_NoCreditBelowK() public view {
        assertEq(handler.creditBelowK(), 0, "credited below k");
        assertEq(handler.maliciousCredited(), 0, "malicious attestation credited");
        assertGe(factory.threshold(), 2, "threshold < 2 in a 2-of-3 deployment");
        assertGe(factory.keeperCount(), factory.threshold(), "k > n");
    }

    /// v0.1.2 RecoveryVault: vault balance == sum of unclaimed == totalUnclaimed, and per route
    /// unclaimed == swept/flushed in - claims - horizon releases.
    function invariant_Vault_BalanceEqualsUnclaimed() public view {
        RecoveryVault v = factory.vault();
        uint256 sum;
        for (uint256 i = 0; i < handler.routeCount(); i++) {
            address r = handler.routes(i);
            uint256 u = v.unclaimed(r);
            sum += u;
            assertEq(u, handler.vaultIn(r) - handler.vaultOut(r) - handler.vaultReleased(r), "vault per-route ghost");
        }
        assertEq(v.totalUnclaimed(), sum, "totalUnclaimed != sum");
        assertEq(usdc.balanceOf(address(v)), sum, "vault balance != unclaimed sum");
    }

    /// A-1e: every attack attempt (same-nonce double-sign, settling a used authorization, duplicate
    /// attestation, non-keeper attest / startSweep / vault payout) failed.
    function invariant_A1e_AttacksFail() public view {
        assertEq(handler.exploitSucceeded(), 0, "double-sign / used-auth settle succeeded");
        assertEq(handler.duplicateAttestSucceeded(), 0, "duplicate attestation succeeded");
        assertEq(handler.unauthorizedSucceeded(), 0, "non-keeper call succeeded");
    }

    /// A-1d: every deployed route sweeps to the destination fixed at creation (the RecoveryVault).
    function invariant_A1d_SweepToImmutable() public view {
        for (uint256 i = 0; i < handler.routeCount(); i++) {
            address r = handler.routes(i);
            if (r.code.length != 0) {
                assertEq(EscrowDepositRoute(r).sweepTo(), address(factory.vault()), "sweepTo changed");
            }
        }
    }

    /// x402 exact: every successful settle opened at most one job, each from one authorization.
    function invariant_RouteJobsMatchSettles() public view {
        assertLe(handler.routeJobsOpened(), handler.routeSettles());
    }

    /// Successful-call counts per action for the run (printed with -vv). Shows the handler reaches
    /// deep states (rulings, stale disputes, sweeps), not just reverting calls.
    function afterInvariant() public view {
        string[21] memory names = [
            "createAndFund",
            "submit",
            "verdict",
            "challenge",
            "giveRuling",
            "resolveStaleDispute",
            "finalize",
            "timeoutRelease",
            "cancel",
            "claimRefund",
            "postProviderBond",
            "routePay",
            "attestPending",
            "startSweep",
            "sweep",
            "fund",
            "payerTransfer",
            "stray",
            "resolveFrozen",
            "releaseVault",
            "claimFromVault"
        ];
        string memory line = "ok:";
        for (uint256 i = 0; i < names.length; i++) {
            line = string.concat(line, " ", names[i], "=", vm.toString(handler.okCalls(names[i])));
        }
        console2.log(line);
        console2.log("sweepAttests", handler.sweepAttests(), "positiveSweeps", handler.positiveSweeps());
        console2.log("attests", handler.routeAttests(), "attestRefunds", handler.attestRefunds());
        console2.log("attackAttempts", handler.attackAttempts(), "deposits", handler.depositCount());
        console2.log("votes", handler.votes(), "freezes", handler.freezes());
        console2.log("resolutions", handler.resolutions(), "keeperChanges", handler.keeperChanges());
        console2.log("vaultClaims", handler.vaultClaims(), "releases", handler.releases());
    }
}
