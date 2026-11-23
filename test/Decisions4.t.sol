// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EscrowDepositRoute, EscrowDepositRouteFactory} from "../src/EscrowDepositRoute.sol";
import {RecoveryVault} from "../src/RecoveryVault.sol";
import {Defaults} from "../script/Defaults.sol";

/// v0.1.2 research decisions: k-of-n keeper attestation (default 2-of-3), conflict freeze + timelocked
/// resolution, keeper-set / threshold changes mid-attestation (epoch), k < 2 gated to local/test chains,
/// RecoveryVault instead of sweep-to-treasury (claim, double-claim, horizon).
contract Decisions4Test is BaseTest {
    EscrowDepositRouteFactory internal f;
    EscrowDepositRouteFactory.Offer internal o;
    address internal route;
    address internal payer = makeAddr("payer");

    function setUp() public override {
        super.setUp();
        f = _newFactory(Defaults.ROUTE_SWEEP_DELAY, treasury);
        o = EscrowDepositRouteFactory.Offer({
            provider: provider, evaluator: evaluator, amount: 2 * USDC, deadlineSeconds: 1 days, specHash: SPEC
        });
        route = f.routeFor(o);
        usdc.mint(payer, 100 * USDC);
    }

    function _pay(uint256 v) internal {
        vm.prank(payer);
        usdc.transfer(route, v); // out-of-band Transfer (txHash/logIndex are synthetic here)
    }

    function _vote(address k, bytes32 txh, uint256 li, address from, uint256 v, bool ro)
        internal
        returns (bool credited, uint256 jobId, bool refunded)
    {
        vm.prank(k);
        return f.attestDeposit(o, txh, li, from, v, ro);
    }

    function _status(bytes32 txh, uint256 li) internal view returns (EscrowDepositRouteFactory.Status) {
        return f.claimOf(f.transferId(txh, li)).status;
    }

    // ---------------- k-of-n credit ----------------

    function test_KofN_Defaults_2of3() public view {
        assertEq(f.threshold(), 2);
        assertEq(f.keeperCount(), 3);
        assertEq(f.keeperEpoch(), 0);
        assertEq(Defaults.KEEPER_THRESHOLD, 2);
        assertEq(Defaults.RECOVERY_HORIZON, 365 days);
        assertEq(f.vault().horizon(), 365 days);
    }

    function test_KofN_OneOfThreeDoesNotCredit_TwoCredit() public {
        _pay(2 * USDC);
        bytes32 txh = keccak256("tx1");
        bytes32 id = f.transferId(txh, 3);
        uint256 jobs0 = escrow.jobCount();
        vm.expectEmit(true, true, true, true, address(f));
        emit EscrowDepositRouteFactory.AttestationRecorded(
            id, keeper, f.attestationDigest(route, payer, 2 * USDC, false), 1, 0
        );
        (bool c1,,) = _vote(keeper, txh, 3, payer, 2 * USDC, false);
        assertFalse(c1, "1-of-3 must not credit");
        assertEq(usdc.balanceOf(route), 2 * USDC);
        assertEq(escrow.jobCount(), jobs0);
        assertTrue(f.hasAttested(id, keeper));
        assertEq(uint8(_status(txh, 3)), uint8(EscrowDepositRouteFactory.Status.Pending));
        // the same keeper cannot vote twice
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(EscrowDepositRouteFactory.AlreadyVoted.selector, id));
        f.attestDeposit(o, txh, 3, payer, 2 * USDC, false);
        // second distinct keeper, same fields: credits
        (bool c2, uint256 jobId, bool refunded) = _vote(keeper3, txh, 3, payer, 2 * USDC, false);
        assertTrue(c2);
        assertFalse(refunded);
        assertEq(escrow.getJob(jobId).client, payer);
        assertEq(usdc.balanceOf(route), 0);
        assertTrue(f.attested(id));
        // third keeper (or anyone again) is rejected: credited once
        vm.prank(keeper2);
        vm.expectRevert(abi.encodeWithSelector(EscrowDepositRouteFactory.AlreadyAttested.selector, txh, 3));
        f.attestDeposit(o, txh, 3, payer, 2 * USDC, false);
    }

    function test_KofN_ThreeOfThree() public {
        EscrowDepositRouteFactory f3 = _newFactoryK(Defaults.ROUTE_SWEEP_DELAY, treasury, 3);
        address r3 = f3.routeFor(o);
        usdc.mint(r3, 1 * USDC);
        vm.prank(keeper);
        (bool a,,) = f3.attestDeposit(o, keccak256("t"), 0, payer, 1 * USDC, true);
        vm.prank(keeper2);
        (bool b,,) = f3.attestDeposit(o, keccak256("t"), 0, payer, 1 * USDC, true);
        vm.prank(keeper3);
        (bool c,,) = f3.attestDeposit(o, keccak256("t"), 0, payer, 1 * USDC, true);
        assertFalse(a);
        assertFalse(b);
        assertTrue(c);
        assertEq(usdc.balanceOf(r3), 0);
    }

    // ---------------- conflict freeze ----------------

    function test_Conflict_EachField_Freezes() public {
        usdc.mint(route, 10 * USDC);
        EscrowDepositRouteFactory.Offer memory other = o;
        other.amount = 1 * USDC;
        for (uint256 i = 0; i < 4; i++) {
            bytes32 txh = keccak256(abi.encode("c", i));
            bytes32 id = f.transferId(txh, 0);
            _vote(keeper, txh, 0, payer, 2 * USDC, false);
            bytes32 d1 = f.attestationDigest(route, payer, 2 * USDC, false);
            bytes32 d2 = f.attestationDigest(route, outsider, 2 * USDC, false);
            if (i == 0) {
                vm.expectEmit(true, true, true, true, address(f));
                emit EscrowDepositRouteFactory.DepositFrozen(id, keeper2, d1, d2);
            }
            vm.prank(keeper2);
            if (i == 0) {
                f.attestDeposit(o, txh, 0, outsider, 2 * USDC, false); // other `from`
            } else if (i == 1) {
                f.attestDeposit(o, txh, 0, payer, 3 * USDC, false); // other value
            } else if (i == 2) {
                f.attestDeposit(o, txh, 0, payer, 2 * USDC, true); // other refundOnly
            } else {
                f.attestDeposit(other, txh, 0, payer, 2 * USDC, false); // other route
            }
            assertEq(uint8(_status(txh, 0)), uint8(EscrowDepositRouteFactory.Status.Frozen));
            // frozen: nobody can attest it any more, nothing moved
            vm.prank(keeper3);
            vm.expectRevert(abi.encodeWithSelector(EscrowDepositRouteFactory.DepositIsFrozen.selector, id));
            f.attestDeposit(o, txh, 0, payer, 2 * USDC, false);
        }
        assertEq(usdc.balanceOf(route), 10 * USDC);
        assertEq(usdc.balanceOf(payer), 100 * USDC);
    }

    function test_Frozen_ResolutionCredit_Timelocked() public {
        _pay(2 * USDC);
        bytes32 txh = keccak256("fz");
        bytes32 id = f.transferId(txh, 1);
        // not frozen yet: no resolution
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(EscrowDepositRouteFactory.NotFrozen.selector, id));
        f.proposeResolution(id, EscrowDepositRouteFactory.ResolutionKind.Credit, route, payer, 2 * USDC, true);
        _vote(keeper, txh, 1, outsider, 2 * USDC, true); // malicious: wrong `from`
        _vote(keeper2, txh, 1, payer, 2 * USDC, true); // honest -> freeze
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, outsider));
        f.proposeResolution(id, EscrowDepositRouteFactory.ResolutionKind.Credit, route, payer, 2 * USDC, true);
        uint64 eta = uint64(block.timestamp + 48 hours);
        vm.expectEmit(true, true, true, true, address(f));
        emit EscrowDepositRouteFactory.ResolutionProposed(
            id, EscrowDepositRouteFactory.ResolutionKind.Credit, route, payer, 2 * USDC, true, eta
        );
        vm.prank(owner);
        f.proposeResolution(id, EscrowDepositRouteFactory.ResolutionKind.Credit, route, payer, 2 * USDC, true);
        vm.expectRevert(abi.encodeWithSelector(EscrowDepositRouteFactory.TimelockNotElapsed.selector, eta));
        f.executeResolution(id, o);
        vm.warp(eta);
        EscrowDepositRouteFactory.Offer memory wrong = o;
        wrong.amount = 1;
        vm.expectRevert(EscrowDepositRouteFactory.WrongRoute.selector);
        f.executeResolution(id, wrong);
        uint256 p0 = usdc.balanceOf(payer);
        vm.prank(outsider); // anyone executes
        (, bool refunded) = f.executeResolution(id, o);
        assertTrue(refunded);
        assertEq(usdc.balanceOf(payer) - p0, 2 * USDC);
        assertTrue(f.attested(id));
        vm.prank(keeper3);
        vm.expectRevert(abi.encodeWithSelector(EscrowDepositRouteFactory.AlreadyAttested.selector, txh, 1));
        f.attestDeposit(o, txh, 1, payer, 2 * USDC, true);
        vm.expectRevert(EscrowDepositRouteFactory.NoPendingChange.selector);
        f.executeResolution(id, o);
    }

    function test_Frozen_ResolutionReset_ThenKeepersReattest_AndCancel() public {
        _pay(2 * USDC);
        bytes32 txh = keccak256("rs");
        bytes32 id = f.transferId(txh, 0);
        _vote(keeper2, txh, 0, payer, 2 * USDC, false);
        _vote(keeper, txh, 0, payer, 1 * USDC, false); // conflicting -> frozen
        vm.startPrank(owner);
        f.proposeResolution(id, EscrowDepositRouteFactory.ResolutionKind.Credit, route, payer, 2 * USDC, false);
        f.cancelResolution(id);
        vm.expectRevert(EscrowDepositRouteFactory.NoPendingChange.selector);
        f.cancelResolution(id);
        f.proposeResolution(id, EscrowDepositRouteFactory.ResolutionKind.Reset, address(0), address(0), 0, false);
        vm.stopPrank();
        vm.warp(block.timestamp + 48 hours);
        f.executeResolution(id, o);
        assertEq(uint8(_status(txh, 0)), uint8(EscrowDepositRouteFactory.Status.None));
        // all votes discarded: keeper2 votes again (new round), then keeper3 credits
        (bool c1,,) = _vote(keeper2, txh, 0, payer, 2 * USDC, false);
        assertFalse(c1);
        (bool c2, uint256 jobId,) = _vote(keeper3, txh, 0, payer, 2 * USDC, false);
        assertTrue(c2);
        assertEq(escrow.getJob(jobId).client, payer);
    }

    // ---------------- keeper-set / threshold changes mid-attestation ----------------

    /// k=3: two votes pending; k lowered to 2. The old votes must not let a single new vote finalize.
    function test_Epoch_LoweringK_DoesNotFinalizeStaleVotes() public {
        EscrowDepositRouteFactory f3 = _newFactoryK(Defaults.ROUTE_SWEEP_DELAY, treasury, 3);
        address r3 = f3.routeFor(o);
        usdc.mint(r3, 2 * USDC);
        bytes32 txh = keccak256("lk");
        vm.prank(keeper);
        f3.attestDeposit(o, txh, 0, payer, 2 * USDC, true);
        vm.prank(keeper2);
        f3.attestDeposit(o, txh, 0, payer, 2 * USDC, true);
        vm.prank(owner);
        f3.proposeThreshold(2);
        vm.warp(block.timestamp + 48 hours);
        f3.executeThreshold();
        assertEq(f3.threshold(), 2);
        assertEq(f3.keeperEpoch(), 1);
        bytes32 id = f3.transferId(txh, 0);
        assertFalse(f3.hasAttested(id, keeper), "stale vote no longer counts");
        vm.prank(keeper3);
        (bool c,,) = f3.attestDeposit(o, txh, 0, payer, 2 * USDC, true);
        assertFalse(c, "one fresh vote + stale votes must not credit");
        assertEq(f3.claimOf(id).count, 1);
        assertEq(usdc.balanceOf(r3), 2 * USDC);
        vm.prank(keeper); // previous voters may vote again in the new epoch
        (c,,) = f3.attestDeposit(o, txh, 0, payer, 2 * USDC, true);
        assertTrue(c);
    }

    /// A removed keeper's pending vote is discarded; removal cannot drop n below k; a threshold change
    /// is re-checked against n at execution.
    function test_Epoch_RemovingKeeper_DiscardsItsVote_AndBounds() public {
        _pay(2 * USDC);
        bytes32 txh = keccak256("rm");
        bytes32 id = f.transferId(txh, 0);
        _vote(keeper, txh, 0, payer, 2 * USDC, true);
        vm.prank(owner);
        f.proposeKeeper(keeper, false);
        vm.warp(block.timestamp + 48 hours);
        f.executeKeeper(keeper);
        assertEq(f.keeperCount(), 2);
        (bool c,,) = _vote(keeper2, txh, 0, payer, 2 * USDC, true);
        assertFalse(c, "removed keeper's vote must not count");
        assertEq(f.claimOf(id).count, 1);
        (c,,) = _vote(keeper3, txh, 0, payer, 2 * USDC, true);
        assertTrue(c);
        // n == k == 2: removing another keeper reverts at execution
        vm.prank(owner);
        f.proposeKeeper(keeper2, false);
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(abi.encodeWithSelector(EscrowDepositRouteFactory.InvalidThreshold.selector, 2, 1));
        f.executeKeeper(keeper2);
        // raising k above n reverts at execution
        vm.prank(owner);
        f.proposeThreshold(3);
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(abi.encodeWithSelector(EscrowDepositRouteFactory.InvalidThreshold.selector, 3, 2));
        f.executeThreshold();
        vm.prank(owner);
        f.cancelThreshold();
        vm.expectRevert(EscrowDepositRouteFactory.NoPendingChange.selector);
        f.executeThreshold();
    }

    /// A freeze survives keeper-set changes (a removed malicious keeper does not unfreeze it).
    function test_Epoch_FreezeSurvivesKeeperChange() public {
        _pay(2 * USDC);
        bytes32 txh = keccak256("fe");
        bytes32 id = f.transferId(txh, 0);
        _vote(keeper2, txh, 0, payer, 2 * USDC, true);
        _vote(keeper, txh, 0, payer, 5 * USDC, true); // malicious conflicting vote
        vm.prank(owner);
        f.proposeKeeper(keeper, false);
        vm.warp(block.timestamp + 48 hours);
        f.executeKeeper(keeper);
        vm.prank(keeper3);
        vm.expectRevert(abi.encodeWithSelector(EscrowDepositRouteFactory.DepositIsFrozen.selector, id));
        f.attestDeposit(o, txh, 0, payer, 2 * USDC, true);
    }

    function test_KeeperChanges_Timelocked_OnlyOwner() public {
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, outsider));
        f.proposeThreshold(3);
        uint64 eta = uint64(block.timestamp + 48 hours);
        vm.expectEmit(true, true, true, true, address(f));
        emit EscrowDepositRouteFactory.ThresholdChangeProposed(3, eta);
        vm.prank(owner);
        f.proposeThreshold(3);
        vm.expectRevert(abi.encodeWithSelector(EscrowDepositRouteFactory.TimelockNotElapsed.selector, eta));
        f.executeThreshold();
        vm.warp(eta);
        vm.expectEmit(true, true, true, true, address(f));
        emit EscrowDepositRouteFactory.ThresholdSet(3, 3, 1);
        f.executeThreshold();
        assertEq(f.threshold(), 3);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(EscrowDepositRouteFactory.InvalidThreshold.selector, 0, 3));
        f.proposeThreshold(0);
    }

    // ---------------- k < 2 gate ----------------

    function test_ThresholdGate_KOneOnlyOnLocalOrTestChains() public {
        // local (31337): k = 1 allowed; a single attestation credits
        EscrowDepositRouteFactory f1 = _newFactoryK(Defaults.ROUTE_SWEEP_DELAY, treasury, 1);
        assertTrue(f1.lowThresholdAllowed());
        usdc.mint(f1.routeFor(o), 1);
        vm.prank(keeper);
        (bool c,,) = f1.attestDeposit(o, keccak256("one"), 0, payer, 1, true);
        assertTrue(c);
        // k = 0 and k > n always rejected
        vm.expectRevert(abi.encodeWithSelector(EscrowDepositRouteFactory.InvalidThreshold.selector, 0, 3));
        _newFactoryK(1 days, treasury, 0);
        vm.expectRevert(abi.encodeWithSelector(EscrowDepositRouteFactory.InvalidThreshold.selector, 4, 3));
        _newFactoryK(1 days, treasury, 4);
        // testnets allowed (Sepolia, Base Sepolia)
        vm.chainId(84532);
        _newFactoryK(1 days, treasury, 1);
        vm.chainId(11155111);
        _newFactoryK(1 days, treasury, 1);
        // any other chain (Base mainnet 8453, Ethereum 1): k = 1 reverts, k = 2 fine
        vm.chainId(8453);
        assertFalse(f.lowThresholdAllowed());
        vm.expectRevert(
            abi.encodeWithSelector(EscrowDepositRouteFactory.ThresholdBelowTwoOnProductionChain.selector, 8453)
        );
        _newFactoryK(1 days, treasury, 1);
        _newFactoryK(1 days, treasury, 2);
        // and a later change down to 1 is refused at execution
        vm.prank(owner);
        f.proposeThreshold(1);
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(
            abi.encodeWithSelector(EscrowDepositRouteFactory.ThresholdBelowTwoOnProductionChain.selector, 8453)
        );
        f.executeThreshold();
        vm.chainId(1);
        vm.expectRevert(
            abi.encodeWithSelector(EscrowDepositRouteFactory.ThresholdBelowTwoOnProductionChain.selector, 1)
        );
        _newFactoryK(1 days, treasury, 1);
    }

    // ---------------- RecoveryVault ----------------

    function _sweepRouteToVault() internal returns (EscrowDepositRoute r) {
        r = EscrowDepositRoute(f.deploy(o));
        vm.prank(keeper);
        r.startSweep();
        vm.warp(block.timestamp + Defaults.ROUTE_SWEEP_DELAY);
        r.sweep();
    }

    function test_Vault_ClaimAfterSweep_And_DoubleClaim() public {
        _pay(2 * USDC); // a keeper missed it; it gets swept
        RecoveryVault v = f.vault();
        uint256 t0 = usdc.balanceOf(treasury);
        _sweepRouteToVault();
        assertEq(usdc.balanceOf(treasury), t0, "nothing to treasury");
        assertEq(v.unclaimed(route), 2 * USDC);
        assertEq(v.releasableAt(route), block.timestamp + 365 days);
        bytes32 txh = keccak256("late");
        (bool c1,,) = _vote(keeper, txh, 2, payer, 2 * USDC, false);
        assertFalse(c1, "1-of-3 cannot claim");
        assertEq(v.unclaimed(route), 2 * USDC);
        uint256 p0 = usdc.balanceOf(payer);
        vm.expectEmit(true, true, true, true, address(v));
        emit RecoveryVault.Claimed(route, f.transferId(txh, 2), payer, 2 * USDC);
        vm.expectEmit(true, true, true, true, address(f));
        emit EscrowDepositRouteFactory.DepositAttested(route, f.transferId(txh, 2), payer, 2 * USDC, 0, true, true);
        (bool c2, uint256 jobId, bool refunded) = _vote(keeper2, txh, 2, payer, 2 * USDC, false);
        assertTrue(c2);
        assertEq(jobId, 0, "vault claims refund, never open a job");
        assertTrue(refunded);
        assertEq(usdc.balanceOf(payer) - p0, 2 * USDC);
        assertEq(v.unclaimed(route), 0);
        assertEq(v.totalUnclaimed(), 0);
        // double claim: same (txHash, logIndex) rejected
        usdc.mint(route, 2 * USDC);
        _sweepRouteToVault();
        vm.prank(keeper3);
        vm.expectRevert(abi.encodeWithSelector(EscrowDepositRouteFactory.AlreadyAttested.selector, txh, 2));
        f.attestDeposit(o, txh, 2, payer, 2 * USDC, false);
        assertEq(v.unclaimed(route), 2 * USDC);
    }

    function test_Vault_ClaimCannotExceedTransferOrUnclaimed() public {
        _pay(1 * USDC);
        RecoveryVault v = f.vault();
        _sweepRouteToVault();
        // a (colluding or mistaken) claim larger than what reached the route + vault reverts
        _vote(keeper, keccak256("big"), 0, payer, 3 * USDC, true);
        vm.prank(keeper2);
        vm.expectRevert(abi.encodeWithSelector(RecoveryVault.InsufficientUnclaimed.selector, 1 * USDC, 3 * USDC));
        f.attestDeposit(o, keccak256("big"), 0, payer, 3 * USDC, true);
        assertEq(v.unclaimed(route), 1 * USDC);
        // only the factory pays out; only routes record sweeps
        vm.expectRevert(RecoveryVault.OnlyFactory.selector);
        v.payout(route, bytes32(0), outsider, 1);
        vm.expectRevert(RecoveryVault.NotRoute.selector);
        v.recordSweep(1);
        vm.prank(keeper);
        vm.expectRevert(EscrowDepositRoute.OnlyFactory.selector);
        EscrowDepositRoute(route).flushToVault();
    }

    /// A deposit split between route and vault (part swept): the route balance is flushed into the vault
    /// and both claims are paid from the pooled unclaimed funds.
    function test_Vault_SplitRouteAndVault_Flush() public {
        _pay(2 * USDC); // deposit A, swept
        RecoveryVault v = f.vault();
        EscrowDepositRoute r = _sweepRouteToVault();
        _pay(1 * USDC); // deposit B, still in the route
        uint256 p0 = usdc.balanceOf(payer);
        _vote(keeper, keccak256("A"), 0, payer, 2 * USDC, true);
        (bool c,,) = _vote(keeper2, keccak256("A"), 0, payer, 2 * USDC, true);
        assertTrue(c);
        assertEq(usdc.balanceOf(address(r)), 0, "route flushed");
        assertEq(v.unclaimed(route), 1 * USDC);
        _vote(keeper, keccak256("B"), 0, payer, 1 * USDC, true);
        (c,,) = _vote(keeper3, keccak256("B"), 0, payer, 1 * USDC, true);
        assertTrue(c);
        assertEq(usdc.balanceOf(payer) - p0, 3 * USDC);
        assertEq(v.unclaimed(route), 0);
        assertEq(usdc.balanceOf(address(v)), 0);
    }

    function test_Vault_Horizon_ReleaseToTreasury() public {
        _pay(2 * USDC);
        RecoveryVault v = f.vault();
        vm.expectRevert(RecoveryVault.NothingToRelease.selector);
        v.releaseExpired(route);
        _sweepRouteToVault();
        uint64 at = v.releasableAt(route);
        vm.warp(at - 1);
        vm.expectRevert(abi.encodeWithSelector(RecoveryVault.HorizonNotElapsed.selector, at));
        v.releaseExpired(route);
        // a new sweep into the vault restarts the route's horizon
        usdc.mint(route, 1 * USDC);
        _sweepRouteToVault();
        uint64 at2 = v.releasableAt(route);
        assertGt(at2, at);
        vm.warp(at2);
        uint256 t0 = usdc.balanceOf(treasury);
        vm.expectEmit(true, true, true, true, address(v));
        emit RecoveryVault.ReleasedToTreasury(route, treasury, 3 * USDC);
        vm.prank(outsider); // anyone
        assertEq(v.releaseExpired(route), 3 * USDC);
        assertEq(usdc.balanceOf(treasury) - t0, 3 * USDC);
        assertEq(v.unclaimed(route), 0);
        // after the horizon a claim has nothing left to pay from
        _vote(keeper, keccak256("tooLate"), 0, payer, 2 * USDC, true);
        vm.prank(keeper2);
        vm.expectRevert(abi.encodeWithSelector(RecoveryVault.InsufficientUnclaimed.selector, 0, 2 * USDC));
        f.attestDeposit(o, keccak256("tooLate"), 0, payer, 2 * USDC, true);
    }

    function test_Vault_HorizonConfigurable_AndValidated() public {
        address[] memory ks = new address[](2);
        (ks[0], ks[1]) = (keeper, keeper2);
        EscrowDepositRouteFactory.Config memory cfg = EscrowDepositRouteFactory.Config({
            sweepDelay: 1 days, treasury: treasury, recoveryHorizon: 30 days, keeperTimelock: 1 hours, threshold: 2
        });
        EscrowDepositRouteFactory f2 =
            new EscrowDepositRouteFactory(IERC20(address(usdc)), address(escrow), owner, cfg, ks);
        assertEq(f2.vault().horizon(), 30 days);
        assertEq(f2.keeperTimelock(), 1 hours);
        cfg.recoveryHorizon = 0;
        vm.expectRevert(RecoveryVault.InvalidConfig.selector);
        new EscrowDepositRouteFactory(IERC20(address(usdc)), address(escrow), owner, cfg, ks);
    }
}
