// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {IArbitrator} from "../src/interfaces/IArbitrator.sol";

/// Mainnet launch profile (Carter, Nov 23): disputes off = escrow.arbitrator == address(0), fees 0.
/// Challenge reverts atomically (nothing frozen); verdict -> finalize and refunds still work.
contract DisputesOffTest is BaseTest {
    function setUp() public override {
        super.setUp();
        JobEscrow.Config memory c = escrow.currentConfig();
        c.feeBps = 0;
        c.evaluatorFeeBps = 0;
        vm.startPrank(owner);
        escrow.setConfig(c);
        escrow.setArbitrator(IArbitrator(address(0)));
        vm.stopPrank();
    }

    function test_challenge_reverts_noFreeze_thenSettles() public {
        uint256 id = _openAndSubmit(10 * USDC);
        _verdict(id, JobEscrow.Outcome.Reject, 0);
        uint256 cl0 = usdc.balanceOf(client);
        uint256 pr0 = usdc.balanceOf(provider);
        vm.prank(provider);
        vm.expectRevert(JobEscrow.NoArbitrator.selector);
        escrow.challenge(id, REASON);
        assertEq(uint8(_state(id)), uint8(JobEscrow.State.Rejected), "state unchanged");
        assertEq(usdc.balanceOf(provider), pr0, "no bond taken");
        _passChallengeWindow();
        escrow.finalize(id);
        assertEq(uint8(_state(id)), uint8(JobEscrow.State.Settled));
        assertEq(usdc.balanceOf(client), cl0 + 10 * USDC, "reject refunds client");
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function test_completeSettles_zeroFees() public {
        uint256 id = _openAndSubmit(10 * USDC);
        _verdict(id, JobEscrow.Outcome.Complete, 10000);
        uint256 pr0 = usdc.balanceOf(provider);
        uint256 t0 = usdc.balanceOf(treasury);
        uint256 e0 = usdc.balanceOf(evaluator);
        _passChallengeWindow();
        escrow.finalize(id);
        assertEq(usdc.balanceOf(provider), pr0 + 10 * USDC, "provider gets 100%");
        assertEq(usdc.balanceOf(treasury), t0, "no protocol fee");
        assertEq(usdc.balanceOf(evaluator), e0, "no evaluator fee");
    }

    function test_refunds_work() public {
        uint256 a = _open(5 * USDC);
        uint256 cl0 = usdc.balanceOf(client);
        vm.prank(client);
        escrow.cancel(a);
        assertEq(usdc.balanceOf(client), cl0 + 5 * USDC);
        uint256 b = _open(5 * USDC);
        vm.prank(provider);
        escrow.accept(b);
        vm.warp(block.timestamp + 3 days);
        escrow.claimRefund(b);
        assertEq(usdc.balanceOf(client), cl0 + 5 * USDC, "claimRefund returns b");
        assertEq(escrow.totalLocked(), 0);
    }
}
