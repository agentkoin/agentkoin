// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IEvaluatorRegistry} from "./interfaces/IEvaluatorRegistry.sol";
import {IArbitrator, IArbitrable} from "./interfaces/IArbitrator.sol";
import {PayoutScheduleLib} from "./PayoutScheduleLib.sol";

/// @title JobEscrow
/// @notice USDC job escrow with a staked evaluator (ERC-8183 evaluator role), split verdicts,
///         an instant-release path for small amounts, an optimistic challenge window and an
///         external arbitrator. No buyer-side bond. Optional provider bond.
/// @dev Spec: specs/SPEC-v0.md section 2. v0.6 payout schedules: specs/AD-014-payout-schedule.md
///      and docs/AD-014-amendments.md. Unscheduled jobs keep v0.5 behaviour.
///      Assumptions: docs/ASSUMPTIONS.md (E-*).
///      Lifecycle naming follows ERC-8183 where it overlaps (createJob, fund, submit, complete,
///      reject, claimRefund, JobCreated/JobFunded/JobSubmitted/JobExpired/PaymentReleased/Refunded).
contract JobEscrow is IArbitrable, Ownable2Step, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    uint16 public constant BPS = 10_000;
    /// @notice Hard ceiling on feeBps + evaluatorFeeBps (5%), enforced in the constructor and in setConfig.
    uint16 public constant MAX_TOTAL_FEE_BPS = 500;

    enum State {
        None,
        Open, // created, not funded
        Funded, // escrow holds amount
        Submitted, // provider delivered; awaiting verdict
        Completed, // verdict (or instant release) = full payout; challenge window running
        Rejected, // verdict = refund; challenge window running
        Partial, // verdict = payoutBps split; challenge window running
        Disputed, // challenged; awaiting arbitrator
        Settled, // terminal: funds distributed
        Expired, // terminal: refunded (deadline passed without submission, or verdict timeout)
        Cancelled // terminal: cancelled by client before provider accepted
    }

    enum Outcome {
        None,
        Complete,
        Reject,
        Partial
    }

    /// @notice All protocol parameters. Versioned; each job pins the version current at creation.
    struct Config {
        uint256 instantThreshold; // amount <= this uses instant release. default 1e6 (1 USDC)
        uint256 minChallengeBond; // floor of challenge bond. default 1e6
        uint64 evalWindow; // seconds after submit for verdict. default 24h
        uint64 challengeWindow; // seconds after verdict for challenge. default 48h
        uint64 arbitrationTimeout; // seconds after challenge before anyone may unfreeze. default 30d
        uint16 challengeBondBps; // challenge bond = max(amount * bps, minChallengeBond). default 500
        uint16 missedVerdictSlashBps; // of registry minStake. default 1000
        uint16 wrongVerdictSlashBps; // of registry minStake. default 2500
        uint16 materialDiffBps; // |ruling - verdict| > this => verdict overturned. default 2000
        uint16 feeBps; // protocol fee on provider payout. default 100
        uint16 failedChallengeEvaluatorShareBps; // share of a failed challenge bond to evaluator (or provider on instant jobs); rest to treasury. default 5000
        uint16 instantBondCoverBps; // instant path needs providerBond >= amount * bps. default 10000
        uint16 evaluatorFeeBps; // evaluator fee on provider gross at settled Complete/Partial (E-18). default 50
    }

    struct Job {
        address client;
        address provider;
        address evaluator;
        uint32 configVersion;
        State state;
        Outcome outcome;
        bool accepted;
        bool instant;
        uint16 payoutBps;
        uint64 deadline; // submission deadline
        uint64 submittedAt;
        uint64 verdictAt;
        uint64 disputedAt;
        uint256 amount;
        uint256 providerBond;
        uint256 slashBase; // registry.minStake() pinned at fund (E-22); slash amounts are bps of this
        bytes32 specHash;
        bytes32 deliverableHash;
        bytes32 reasonHash;
    }

    struct Dispute {
        address challenger;
        address arbitrator;
        uint256 bond;
        uint256 arbFee; // arbitration cost paid by the challenger, held here until a ruling (E-17a)
        uint256 disputeId;
        bytes32 reasonHash;
    }

    /// @notice Per-job payout schedule. Absent (docHash == 0) means an unscheduled v0.5 job.
    ///         requiredTotal is committed at funding and must equal the number of required
    ///         criteria in the criteria document whose sha256 is specHash (enforced off-chain
    ///         at funding; enforced on-chain at verdictScheduled).
    struct PayoutSchedule {
        bytes32 docHash; // sha256 of the JCS schedule JSON; opaque on-chain
        uint8 requiredTotal; // n = required criteria in the committed criteria doc, 1..15
        uint256 bpsTable; // entry k (k = 0..n) = payoutBps when required_pass == k; 16 bits each, at bits [16k, 16k+16)
    }

    IERC20 public immutable token;
    IEvaluatorRegistry public immutable registry;
    address public treasury;
    IArbitrator public arbitrator;
    uint32 public currentConfigVersion;
    uint256 public jobCount;

    /// @notice Mainnet-prep circuit breaker (READINESS item 1). Intended to be a Safe. Can pause and
    ///         unpause; the owner can too. Pause blocks new job creation and funding only: refunds,
    ///         claimRefund, cancel, verdicts, challenges, rulings and finalize keep working, so funds
    ///         are never trapped.
    address public pauser;
    /// @notice Mainnet-prep caps (READINESS item 2), token atomic units. Owner can only lower them.
    uint256 public maxPerJob;
    uint256 public maxTotalLocked;
    /// @notice Sum of `amount` over funded jobs not yet refunded or settled (excludes bonds and fees).
    uint256 public totalLocked;

    mapping(uint32 => Config) internal _configs;
    mapping(uint256 => Job) internal _jobs;
    mapping(uint256 => Dispute) internal _disputes;
    mapping(uint256 => PayoutSchedule) internal _schedules; // docHash == 0 => unscheduled

    // ---------------- events ----------------
    event ConfigUpdated(uint32 indexed version, Config config);
    event TreasurySet(address treasury);
    event ArbitratorSet(address arbitrator);

    event JobCreated(
        uint256 indexed jobId,
        address indexed client,
        address indexed provider,
        address evaluator,
        uint256 amount,
        uint64 deadline,
        bytes32 specHash,
        uint32 configVersion
    );
    event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event ProviderBondPosted(uint256 indexed jobId, address indexed provider, uint256 amount, uint256 totalBond);
    event JobAccepted(uint256 indexed jobId, address indexed provider);
    event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverableHash);
    event InstantReleased(uint256 indexed jobId, address indexed provider, uint256 net, uint256 fee);
    event Verdict(
        uint256 indexed jobId, address indexed evaluator, Outcome outcome, uint16 payoutBps, bytes32 reasonHash
    );
    event VerdictTimedOut(uint256 indexed jobId, address indexed evaluator, uint256 slashed);
    event Challenged(
        uint256 indexed jobId,
        address indexed challenger,
        address indexed arbitrator,
        uint256 bond,
        uint256 disputeId,
        bytes32 reasonHash
    );
    /// @notice Challenger's arbitration cost moved into this contract (held until a ruling, E-17a).
    event ArbitrationFeeEscrowed(
        uint256 indexed jobId, address indexed challenger, address indexed arbitrator, uint256 fee
    );
    /// @notice Held arbitration cost paid to the arbitrator when it ruled.
    event ArbitrationFeePaid(
        uint256 indexed jobId, address indexed challenger, address indexed arbitrator, uint256 fee
    );
    /// @notice Held arbitration cost returned to the challenger on a stale dispute (E-17a).
    event ArbitrationFeeRefunded(uint256 indexed jobId, address indexed challenger, uint256 fee);
    event ArbitrationFeeReimbursed(
        uint256 indexed jobId, address indexed challenger, address indexed from, uint256 amount
    );
    event EvaluatorFeePaid(uint256 indexed jobId, address indexed evaluator, uint256 amount);
    event Ruled(
        uint256 indexed jobId,
        address indexed arbitrator,
        uint16 verdictPayoutBps,
        uint16 rulingPayoutBps,
        bool overturned
    );
    event DisputeTimedOut(uint256 indexed jobId);
    event ChallengeBondDistributed(
        uint256 indexed jobId,
        address indexed challenger,
        uint256 toChallenger,
        uint256 toCounterparty,
        uint256 toTreasury
    );
    event Slashed(uint256 indexed jobId, address indexed evaluator, uint8 reason, uint256 amount);
    event ProviderBondSlashed(uint256 indexed jobId, address indexed provider, address indexed to, uint256 amount);
    event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 net, uint256 fee);
    event Refunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event ProviderBondReturned(uint256 indexed jobId, address indexed provider, uint256 amount);
    event Settled(uint256 indexed jobId, uint16 payoutBps);
    event JobExpired(uint256 indexed jobId);
    event JobCancelled(uint256 indexed jobId);
    event PauserSet(address indexed pauser);
    event MaxPerJobSet(uint256 previous, uint256 current);
    event MaxTotalLockedSet(uint256 previous, uint256 current);

    event ScheduleCommitted(uint256 indexed jobId, bytes32 docHash, uint8 requiredTotal, uint256 bpsTable);
    event ScheduledVerdict(uint256 indexed jobId, uint16 passMask, uint8 requiredPass, uint16 payoutBps);

    // ---------------- errors ----------------
    error ZeroAddress();
    error ZeroAmount();
    error InvalidConfig();
    error FeeCeilingExceeded(uint256 totalFeeBps, uint256 ceilingBps);
    error InvalidParty();
    error DeadlineInPast();
    error EvaluatorNotActive(address evaluator);
    error JobNotFound(uint256 jobId);
    error WrongState(State current);
    error Unauthorized();
    error DeadlinePassed();
    error DeadlineNotReached();
    error EvalWindowClosed();
    error EvalWindowOpen();
    error ChallengeWindowClosed();
    error ChallengeWindowOpen();
    error ArbitrationTimeoutNotReached();
    error InvalidOutcome();
    error InvalidPayout();
    error NoArbitrator();
    error ZeroHash();
    error ScheduledJob(uint256 jobId);
    error NotScheduled(uint256 jobId);
    error InvalidSchedule();
    error InvalidPassMask();
    error RequiredTotalMismatch();
    error RequiredPassMismatch();
    error NotPauser();
    error CapIncrease(uint256 current, uint256 requested);
    error ExceedsPerJobCap(uint256 amount, uint256 cap);
    error ExceedsTotalCap(uint256 totalAfter, uint256 cap);

    constructor(
        IERC20 token_,
        IEvaluatorRegistry registry_,
        address treasury_,
        IArbitrator arbitrator_,
        Config memory config_,
        address owner_,
        address pauser_,
        uint256 maxPerJob_,
        uint256 maxTotalLocked_
    ) Ownable(owner_) {
        if (
            address(token_) == address(0) || address(registry_) == address(0) || treasury_ == address(0)
                || pauser_ == address(0)
        ) {
            revert ZeroAddress();
        }
        if (maxPerJob_ == 0 || maxTotalLocked_ == 0 || maxPerJob_ > maxTotalLocked_) revert InvalidConfig();
        pauser = pauser_;
        maxPerJob = maxPerJob_;
        maxTotalLocked = maxTotalLocked_;
        emit PauserSet(pauser_);
        emit MaxPerJobSet(0, maxPerJob_);
        emit MaxTotalLockedSet(0, maxTotalLocked_);
        token = token_;
        registry = registry_;
        treasury = treasury_;
        arbitrator = arbitrator_; // may be zero: challenges revert until set
        _setConfig(config_);
    }

    // =====================================================================
    // admin
    // =====================================================================

    /// @notice Publishes a new config version. Existing jobs keep their pinned version.
    function setConfig(Config calldata config_) external onlyOwner {
        _setConfig(config_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    /// @notice Arbitrator for future challenges. Open disputes keep the arbitrator they were sent to.
    /// @notice Pauser or owner. Emits Paused(account).
    function pause() external {
        if (msg.sender != pauser && msg.sender != owner()) revert NotPauser();
        _pause();
    }

    /// @notice Pauser or owner. Emits Unpaused(account).
    function unpause() external {
        if (msg.sender != pauser && msg.sender != owner()) revert NotPauser();
        _unpause();
    }

    function setPauser(address pauser_) external onlyOwner {
        if (pauser_ == address(0)) revert ZeroAddress();
        pauser = pauser_;
        emit PauserSet(pauser_);
    }

    /// @notice Lower-only. Does not affect already-funded jobs.
    function setMaxPerJob(uint256 cap) external onlyOwner {
        uint256 prev = maxPerJob;
        if (cap > prev) revert CapIncrease(prev, cap);
        maxPerJob = cap;
        emit MaxPerJobSet(prev, cap);
    }

    /// @notice Lower-only. May go below `totalLocked`: that only blocks new funding.
    function setMaxTotalLocked(uint256 cap) external onlyOwner {
        uint256 prev = maxTotalLocked;
        if (cap > prev) revert CapIncrease(prev, cap);
        maxTotalLocked = cap;
        emit MaxTotalLockedSet(prev, cap);
    }

    function setArbitrator(IArbitrator arbitrator_) external onlyOwner {
        arbitrator = arbitrator_;
        emit ArbitratorSet(address(arbitrator_));
    }

    function _setConfig(Config memory c) internal {
        // hard ceiling (constructor and every config update): protocol fee + evaluator fee <= 5%
        if (uint256(c.feeBps) + c.evaluatorFeeBps > MAX_TOTAL_FEE_BPS) {
            revert FeeCeilingExceeded(uint256(c.feeBps) + c.evaluatorFeeBps, MAX_TOTAL_FEE_BPS);
        }
        if (
            c.evalWindow == 0 || c.challengeWindow == 0 || c.arbitrationTimeout == 0 || c.challengeBondBps > BPS
                || c.missedVerdictSlashBps > BPS || c.wrongVerdictSlashBps > BPS || c.materialDiffBps > BPS
                || uint256(c.feeBps) + c.evaluatorFeeBps > BPS || c.failedChallengeEvaluatorShareBps > BPS
        ) revert InvalidConfig();
        uint32 v = currentConfigVersion + 1;
        currentConfigVersion = v;
        _configs[v] = c;
        emit ConfigUpdated(v, c);
    }

    // =====================================================================
    // client
    // =====================================================================

    function createJob(address provider, address evaluator, uint256 amount, uint64 deadline, bytes32 specHash)
        external
        nonReentrant
        returns (uint256 jobId)
    {
        jobId = _create(msg.sender, provider, evaluator, amount, deadline, specHash);
    }

    /// @notice createJob + fund in one call.
    function createAndFund(address provider, address evaluator, uint256 amount, uint64 deadline, bytes32 specHash)
        external
        nonReentrant
        returns (uint256 jobId)
    {
        jobId = _create(msg.sender, provider, evaluator, amount, deadline, specHash);
        _fund(jobId, msg.sender);
    }

    /// @notice createJob + fund where msg.sender pays and `client` becomes the job client
    ///         (refunds and client rights go to `client`). Used by EscrowDepositRoute (x402 exact, A-1).
    function createAndFundFor(
        address client,
        address provider,
        address evaluator,
        uint256 amount,
        uint64 deadline,
        bytes32 specHash
    ) external nonReentrant returns (uint256 jobId) {
        if (client == address(0)) revert ZeroAddress();
        jobId = _create(client, provider, evaluator, amount, deadline, specHash);
        _fund(jobId, msg.sender);
    }

    /// @notice Create an unfunded job with an immutable payout schedule (AD-014).
    function createJobScheduled(
        address provider,
        address evaluator,
        uint256 amount,
        uint64 deadline,
        bytes32 specHash,
        PayoutSchedule calldata s
    ) external nonReentrant returns (uint256 jobId) {
        jobId = _create(msg.sender, provider, evaluator, amount, deadline, specHash);
        _commitSchedule(jobId, s);
    }

    /// @notice createJobScheduled + fund in one call.
    function createAndFundScheduled(
        address provider,
        address evaluator,
        uint256 amount,
        uint64 deadline,
        bytes32 specHash,
        PayoutSchedule calldata s
    ) external nonReentrant returns (uint256 jobId) {
        jobId = _create(msg.sender, provider, evaluator, amount, deadline, specHash);
        _commitSchedule(jobId, s);
        _fund(jobId, msg.sender);
    }

    function fund(uint256 jobId) external nonReentrant {
        Job storage j = _job(jobId);
        if (msg.sender != j.client) revert Unauthorized();
        _fund(jobId, msg.sender);
    }

    /// @notice Client exit. Open: cancel. Funded and not accepted: cancel with refund.
    ///         Funded, accepted, deadline passed with no submission: expire with refund.
    function cancel(uint256 jobId) external nonReentrant {
        Job storage j = _job(jobId);
        if (msg.sender != j.client) revert Unauthorized();
        if (j.state == State.Open) {
            j.state = State.Cancelled;
            emit JobCancelled(jobId);
            _returnProviderBond(jobId, j);
        } else if (j.state == State.Funded && !j.accepted) {
            j.state = State.Cancelled;
            emit JobCancelled(jobId);
            _refundAll(jobId, j);
        } else if (j.state == State.Funded && block.timestamp >= j.deadline) {
            _expire(jobId, j);
        } else {
            revert WrongState(j.state);
        }
    }

    /// @notice ERC-8183 claimRefund: anyone, once a Funded job passed its deadline without submission.
    function claimRefund(uint256 jobId) external nonReentrant {
        Job storage j = _job(jobId);
        if (j.state != State.Funded) revert WrongState(j.state);
        if (block.timestamp < j.deadline) revert DeadlineNotReached();
        _expire(jobId, j);
    }

    // =====================================================================
    // provider
    // =====================================================================

    /// @notice Optional provider bond. Slashable only on a lost dispute. Returned at settlement.
    function postProviderBond(uint256 jobId, uint256 amount) external nonReentrant {
        Job storage j = _job(jobId);
        if (msg.sender != j.provider) revert Unauthorized();
        if (j.state != State.Open && j.state != State.Funded) revert WrongState(j.state);
        if (amount == 0) revert ZeroAmount();
        j.providerBond += amount;
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit ProviderBondPosted(jobId, msg.sender, amount, j.providerBond);
    }

    /// @notice Provider commits to the job; afterwards the client can no longer cancel before the deadline.
    function accept(uint256 jobId) external {
        Job storage j = _job(jobId);
        if (msg.sender != j.provider) revert Unauthorized();
        if (j.state != State.Funded) revert WrongState(j.state);
        if (j.accepted) revert WrongState(j.state);
        j.accepted = true;
        emit JobAccepted(jobId, msg.sender);
    }

    /// @notice Submit deliverable hash before the deadline. If amount <= instantThreshold and the
    ///         provider bond covers amount * instantBondCoverBps, payment is released immediately.
    function submit(uint256 jobId, bytes32 deliverableHash) external nonReentrant {
        Job storage j = _job(jobId);
        if (msg.sender != j.provider) revert Unauthorized();
        if (j.state != State.Funded) revert WrongState(j.state);
        if (block.timestamp >= j.deadline) revert DeadlinePassed();
        if (deliverableHash == bytes32(0)) revert ZeroHash();

        j.deliverableHash = deliverableHash;
        j.submittedAt = uint64(block.timestamp);
        j.accepted = true;
        emit JobSubmitted(jobId, msg.sender, deliverableHash);

        if (_schedules[jobId].docHash == 0 && _instantEligible(j)) {
            j.instant = true;
            j.state = State.Completed;
            j.outcome = Outcome.Complete;
            j.payoutBps = BPS;
            j.verdictAt = uint64(block.timestamp);
            (uint256 net, uint256 fee) = _payProvider(jobId, j, j.amount, 0);
            emit InstantReleased(jobId, j.provider, net, fee);
        } else {
            j.state = State.Submitted;
        }
    }

    // =====================================================================
    // evaluator
    // =====================================================================

    /// @notice Named evaluator records a verdict within evalWindow after submission.
    ///         Complete => payoutBps 10000, Reject => 0, Partial => 1..9999.
    function verdict(uint256 jobId, Outcome outcome, uint16 payoutBps, bytes32 reasonHash) external nonReentrant {
        _verdict(jobId, outcome, payoutBps, reasonHash);
    }

    /// @notice ERC-8183 alias for verdict(Complete, 10000, reason).
    function complete(uint256 jobId, bytes32 reason) external nonReentrant {
        _verdict(jobId, Outcome.Complete, BPS, reason);
    }

    /// @notice ERC-8183 alias for verdict(Reject, 0, reason). Only from Submitted in v0.
    function reject(uint256 jobId, bytes32 reason) external nonReentrant {
        _verdict(jobId, Outcome.Reject, 0, reason);
    }

    /// @notice Scheduled-job verdict. Outcome and payoutBps are derived from the committed
    ///         table at required_pass. requiredTotal must match the value committed at funding;
    ///         requiredPass must equal popcount(passMask restricted to required criteria).
    function verdictScheduled(
        uint256 jobId,
        uint16 passMask,
        uint8 requiredTotal,
        uint8 requiredPass,
        bytes32 reasonHash
    ) external nonReentrant {
        Job storage j = _job(jobId);
        PayoutSchedule storage s = _schedules[jobId];
        if (s.docHash == 0) revert NotScheduled(jobId);
        if (msg.sender != j.evaluator) revert Unauthorized();
        if (j.state != State.Submitted) revert WrongState(j.state);
        Config storage c = _configs[j.configVersion];
        if (block.timestamp > uint256(j.submittedAt) + c.evalWindow) revert EvalWindowClosed();
        if (reasonHash == bytes32(0)) revert ZeroHash();
        if (requiredTotal != s.requiredTotal) revert RequiredTotalMismatch();
        if (uint256(passMask) >> s.requiredTotal != 0) revert InvalidPassMask();
        uint8 passCount = PayoutScheduleLib.requiredPassFromMask(passMask, s.requiredTotal);
        if (requiredPass != passCount) revert RequiredPassMismatch();

        uint16 bps = PayoutScheduleLib.entryAt(s.bpsTable, passCount);
        Outcome outcome = _outcomeFromBps(bps);
        State next;
        if (outcome == Outcome.Complete) next = State.Completed;
        else if (outcome == Outcome.Reject) next = State.Rejected;
        else next = State.Partial;

        j.state = next;
        j.outcome = outcome;
        j.payoutBps = bps;
        j.reasonHash = reasonHash;
        j.verdictAt = uint64(block.timestamp);
        emit Verdict(jobId, msg.sender, outcome, bps, reasonHash);
        emit ScheduledVerdict(jobId, passMask, passCount, bps);
    }

    /// @notice Anyone, after evalWindow with no verdict: evaluator slashed, client refunded.
    function timeoutRelease(uint256 jobId) external nonReentrant {
        Job storage j = _job(jobId);
        if (j.state != State.Submitted) revert WrongState(j.state);
        Config storage c = _configs[j.configVersion];
        if (block.timestamp <= uint256(j.submittedAt) + c.evalWindow) revert EvalWindowOpen();

        uint256 slashAmt = (j.slashBase * c.missedVerdictSlashBps) / BPS;
        // harmed party for a missed verdict = provider (client is made whole by the refund). See E-12.
        uint256 slashed = registry.slash(j.evaluator, jobId, slashAmt, j.provider, 1);
        emit Slashed(jobId, j.evaluator, 1, slashed);
        emit VerdictTimedOut(jobId, j.evaluator, slashed);
        _expire(jobId, j);
    }

    // =====================================================================
    // challenge / arbitration
    // =====================================================================

    /// @notice Client or provider challenges a verdict within challengeWindow by posting a challenge
    ///         bond plus the arbitrator's quoted arbitrationCost. Both are held in this contract.
    ///         On instant-release jobs only the client may challenge.
    function challenge(uint256 jobId, bytes32 reasonHash) external nonReentrant {
        Job storage j = _job(jobId);
        if (j.state != State.Completed && j.state != State.Rejected && j.state != State.Partial) {
            revert WrongState(j.state);
        }
        Config storage c = _configs[j.configVersion];
        if (block.timestamp > uint256(j.verdictAt) + c.challengeWindow) revert ChallengeWindowClosed();
        if (msg.sender != j.client && msg.sender != j.provider) revert Unauthorized();
        if (j.instant && msg.sender != j.client) revert Unauthorized();
        IArbitrator arb = arbitrator;
        if (address(arb) == address(0)) revert NoArbitrator();

        uint256 bond = _challengeBond(c, j.amount);
        uint256 fee = arb.arbitrationCost(jobId, j.amount);
        j.state = State.Disputed;
        j.disputedAt = uint64(block.timestamp);
        Dispute storage d = _disputes[jobId];
        d.challenger = msg.sender;
        d.arbitrator = address(arb);
        d.bond = bond;
        d.arbFee = fee;
        d.reasonHash = reasonHash;

        token.safeTransferFrom(msg.sender, address(this), bond + fee);
        if (fee > 0) emit ArbitrationFeeEscrowed(jobId, msg.sender, address(arb), fee);
        d.disputeId = arb.requestRuling(jobId, msg.sender, j.payoutBps, reasonHash);
        emit Challenged(jobId, msg.sender, address(arb), bond, d.disputeId, reasonHash);
    }

    /// @inheritdoc IArbitrable
    function rule(uint256 jobId, uint16 payoutBps) external nonReentrant {
        Job storage j = _job(jobId);
        if (j.state != State.Disputed) revert WrongState(j.state);
        Dispute storage d = _disputes[jobId];
        if (msg.sender != d.arbitrator) revert Unauthorized();
        if (payoutBps > BPS) revert InvalidPayout();
        if (
            _schedules[jobId].docHash != 0
                && !PayoutScheduleLib.tableContains(
                    _schedules[jobId].bpsTable, _schedules[jobId].requiredTotal, payoutBps
                )
        ) {
            revert InvalidPayout();
        }

        Config storage c = _configs[j.configVersion];
        uint16 verdictBps = j.payoutBps;
        uint256 diff = payoutBps > verdictBps ? payoutBps - verdictBps : verdictBps - payoutBps;
        bool overturned = diff > c.materialDiffBps;

        j.state = State.Settled;
        j.payoutBps = payoutBps;
        emit Ruled(jobId, msg.sender, verdictBps, payoutBps, overturned);

        if (j.instant) {
            _resolveInstantDispute(jobId, j, d, c, payoutBps, overturned);
        } else {
            _resolveVerdictDispute(jobId, j, d, c, verdictBps, payoutBps, overturned);
            // evaluator fee only when the verdict stands (E-18)
            _distribute(jobId, j, payoutBps, !overturned);
        }
        // E-17a: the held arbitration cost goes to the arbitrator only now, when it ruled
        if (d.arbFee > 0) {
            _transferOut(d.arbitrator, d.arbFee);
            emit ArbitrationFeePaid(jobId, d.challenger, d.arbitrator, d.arbFee);
        }
        _closeOut(jobId, j);
    }

    /// @notice Anyone, if the arbitrator has not ruled within arbitrationTimeout: settle per the
    ///         original verdict and return the challenge bond and the held arbitration cost in full
    ///         (E-17a). A later rule() from the arbitrator reverts (state is no longer Disputed).
    function resolveStaleDispute(uint256 jobId) external nonReentrant {
        Job storage j = _job(jobId);
        if (j.state != State.Disputed) revert WrongState(j.state);
        Config storage c = _configs[j.configVersion];
        if (block.timestamp < uint256(j.disputedAt) + c.arbitrationTimeout) revert ArbitrationTimeoutNotReached();
        Dispute storage d = _disputes[jobId];
        j.state = State.Settled;
        emit DisputeTimedOut(jobId);
        _transferOut(d.challenger, d.bond);
        emit ChallengeBondDistributed(jobId, d.challenger, d.bond, 0, 0);
        if (d.arbFee > 0) {
            _transferOut(d.challenger, d.arbFee);
            emit ArbitrationFeeRefunded(jobId, d.challenger, d.arbFee);
        }
        if (!j.instant) _distribute(jobId, j, j.payoutBps, true);
        _closeOut(jobId, j);
    }

    /// @notice Anyone, after challengeWindow with no challenge: pay out per verdict.
    function finalize(uint256 jobId) external nonReentrant {
        Job storage j = _job(jobId);
        if (j.state != State.Completed && j.state != State.Rejected && j.state != State.Partial) {
            revert WrongState(j.state);
        }
        Config storage c = _configs[j.configVersion];
        if (block.timestamp <= uint256(j.verdictAt) + c.challengeWindow) revert ChallengeWindowOpen();
        j.state = State.Settled;
        if (!j.instant) _distribute(jobId, j, j.payoutBps, true);
        _closeOut(jobId, j);
    }

    // =====================================================================
    // views
    // =====================================================================

    function getJob(uint256 jobId) external view returns (Job memory) {
        return _jobs[jobId];
    }

    function getSchedule(uint256 jobId) external view returns (PayoutSchedule memory) {
        return _schedules[jobId];
    }

    /// @notice Dry-run helper: outcome and payoutBps for a pass mask on a scheduled job.
    function scheduledPayout(uint256 jobId, uint16 passMask) external view returns (Outcome outcome, uint16 payoutBps) {
        PayoutSchedule storage s = _schedules[jobId];
        if (s.docHash == 0) revert NotScheduled(jobId);
        if (uint256(passMask) >> s.requiredTotal != 0) revert InvalidPassMask();
        uint8 passCount = PayoutScheduleLib.requiredPassFromMask(passMask, s.requiredTotal);
        payoutBps = PayoutScheduleLib.entryAt(s.bpsTable, passCount);
        outcome = _outcomeFromBps(payoutBps);
    }

    function getDispute(uint256 jobId) external view returns (Dispute memory) {
        return _disputes[jobId];
    }

    function config(uint32 version) external view returns (Config memory) {
        return _configs[version];
    }

    function currentConfig() external view returns (Config memory) {
        return _configs[currentConfigVersion];
    }

    /// @notice Price facts for a prospective job under the current config.
    /// @return feeAtFullPayout protocol fee if the job settles Complete
    /// @return evaluatorFeeAtFullPayout evaluator fee if the job settles Complete via a verdict
    /// @return providerNetAtFullPayout provider receipt if the job settles Complete via a verdict
    /// @return challengeBond bond required to challenge a verdict on this job
    /// @return arbitrationFee arbitrator's arbitrationCost(0, amount) the challenger pays with the bond (0 if no arbitrator)
    /// @return instantEligible whether submit would release instantly given providerBond
    /// @return configVersion config version the job would pin
    function quote(uint256 amount, uint256 providerBond)
        external
        view
        returns (
            uint256 feeAtFullPayout,
            uint256 evaluatorFeeAtFullPayout,
            uint256 providerNetAtFullPayout,
            uint256 challengeBond,
            uint256 arbitrationFee,
            bool instantEligible,
            uint32 configVersion
        )
    {
        configVersion = currentConfigVersion;
        Config storage c = _configs[configVersion];
        feeAtFullPayout = (amount * c.feeBps) / BPS;
        evaluatorFeeAtFullPayout = (amount * c.evaluatorFeeBps) / BPS;
        providerNetAtFullPayout = amount - feeAtFullPayout - evaluatorFeeAtFullPayout;
        challengeBond = _challengeBond(c, amount);
        if (address(arbitrator) != address(0)) arbitrationFee = arbitrator.arbitrationCost(0, amount);
        instantEligible = amount <= c.instantThreshold && providerBond * BPS >= amount * c.instantBondCoverBps;
    }

    // =====================================================================
    // internals
    // =====================================================================

    function _job(uint256 jobId) internal view returns (Job storage j) {
        j = _jobs[jobId];
        if (j.state == State.None) revert JobNotFound(jobId);
    }

    function _create(
        address client,
        address provider,
        address evaluator,
        uint256 amount,
        uint64 deadline,
        bytes32 specHash
    ) internal whenNotPaused returns (uint256 jobId) {
        if (provider == address(0) || evaluator == address(0)) revert ZeroAddress();
        if (provider == client || evaluator == client || evaluator == provider) revert InvalidParty();
        if (amount == 0) revert ZeroAmount();
        if (deadline <= block.timestamp) revert DeadlineInPast();
        if (specHash == bytes32(0)) revert ZeroHash();
        if (!registry.isActive(evaluator)) revert EvaluatorNotActive(evaluator);

        jobId = ++jobCount;
        Job storage j = _jobs[jobId];
        j.client = client;
        j.provider = provider;
        j.evaluator = evaluator;
        j.configVersion = currentConfigVersion;
        j.state = State.Open;
        j.amount = amount;
        j.deadline = deadline;
        j.specHash = specHash;
        emit JobCreated(jobId, client, provider, evaluator, amount, deadline, specHash, j.configVersion);
    }

    function _commitSchedule(uint256 jobId, PayoutSchedule calldata s) internal {
        if (!PayoutScheduleLib.scheduleValid(s.docHash, s.requiredTotal, s.bpsTable)) revert InvalidSchedule();
        _schedules[jobId] = s;
        emit ScheduleCommitted(jobId, s.docHash, s.requiredTotal, s.bpsTable);
    }

    function _outcomeFromBps(uint16 bps) internal pure returns (Outcome) {
        if (bps == BPS) return Outcome.Complete;
        if (bps == 0) return Outcome.Reject;
        return Outcome.Partial;
    }

    function _fund(uint256 jobId, address payer) internal whenNotPaused {
        Job storage j = _jobs[jobId];
        if (j.state != State.Open) revert WrongState(j.state);
        if (block.timestamp >= j.deadline) revert DeadlinePassed();
        uint256 amt = j.amount;
        if (amt > maxPerJob) revert ExceedsPerJobCap(amt, maxPerJob);
        uint256 totalAfter = totalLocked + amt;
        if (totalAfter > maxTotalLocked) revert ExceedsTotalCap(totalAfter, maxTotalLocked);
        totalLocked = totalAfter;
        j.state = State.Funded;
        j.slashBase = registry.minStake(); // E-22: later registry minStake changes do not affect this job
        registry.lockExposure(j.evaluator, jobId, j.amount); // reverts if inactive or over cap
        token.safeTransferFrom(payer, address(this), j.amount);
        emit JobFunded(jobId, j.client, j.amount);
    }

    function _verdict(uint256 jobId, Outcome outcome, uint16 payoutBps, bytes32 reasonHash) internal {
        Job storage j = _job(jobId);
        if (_schedules[jobId].docHash != 0) revert ScheduledJob(jobId);
        if (msg.sender != j.evaluator) revert Unauthorized();
        if (j.state != State.Submitted) revert WrongState(j.state);
        Config storage c = _configs[j.configVersion];
        if (block.timestamp > uint256(j.submittedAt) + c.evalWindow) revert EvalWindowClosed();

        State next;
        if (outcome == Outcome.Complete) {
            if (payoutBps != BPS) revert InvalidPayout();
            next = State.Completed;
        } else if (outcome == Outcome.Reject) {
            if (payoutBps != 0) revert InvalidPayout();
            next = State.Rejected;
        } else if (outcome == Outcome.Partial) {
            if (payoutBps == 0 || payoutBps >= BPS) revert InvalidPayout();
            next = State.Partial;
        } else {
            revert InvalidOutcome();
        }
        j.state = next;
        j.outcome = outcome;
        j.payoutBps = payoutBps;
        j.reasonHash = reasonHash;
        j.verdictAt = uint64(block.timestamp);
        emit Verdict(jobId, msg.sender, outcome, payoutBps, reasonHash);
    }

    function _instantEligible(Job storage j) internal view returns (bool) {
        Config storage c = _configs[j.configVersion];
        return j.amount <= c.instantThreshold && j.providerBond * BPS >= j.amount * c.instantBondCoverBps;
    }

    function _challengeBond(Config storage c, uint256 amount) internal view returns (uint256 bond) {
        bond = (amount * c.challengeBondBps) / BPS;
        if (bond < c.minChallengeBond) bond = c.minChallengeBond;
    }

    /// @dev Verdict-path dispute: evaluator slash on overturn, provider-bond slash when the ruling
    ///      lowers the provider's payout materially, challenge bond to challenger or split.
    function _resolveVerdictDispute(
        uint256 jobId,
        Job storage j,
        Dispute storage d,
        Config storage c,
        uint16 verdictBps,
        uint16 rulingBps,
        bool overturned
    ) internal {
        if (overturned) {
            // E-17 loser pays: the evaluator whose verdict was overturned refunds the arbitration fee
            if (d.arbFee > 0) {
                uint256 paid = registry.reimburse(j.evaluator, jobId, d.arbFee, d.challenger);
                if (paid > 0) emit ArbitrationFeeReimbursed(jobId, d.challenger, j.evaluator, paid);
            }
            uint256 slashAmt = (j.slashBase * c.wrongVerdictSlashBps) / BPS;
            uint256 slashed = registry.slash(j.evaluator, jobId, slashAmt, d.challenger, 2);
            emit Slashed(jobId, j.evaluator, 2, slashed);
            _transferOut(d.challenger, d.bond);
            emit ChallengeBondDistributed(jobId, d.challenger, d.bond, 0, 0);
            if (rulingBps < verdictBps && j.providerBond > 0) {
                uint256 bondSlash = (j.providerBond * (verdictBps - rulingBps)) / BPS;
                j.providerBond -= bondSlash;
                _transferOut(j.client, bondSlash);
                emit ProviderBondSlashed(jobId, j.provider, j.client, bondSlash);
            }
        } else {
            _splitFailedChallengeBond(jobId, d, c, j.evaluator);
        }
    }

    /// @dev Instant-path dispute: payment already left escrow, so the client is compensated from
    ///      the provider bond only (capped at the bond).
    function _resolveInstantDispute(
        uint256 jobId,
        Job storage j,
        Dispute storage d,
        Config storage c,
        uint16 rulingBps,
        bool overturned
    ) internal {
        uint256 owed = (j.amount * (BPS - rulingBps)) / BPS;
        uint256 comp = owed > j.providerBond ? j.providerBond : owed;
        if (comp > 0) {
            j.providerBond -= comp;
            _transferOut(j.client, comp);
            emit ProviderBondSlashed(jobId, j.provider, j.client, comp);
        }
        if (overturned) {
            // E-17 loser pays: on an instant job the losing side is the provider; reimburse the
            // arbitration fee from what remains of the provider bond (capped).
            uint256 feeBack = d.arbFee > j.providerBond ? j.providerBond : d.arbFee;
            if (feeBack > 0) {
                j.providerBond -= feeBack;
                _transferOut(d.challenger, feeBack);
                emit ArbitrationFeeReimbursed(jobId, d.challenger, j.provider, feeBack);
            }
            _transferOut(d.challenger, d.bond);
            emit ChallengeBondDistributed(jobId, d.challenger, d.bond, 0, 0);
        } else {
            _splitFailedChallengeBond(jobId, d, c, j.provider);
        }
    }

    function _splitFailedChallengeBond(uint256 jobId, Dispute storage d, Config storage c, address counterparty)
        internal
    {
        uint256 toCounterparty = (d.bond * c.failedChallengeEvaluatorShareBps) / BPS;
        uint256 toTreasury = d.bond - toCounterparty;
        _transferOut(counterparty, toCounterparty);
        _transferOut(treasury, toTreasury);
        emit ChallengeBondDistributed(jobId, d.challenger, 0, toCounterparty, toTreasury);
    }

    /// @dev Pays provider share (minus fee) and refunds the remainder to the client.
    /// @param payEvaluator true when the evaluator's verdict stands (E-18 evaluator fee is due).
    function _distribute(uint256 jobId, Job storage j, uint16 payoutBps, bool payEvaluator) internal {
        uint256 gross = (j.amount * payoutBps) / BPS;
        if (gross > 0) {
            uint256 evalFee = payEvaluator ? (gross * _configs[j.configVersion].evaluatorFeeBps) / BPS : 0;
            if (evalFee > 0) {
                _transferOut(j.evaluator, evalFee);
                emit EvaluatorFeePaid(jobId, j.evaluator, evalFee);
            }
            _payProvider(jobId, j, gross, evalFee);
        }
        uint256 refund = j.amount - gross;
        if (refund > 0) {
            _transferOut(j.client, refund);
            emit Refunded(jobId, j.client, refund);
        }
    }

    /// @dev Protocol fee = gross * feeBps; evaluatorFee was already paid by the caller.
    ///      Provider net = gross - fee - evaluatorFee.
    function _payProvider(uint256 jobId, Job storage j, uint256 gross, uint256 evaluatorFee)
        internal
        returns (uint256 net, uint256 fee)
    {
        fee = (gross * _configs[j.configVersion].feeBps) / BPS;
        net = gross - fee - evaluatorFee;
        _transferOut(treasury, fee);
        _transferOut(j.provider, net);
        emit PaymentReleased(jobId, j.provider, net, fee);
    }

    function _expire(uint256 jobId, Job storage j) internal {
        j.state = State.Expired;
        emit JobExpired(jobId);
        _refundAll(jobId, j);
    }

    function _refundAll(uint256 jobId, Job storage j) internal {
        _transferOut(j.client, j.amount);
        emit Refunded(jobId, j.client, j.amount);
        _unlock(j.amount);
        registry.releaseExposure(j.evaluator, jobId, j.amount);
        _returnProviderBond(jobId, j);
    }

    function _closeOut(uint256 jobId, Job storage j) internal {
        _unlock(j.amount);
        registry.releaseExposure(j.evaluator, jobId, j.amount);
        _returnProviderBond(jobId, j);
        emit Settled(jobId, j.payoutBps);
    }

    /// @dev Saturating so a release can never revert (never traps funds); invariant tests check exactness.
    function _unlock(uint256 amount) internal {
        uint256 t = totalLocked;
        totalLocked = amount > t ? 0 : t - amount;
    }

    function _returnProviderBond(uint256 jobId, Job storage j) internal {
        uint256 b = j.providerBond;
        if (b == 0) return;
        j.providerBond = 0;
        _transferOut(j.provider, b);
        emit ProviderBondReturned(jobId, j.provider, b);
    }

    function _transferOut(address to, uint256 amount) internal {
        if (amount > 0) token.safeTransfer(to, amount);
    }
}
