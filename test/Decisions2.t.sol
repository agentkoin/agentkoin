// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {IArbitrator} from "../src/interfaces/IArbitrator.sol";
import {EscrowDepositRoute, EscrowDepositRouteFactory} from "../src/EscrowDepositRoute.sol";
import {Defaults} from "../script/Defaults.sol";

/// Round-2 research decisions: E-17a (held arbitration fee), E-17b (arbitrationCost quote),
/// A-1a (route sweep). E-1a adapter expiry tests live in Adapter.t.sol.
contract Decisions2Test is BaseTest {
    EscrowDepositRouteFactory internal f;

    function setUp() public override {
        super.setUp();
        f = _newFactory(Defaults.ROUTE_SWEEP_DELAY, treasury);
    }

    // ---------------- E-17a ----------------

    function test_E17a_StaleDispute_RefundsFee_InstantJob() public {
        uint256 id = _open(1 * USDC);
        vm.startPrank(provider);
        escrow.postProviderBond(id, 1 * USDC);
        escrow.submit(id, DELIVERABLE);
        vm.stopPrank();
        uint256 c0 = usdc.balanceOf(client);
        vm.prank(client);
        escrow.challenge(id, REASON);
        assertEq(usdc.balanceOf(address(escrow)), 1 * USDC + 1 * USDC + ARB_FEE); // provider bond + challenge bond + fee
        vm.warp(block.timestamp + 30 days);
        escrow.resolveStaleDispute(id);
        assertEq(usdc.balanceOf(client), c0);
        assertEq(usdc.balanceOf(address(arb)), 0);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    /// The amount held and paid is the quote at challenge time, even if the arbitrator re-prices.
    function test_E17a_FeeFixedAtChallenge() public {
        uint256 id = _openAndSubmit(100 * USDC);
        _verdict(id, JobEscrow.Outcome.Complete, 10_000);
        vm.prank(client);
        escrow.challenge(id, REASON);
        vm.prank(owner);
        arb.setFee(9 * USDC);
        vm.prank(owner);
        arb.giveRuling(1, 10_000);
        assertEq(usdc.balanceOf(address(arb)), ARB_FEE);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_E17a_FailedChallenge_FeeToArbitrator_NotReimbursed() public {
        uint256 id = _openAndSubmit(100 * USDC);
        _verdict(id, JobEscrow.Outcome.Partial, 6000);
        uint256 p0 = usdc.balanceOf(provider);
        vm.prank(provider);
        escrow.challenge(id, REASON);
        vm.prank(owner);
        arb.giveRuling(1, 7000); // diff 1000 <= materialDiffBps 2000: not overturned
        assertEq(usdc.balanceOf(address(arb)), ARB_FEE);
        assertEq(registry.stakeOf(evaluator), 100 * USDC);
        // provider: -5 bond -0.5 fee + 70 gross - 0.7 fee - 0.35 evaluator fee
        assertEq(int256(usdc.balanceOf(provider)) - int256(p0), int256(70 * USDC - 7e5 - 35e4 - 5 * USDC - ARB_FEE));
    }

    // ---------------- E-17b ----------------

    function test_E17b_QuoteUsesArbitrationCost() public {
        assertEq(arb.arbitrationCost(0, 1), ARB_FEE); // flat mock
        assertEq(arb.arbitrationCost(42, 1_000_000 * USDC), ARB_FEE);
        vm.prank(owner);
        escrow.setArbitrator(IArbitrator(address(0)));
        (,,,, uint256 cost,,) = escrow.quote(100 * USDC, 0);
        assertEq(cost, 0);
    }

    // ---------------- A-1a sweep ----------------

    function _offer() internal view returns (EscrowDepositRouteFactory.Offer memory) {
        return EscrowDepositRouteFactory.Offer({
            provider: provider, evaluator: evaluator, amount: 2 * USDC, deadlineSeconds: 1 days, specHash: SPEC
        });
    }

    function _signAuth(uint256 pk, address from, address to, uint256 value, uint256 vb, bytes32 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 structHash =
            keccak256(abi.encode(usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), from, to, value, 0, vb, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_A1a_Sweep_StrayAfterDelay() public {
        EscrowDepositRoute r = EscrowDepositRoute(f.deploy(_offer()));
        vm.prank(keeper);
        vm.expectRevert(EscrowDepositRoute.NothingToSweep.selector);
        r.startSweep();
        vm.expectRevert(EscrowDepositRoute.SweepNotStarted.selector);
        r.sweep();
        usdc.mint(address(r), 3 * USDC); // stray transfer
        uint64 at = uint64(block.timestamp + 30 days);
        vm.expectEmit(true, true, true, true, address(r));
        emit EscrowDepositRoute.SweepStarted(keeper, 3 * USDC, at);
        vm.prank(outsider); // A-1e: only a keeper starts a sweep
        vm.expectRevert(EscrowDepositRoute.NotKeeper.selector);
        r.startSweep();
        vm.prank(keeper);
        r.startSweep();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(EscrowDepositRoute.SweepPending.selector, at));
        r.startSweep();
        vm.warp(at - 1);
        vm.expectRevert(abi.encodeWithSelector(EscrowDepositRoute.SweepDelayNotElapsed.selector, at));
        r.sweep();
        vm.warp(at);
        uint256 t0 = usdc.balanceOf(treasury);
        address v = address(f.vault());
        vm.expectEmit(true, true, true, true, address(r));
        emit EscrowDepositRoute.Swept(outsider, v, 3 * USDC);
        vm.prank(outsider); // permissionless
        r.sweep();
        // v0.1.2: swept into the RecoveryVault under this route, not to the treasury
        assertEq(usdc.balanceOf(treasury), t0);
        assertEq(usdc.balanceOf(v), 3 * USDC);
        assertEq(f.vault().unclaimed(address(r)), 3 * USDC);
        assertEq(usdc.balanceOf(address(r)), 0);
        assertEq(r.sweepableAt(), 0);
    }

    /// A front-run payment attested by the keeper during the delay is deducted from the snapshot;
    /// the sweep never exceeds what is left of it. (A-1e: attest, not front-run settle.)
    function test_A1a_Sweep_FrontRunPayerAttestedDuringDelay() public {
        EscrowDepositRouteFactory.Offer memory o = _offer();
        address payTo = f.routeFor(o);
        (address payer, uint256 pk) = makeAddrAndKey("payer");
        usdc.mint(payer, 10 * USDC);
        uint256 vb = block.timestamp + 10 minutes;
        bytes32 nonce = bytes32(uint256(77));
        bytes memory sig = _signAuth(pk, payer, payTo, 2 * USDC, vb, nonce);
        usdc.transferWithAuthorization(payer, payTo, 2 * USDC, 0, vb, nonce, sig); // direct to token
        usdc.mint(payTo, 1 * USDC); // plus a stray
        EscrowDepositRoute r = EscrowDepositRoute(f.deploy(o));
        vm.prank(keeper); // a keeper that had not yet seen the payment
        r.startSweep();
        assertEq(r.sweepAmount(), 3 * USDC);
        vm.warp(block.timestamp + 10 days);
        (uint256 jobId,) = _attest2(f, o, keccak256("tx77"), 3, payer, 2 * USDC, false);
        assertEq(escrow.getJob(jobId).client, payer);
        assertEq(r.sweepAmount(), 1 * USDC, "attested credit deducted from the snapshot");
        usdc.mint(payTo, 4 * USDC); // arrives after the snapshot
        vm.warp(block.timestamp + 20 days);
        assertEq(r.sweep(), 1 * USDC); // only the unattributable stray
        assertEq(f.vault().unclaimed(address(r)), 1 * USDC); // into the vault (v0.1.2)
        assertEq(usdc.balanceOf(payTo), 4 * USDC); // needs a new sweep cycle
    }

    function test_A1a_SweepDelayConfigurable() public {
        EscrowDepositRouteFactory f2 = _newFactory(1 days, treasury);
        assertEq(f2.sweepDelay(), 1 days);
        EscrowDepositRoute r = EscrowDepositRoute(f2.deploy(_offer()));
        usdc.mint(address(r), 1);
        vm.prank(keeper);
        r.startSweep();
        assertEq(r.sweepableAt(), block.timestamp + 1 days);
        vm.expectRevert(EscrowDepositRouteFactory.InvalidSweepDelay.selector);
        _newFactory(0, treasury);
    }

    /// A-1d: the sweep destination is fixed per route at creation; a later escrow treasury change
    ///       does not redirect it.
    function test_A1d_SweepToFixedAtCreation() public {
        EscrowDepositRoute r = EscrowDepositRoute(f.deploy(_offer()));
        assertEq(r.sweepTo(), address(f.vault())); // v0.1.2: the factory's RecoveryVault
        assertEq(f.sweepTo(), address(f.vault()));
        assertEq(f.vault().treasury(), treasury);
        usdc.mint(address(r), 5);
        vm.prank(keeper);
        r.startSweep();
        address t2 = makeAddr("treasury2");
        vm.prank(owner);
        escrow.setTreasury(t2);
        vm.warp(block.timestamp + 30 days);
        r.sweep();
        assertEq(usdc.balanceOf(t2), 0);
        assertEq(r.sweepTo(), address(f.vault()));
        vm.expectRevert(EscrowDepositRouteFactory.InvalidTreasury.selector);
        _newFactory(1 days, address(0));
    }
}
