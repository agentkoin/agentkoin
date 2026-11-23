// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {MockArbitrator} from "../../src/mocks/MockArbitrator.sol";
import {EvaluatorRegistry} from "../../src/EvaluatorRegistry.sol";
import {JobEscrow} from "../../src/JobEscrow.sol";
import {PayoutScheduleLib} from "../../src/PayoutScheduleLib.sol";
import {EscrowDepositRoute, EscrowDepositRouteFactory} from "../../src/EscrowDepositRoute.sol";
import {RecoveryVault} from "../../src/RecoveryVault.sol";

/// @notice Invariant handler: drives JobEscrow (all lifecycle paths, instant and verdict jobs,
///         disputes, stale disputes, arbitrator re-pricing, registry minStake changes) and
///         EscrowDepositRoute (x402 atomic settle, out-of-band deposits credited by k-of-n keeper
///         attestation, A-1e double-sign / duplicate-attest / non-keeper attacks, a malicious keeper
///         that attests wrong values (freezes), timelocked frozen-deposit resolutions, keeper-set and
///         threshold changes mid-attestation, strays, sweeps into the RecoveryVault, vault claims and
///         horizon releases to the treasury).
///         Payout ghosts are parsed from events of successful calls only.
contract EscrowHandler is Test {
    MockUSDC public usdc;
    JobEscrow public escrow;
    EvaluatorRegistry public registry;
    MockArbitrator public arb;
    EscrowDepositRouteFactory public factory;
    address public admin; // owner of escrow, registry and arbitrator
    RecoveryVault public vault;
    /// keeper candidates: [0] is MALICIOUS (only ever attests wrong values), [1], [2] honest and
    /// allowlisted at deploy, [3] honest and added / removed by rotateKeeper (A-1e v0.1.2)
    address[4] public keeperPool;

    address[] public clients;
    address[] public providers;
    address[] public evaluators;
    address[] public payers;
    uint256[] internal payerKeys;
    EscrowDepositRouteFactory.Offer[] internal offers;
    address[] public routes;

    // ---- ghosts ----
    /// jobId => token units paid out of the job amount (provider net + protocol fee + evaluator fee + refunds)
    mapping(uint256 => uint256) public paidFromAmount;
    mapping(uint256 => uint256) public paymentEvents;
    mapping(uint256 => uint256) public refundEvents;
    mapping(uint256 => uint256) public settleEvents;
    /// evaluator => total ever staked
    mapping(address => uint256) public staked;
    /// route => token units in (all Transfers into the route) and out (jobs/refunds/sweeps)
    mapping(address => uint256) public routeIn;
    mapping(address => uint256) public routeOut;
    mapping(address => uint256) public routeSwept;
    /// route => sum of actual Transfers into it from a non-zero sender (attributable deposits,
    /// including the atomic-settle transfers)
    mapping(address => uint256) public routeTransferredIn;
    /// route => total credited (atomic settles + attestations), as observed by the handler
    mapping(address => uint256) public routeCredited;
    uint256 public routeJobsOpened;
    uint256 public routeSettles; // successful atomic settles + attestations
    uint256 public routeAttests;
    uint256 public attestRefunds;
    uint256 public sweepAttests; // attest-first credits done right before a snapshot or a due sweep
    uint256 public positiveSweeps;
    /// A-1e attack ghosts: each must stay 0
    uint256 public exploitSucceeded; // same-nonce double-sign or settle of a used authorization
    uint256 public duplicateAttestSucceeded;
    uint256 public unauthorizedSucceeded; // non-keeper attest or startSweep
    uint256 public attackAttempts;
    /// v0.1.2 ghosts
    uint256 public creditBelowK; // credits observed with fewer than k matching current-epoch votes (must stay 0)
    uint256 public maliciousCredited; // credits completed by the malicious keeper's wrong attestation (must stay 0)
    uint256 public freezes;
    uint256 public resolutions;
    uint256 public keeperChanges;
    uint256 public vaultClaims;
    uint256 public releases;
    uint256 public votes;
    /// route => into the vault (sweeps + flushes), paid out of the vault (claims), released to treasury
    mapping(address => uint256) public vaultIn;
    mapping(address => uint256) public vaultOut;
    mapping(address => uint256) public vaultReleased;

    /// One actual token Transfer into a route that did not go through the atomic settle, keyed by a
    /// synthetic (txHash, logIndex): the EVM has no tx hash, so the handler plays the log indexer.
    struct Deposit {
        uint256 offer;
        address from;
        uint256 value;
        bytes32 txHash;
        uint256 logIndex;
        uint256 payer; // index, for the signature (front-run authorizations)
        uint256 validBefore;
        bytes32 nonce;
        bytes sig; // empty for plain transfers
        uint256 credited; // total credited against this transfer id (must stay <= value)
        bool done;
        bool inSnapshot; // was uncredited when a sweep snapshot was taken for its route
        bool frozen;
        bool refundOnly; // the honest keepers' common policy for this deposit
    }

    Deposit[] internal deposits;
    uint256 internal nonceCounter;
    mapping(string => uint256) public calls;
    /// successful (non-reverting) protocol calls per action, to check the handler reaches states
    mapping(string => uint256) public okCalls;
    string internal cur;

    function _c(string memory name) internal {
        cur = name;
        calls[name]++;
    }

    constructor(
        MockUSDC usdc_,
        JobEscrow escrow_,
        EvaluatorRegistry registry_,
        MockArbitrator arb_,
        EscrowDepositRouteFactory factory_,
        address admin_,
        address[4] memory keeperPool_
    ) {
        usdc = usdc_;
        escrow = escrow_;
        registry = registry_;
        arb = arb_;
        factory = factory_;
        admin = admin_;
        keeperPool = keeperPool_;
        vault = factory_.vault();
        for (uint256 i = 0; i < 3; i++) {
            clients.push(_actor(string.concat("client", vm.toString(i))));
            providers.push(_actor(string.concat("provider", vm.toString(i))));
        }
        for (uint256 i = 0; i < 2; i++) {
            address e = _actor(string.concat("evaluator", vm.toString(i)));
            evaluators.push(e);
            vm.prank(e);
            registry.stake(200e6);
            staked[e] += 200e6;
        }
        for (uint256 i = 0; i < 2; i++) {
            (address p, uint256 pk) = makeAddrAndKey(string.concat("payer", vm.toString(i)));
            usdc.mint(p, 1_000_000e6);
            vm.prank(p);
            usdc.approve(address(escrow), type(uint256).max);
            payers.push(p);
            payerKeys.push(pk);
        }
        // two offers: provider0/evaluator0 2 USDC, provider1/evaluator1 1 USDC
        offers.push(EscrowDepositRouteFactory.Offer(providers[0], evaluators[0], 2e6, 1 days, keccak256("o1")));
        offers.push(EscrowDepositRouteFactory.Offer(providers[1], evaluators[1], 1e6, 2 days, keccak256("o2")));
        routes.push(factory.routeFor(offers[0]));
        routes.push(factory.routeFor(offers[1]));
    }

    function _actor(string memory name) internal returns (address a) {
        a = makeAddr(name);
        usdc.mint(a, 1_000_000e6);
        vm.startPrank(a);
        usdc.approve(address(escrow), type(uint256).max);
        usdc.approve(address(registry), type(uint256).max);
        vm.stopPrank();
    }

    // ---------------- log parsing ----------------

    function _begin() internal {
        vm.recordLogs();
    }

    function _end(bool ok) internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        if (!ok) return; // reverted call: nothing happened
        okCalls[cur]++;
        for (uint256 i = 0; i < logs.length; i++) {
            Vm.Log memory l = logs[i];
            if (l.emitter != address(escrow)) continue;
            bytes32 t = l.topics[0];
            if (t == JobEscrow.PaymentReleased.selector) {
                uint256 id = uint256(l.topics[1]);
                (uint256 net, uint256 fee) = abi.decode(l.data, (uint256, uint256));
                paidFromAmount[id] += net + fee;
                paymentEvents[id] += 1;
            } else if (t == JobEscrow.EvaluatorFeePaid.selector) {
                paidFromAmount[uint256(l.topics[1])] += abi.decode(l.data, (uint256));
            } else if (t == JobEscrow.Refunded.selector) {
                uint256 id = uint256(l.topics[1]);
                paidFromAmount[id] += abi.decode(l.data, (uint256));
                refundEvents[id] += 1;
            } else if (
                t == JobEscrow.Settled.selector || t == JobEscrow.JobExpired.selector
                    || t == JobEscrow.JobCancelled.selector
            ) {
                settleEvents[uint256(l.topics[1])] += 1;
            }
        }
    }

    function _jobId(uint256 seed) internal view returns (uint256 id, bool ok) {
        uint256 n = escrow.jobCount();
        if (n == 0) return (0, false);
        return ((seed % n) + 1, true);
    }

    /// Prefer a job in one of the wanted states (scanning from the seed) so deep paths are reached;
    /// falls back to the seeded id so wrong-state calls are still exercised.
    function _pick(uint256 seed, uint8 mask) internal view returns (uint256 id, bool ok) {
        uint256 n = escrow.jobCount();
        if (n == 0) return (0, false);
        uint256 start = seed % n;
        for (uint256 k = 0; k < n; k++) {
            uint256 cand = ((start + k) % n) + 1;
            if (mask & (uint8(1) << uint8(escrow.getJob(cand).state)) != 0) return (cand, true);
        }
        return (start + 1, true);
    }

    /// a job where the action is still in its window: 0 submit, 1 verdict, 2 challenge
    function _live(JobEscrow.Job memory j, uint8 mode) internal view returns (bool) {
        JobEscrow.Config memory c = escrow.config(j.configVersion);
        if (mode == 0) return j.state == JobEscrow.State.Funded && j.deadline > block.timestamp;
        if (mode == 1) return j.state == JobEscrow.State.Submitted && block.timestamp <= j.submittedAt + c.evalWindow;
        bool v = j.state == JobEscrow.State.Completed || j.state == JobEscrow.State.Rejected
            || j.state == JobEscrow.State.Partial;
        return v && block.timestamp <= j.verdictAt + c.challengeWindow;
    }

    function _pickLive(uint256 seed, uint8 mode) internal view returns (uint256 id, bool ok) {
        uint256 n = escrow.jobCount();
        if (n == 0) return (0, false);
        uint256 start = seed % n;
        for (uint256 k = 0; k < n; k++) {
            uint256 cand = ((start + k) % n) + 1;
            JobEscrow.Job memory j = escrow.getJob(cand);
            if (_live(j, mode)) return (cand, true);
        }
        return (start + 1, true);
    }

    function _bit(JobEscrow.State s) internal pure returns (uint8) {
        return uint8(1) << uint8(s);
    }

    function _verdictStates() internal pure returns (uint8) {
        return _bit(JobEscrow.State.Completed) | _bit(JobEscrow.State.Rejected) | _bit(JobEscrow.State.Partial);
    }

    // ---------------- escrow actions ----------------

    function createAndFund(uint256 cs, uint256 ps, uint256 es, uint256 amount, uint256 dl) external {
        _c("createAndFund");
        amount = bound(amount, 1e5, 400e6);
        dl = bound(dl, 1 hours, 5 days);
        address c = clients[cs % clients.length];
        address p = providers[ps % providers.length];
        address e = evaluators[es % evaluators.length];
        _begin();
        vm.prank(c);
        try escrow.createAndFund(p, e, amount, uint64(block.timestamp + dl), keccak256(abi.encode(cs, amount))) {
            _end(true);
        } catch {
            _end(false);
        }
    }

    function createOnly(uint256 cs, uint256 amount) external {
        _c("createOnly");
        amount = bound(amount, 1e5, 50e6);
        address c = clients[cs % clients.length];
        _begin();
        vm.prank(c);
        try escrow.createJob(
            providers[cs % 3], evaluators[cs % 2], amount, uint64(block.timestamp + 2 days), keccak256("c")
        ) {
            _end(true);
        } catch {
            _end(false);
        }
    }

    function fund(uint256 js) external {
        _c("fund");
        (uint256 id, bool ok) = _pick(js, _bit(JobEscrow.State.Open));
        if (!ok) return;
        JobEscrow.Job memory j = escrow.getJob(id);
        _begin();
        vm.prank(j.client);
        try escrow.fund(id) {
            _end(true);
        } catch {
            _end(false);
        }
    }

    function postProviderBond(uint256 js, uint256 amount) external {
        _c("postProviderBond");
        (uint256 id, bool ok) = _pick(js, _bit(JobEscrow.State.Open) | _bit(JobEscrow.State.Funded));
        if (!ok) return;
        amount = bound(amount, 1, 5e6);
        JobEscrow.Job memory j = escrow.getJob(id);
        _begin();
        vm.prank(j.provider);
        try escrow.postProviderBond(id, amount) {
            _end(true);
        } catch {
            _end(false);
        }
    }

    function acceptJob(uint256 js) external {
        _c("accept");
        (uint256 id, bool ok) = _pick(js, _bit(JobEscrow.State.Funded));
        if (!ok) return;
        _begin();
        vm.prank(escrow.getJob(id).provider);
        try escrow.accept(id) {
            _end(true);
        } catch {
            _end(false);
        }
    }

    function submit(uint256 js) external {
        _c("submit");
        (uint256 id, bool ok) = _pickLive(js, 0);
        if (!ok) return;
        _begin();
        vm.prank(escrow.getJob(id).provider);
        try escrow.submit(id, keccak256(abi.encode("d", id))) {
            _end(true);
        } catch {
            _end(false);
        }
    }

    function verdict(uint256 js, uint8 o, uint16 bps) external {
        _c("verdict");
        (uint256 id, bool ok) = _pickLive(js, 1);
        if (!ok) return;
        JobEscrow.Outcome outcome = JobEscrow.Outcome(uint8(bound(o, 1, 3)));
        if (outcome == JobEscrow.Outcome.Complete) bps = 10_000;
        else if (outcome == JobEscrow.Outcome.Reject) bps = 0;
        else bps = uint16(bound(bps, 1, 9_999));
        _begin();
        vm.prank(escrow.getJob(id).evaluator);
        try escrow.verdict(id, outcome, bps, keccak256("r")) {
            _end(true);
        } catch {
            _end(false);
        }
    }

    function timeoutRelease(uint256 js) external {
        _c("timeoutRelease");
        (uint256 id, bool ok) = _pick(js, _bit(JobEscrow.State.Submitted));
        if (!ok) return;
        _begin();
        try escrow.timeoutRelease(id) {
            _end(true);
        } catch {
            _end(false);
        }
    }

    function challenge(uint256 js, bool byProvider) external {
        _c("challenge");
        (uint256 id, bool ok) = _pickLive(js, 2);
        if (!ok) return;
        JobEscrow.Job memory j = escrow.getJob(id);
        _begin();
        vm.prank(byProvider ? j.provider : j.client);
        try escrow.challenge(id, keccak256("c")) {
            _end(true);
        } catch {
            _end(false);
        }
    }

    function giveRuling(uint256 js, uint16 bps) external {
        _c("giveRuling");
        if (js % 3 != 0) return; // thinned so other paths (stale disputes, submits) are reached
        (uint256 id, bool ok) = _pick(js, _bit(JobEscrow.State.Disputed));
        if (!ok) return;
        JobEscrow.Dispute memory d = escrow.getDispute(id);
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

    function resolveStaleDispute(uint256 js) external {
        _c("resolveStaleDispute");
        (uint256 id, bool ok) = _pick(js, _bit(JobEscrow.State.Disputed));
        if (!ok) return;
        _begin();
        try escrow.resolveStaleDispute(id) {
            _end(true);
        } catch {
            _end(false);
        }
    }

    function finalize(uint256 js) external {
        _c("finalize");
        (uint256 id, bool ok) = _pick(js, _verdictStates());
        if (!ok) return;
        _begin();
        try escrow.finalize(id) {
            _end(true);
        } catch {
            _end(false);
        }
    }

    function cancel(uint256 js) external {
        _c("cancel");
        if (js % 4 != 0) return; // thinned so other paths (stale disputes, submits) are reached
        (uint256 id, bool ok) = _pick(js, _bit(JobEscrow.State.Open) | _bit(JobEscrow.State.Funded));
        if (!ok) return;
        _begin();
        vm.prank(escrow.getJob(id).client);
        try escrow.cancel(id) {
            _end(true);
        } catch {
            _end(false);
        }
    }

    function claimRefund(uint256 js) external {
        _c("claimRefund");
        if (js % 3 != 0) return; // thinned so other paths (stale disputes, submits) are reached
        (uint256 id, bool ok) = _pick(js, _bit(JobEscrow.State.Funded));
        if (!ok) return;
        _begin();
        try escrow.claimRefund(id) {
            _end(true);
        } catch {
            _end(false);
        }
    }

    function warp(uint256 secs) external {
        _c("warp");
        // mostly short hops so evaluation/challenge windows are hit; occasionally long jumps to
        // cross deadlines, arbitration timeouts and the 30d sweep delay
        uint256 r = secs % 8;
        uint256 maxHop = r == 0 ? 40 days : (r < 3 ? 3 days : 6 hours);
        vm.warp(block.timestamp + bound(secs >> 3, 1, maxHop));
    }

    function setArbitrationCost(uint256 fee) external {
        _c("setArbitrationCost");
        vm.prank(admin);
        arb.setFee(bound(fee, 0, 3e6));
    }

    function setMinStake(uint256 m) external {
        _c("setMinStake");
        EvaluatorRegistry.Config memory c = registry.config();
        c.minStake = bound(m, 50e6, 250e6);
        vm.prank(admin);
        registry.setConfig(c);
    }

    function topUpStake(uint256 es, uint256 amount) external {
        _c("topUpStake");
        address e = evaluators[es % evaluators.length];
        amount = bound(amount, 1e6, 100e6);
        vm.prank(e);
        try registry.stake(amount) {
            staked[e] += amount;
            okCalls[cur]++;
        } catch {}
    }

    // ---------------- route actions (A-1, A-1a, A-1e k-of-n, RecoveryVault) ----------------

    function _sign(uint256 pk, address from, address to, uint256 value, uint256 vb, bytes32 nonce)
        internal
        view
        returns (bytes memory)
    {
        bytes32 sh = keccak256(abi.encode(usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), from, to, value, 0, vb, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), sh));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _txHash(uint256 k) internal pure returns (bytes32) {
        return keccak256(abi.encode("tx", k));
    }

    /// x402 exact payment. frontRun = someone submits the authorization to the token directly, so it
    /// is an out-of-band Transfer the keepers must attest; otherwise the atomic settle path.
    function routePay(uint256 os, uint256 ps, bool frontRun) external {
        _c("routePay");
        uint256 oi = os % offers.length;
        uint256 pi = ps % payers.length;
        EscrowDepositRouteFactory.Offer memory o = offers[oi];
        address route = routes[oi];
        bytes32 nonce = bytes32(++nonceCounter);
        uint256 vb = block.timestamp + 1 hours;
        bytes memory sig = _sign(payerKeys[pi], payers[pi], route, o.amount, vb, nonce);
        if (frontRun) {
            usdc.transferWithAuthorization(payers[pi], route, o.amount, 0, vb, nonce, sig);
            _recordDeposit(oi, payers[pi], o.amount, pi, vb, nonce, sig);
            return;
        }
        _begin();
        try factory.settle(o, payers[pi], o.amount, 0, vb, nonce, sig) returns (address, uint256 jobId) {
            _end(true);
            // atomic: the Transfer in and the credit happen in the same call
            routeIn[route] += o.amount;
            routeOut[route] += o.amount;
            routeTransferredIn[route] += o.amount;
            routeCredited[route] += o.amount;
            routeSettles++;
            if (jobId != 0) routeJobsOpened++;
        } catch {
            _end(false);
        }
    }

    function _recordDeposit(
        uint256 oi,
        address from,
        uint256 value,
        uint256 pi,
        uint256 vb,
        bytes32 nonce,
        bytes memory sig
    ) internal {
        address route = routes[oi];
        uint256 k = deposits.length;
        bool ro = value != offers[oi].amount || k % 3 == 0;
        deposits.push(Deposit(oi, from, value, _txHash(k), k % 4, pi, vb, nonce, sig, 0, false, false, false, ro));
        routeIn[route] += value;
        routeTransferredIn[route] += value;
    }

    /// A payer transfers an arbitrary (usually wrong) amount straight to a route: attributable, the
    /// keepers refund it.
    function payerTransfer(uint256 os, uint256 ps, uint256 amount) external {
        _c("payerTransfer");
        uint256 oi = os % offers.length;
        uint256 pi = ps % payers.length;
        amount = bound(amount, 1, 5e6);
        vm.prank(payers[pi]);
        usdc.transfer(routes[oi], amount);
        _recordDeposit(oi, payers[pi], amount, pi, 0, bytes32(0), "");
        okCalls[cur]++;
    }

    /// Unattributable stray (a mint: Transfer from address(0), which the keepers never attest).
    function stray(uint256 rs, uint256 amount) external {
        _c("stray");
        address r = routes[rs % routes.length];
        amount = bound(amount, 1, 10e6);
        usdc.mint(r, amount);
        routeIn[r] += amount;
        okCalls[cur]++;
    }

    function _id(Deposit storage d) internal view returns (bytes32) {
        return factory.transferId(d.txHash, d.logIndex);
    }

    /// current keepers whose vote on `id` counts right now
    function _countVotes(bytes32 id) internal view returns (uint256 n) {
        for (uint256 i = 0; i < 4; i++) {
            if (factory.isKeeper(keeperPool[i]) && factory.hasAttested(id, keeperPool[i])) n++;
        }
    }

    /// an honest current keeper (pool 1..3) that has not voted on `id` this round, or address(0)
    function _freshKeeper(bytes32 id, uint256 seed) internal view returns (address) {
        for (uint256 j = 0; j < 3; j++) {
            address k = keeperPool[1 + ((seed % 3 + j) % 3)];
            if (factory.isKeeper(k) && !factory.hasAttested(id, k)) return k;
        }
        return address(0);
    }

    /// Book a credit of deposit d (k-of-n or resolution). rb = route balance before the call.
    function _booked(Deposit storage d, uint256 rb, uint256 jobId, bool refunded) internal {
        address r = routes[d.offer];
        d.done = true;
        d.credited += d.value;
        if (rb >= d.value) {
            routeOut[r] += d.value;
        } else {
            // flushed: whole route balance into the vault, claim paid from the vault
            routeOut[r] += rb;
            vaultIn[r] += rb;
            vaultOut[r] += d.value;
            vaultClaims++;
        }
        routeCredited[r] += d.value;
        routeSettles++;
        routeAttests++;
        if (jobId != 0) routeJobsOpened++;
        if (refunded) attestRefunds++;
    }

    /// One honest keeper vote on deposit d. Returns whether this vote credited it.
    function _vote(Deposit storage d, uint256 seed) internal returns (bool credited) {
        if (d.done || d.frozen) return false;
        bytes32 id = _id(d);
        address k = _freshKeeper(id, seed);
        if (k == address(0)) return false;
        uint256 prior = _countVotes(id);
        uint256 rb = usdc.balanceOf(routes[d.offer]);
        uint256 b0 = usdc.balanceOf(d.from);
        _begin();
        vm.prank(k);
        try factory.attestDeposit(offers[d.offer], d.txHash, d.logIndex, d.from, d.value, d.refundOnly) returns (
            bool c, uint256 jobId, bool refunded
        ) {
            _end(true);
            votes++;
            if (factory.claimOf(id).status == EscrowDepositRouteFactory.Status.Frozen) {
                d.frozen = true; // the malicious keeper voted first this round
                freezes++;
                return false;
            }
            if (!c) return false;
            if (prior + 1 < factory.threshold()) creditBelowK++;
            if (refunded) require(usdc.balanceOf(d.from) - b0 == d.value, "attest refund amount");
            _booked(d, rb, jobId, refunded);
            okCalls["attestPending"]++;
            return true;
        } catch {
            _end(false);
            return false;
        }
    }

    /// Honest keepers vote until the deposit is credited (or no fresh keeper is left).
    function _attestFull(Deposit storage d) internal returns (bool) {
        for (uint256 j = 0; j < 4; j++) {
            if (_vote(d, j)) return true;
            if (d.done || d.frozen) return false;
        }
        return false;
    }

    /// One honest keeper vote on a recorded Transfer with its true (txHash, logIndex, from, value).
    function attestPending(uint256 s, uint256 ks) external {
        _c("attestPending");
        if (deposits.length == 0) return;
        _vote(deposits[s % deposits.length], ks);
    }

    /// Lagging keepers catch up on a deposit that was swept into the RecoveryVault before it was
    /// attested: k honest votes, paid from the vault (route balance flushed in first).
    function claimFromVault(uint256 s) external {
        _c("claimFromVault");
        for (uint256 j = 0; j < deposits.length; j++) {
            Deposit storage d = deposits[(s % deposits.length + j) % deposits.length];
            if (d.done || d.frozen || !d.inSnapshot) continue;
            if (usdc.balanceOf(routes[d.offer]) >= d.value) continue;
            if (_attestFull(d)) okCalls[cur]++;
            return;
        }
    }

    /// The malicious keeper (pool[0]) attests a pending deposit with a wrong value or flipped refund
    /// mode: must never credit; freezes the deposit if the honest keepers already voted this round.
    function conflictAttest(uint256 s, bool flipRefund) external {
        _c("conflictAttest");
        if (deposits.length == 0) return;
        Deposit storage d = deposits[s % deposits.length];
        if (d.done || d.frozen) return;
        address m = keeperPool[0];
        bytes32 id = _id(d);
        if (!factory.isKeeper(m) || factory.hasAttested(id, m)) return;
        attackAttempts++;
        uint256 v = flipRefund ? d.value : d.value + 1;
        bool ro = flipRefund ? !d.refundOnly : d.refundOnly;
        vm.prank(m);
        try factory.attestDeposit(offers[d.offer], d.txHash, d.logIndex, d.from, v, ro) returns (
            bool c, uint256, bool
        ) {
            if (c) maliciousCredited++;
            if (factory.claimOf(id).status == EscrowDepositRouteFactory.Status.Frozen) {
                d.frozen = true;
                freezes++;
            }
        } catch {}
    }

    /// Admin resolves a frozen deposit through the timelock: Credit with the true values, or Reset.
    function resolveFrozen(uint256 s, bool reset) external {
        _c("resolveFrozen");
        for (uint256 j = 0; j < deposits.length; j++) {
            Deposit storage d = deposits[(s % deposits.length + j) % deposits.length];
            if (!d.frozen) continue;
            bytes32 id = _id(d);
            EscrowDepositRouteFactory.ResolutionKind kind = reset
                ? EscrowDepositRouteFactory.ResolutionKind.Reset
                : EscrowDepositRouteFactory.ResolutionKind.Credit;
            vm.prank(admin);
            factory.proposeResolution(id, kind, routes[d.offer], d.from, d.value, d.refundOnly);
            vm.warp(block.timestamp + factory.keeperTimelock());
            uint256 rb = usdc.balanceOf(routes[d.offer]);
            _begin();
            try factory.executeResolution(id, offers[d.offer]) returns (uint256 jobId, bool refunded) {
                _end(true);
                resolutions++;
                d.frozen = false;
                if (!reset) _booked(d, rb, jobId, refunded);
            } catch {
                _end(false);
                vm.prank(admin);
                factory.cancelResolution(id);
            }
            return;
        }
    }

    /// Keeper-set / threshold change through the 48h timelock, possibly mid-attestation: toggles
    /// pool[3], toggles the malicious pool[0], or sets k to 2 or 3. May revert (k > n): fine.
    function rotateKeeper(uint256 seed) external {
        _c("rotateKeeper");
        if (seed % 4 != 0) return; // thinned
        uint256 m = (seed >> 2) % 3;
        vm.startPrank(admin);
        if (m == 0) factory.proposeKeeper(keeperPool[3], !factory.isKeeper(keeperPool[3]));
        else if (m == 1) factory.proposeKeeper(keeperPool[0], !factory.isKeeper(keeperPool[0]));
        else factory.proposeThreshold(factory.threshold() == 2 ? 3 : 2);
        vm.stopPrank();
        vm.warp(block.timestamp + factory.keeperTimelock());
        if (m == 2) {
            try factory.executeThreshold() {
                keeperChanges++;
            } catch {
                vm.prank(admin);
                factory.cancelThreshold();
            }
        } else {
            address k = keeperPool[m == 0 ? 3 : 0];
            try factory.executeKeeper(k) {
                keeperChanges++;
            } catch {
                vm.prank(admin);
                factory.cancelKeeper(k);
            }
        }
    }

    /// Attack: re-attest an already credited transfer id (same txHash, logIndex), possibly with other
    /// parameters / to another route. Must revert.
    function attestDuplicate(uint256 s, uint256 os, bool refundOnly) external {
        _c("attestDuplicate");
        if (deposits.length == 0) return;
        Deposit storage d = deposits[s % deposits.length];
        if (!d.done) return;
        uint256 oi = os % offers.length;
        address r = routes[oi];
        uint256 bal = usdc.balanceOf(r);
        if (bal == 0) return;
        uint256 v = d.value <= bal ? d.value : bal;
        attackAttempts++;
        for (uint256 i = 0; i < 4; i++) {
            if (!factory.isKeeper(keeperPool[i])) continue;
            vm.prank(keeperPool[i]);
            try factory.attestDeposit(offers[oi], d.txHash, d.logIndex, d.from, v, refundOnly) {
                duplicateAttestSucceeded++;
            } catch {}
        }
    }

    /// Attack: a non-keeper attests a made-up transfer, or starts a sweep. Must revert.
    function unauthorized(uint256 os, uint256 ps, bool sweepStart) external {
        _c("unauthorized");
        uint256 oi = os % offers.length;
        address who = payers[ps % payers.length];
        attackAttempts++;
        if (sweepStart) {
            factory.deploy(offers[oi]);
            vm.prank(who);
            try EscrowDepositRoute(routes[oi]).startSweep() {
                unauthorizedSucceeded++;
            } catch {}
            return;
        }
        uint256 bal = usdc.balanceOf(routes[oi]);
        if (bal == 0) return;
        vm.prank(who);
        try factory.attestDeposit(offers[oi], keccak256(abi.encode("fake", ++nonceCounter)), 0, who, bal, true) {
            unauthorizedSucceeded++;
        } catch {}
        vm.prank(who);
        try vault.payout(routes[oi], bytes32(0), who, 1) {
            unauthorizedSucceeded++;
        } catch {}
    }

    /// Attack (A-1e): sign A (to = route, offer amount) and B (to = elsewhere, 1 unit) with one nonce,
    /// execute B, then try to get A credited through the route's settle. Must revert.
    function doubleSignAttack(uint256 os, uint256 ps) external {
        _c("doubleSignAttack");
        uint256 oi = os % offers.length;
        uint256 pi = ps % payers.length;
        bytes32 nonce = bytes32(++nonceCounter);
        uint256 vb = block.timestamp + 1 hours;
        _executeDecoy(pi, nonce, vb);
        attackAttempts++;
        EscrowDepositRouteFactory.Offer memory o = offers[oi];
        bytes memory a = _sign(payerKeys[pi], payers[pi], routes[oi], o.amount, vb, nonce);
        try factory.settle(o, payers[pi], o.amount, 0, vb, nonce, a) {
            exploitSucceeded++;
        } catch {}
    }

    function _executeDecoy(uint256 pi, bytes32 nonce, uint256 vb) internal {
        address sink = makeAddr("sink");
        bytes memory b = _sign(payerKeys[pi], payers[pi], sink, 1, vb, nonce);
        usdc.transferWithAuthorization(payers[pi], sink, 1, 0, vb, nonce, b);
    }

    /// Attack: present an out-of-band (already executed) authorization to settle, the old
    /// front-run path. Must revert (only the keepers credit it).
    function settleUsedAuth(uint256 s) external {
        _c("settleUsedAuth");
        if (deposits.length == 0) return;
        Deposit storage d = deposits[s % deposits.length];
        if (d.sig.length == 0) return;
        attackAttempts++;
        try factory.settle(offers[d.offer], d.from, d.value, 0, d.validBefore, d.nonce, d.sig) {
            exploitSucceeded++;
        } catch {}
    }

    /// A-1d: rotating the escrow treasury must not redirect any route's sweep.
    function setEscrowTreasury(uint256 t) external {
        _c("setEscrowTreasury");
        if (t % 8 != 0) return; // thinned
        vm.prank(admin);
        escrow.setTreasury(makeAddr(string.concat("treasury", vm.toString((t >> 3) % 3))));
    }

    /// A keeper starts a sweep. attestFirst = the documented keeper policy (attest every outstanding
    /// transfer, then snapshot); otherwise a lagging keeper snapshots attributable funds too, which
    /// then go to the RecoveryVault and must stay claimable there.
    function startSweep(uint256 rs, bool attestFirst) external {
        _c("startSweep");
        uint256 i = rs % routes.length;
        factory.deploy(offers[i]);
        if (attestFirst) {
            for (uint256 k = 0; k < deposits.length; k++) {
                if (!deposits[k].done && deposits[k].offer == i && _attestFull(deposits[k])) sweepAttests++;
            }
        }
        address kp = factory.isKeeper(keeperPool[1]) ? keeperPool[1] : keeperPool[2];
        vm.prank(kp);
        try EscrowDepositRoute(routes[i]).startSweep() {
            okCalls[cur]++;
            for (uint256 k = 0; k < deposits.length; k++) {
                if (!deposits[k].done && deposits[k].offer == i) deposits[k].inSnapshot = true;
            }
        } catch {}
    }

    /// Anyone sweeps a due snapshot into the RecoveryVault (no attest-first needed any more: swept
    /// attributable deposits stay claimable from the vault).
    function sweep(uint256 rs) external {
        _c("sweep");
        uint256 i = rs % routes.length;
        if (routes[i].code.length == 0) return;
        EscrowDepositRoute r = EscrowDepositRoute(routes[i]);
        uint64 at = r.sweepableAt();
        // half the time wait out the sweep delay so swept deposits are later claimed from the vault
        if (at > block.timestamp && (rs >> 8) % 2 == 0) vm.warp(at);
        try r.sweep() returns (uint256 amt) {
            routeOut[routes[i]] += amt;
            routeSwept[routes[i]] += amt;
            vaultIn[routes[i]] += amt;
            if (amt > 0) positiveSweeps++;
            okCalls[cur]++;
        } catch {}
    }

    /// Anyone releases a route's vault funds that stayed unclaimed for the horizon to the treasury.
    function releaseVault(uint256 rs) external {
        _c("releaseVault");
        address r = routes[rs % routes.length];
        uint64 at = vault.releasableAt(r);
        // thinned: occasionally wait out the (invariant-config 60d) horizon
        if (at > block.timestamp && (rs >> 8) % 4 == 0) vm.warp(at);
        try vault.releaseExpired(r) returns (uint256 amt) {
            vaultReleased[r] += amt;
            releases++;
            okCalls[cur]++;
        } catch {}
    }

    // ---------------- views for the invariant contract ----------------

    function evaluatorCount() external view returns (uint256) {
        return evaluators.length;
    }

    function routeCount() external view returns (uint256) {
        return routes.length;
    }

    /// attributable deposits not yet credited
    function pendingUncredited(address route) external view returns (uint256 amt) {
        for (uint256 i = 0; i < deposits.length; i++) {
            if (!deposits[i].done && routes[deposits[i].offer] == route) amt += deposits[i].value;
        }
    }

    /// number of transfer ids credited more than their actual Transfer value (must be 0)
    function overCreditedTransfers() external view returns (uint256 n) {
        for (uint256 i = 0; i < deposits.length; i++) {
            if (deposits[i].credited > deposits[i].value) n++;
        }
    }

    /// number of credited deposits whose on-chain claim is not Credited, or uncredited ones that are (must be 0)
    function statusMismatches() external view returns (uint256 n) {
        for (uint256 i = 0; i < deposits.length; i++) {
            Deposit storage d = deposits[i];
            bool c = factory.attested(factory.transferId(d.txHash, d.logIndex));
            if (c != d.done) n++;
        }
    }

    function depositCount() external view returns (uint256) {
        return deposits.length;
    }

    function payerCount() external view returns (uint256) {
        return payers.length;
    }

    function _linearSchedule() internal pure returns (JobEscrow.PayoutSchedule memory s) {
        uint16[] memory xs = new uint16[](5);
        xs[0] = 0;
        xs[1] = 2500;
        xs[2] = 5000;
        xs[3] = 7500;
        xs[4] = 10_000;
        s.docHash = keccak256("inv-schedule");
        s.requiredTotal = 4;
        s.bpsTable = PayoutScheduleLib.packTable(xs);
    }

    /// @notice AD-014: open a scheduled job so verdictScheduled / constrained rule are in the invariant set.
    function createAndFundScheduled(uint256 cs, uint256 ps, uint256 es, uint256 amount, uint256 dl) external {
        _c("createAndFundScheduled");
        amount = bound(amount, 1e5, 400e6);
        dl = bound(dl, 1 hours, 5 days);
        address c = clients[cs % clients.length];
        address p = providers[ps % providers.length];
        address e = evaluators[es % evaluators.length];
        _begin();
        vm.prank(c);
        try escrow.createAndFundScheduled(
            p, e, amount, uint64(block.timestamp + dl), keccak256(abi.encode(cs, amount, "s")), _linearSchedule()
        ) {
            _end(true);
        } catch {
            _end(false);
        }
    }

    function verdictScheduled(uint256 js, uint16 mask) external {
        _c("verdictScheduled");
        (uint256 id, bool ok) = _pickLive(js, 1);
        if (!ok) return;
        JobEscrow.PayoutSchedule memory s = escrow.getSchedule(id);
        if (s.docHash == bytes32(0)) return;
        mask = mask & PayoutScheduleLib.requiredBits(s.requiredTotal);
        uint8 pass = PayoutScheduleLib.requiredPassFromMask(mask, s.requiredTotal);
        _begin();
        vm.prank(escrow.getJob(id).evaluator);
        try escrow.verdictScheduled(id, mask, s.requiredTotal, pass, keccak256("r")) {
            _end(true);
        } catch {
            _end(false);
        }
    }
}
