// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {EvaluatorRegistry} from "../src/EvaluatorRegistry.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract EvaluatorRegistryTest is BaseTest {
    function test_Stake_BelowMin_Reverts() public {
        vm.startPrank(evaluator2);
        usdc.approve(address(registry), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(EvaluatorRegistry.BelowMinStake.selector, 99 * USDC, 100 * USDC));
        registry.stake(99 * USDC);
        vm.stopPrank();
    }

    function test_Stake_TopUp() public {
        _stake(evaluator, 50 * USDC);
        assertEq(registry.stakeOf(evaluator), 150 * USDC);
        assertEq(registry.availableExposure(evaluator), 750 * USDC);
        assertTrue(registry.isActive(evaluator));
    }

    function test_Unstake_FullCycle() public {
        vm.prank(evaluator);
        registry.requestUnstake();
        assertFalse(registry.isActive(evaluator));
        vm.prank(evaluator);
        vm.expectRevert();
        registry.withdraw();
        vm.warp(block.timestamp + 7 days);
        uint256 b0 = usdc.balanceOf(evaluator);
        vm.prank(evaluator);
        registry.withdraw();
        assertEq(usdc.balanceOf(evaluator) - b0, 100 * USDC);
        assertEq(registry.stakeOf(evaluator), 0);
    }

    function test_Unbonding_CannotBeAssignedOrStake() public {
        vm.prank(evaluator);
        registry.requestUnstake();
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.EvaluatorNotActive.selector, evaluator));
        escrow.createJob(provider, evaluator, 1, uint64(block.timestamp + 1 days), SPEC);
        vm.prank(evaluator);
        vm.expectRevert(EvaluatorRegistry.AlreadyUnbonding.selector);
        registry.stake(1);
    }

    function test_Unbonding_FundAfterUnstakeRequest_Reverts() public {
        vm.prank(client);
        uint256 id = escrow.createJob(provider, evaluator, 1, uint64(block.timestamp + 1 days), SPEC);
        vm.prank(evaluator);
        registry.requestUnstake();
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(EvaluatorRegistry.EvaluatorNotActive.selector, evaluator));
        escrow.fund(id);
    }

    /// Evaluator starts unbonding with an open job, then misses the verdict: still slashed.
    function test_Unbonding_StillSlashable() public {
        uint256 id = _openAndSubmit(100 * USDC);
        vm.prank(evaluator);
        registry.requestUnstake();
        vm.warp(block.timestamp + 7 days); // unbonding elapsed, but job still open
        vm.prank(evaluator);
        vm.expectRevert(abi.encodeWithSelector(EvaluatorRegistry.HasOpenJobs.selector, 1));
        registry.withdraw();

        escrow.timeoutRelease(id);
        assertEq(registry.stakeOf(evaluator), 90 * USDC);

        uint256 b0 = usdc.balanceOf(evaluator);
        vm.prank(evaluator);
        registry.withdraw();
        assertEq(usdc.balanceOf(evaluator) - b0, 90 * USDC);
    }

    function _addSlasherViaTimelock(address who) internal {
        vm.prank(owner);
        registry.proposeSlasher(who, true);
        vm.warp(block.timestamp + 48 hours);
        registry.executeSlasher(who);
    }

    function test_Slash_CappedAtStake() public {
        _addSlasherViaTimelock(address(this));
        uint256 slashed = registry.slash(evaluator, 0, 1_000 * USDC, outsider, 2);
        assertEq(slashed, 100 * USDC);
        assertEq(registry.stakeOf(evaluator), 0);
        assertEq(usdc.balanceOf(outsider), 50 * USDC);
        assertEq(usdc.balanceOf(treasury), 50 * USDC);
        assertFalse(registry.isActive(evaluator));
        assertEq(registry.evaluatorInfo(evaluator).slashedTotal, 100 * USDC);
    }

    function test_SlashedBelowMin_BecomesInactive() public {
        uint256 id = _openAndSubmit(100 * USDC);
        vm.warp(block.timestamp + 25 hours);
        escrow.timeoutRelease(id); // stake 90 < minStake 100
        assertFalse(registry.isActive(evaluator));
        _stake(evaluator, 10 * USDC); // top back up
        assertTrue(registry.isActive(evaluator));
    }

    function test_Config_OnlyOwner_AndValidation() public {
        EvaluatorRegistry.Config memory c = registry.config();
        vm.prank(outsider);
        vm.expectRevert();
        registry.setConfig(c);
        c.slashHarmedShareBps = 10_001;
        vm.prank(owner);
        vm.expectRevert(EvaluatorRegistry.InvalidConfig.selector);
        registry.setConfig(c);
    }

    // ---------------- R-5: deploy-time slashers + timelock ----------------

    function test_R5_DeploySlashers() public view {
        assertTrue(registry.isSlasher(address(escrow)));
        assertTrue(registry.isSlasher(address(adapter)));
        assertFalse(registry.isSlasher(owner));
        assertEq(registry.slasherTimelock(), 48 hours);
    }

    function test_R5_NonSlasherCannotSlash() public {
        vm.expectRevert(EvaluatorRegistry.NotSlasher.selector);
        registry.slash(evaluator, 0, 1, outsider, 2);
        vm.expectRevert(EvaluatorRegistry.NotSlasher.selector);
        registry.reimburse(evaluator, 0, 1, outsider);
    }

    function test_R5_ProposeOnlyOwner() public {
        vm.prank(outsider);
        vm.expectRevert();
        registry.proposeSlasher(outsider, true);
    }

    function test_R5_TimelockEnforced() public {
        vm.expectEmit(true, false, false, true, address(registry));
        emit EvaluatorRegistry.SlasherChangeProposed(outsider, true, uint64(block.timestamp + 48 hours));
        vm.prank(owner);
        registry.proposeSlasher(outsider, true);
        vm.warp(block.timestamp + 48 hours - 1);
        vm.expectRevert(
            abi.encodeWithSelector(EvaluatorRegistry.TimelockNotElapsed.selector, uint64(block.timestamp + 1))
        );
        registry.executeSlasher(outsider);
        assertFalse(registry.isSlasher(outsider));
        vm.warp(block.timestamp + 1);
        vm.expectEmit(true, false, false, true, address(registry));
        emit EvaluatorRegistry.SlasherSet(outsider, true);
        vm.prank(outsider); // anyone may execute
        registry.executeSlasher(outsider);
        assertTrue(registry.isSlasher(outsider));
        vm.expectRevert(EvaluatorRegistry.NoPendingChange.selector);
        registry.executeSlasher(outsider);
    }

    function test_R5_RemovalAlsoTimelocked_AndCancel() public {
        vm.prank(owner);
        registry.proposeSlasher(address(escrow), false);
        assertTrue(registry.isSlasher(address(escrow)));
        vm.prank(owner);
        registry.cancelSlasher(address(escrow));
        vm.warp(block.timestamp + 49 hours);
        vm.expectRevert(EvaluatorRegistry.NoPendingChange.selector);
        registry.executeSlasher(address(escrow));
        assertTrue(registry.isSlasher(address(escrow)));
    }

    function test_R5_TimelockConfigurableAtDeploy() public {
        address[] memory none = new address[](0);
        EvaluatorRegistry r2 = new EvaluatorRegistry(IERC20(address(usdc)), registry.config(), owner, none, 1 hours);
        assertEq(r2.slasherTimelock(), 1 hours);
        vm.prank(owner);
        r2.proposeSlasher(outsider, true);
        vm.warp(block.timestamp + 1 hours);
        r2.executeSlasher(outsider);
        assertTrue(r2.isSlasher(outsider));
    }

    function test_Reimburse_PaysFullAmountCapped() public {
        _addSlasherViaTimelock(address(this));
        uint256 paid = registry.reimburse(evaluator, 0, 30 * USDC, outsider);
        assertEq(paid, 30 * USDC);
        assertEq(usdc.balanceOf(outsider), 30 * USDC);
        assertEq(registry.stakeOf(evaluator), 70 * USDC);
        paid = registry.reimburse(evaluator, 0, 500 * USDC, outsider);
        assertEq(paid, 70 * USDC);
    }
}
