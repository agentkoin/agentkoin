// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {Defaults} from "../script/Defaults.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IEvaluatorRegistry} from "../src/interfaces/IEvaluatorRegistry.sol";
import {IArbitrator} from "../src/interfaces/IArbitrator.sol";

/// Hard fee ceiling: feeBps + evaluatorFeeBps <= 500 (5%) in the constructor and in setConfig (the only fee setter).
contract FeeCeilingTest is BaseTest {
    function _deploy(uint16 fee, uint16 evalFee) internal returns (JobEscrow) {
        JobEscrow.Config memory c = Defaults.escrowConfig();
        c.feeBps = fee;
        c.evaluatorFeeBps = evalFee;
        return new JobEscrow(IERC20(address(usdc)), IEvaluatorRegistry(address(registry)), treasury, IArbitrator(address(0)), c, owner, owner, 50e6, 500e6);
    }

    function test_Constant() public view {
        assertEq(escrow.MAX_TOTAL_FEE_BPS(), 500);
    }

    function test_Constructor_RevertsAboveCeiling() public {
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.FeeCeilingExceeded.selector, 501, 500));
        _deploy(501, 0);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.FeeCeilingExceeded.selector, 501, 500));
        _deploy(0, 501);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.FeeCeilingExceeded.selector, 501, 500));
        _deploy(300, 201);
    }

    function test_Constructor_BoundaryOk() public {
        JobEscrow e = _deploy(450, 50);
        assertEq(uint256(e.currentConfig().feeBps) + e.currentConfig().evaluatorFeeBps, 500);
        _deploy(500, 0);
        _deploy(0, 500);
    }

    function test_SetConfig_FeeBpsReverts() public {
        JobEscrow.Config memory c = escrow.currentConfig();
        c.evaluatorFeeBps = 0;
        c.feeBps = 501;
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.FeeCeilingExceeded.selector, 501, 500));
        escrow.setConfig(c);
    }

    function test_SetConfig_EvaluatorFeeBpsReverts() public {
        JobEscrow.Config memory c = escrow.currentConfig();
        c.feeBps = 0;
        c.evaluatorFeeBps = 501;
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.FeeCeilingExceeded.selector, 501, 500));
        escrow.setConfig(c);
    }

    function test_SetConfig_SumRevertsAndBoundaryOk() public {
        JobEscrow.Config memory c = escrow.currentConfig();
        c.feeBps = 400;
        c.evaluatorFeeBps = 101;
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.FeeCeilingExceeded.selector, 501, 500));
        escrow.setConfig(c);
        c.evaluatorFeeBps = 100;
        vm.prank(owner);
        escrow.setConfig(c);
        assertEq(escrow.currentConfig().feeBps, 400);
        assertEq(escrow.currentConfig().evaluatorFeeBps, 100);
    }

    function testFuzz_SetConfig_Ceiling(uint16 fee, uint16 evalFee) public {
        JobEscrow.Config memory c = escrow.currentConfig();
        c.feeBps = fee;
        c.evaluatorFeeBps = evalFee;
        vm.prank(owner);
        if (uint256(fee) + evalFee > 500) {
            vm.expectRevert(abi.encodeWithSelector(JobEscrow.FeeCeilingExceeded.selector, uint256(fee) + evalFee, 500));
            escrow.setConfig(c);
        } else {
            escrow.setConfig(c);
            assertEq(uint256(escrow.currentConfig().feeBps) + escrow.currentConfig().evaluatorFeeBps, uint256(fee) + evalFee);
        }
    }
}
