// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {MockArbitrator} from "../../src/mocks/MockArbitrator.sol";
import {MockERC8183Kernel} from "../../src/mocks/MockERC8183Kernel.sol";
import {IERC8183} from "../../src/interfaces/IERC8183.sol";
import {EvaluatorRegistry} from "../../src/EvaluatorRegistry.sol";
import {ERC8183EvaluatorAdapter} from "../../src/ERC8183EvaluatorAdapter.sol";

/// @notice Invariant handler for ERC8183EvaluatorAdapter on the mock ERC-8183 kernel: assignment,
///         acceptance (E-1a expiry gate), submission notice, verdicts, timeouts, challenges,
///         rulings, stale disputes, finalize, kernel-side claimRefund racing the adapter, adapter
///         config changes (windows), arbitration re-pricing.
contract AdapterHandler is Test {
    MockUSDC public usdc;
    MockERC8183Kernel public kernel;
    ERC8183EvaluatorAdapter public adapter;
    EvaluatorRegistry public registry;
    MockArbitrator public arb;
    address public admin;

    address[] public clients;
    address[] public providers;
    address[] public evaluators;

    // ---- ghosts ----
    mapping(address => uint256) public staked;
    mapping(uint256 => uint256) public kernelExecutedEvents; // adapter id => KernelExecuted count
    mapping(uint256 => uint256) public kernelTerminalEvents; // kernel job id => Completed/Rejected/Expired count
    mapping(uint256 => uint256) public slashEvents; // adapter id => adapter Slashed count
    mapping(uint256 => uint256) public expiryRiskEvents; // adapter id => ExpiryRisk count
    uint256 public expiryRefusals; // total ExpiryRisk events (E-1c refusal reach)
    uint256 public acceptViolations; // accepted with kernel expiredAt < now + required duration
    mapping(string => uint256) public calls;
    mapping(string => uint256) public okCalls;
    string internal cur;

    constructor(
        MockUSDC usdc_,
        MockERC8183Kernel kernel_,
        ERC8183EvaluatorAdapter adapter_,
        EvaluatorRegistry registry_,
        MockArbitrator arb_,
        address admin_
    ) {
        usdc = usdc_;
        kernel = kernel_;
        adapter = adapter_;
        registry = registry_;
        arb = arb_;
        admin = admin_;
        for (uint256 i = 0; i < 2; i++) {
            clients.push(_actor(string.concat("aclient", vm.toString(i))));
            providers.push(_actor(string.concat("aprovider", vm.toString(i))));
            address e = _actor(string.concat("aevaluator", vm.toString(i)));
            evaluators.push(e);
            vm.prank(e);
            registry.stake(200e6);
            staked[e] += 200e6;
        }
    }

    function _actor(string memory name) internal returns (address a) {
        a = makeAddr(name);
        usdc.mint(a, 1_000_000e6);
        vm.startPrank(a);
        usdc.approve(address(adapter), type(uint256).max);
        usdc.approve(address(kernel), type(uint256).max);
        usdc.approve(address(registry), type(uint256).max);
        vm.stopPrank();
    }

    function _c(string memory name) internal {
        cur = name;
        calls[name]++;
    }

    function _begin() internal {
        vm.recordLogs();
    }

    function _end(bool ok) internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        if (!ok) return;
        okCalls[cur]++;
        for (uint256 i = 0; i < logs.length; i++) {
            Vm.Log memory l = logs[i];
            bytes32 t = l.topics[0];
            if (l.emitter == address(adapter) && t == ERC8183EvaluatorAdapter.KernelExecuted.selector) {
                kernelExecutedEvents[uint256(l.topics[1])] += 1;
            } else if (l.emitter == address(adapter) && t == ERC8183EvaluatorAdapter.Slashed.selector) {
                slashEvents[uint256(l.topics[1])] += 1;
            } else if (l.emitter == address(adapter) && t == ERC8183EvaluatorAdapter.ExpiryRisk.selector) {
                expiryRiskEvents[uint256(l.topics[1])] += 1;
                expiryRefusals += 1;
            } else if (
                l.emitter == address(kernel)
                    && (t == MockERC8183Kernel.JobCompleted.selector
                        || t == MockERC8183Kernel.JobRejected.selector
                        || t == MockERC8183Kernel.JobExpired.selector)
            ) {
                kernelTerminalEvents[uint256(l.topics[1])] += 1;
            }
        }
    }

    // ---- pickers: prefer an adapter job in a given state so deep paths are reached ----

    function _bit(ERC8183EvaluatorAdapter.State s) internal pure returns (uint16) {
        return uint16(1) << uint16(uint8(s));
    }

    function _pick(uint256 seed, uint16 mask) internal view returns (uint256 id, bool ok) {
        uint256 n = adapter.jobCount();
        if (n == 0) return (0, false);
        uint256 start = seed % n;
        for (uint256 k = 0; k < n; k++) {
            uint256 cand = ((start + k) % n) + 1;
            if (mask & _bit(adapter.getJob(cand).state) != 0) return (cand, true);
        }
        return (start + 1, true);
    }

    /// kernel job picker: prefer one with the wanted kernel status
    function _pickK(uint256 seed, IERC8183.JobStatus want) internal view returns (uint256 kid, bool ok) {
        uint256 n = kernel.jobCounter();
        if (n == 0) return (0, false);
        uint256 start = seed % n;
        for (uint256 k = 0; k < n; k++) {
            uint256 cand = ((start + k) % n) + 1;
            if (kernel.getJob(cand).status == want) return (cand, true);
        }
        return (start + 1, true);
    }

    // ---------------- kernel-side actions ----------------

    function kCreateAndFund(uint256 cs, uint256 budget, uint256 expiresIn) external {
        _c("kCreateAndFund");
        address c = clients[cs % 2];
        address p = providers[(cs >> 1) % 2];
        budget = bound(budget, 1e5, 100e6);
        // spans both sides of the E-1a bound (24h + 24h + 7d + 1h = 9d 1h by default); mostly above
        expiresIn = expiresIn % 4 == 0
            ? bound(expiresIn >> 2, 1 hours, 9 days + 1 hours)
            : bound(expiresIn >> 2, 9 days, 20 days);
        _begin();
        vm.startPrank(c);
        try kernel.createJob(p, address(adapter), block.timestamp + expiresIn, "job", address(0)) returns (
            uint256 kid
        ) {
            kernel.setBudget(kid, budget, "");
            kernel.fund(kid, budget, "");
            vm.stopPrank();
            _end(true);
        } catch {
            vm.stopPrank();
            _end(false);
        }
    }

    function kSubmit(uint256 ks) external {
        _c("kSubmit");
        if (ks % 2 != 0) return; // thinned so never-submitted jobs exist
        ks >>= 1;
        (uint256 kid, bool ok) = _pickK(ks, IERC8183.JobStatus.Funded);
        if (!ok) return;
        _begin();
        vm.prank(kernel.getJob(kid).provider);
        try kernel.submit(kid, keccak256("d"), "") {
            _end(true);
        } catch {
            _end(false);
        }
    }

    /// kernel-side refund after expiry, outside the adapter's control (E-1a liveness limit)
    function kClaimRefund(uint256 ks) external {
        _c("kClaimRefund");
        if (ks % 2 != 0) return; // thinned
        (uint256 kid, bool ok) = _pickK(ks >> 1, IERC8183.JobStatus.Funded);
        if (!ok) return;
        if (ks % 4 == 0) (kid,) = _pickK(ks >> 2, IERC8183.JobStatus.Submitted);
        _begin();
        try kernel.claimRefund(kid) {
            _end(true);
        } catch {
            _end(false);
        }
    }

    // ---------------- adapter actions ----------------

    function assign(uint256 ks, uint256 es) external {
        _c("assign");
        uint256 n = kernel.jobCounter();
        if (n == 0) return;
        uint256 kid = (ks % n) + 1;
        // prefer a funded kernel job with no live assignment
        for (uint256 k = 0; k < n; k++) {
            uint256 cand = (((ks % n) + k) % n) + 1;
            IERC8183.JobStatus st = kernel.getJob(cand).status;
            if (
                (st == IERC8183.JobStatus.Funded || st == IERC8183.JobStatus.Submitted)
                    && adapter.assignmentOf(keccak256(abi.encode(address(kernel), cand))) == 0
            ) {
                kid = cand;
                break;
            }
        }
        _begin();
        vm.prank(kernel.getJob(kid).client);
        try adapter.assign(address(kernel), kid, evaluators[es % 2]) {
            _end(true);
        } catch {
            _end(false);
        }
    }

    function withdrawAssignment(uint256 s) external {
        _c("withdrawAssignment");
        if (s % 4 != 0) return;
        (uint256 id, bool ok) = _pick(s >> 2, _bit(ERC8183EvaluatorAdapter.State.Proposed));
        if (!ok) return;
        _begin();
        vm.prank(adapter.getJob(id).client);
        try adapter.withdrawAssignment(id) {
            _end(true);
        } catch {
            _end(false);
        }
    }

    function acceptAssignment(uint256 s) external {
        _c("acceptAssignment");
        (uint256 id, bool ok) = _pick(s, _bit(ERC8183EvaluatorAdapter.State.Proposed));
        if (!ok) return;
        ERC8183EvaluatorAdapter.AdapterJob memory j = adapter.getJob(id);
        uint256 kexp = kernel.getJob(j.kernelJobId).expiredAt;
        uint256 required = adapter.requiredExpiryDuration(j.configVersion);
        _begin();
        vm.prank(j.evaluator);
        try adapter.acceptAssignment(id) {
            _end(true);
            if (kexp < block.timestamp + required) acceptViolations++;
        } catch {
            _end(false);
        }
    }

    function noteSubmission(uint256 s) external {
        _c("noteSubmission");
        (uint256 id, bool ok) = _pick(s, _bit(ERC8183EvaluatorAdapter.State.Active));
        if (!ok) return;
        _begin();
        try adapter.noteSubmission(id) {
            _end(true);
        } catch {
            _end(false);
        }
    }

    function verdict(uint256 s, uint16 bps) external {
        _c("verdict");
        (uint256 id, bool ok) = _pick(s, _bit(ERC8183EvaluatorAdapter.State.Active));
        if (!ok) return;
        bps = uint16(bound(bps, 0, 10_000));
        _begin();
        vm.prank(adapter.getJob(id).evaluator);
        try adapter.verdict(id, bps, keccak256("r")) {
            _end(true);
        } catch {
            _end(false);
        }
    }

    function timeoutRelease(uint256 s) external {
        _c("timeoutRelease");
        (uint256 id, bool ok) = _pick(s, _bit(ERC8183EvaluatorAdapter.State.Active));
        if (!ok) return;
        _begin();
        try adapter.timeoutRelease(id) {
            _end(true);
        } catch {
            _end(false);
        }
    }

    function challenge(uint256 s, bool byProvider) external {
        _c("challenge");
        (uint256 id, bool ok) = _pick(s, _bit(ERC8183EvaluatorAdapter.State.Held));
        if (!ok) return;
        ERC8183EvaluatorAdapter.AdapterJob memory j = adapter.getJob(id);
        _begin();
        vm.prank(byProvider ? j.provider : j.client);
        try adapter.challenge(id, keccak256("c")) {
            _end(true);
        } catch {
            _end(false);
        }
    }

    function giveRuling(uint256 s, uint16 bps) external {
        _c("giveRuling");
        if (s % 3 != 0) return; // thinned so stale disputes are reached
        (uint256 id, bool ok) = _pick(s / 3, _bit(ERC8183EvaluatorAdapter.State.Disputed));
        if (!ok) return;
        ERC8183EvaluatorAdapter.Dispute memory d = adapter.getDispute(id);
        if (d.disputeId == 0) return;
        bps = uint16(bound(bps, 0, 10_000));
        _begin();
        vm.prank(admin);
        try arb.giveRuling(d.disputeId, bps) {
            _end(true);
        } catch {
            _end(false);
        }
    }

    function resolveStaleDispute(uint256 s) external {
        _c("resolveStaleDispute");
        (uint256 id, bool ok) = _pick(s, _bit(ERC8183EvaluatorAdapter.State.Disputed));
        if (!ok) return;
        _begin();
        try adapter.resolveStaleDispute(id) {
            _end(true);
        } catch {
            _end(false);
        }
    }

    function finalize(uint256 s) external {
        _c("finalize");
        (uint256 id, bool ok) = _pick(s, _bit(ERC8183EvaluatorAdapter.State.Held));
        if (!ok) return;
        _begin();
        try adapter.finalize(id) {
            _end(true);
        } catch {
            _end(false);
        }
    }

    function closeKernelEnded(uint256 s) external {
        _c("closeKernelEnded");
        (uint256 id, bool ok) =
            _pick(s, _bit(ERC8183EvaluatorAdapter.State.Active) | _bit(ERC8183EvaluatorAdapter.State.Proposed)); // E-1d: Proposed assignments are closable too
        if (!ok) return;
        _begin();
        try adapter.closeKernelEnded(id) {
            _end(true);
        } catch {
            _end(false);
        }
    }

    // ---------------- environment ----------------

    function warp(uint256 secs) external {
        _c("warp");
        uint256 r = secs % 8;
        uint256 maxHop = r == 0 ? 12 days : (r < 3 ? 2 days : 6 hours);
        vm.warp(block.timestamp + bound(secs >> 3, 1, maxHop));
    }

    function setArbitrationCost(uint256 fee) external {
        _c("setArbitrationCost");
        vm.prank(admin);
        arb.setFee(bound(fee, 0, 3e6));
    }

    /// new config version with different windows; existing jobs stay pinned to their version
    function setAdapterWindows(uint256 a, uint256 b, uint256 c, uint256 m) external {
        _c("setAdapterWindows");
        if (a % 4 != 0) return; // thinned
        ERC8183EvaluatorAdapter.Config memory cfg = adapter.currentConfig();
        cfg.evalWindow = uint64(bound(a >> 2, 1 hours, 2 days));
        cfg.challengeWindow = uint64(bound(b, 1 hours, 2 days));
        cfg.arbitrationTimeout = uint64(bound(c, 1 days, 7 days));
        cfg.expiryMargin = uint64(bound(m, 0, 6 hours));
        vm.prank(admin);
        adapter.setConfig(cfg);
    }

    function topUpStake(uint256 es, uint256 amount) external {
        _c("topUpStake");
        address e = evaluators[es % 2];
        amount = bound(amount, 1e6, 100e6);
        vm.prank(e);
        try registry.stake(amount) {
            staked[e] += amount;
            okCalls[cur]++;
        } catch {}
    }

    function evaluatorCount() external view returns (uint256) {
        return evaluators.length;
    }
}
