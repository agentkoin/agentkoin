// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {Defaults} from "../script/Defaults.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IEvaluatorRegistry} from "../src/interfaces/IEvaluatorRegistry.sol";
import {IArbitrator} from "../src/interfaces/IArbitrator.sol";

/// Mainnet-prep READINESS items 1-2: pause switch + per-job / total-locked caps on JobEscrow.
contract PauseCapsTest is BaseTest {
    address internal pauserSafe = makeAddr("pauserSafe");
    uint256 internal constant PER = Defaults.MAINNET_MAX_PER_JOB; // 50e6
    uint256 internal constant TOTAL = Defaults.MAINNET_MAX_TOTAL_LOCKED; // 500e6

    event Paused(address account);
    event Unpaused(address account);
    event PauserSet(address indexed pauser);
    event MaxPerJobSet(uint256 previous, uint256 current);
    event MaxTotalLockedSet(uint256 previous, uint256 current);

    function setUp() public override {
        super.setUp();
        // Base deploys uncapped with pauser = owner; bring it to the mainnet profile (lower-only setters).
        vm.startPrank(owner);
        escrow.setPauser(pauserSafe);
        escrow.setMaxPerJob(PER);
        escrow.setMaxTotalLocked(TOTAL);
        vm.stopPrank();
        _stake(evaluator, 900 * USDC); // exposure cap (stake x5) well above TOTAL, so only our caps bind
    }

    function _deadline() internal view returns (uint64) {
        return uint64(block.timestamp + 3 days);
    }

    // ---------------- constructor ----------------

    function test_constructor_setsPauserAndCaps() public {
        JobEscrow e = new JobEscrow(
            IERC20(address(usdc)), IEvaluatorRegistry(address(registry)), treasury, IArbitrator(address(arb)),
            Defaults.escrowConfig(), owner, pauserSafe, PER, TOTAL
        );
        assertEq(e.pauser(), pauserSafe);
        assertEq(e.maxPerJob(), PER);
        assertEq(e.maxTotalLocked(), TOTAL);
        assertEq(e.totalLocked(), 0);
        assertFalse(e.paused());
    }

    function test_constructor_rejectsBadParams() public {
        JobEscrow.Config memory c = Defaults.escrowConfig();
        IEvaluatorRegistry r = IEvaluatorRegistry(address(registry));
        vm.expectRevert(JobEscrow.ZeroAddress.selector);
        new JobEscrow(IERC20(address(usdc)), r, treasury, IArbitrator(address(arb)), c, owner, address(0), PER, TOTAL);
        vm.expectRevert(JobEscrow.InvalidConfig.selector);
        new JobEscrow(IERC20(address(usdc)), r, treasury, IArbitrator(address(arb)), c, owner, pauserSafe, 0, TOTAL);
        vm.expectRevert(JobEscrow.InvalidConfig.selector);
        new JobEscrow(IERC20(address(usdc)), r, treasury, IArbitrator(address(arb)), c, owner, pauserSafe, PER, 0);
        vm.expectRevert(JobEscrow.InvalidConfig.selector);
        new JobEscrow(IERC20(address(usdc)), r, treasury, IArbitrator(address(arb)), c, owner, pauserSafe, TOTAL + 1, TOTAL);
    }

    // ---------------- pause: what is blocked ----------------

    function test_pause_blocksCreateAndFund() public {
        vm.prank(client);
        uint256 openId = escrow.createJob(provider, evaluator, 1 * USDC, _deadline(), SPEC);
        vm.prank(pauserSafe);
        escrow.pause();
        vm.startPrank(client);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        escrow.createAndFund(provider, evaluator, 1 * USDC, _deadline(), SPEC);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        escrow.createJob(provider, evaluator, 1 * USDC, _deadline(), SPEC);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        escrow.fund(openId);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        escrow.createAndFundFor(client, provider, evaluator, 1 * USDC, _deadline(), SPEC);
        vm.stopPrank();
        // unpause restores
        vm.prank(pauserSafe);
        escrow.unpause();
        vm.prank(client);
        escrow.fund(openId);
        assertEq(escrow.totalLocked(), 1 * USDC);
    }

    // ---------------- pause: exits keep working ----------------

    function test_paused_cancelRefund_works() public {
        uint256 id = _open(10 * USDC);
        vm.prank(pauserSafe);
        escrow.pause();
        uint256 b0 = usdc.balanceOf(client);
        vm.prank(client);
        escrow.cancel(id);
        assertEq(usdc.balanceOf(client), b0 + 10 * USDC);
        assertEq(escrow.totalLocked(), 0);
    }

    function test_paused_claimRefund_works() public {
        uint256 id = _open(10 * USDC);
        vm.prank(provider);
        escrow.accept(id);
        vm.prank(pauserSafe);
        escrow.pause();
        vm.warp(block.timestamp + 3 days);
        uint256 b0 = usdc.balanceOf(client);
        escrow.claimRefund(id); // anyone
        assertEq(usdc.balanceOf(client), b0 + 10 * USDC);
        assertEq(uint8(_state(id)), uint8(JobEscrow.State.Expired));
        assertEq(escrow.totalLocked(), 0);
    }

    function test_paused_settleFundedJob_works() public {
        uint256 id = _open(20 * USDC);
        vm.prank(pauserSafe);
        escrow.pause();
        vm.prank(provider);
        escrow.submit(id, DELIVERABLE);
        _verdict(id, JobEscrow.Outcome.Complete, 10000);
        _passChallengeWindow();
        uint256 p0 = usdc.balanceOf(provider);
        escrow.finalize(id);
        assertEq(uint8(_state(id)), uint8(JobEscrow.State.Settled));
        assertGt(usdc.balanceOf(provider), p0, "provider paid while paused");
        assertEq(escrow.totalLocked(), 0);
        assertEq(usdc.balanceOf(address(escrow)), 0, "nothing trapped");
    }

    // ---------------- roles ----------------

    function test_roles_pauseUnpause() public {
        address rando = makeAddr("rando");
        vm.prank(rando);
        vm.expectRevert(JobEscrow.NotPauser.selector);
        escrow.pause();

        vm.expectEmit(address(escrow));
        emit Paused(pauserSafe);
        vm.prank(pauserSafe);
        escrow.pause();

        vm.prank(rando);
        vm.expectRevert(JobEscrow.NotPauser.selector);
        escrow.unpause();

        vm.expectEmit(address(escrow));
        emit Unpaused(owner);
        vm.prank(owner); // owner may unpause
        escrow.unpause();

        vm.prank(owner); // owner may pause too
        escrow.pause();
        vm.prank(pauserSafe); // pauser may unpause
        escrow.unpause();
        assertFalse(escrow.paused());
    }

    function test_roles_setPauser_onlyOwner() public {
        vm.prank(pauserSafe);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, pauserSafe));
        escrow.setPauser(pauserSafe);
        vm.prank(owner);
        vm.expectRevert(JobEscrow.ZeroAddress.selector);
        escrow.setPauser(address(0));
        address next = makeAddr("nextSafe");
        vm.expectEmit(address(escrow));
        emit PauserSet(next);
        vm.prank(owner);
        escrow.setPauser(next);
        vm.prank(pauserSafe);
        vm.expectRevert(JobEscrow.NotPauser.selector);
        escrow.pause();
    }

    function test_roles_caps_onlyOwner_lowerOnly() public {
        vm.prank(pauserSafe);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, pauserSafe));
        escrow.setMaxPerJob(1);
        vm.prank(pauserSafe);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, pauserSafe));
        escrow.setMaxTotalLocked(1);
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.CapIncrease.selector, PER, PER + 1));
        escrow.setMaxPerJob(PER + 1);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.CapIncrease.selector, TOTAL, TOTAL + 1));
        escrow.setMaxTotalLocked(TOTAL + 1);
        vm.expectEmit(address(escrow));
        emit MaxPerJobSet(PER, 40e6);
        escrow.setMaxPerJob(40e6);
        vm.expectEmit(address(escrow));
        emit MaxTotalLockedSet(TOTAL, 400e6);
        escrow.setMaxTotalLocked(400e6);
        vm.stopPrank();
        assertEq(escrow.maxPerJob(), 40e6);
        assertEq(escrow.maxTotalLocked(), 400e6);
    }

    // ---------------- caps ----------------

    function test_perJobCap_edge() public {
        uint256 id = _open(PER); // exactly the cap passes
        assertEq(escrow.getJob(id).amount, PER);
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.ExceedsPerJobCap.selector, PER + 1, PER));
        escrow.createAndFund(provider, evaluator, PER + 1, _deadline(), SPEC);
    }

    function test_perJobCap_appliesToFundOfOpenJob() public {
        vm.prank(client);
        uint256 id = escrow.createJob(provider, evaluator, PER, _deadline(), SPEC);
        vm.prank(owner);
        escrow.setMaxPerJob(PER - 1); // lowered after creation
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.ExceedsPerJobCap.selector, PER, PER - 1));
        escrow.fund(id);
    }

    function test_totalCap_acrossJobs() public {
        for (uint256 i = 0; i < 10; i++) {
            _open(PER);
        }
        assertEq(escrow.totalLocked(), TOTAL); // exactly the cap
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(JobEscrow.ExceedsTotalCap.selector, TOTAL + 1, TOTAL));
        escrow.createAndFund(provider, evaluator, 1, _deadline(), SPEC);
    }

    function test_totalDecreases_afterReleaseAndRefund() public {
        uint256 a = _open(PER); // will settle (release)
        uint256 b = _open(PER); // will be cancelled (refund)
        uint256 c = _open(30 * USDC); // partial verdict (part release, part refund)
        for (uint256 i = 0; i < 7; i++) {
            _open(PER);
        }
        assertEq(escrow.totalLocked(), 480 * USDC); // 7*50 + 50 + 50 + 30

        vm.prank(provider);
        escrow.submit(a, DELIVERABLE);
        _verdict(a, JobEscrow.Outcome.Complete, 10000);
        vm.prank(provider);
        escrow.submit(c, DELIVERABLE);
        _verdict(c, JobEscrow.Outcome.Partial, 5000);
        _passChallengeWindow();
        escrow.finalize(a);
        assertEq(escrow.totalLocked(), 430 * USDC, "release decrements");
        escrow.finalize(c);
        assertEq(escrow.totalLocked(), 400 * USDC, "partial settle decrements full amount");
        vm.prank(client);
        escrow.cancel(b);
        assertEq(escrow.totalLocked(), 350 * USDC, "refund decrements");
        // headroom is reusable
        _open(PER);
        _open(PER);
        _open(PER);
        assertEq(escrow.totalLocked(), 500 * USDC);
    }

    // ---------------- fuzz: accounting ----------------

    /// Random fund / cancel / claimRefund / settle sequence: totalLocked always equals the sum of
    /// amounts of jobs still holding funds, which here also equals the escrow's token balance.
    function testFuzz_totalLockedAccounting(uint256 seed) public {
        uint256[] memory ids = new uint256[](24);
        uint256 n;
        uint256 expected;
        for (uint256 step = 0; step < 24; step++) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            uint256 action = seed % 4;
            if (action == 0 || n == 0) {
                uint256 amt = 1 + (seed >> 8) % PER;
                if (expected + amt > TOTAL) {
                    vm.prank(client);
                    vm.expectRevert(
                        abi.encodeWithSelector(JobEscrow.ExceedsTotalCap.selector, expected + amt, TOTAL)
                    );
                    escrow.createAndFund(provider, evaluator, amt, _deadline(), SPEC);
                } else {
                    ids[n++] = _open(amt);
                    expected += amt;
                }
            } else {
                uint256 k = (seed >> 16) % n;
                uint256 id = ids[k];
                JobEscrow.Job memory j = escrow.getJob(id);
                if (j.state == JobEscrow.State.Funded) {
                    if (block.timestamp >= j.deadline) {
                        escrow.claimRefund(id); // anyone, past deadline without submission
                    } else if (action == 1) {
                        vm.prank(client);
                        escrow.cancel(id);
                    } else {
                        vm.prank(provider);
                        escrow.submit(id, DELIVERABLE);
                        uint16 bps = uint16((seed >> 24) % 10001);
                        vm.prank(evaluator);
                        escrow.verdict(id, _outcome(bps), bps, REASON);
                        vm.warp(block.timestamp + 48 hours + 1);
                        escrow.finalize(id);
                    }
                    expected -= j.amount;
                }
            }
            assertEq(escrow.totalLocked(), expected, "totalLocked == open funded amounts");
            assertEq(usdc.balanceOf(address(escrow)), expected, "matches escrow balance");
            assertLe(escrow.totalLocked(), escrow.maxTotalLocked());
        }
    }

    function _outcome(uint16 bps) internal pure returns (JobEscrow.Outcome) {
        if (bps == 10000) return JobEscrow.Outcome.Complete;
        if (bps == 0) return JobEscrow.Outcome.Reject;
        return JobEscrow.Outcome.Partial;
    }
}
