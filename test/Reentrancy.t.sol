// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {IArbitrator, IArbitrable} from "../src/interfaces/IArbitrator.sol";
import {ReentrantToken} from "./mocks/ReentrantToken.sol";

/// @notice Arbitrator that tries to rule inside requestRuling (re-entering challenge()).
contract ReenteringArbitrator is IArbitrator {
    bool public lastOk;
    bytes public lastRet;

    function arbitrationCost(uint256, uint256) external pure returns (uint256) {
        return 0;
    }

    function requestRuling(uint256 jobId, address, uint16, bytes32) external returns (uint256) {
        (lastOk, lastRet) = msg.sender.call(abi.encodeCall(IArbitrable.rule, (jobId, 0)));
        return 1;
    }
}

contract ReentrancyTest is BaseTest {
    ReentrantToken internal rtoken;

    function setUp() public override {
        rtoken = new ReentrantToken();
        _deployStack(IERC20(address(rtoken)));
        rtoken.mint(client, 10_000 * USDC);
        rtoken.mint(evaluator, 1_000 * USDC);
        vm.startPrank(evaluator);
        rtoken.approve(address(registry), type(uint256).max);
        registry.stake(100 * USDC);
        vm.stopPrank();
        vm.prank(client);
        rtoken.approve(address(escrow), type(uint256).max);
    }

    function _bal(address a) internal view returns (uint256) {
        return rtoken.balanceOf(a);
    }

    function test_Reentrancy_FinalizeDuringPayout_Blocked() public {
        vm.prank(client);
        uint256 id = escrow.createAndFund(provider, evaluator, 100 * USDC, uint64(block.timestamp + 1 days), SPEC);
        vm.prank(provider);
        escrow.submit(id, DELIVERABLE);
        vm.prank(evaluator);
        escrow.verdict(id, JobEscrow.Outcome.Complete, 10_000, REASON);
        vm.warp(block.timestamp + 49 hours);

        rtoken.arm(address(escrow), address(escrow), abi.encodeCall(JobEscrow.finalize, (id)));
        escrow.finalize(id);

        assertTrue(rtoken.attempted());
        assertFalse(rtoken.lastOk());
        assertEq(bytes4(rtoken.lastRet()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(_bal(provider), 98.5e6); // paid exactly once (1% fee, 0.5% evaluator fee)
        assertEq(_bal(treasury), 1 * USDC);
        assertEq(_bal(address(escrow)), 0);
    }

    function test_Reentrancy_ClaimRefundDuringRefund_Blocked() public {
        vm.prank(client);
        uint256 id = escrow.createAndFund(provider, evaluator, 100 * USDC, uint64(block.timestamp + 1 days), SPEC);
        vm.warp(block.timestamp + 1 days);
        rtoken.arm(address(escrow), address(escrow), abi.encodeCall(JobEscrow.claimRefund, (id)));
        escrow.claimRefund(id);
        assertFalse(rtoken.lastOk());
        assertEq(bytes4(rtoken.lastRet()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(_bal(client), 10_000 * USDC);
    }

    function test_Reentrancy_ArbitratorRulingInsideChallenge_Blocked() public {
        ReenteringArbitrator ra = new ReenteringArbitrator();
        vm.prank(owner);
        escrow.setArbitrator(ra);
        vm.prank(client);
        uint256 id = escrow.createAndFund(provider, evaluator, 100 * USDC, uint64(block.timestamp + 1 days), SPEC);
        vm.prank(provider);
        escrow.submit(id, DELIVERABLE);
        vm.prank(evaluator);
        escrow.verdict(id, JobEscrow.Outcome.Complete, 10_000, REASON);
        vm.prank(client);
        escrow.challenge(id, REASON);
        assertFalse(ra.lastOk());
        assertEq(bytes4(ra.lastRet()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(uint8(escrow.getJob(id).state), uint8(JobEscrow.State.Disputed));
    }
}
