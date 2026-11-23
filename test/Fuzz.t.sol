// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {JobEscrow} from "../src/JobEscrow.sol";

contract FuzzTest is BaseTest {
    function _sumBalances() internal view returns (uint256) {
        return usdc.balanceOf(client) + usdc.balanceOf(provider) + usdc.balanceOf(evaluator) + usdc.balanceOf(treasury)
            + usdc.balanceOf(address(escrow)) + usdc.balanceOf(address(registry)) + usdc.balanceOf(address(arb));
    }

    /// Partial verdict: provider net + fee + client refund == amount; escrow empty afterwards.
    function testFuzz_PartialConservation(uint256 amount, uint16 bps) public {
        amount = bound(amount, 2, 500 * USDC);
        bps = uint16(bound(bps, 1, 9_999));
        uint256 c0 = usdc.balanceOf(client);
        uint256 p0 = usdc.balanceOf(provider);
        uint256 id = _openAndSubmit(amount);
        _verdict(id, JobEscrow.Outcome.Partial, bps);
        _passChallengeWindow();
        escrow.finalize(id);

        uint256 gross = (amount * bps) / 10_000;
        uint256 fee = (gross * 100) / 10_000;
        uint256 evalFee = (gross * 50) / 10_000;
        assertEq(usdc.balanceOf(provider) - p0, gross - fee - evalFee);
        assertEq(usdc.balanceOf(treasury), fee);
        assertEq(c0 - usdc.balanceOf(client), gross);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    /// Any verdict + any ruling + any provider bond: total tokens conserved, escrow drained,
    /// exposure released, evaluator slashed iff the ruling is material.
    function testFuzz_DisputeConservation(
        uint256 amount,
        uint8 outcomeSeed,
        uint16 partialBps,
        uint16 rulingBps,
        uint256 providerBond,
        bool clientChallenges
    ) public {
        amount = bound(amount, 2 * USDC, 500 * USDC);
        rulingBps = uint16(bound(rulingBps, 0, 10_000));
        providerBond = bound(providerBond, 0, 1_000 * USDC);
        uint256 total0 = _sumBalances();

        uint256 id = _open(amount);
        if (providerBond > 0) {
            vm.prank(provider);
            escrow.postProviderBond(id, providerBond);
        }
        vm.prank(provider);
        escrow.submit(id, DELIVERABLE);

        uint8 o = outcomeSeed % 3;
        uint16 vbps;
        if (o == 0) {
            vbps = 10_000;
            _verdict(id, JobEscrow.Outcome.Complete, vbps);
        } else if (o == 1) {
            vbps = 0;
            _verdict(id, JobEscrow.Outcome.Reject, vbps);
        } else {
            vbps = uint16(bound(partialBps, 1, 9_999));
            _verdict(id, JobEscrow.Outcome.Partial, vbps);
        }

        vm.prank(clientChallenges ? client : provider);
        escrow.challenge(id, REASON);
        vm.prank(owner);
        arb.giveRuling(1, rulingBps);

        uint256 diff = rulingBps > vbps ? rulingBps - vbps : vbps - rulingBps;
        uint256 expectedStake = diff > 2000 ? 74.5e6 : 100 * USDC; // overturn: 0.5 fee reimbursed + 25 slashed
        assertEq(registry.stakeOf(evaluator), expectedStake);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(_sumBalances(), total0);
        assertEq(registry.evaluatorInfo(evaluator).exposure, 0);
        assertEq(uint8(escrow.getJob(id).state), uint8(JobEscrow.State.Settled));
    }

    function testFuzz_ChallengeBond(uint256 amount) public view {
        amount = bound(amount, 1, type(uint128).max);
        (,,, uint256 bond,,,) = escrow.quote(amount, 0);
        uint256 pct = (amount * 500) / 10_000;
        assertEq(bond, pct > USDC ? pct : USDC);
    }

    function testFuzz_ExposureCap(uint256 extraStake, uint256 amount) public {
        extraStake = bound(extraStake, 0, 900 * USDC);
        amount = bound(amount, 1, 10_000 * USDC);
        if (extraStake > 0) _stake(evaluator, extraStake);
        uint256 cap = (100 * USDC + extraStake) * 5;
        vm.prank(client);
        if (amount > cap) vm.expectRevert();
        escrow.createAndFund(provider, evaluator, amount, uint64(block.timestamp + 1 days), SPEC);
    }

    function testFuzz_OnlyNamedEvaluatorCanVerdict(address caller) public {
        vm.assume(caller != evaluator);
        uint256 id = _openAndSubmit(10 * USDC);
        vm.prank(caller);
        vm.expectRevert(JobEscrow.Unauthorized.selector);
        escrow.verdict(id, JobEscrow.Outcome.Complete, 10_000, REASON);
    }
}
