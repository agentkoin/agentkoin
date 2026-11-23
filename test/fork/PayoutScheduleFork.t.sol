// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {JobEscrow} from "../../src/JobEscrow.sol";
import {EvaluatorRegistry} from "../../src/EvaluatorRegistry.sol";
import {IEvaluatorRegistry} from "../../src/interfaces/IEvaluatorRegistry.sol";
import {IArbitrator} from "../../src/interfaces/IArbitrator.sol";
import {PayoutScheduleLib} from "../../src/PayoutScheduleLib.sol";

/// Local Anvil fork of Base Sepolia (read-only RPC; nothing is broadcast).
///   FORK_BASE_SEPOLIA_RPC=https://sepolia.base.org forge test --match-path test/fork/PayoutScheduleFork.t.sol -vv
/// Deploys a fresh JobEscrow v0.6, impersonates the live registry owner to proposeSlasher +
/// executeSlasher after a 48h warp, then runs createAndFundScheduled / submit / verdictScheduled /
/// finalize against Circle test USDC. No live transactions.
contract PayoutScheduleForkTest is Test {
    address constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address constant REGISTRY = 0x30576DE005df028D1947C56dEcc85a2a5612036a;
    address constant LIVE_ESCROW = 0x4EaF6d09F8C22980Bb16E719779ACe73A7b1CB3D;
    address constant OWNER = 0x78e2C0164A80F3e337AE17e3bA4b8EA2C0Fa488e;
    address constant PROVIDER = 0x745528C4E0CBdA5759175A660da06d0aaA72db7F;
    address constant EVAL = 0xB87b0d6AD3B17A8a1795d6640317c7997140d140;
    address constant ARBITRATOR = 0x3C4587eD99B1969581cA4f041FD9535a0D269736;

    JobEscrow v06;

    function setUp() public {
        string memory rpc = vm.envOr("FORK_BASE_SEPOLIA_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
    }

    function testFork_CreateSubmitVerdictFinalize_Job2Shape() public {
        JobEscrow live = JobEscrow(LIVE_ESCROW);
        JobEscrow.Config memory cfg = live.config(2);
        assertEq(cfg.feeBps, 0);
        assertEq(cfg.evaluatorFeeBps, 0);
        assertEq(cfg.evalWindow, 3600);
        assertEq(cfg.challengeWindow, 600);

        v06 = new JobEscrow(IERC20(USDC), IEvaluatorRegistry(REGISTRY), OWNER, IArbitrator(ARBITRATOR), cfg, OWNER, OWNER, type(uint256).max, type(uint256).max);

        EvaluatorRegistry registry = EvaluatorRegistry(REGISTRY);
        vm.prank(OWNER);
        registry.proposeSlasher(address(v06), true);
        vm.warp(block.timestamp + registry.slasherTimelock());
        registry.executeSlasher(address(v06));
        assertTrue(registry.isSlasher(address(v06)));

        uint16[] memory xs = new uint16[](5);
        xs[0] = 0;
        xs[1] = 2500;
        xs[2] = 5000;
        xs[3] = 7500;
        xs[4] = 10_000;
        JobEscrow.PayoutSchedule memory s = JobEscrow.PayoutSchedule({
            docHash: keccak256("fork-schedule"), requiredTotal: 4, bpsTable: PayoutScheduleLib.packTable(xs)
        });
        assertEq(s.bpsTable, 0x27101d4c138809c40000);

        uint256 amount = 500_000;
        // Impersonated accounts need gas on the fork; deal only ETH, use the deployer's real USDC.
        vm.deal(OWNER, 1 ether);
        vm.deal(PROVIDER, 1 ether);
        vm.deal(EVAL, 1 ether);

        uint256 ownerUsdc = IERC20(USDC).balanceOf(OWNER);
        uint256 providerUsdc = IERC20(USDC).balanceOf(PROVIDER);
        assertGe(ownerUsdc, amount, "deployer USDC");

        vm.startPrank(OWNER);
        IERC20(USDC).approve(address(v06), amount);
        uint256 id = v06.createAndFundScheduled(
            PROVIDER, EVAL, amount, uint64(block.timestamp + 7 days), keccak256("fork-spec"), s
        );
        vm.stopPrank();

        JobEscrow.PayoutSchedule memory got = v06.getSchedule(id);
        assertEq(got.docHash, s.docHash);
        assertEq(got.requiredTotal, 4);
        assertEq(got.bpsTable, s.bpsTable);
        assertEq(uint256(v06.getJob(id).state), uint256(JobEscrow.State.Funded));

        vm.prank(PROVIDER);
        v06.submit(id, keccak256("fork-deliverable"));
        assertEq(uint256(v06.getJob(id).state), uint256(JobEscrow.State.Submitted));

        vm.prank(EVAL);
        v06.verdictScheduled(id, 7, 4, 3, keccak256("fork-reason"));
        JobEscrow.Job memory j = v06.getJob(id);
        assertEq(uint256(j.state), uint256(JobEscrow.State.Partial));
        assertEq(uint256(j.outcome), uint256(JobEscrow.Outcome.Partial));
        assertEq(j.payoutBps, 7500);

        vm.warp(block.timestamp + cfg.challengeWindow + 1);
        v06.finalize(id);
        assertEq(uint256(v06.getJob(id).state), uint256(JobEscrow.State.Settled));
        assertEq(IERC20(USDC).balanceOf(PROVIDER), providerUsdc + 375_000);
        assertEq(IERC20(USDC).balanceOf(OWNER), ownerUsdc - amount + 125_000);
        assertEq(IERC20(USDC).balanceOf(address(v06)), 0);
    }
}
