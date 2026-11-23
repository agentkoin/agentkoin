// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {EscrowDepositRoute, EscrowDepositRouteFactory} from "../src/EscrowDepositRoute.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {Defaults} from "../script/Defaults.sol";
import {RecoveryVault} from "../src/RecoveryVault.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// A-1e (v0.1.1, k-of-n since v0.1.2): payments are credited only atomically (settle executes the
/// authorization) or by k-of-n allowlisted keeper attestations citing a Transfer log (txHash, logIndex). No permissionless refund
/// and no front-run settle. Includes the regression tests for the same-nonce double-sign exploit.
contract Decisions3Test is BaseTest {
    EscrowDepositRouteFactory internal f;
    address internal payer;
    uint256 internal pk;
    uint256 internal nonceN;

    function setUp() public override {
        super.setUp();
        f = _newFactory(Defaults.ROUTE_SWEEP_DELAY, treasury);
        (payer, pk) = makeAddrAndKey("payer");
        usdc.mint(payer, 100 * USDC);
    }

    function _offer() internal view returns (EscrowDepositRouteFactory.Offer memory) {
        return EscrowDepositRouteFactory.Offer({
            provider: provider, evaluator: evaluator, amount: 2 * USDC, deadlineSeconds: 1 days, specHash: SPEC
        });
    }

    function _sign(address to, uint256 value, uint256 vb, bytes32 nonce) internal view returns (bytes memory) {
        bytes32 sh = keccak256(abi.encode(usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), payer, to, value, 0, vb, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), sh));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _attest(
        EscrowDepositRouteFactory.Offer memory o,
        bytes32 txh,
        uint256 li,
        address from,
        uint256 v,
        bool ro
    ) internal returns (uint256 jobId, bool refunded) {
        return _attest2(f, o, txh, li, from, v, ro); // v0.1.2: 2-of-3
    }

    // ---------------- regression: same-nonce double-sign (was test_KnownIssue_*) ----------------

    /// Attacker signs A (to = route, 2 USDC) and B (to = elsewhere, 1 unit) with one nonce, executes B,
    /// then tries to get A credited. There is no refund() and settle() only credits what it moves
    /// itself, so the token rejects A's used nonce; the route's other funds stay put.
    function test_Regression_SameNonceDoubleSign_NoRefundNoCredit() public {
        EscrowDepositRouteFactory.Offer memory o = _offer();
        EscrowDepositRoute r = EscrowDepositRoute(f.deploy(o));
        usdc.mint(address(r), 2 * USDC); // someone else's unsettled funds / a stray
        uint256 vb = block.timestamp + 1 hours;
        bytes32 n = bytes32(uint256(4242));
        usdc.transferWithAuthorization(payer, outsider, 1, 0, vb, n, _sign(outsider, 1, vb, n)); // B uses nonce n
        bytes memory claim = _sign(address(r), 2 * USDC, vb, n); // A, never executed
        uint256 p0 = usdc.balanceOf(payer);
        vm.expectRevert(MockUSDC.AuthorizationAlreadyUsed.selector);
        f.settle(o, payer, 2 * USDC, 0, vb, n, claim);
        // the removed permissionless refund(...) selector no longer exists on the route
        (bool ok,) = address(r)
            .call(
                abi.encodeWithSignature(
                    "refund(address,uint256,uint256,uint256,bytes32,bytes)", payer, 2 * USDC, 0, vb, n, claim
                )
            );
        assertFalse(ok, "refund path must not exist");
        // and the attacker cannot attest it himself
        vm.prank(payer);
        vm.expectRevert(EscrowDepositRouteFactory.NotKeeper.selector);
        f.attestDeposit(o, keccak256("fake"), 0, payer, 2 * USDC, true);
        assertEq(usdc.balanceOf(payer), p0, "attacker gained nothing");
        assertEq(usdc.balanceOf(address(r)), 2 * USDC, "route funds untouched");
    }

    /// Same exploit via the old front-run settle + cancel: settle reverts, so no job, nothing to cancel.
    function test_Regression_SameNonceDoubleSign_ViaFrontRunSettle_Fails() public {
        EscrowDepositRouteFactory.Offer memory o = _offer();
        EscrowDepositRoute r = EscrowDepositRoute(f.deploy(o));
        usdc.mint(address(r), 2 * USDC);
        uint256 vb = block.timestamp + 1 hours;
        bytes32 n = bytes32(uint256(4343));
        usdc.transferWithAuthorization(payer, outsider, 1, 0, vb, n, _sign(outsider, 1, vb, n));
        uint256 jobs0 = escrow.jobCount();
        bytes memory claim = _sign(address(r), 2 * USDC, vb, n);
        vm.expectRevert(MockUSDC.AuthorizationAlreadyUsed.selector);
        f.settle(o, payer, 2 * USDC, 0, vb, n, claim);
        assertEq(escrow.jobCount(), jobs0, "no job opened from others' funds");
        assertEq(usdc.balanceOf(address(r)), 2 * USDC);
    }

    // ---------------- atomic path ----------------

    function test_A1e_AtomicSettle_CreditsOnlyWhatItMoves() public {
        EscrowDepositRouteFactory.Offer memory o = _offer();
        address route = f.routeFor(o);
        uint256 vb = block.timestamp + 1 hours;
        bytes32 n = bytes32(uint256(1));
        vm.expectEmit(true, true, true, true, route);
        emit EscrowDepositRoute.DepositSettled(payer, n, 1);
        (, uint256 jobId) = f.settle(o, payer, 2 * USDC, 0, vb, n, _sign(route, 2 * USDC, vb, n));
        assertEq(escrow.getJob(jobId).client, payer);
        assertEq(usdc.balanceOf(route), 0);
        assertTrue(EscrowDepositRoute(route).settled(payer, n));
    }

    // ---------------- keeper attestation ----------------

    function test_A1e_Attest_OpensJob_And_RejectsDoubleCredit() public {
        EscrowDepositRouteFactory.Offer memory o = _offer();
        address route = f.routeFor(o);
        usdc.mint(route, 4 * USDC); // two deposits of 2 (e.g. front-run authorizations)
        bytes32 txh = keccak256("tx-a");
        vm.prank(keeper);
        f.attestDeposit(o, txh, 5, payer, 2 * USDC, false);
        vm.expectEmit(true, true, true, true, address(f));
        emit EscrowDepositRouteFactory.DepositAttested(route, f.transferId(txh, 5), payer, 2 * USDC, 1, false, false);
        vm.prank(keeper2);
        (, uint256 jobId, bool refunded) = f.attestDeposit(o, txh, 5, payer, 2 * USDC, false);
        assertFalse(refunded);
        assertEq(escrow.getJob(jobId).client, payer);
        assertTrue(f.attested(f.transferId(txh, 5)));
        // same (txHash, logIndex) again: rejected, even with other parameters or another route
        vm.prank(keeper3);
        vm.expectRevert(abi.encodeWithSelector(EscrowDepositRouteFactory.AlreadyAttested.selector, txh, 5));
        f.attestDeposit(o, txh, 5, payer, 2 * USDC, false);
        EscrowDepositRouteFactory.Offer memory o2 = _offer();
        o2.amount = 1 * USDC;
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(EscrowDepositRouteFactory.AlreadyAttested.selector, txh, 5));
        f.attestDeposit(o2, txh, 5, outsider, 1, true);
        // a different log index in the same tx is a different transfer
        _attest(o, txh, 6, payer, 2 * USDC, false);
        assertEq(usdc.balanceOf(route), 0);
        assertEq(EscrowDepositRoute(route).attestedTotal(), 4 * USDC);
    }

    function test_A1e_Attest_WrongValueOrRefundOnly_RefundsFrom() public {
        EscrowDepositRouteFactory.Offer memory o = _offer();
        address route = f.routeFor(o);
        usdc.mint(route, 5 * USDC);
        uint256 p0 = usdc.balanceOf(payer);
        (uint256 j1, bool r1) = _attest(o, keccak256("w"), 0, payer, 3 * USDC, false); // wrong value
        assertEq(j1, 0);
        assertTrue(r1);
        (uint256 j2, bool r2) = _attest(o, keccak256("r"), 0, payer, 2 * USDC, true); // refund mode
        assertEq(j2, 0);
        assertTrue(r2);
        assertEq(usdc.balanceOf(payer) - p0, 5 * USDC);
    }

    function test_A1e_Attest_Guards() public {
        EscrowDepositRouteFactory.Offer memory o = _offer();
        address route = f.routeFor(o);
        usdc.mint(route, 1 * USDC);
        vm.prank(outsider);
        vm.expectRevert(EscrowDepositRouteFactory.NotKeeper.selector);
        f.attestDeposit(o, keccak256("x"), 0, payer, 1, true);
        vm.startPrank(keeper);
        vm.expectRevert(EscrowDepositRouteFactory.InvalidAttestation.selector);
        f.attestDeposit(o, bytes32(0), 0, payer, 1, true);
        vm.expectRevert(EscrowDepositRouteFactory.InvalidAttestation.selector);
        f.attestDeposit(o, keccak256("x"), 0, address(0), 1, true);
        vm.expectRevert(EscrowDepositRouteFactory.InvalidAttestation.selector);
        f.attestDeposit(o, keccak256("x"), 0, payer, 0, true);
        // cannot credit more than route + vault hold: the k-th vote reverts (id not consumed)
        f.attestDeposit(o, keccak256("x"), 0, payer, 2 * USDC, false);
        vm.stopPrank();
        vm.prank(keeper2);
        vm.expectRevert(abi.encodeWithSelector(RecoveryVault.InsufficientUnclaimed.selector, 1 * USDC, 2 * USDC));
        f.attestDeposit(o, keccak256("x"), 0, payer, 2 * USDC, false);
        assertFalse(f.attested(f.transferId(keccak256("x"), 0)));
        assertEq(f.claimOf(f.transferId(keccak256("x"), 0)).count, 1);
        // only the factory may call the route's credit hook
        f.deploy(o);
        vm.prank(keeper);
        vm.expectRevert(EscrowDepositRoute.OnlyFactory.selector);
        EscrowDepositRoute(route).creditAttested(keccak256("y"), payer, 1, true);
    }

    // ---------------- keeper allowlist: deploy-time + timelock ----------------

    function test_A1e_KeeperAllowlist_Timelocked() public {
        assertTrue(f.isKeeper(keeper));
        assertEq(f.keeperTimelock(), 48 hours);
        address k2 = makeAddr("keeper4");
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, outsider));
        f.proposeKeeper(k2, true);
        uint64 eta = uint64(block.timestamp + 48 hours);
        vm.expectEmit(true, true, true, true, address(f));
        emit EscrowDepositRouteFactory.KeeperChangeProposed(k2, true, eta);
        vm.prank(owner);
        f.proposeKeeper(k2, true);
        vm.expectRevert(abi.encodeWithSelector(EscrowDepositRouteFactory.TimelockNotElapsed.selector, eta));
        f.executeKeeper(k2);
        vm.warp(eta);
        vm.expectEmit(true, true, true, true, address(f));
        emit EscrowDepositRouteFactory.KeeperSet(k2, true, 1);
        f.executeKeeper(k2); // anyone
        assertTrue(f.isKeeper(k2));
        assertEq(f.keeperCount(), 4);
        assertEq(f.keeperEpoch(), 1);
        // removal is timelocked too; cancel works
        vm.prank(owner);
        f.proposeKeeper(keeper, false);
        vm.prank(owner);
        f.cancelKeeper(keeper);
        vm.expectRevert(EscrowDepositRouteFactory.NoPendingChange.selector);
        f.executeKeeper(keeper);
        assertTrue(f.isKeeper(keeper));
        vm.prank(owner);
        f.proposeKeeper(keeper, false);
        vm.warp(block.timestamp + 48 hours);
        f.executeKeeper(keeper);
        assertFalse(f.isKeeper(keeper));
        vm.prank(keeper);
        vm.expectRevert(EscrowDepositRouteFactory.NotKeeper.selector);
        f.attestDeposit(_offer(), keccak256("z"), 0, payer, 1, true);
        vm.expectRevert(EscrowDepositRouteFactory.ZeroAddress.selector);
        vm.prank(owner);
        f.proposeKeeper(address(0), true);
    }

    // ---------------- sweep with keeper-only snapshot ----------------

    /// Keeper attests the attributable deposit before snapshotting, so the snapshot holds only the
    /// unattributable stray. A deposit arriving after the snapshot is never swept.
    function test_A1e_Sweep_OnlyUnattributableExcess() public {
        EscrowDepositRouteFactory.Offer memory o = _offer();
        EscrowDepositRoute r = EscrowDepositRoute(f.deploy(o));
        usdc.mint(address(r), 2 * USDC); // attributable (keeper saw its Transfer log)
        usdc.mint(address(r), 1 * USDC); // unattributable (e.g. a mint / undeclined transfer)
        _attest(o, keccak256("p"), 0, payer, 2 * USDC, true);
        vm.prank(keeper);
        r.startSweep();
        assertEq(r.sweepAmount(), 1 * USDC);
        usdc.mint(address(r), 2 * USDC); // post-snapshot deposit
        vm.warp(block.timestamp + 30 days);
        assertEq(r.sweep(), 1 * USDC);
        assertEq(usdc.balanceOf(address(r)), 2 * USDC, "post-snapshot deposit untouched");
        _attest(o, keccak256("q"), 0, payer, 2 * USDC, false);
        assertEq(usdc.balanceOf(address(r)), 0);
    }

    /// Deduction is conservative and never underflows.
    function test_A1e_Deduction_Conservative_NoUnderflow() public {
        EscrowDepositRouteFactory.Offer memory o = _offer();
        EscrowDepositRoute r = EscrowDepositRoute(f.deploy(o));
        usdc.mint(address(r), 1 * USDC);
        vm.prank(keeper);
        r.startSweep();
        usdc.mint(address(r), 2 * USDC);
        _attest(o, keccak256("late"), 0, payer, 2 * USDC, true);
        assertEq(r.sweepAmount(), 0);
        vm.warp(block.timestamp + 30 days);
        assertEq(r.sweep(), 0);
        assertEq(usdc.balanceOf(address(r)), 1 * USDC);
    }
}
