// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IEvaluatorRegistry} from "./interfaces/IEvaluatorRegistry.sol";
import {IArbitrator, IArbitrable} from "./interfaces/IArbitrator.sol";
import {IERC8183} from "./interfaces/IERC8183.sol";
import {IACPHook, ACPSelectors} from "./interfaces/IACPHook.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @title ERC8183EvaluatorAdapter
/// @notice A contract an external ERC-8183 kernel can name as `evaluator`. A staked evaluator from
///         EvaluatorRegistry decides; the adapter holds the verdict through a challenge window
///         (optionally sent to an arbitrator), then calls complete() or reject() on the kernel.
/// @dev ASSUMPTIONS E-1. ERC-8183 settles all-or-nothing, so a payout in basis points is mapped
///      to a binary outcome: payoutBps >= completeThresholdBps => complete, else reject. This
///      mapping is LOSSY (a 6000 bps verdict pays 100% to the provider on the kernel).
///      The adapter is a slasher in EvaluatorRegistry (exposure lock + slashing on the same stake
///      the native JobEscrow uses). Adapter job ids are local to this contract.
///      Liveness limit (E-1a): the kernel's claimRefund() after expiredAt is outside the adapter's
///      control. Adapter jobs therefore use their own shorter windows (defaults eval 24h,
///      challenge 24h, arbitration timeout 7d) and assign()/acceptAssignment() refuse a kernel job
///      whose expiredAt < now + evalWindow + challengeWindow + arbitrationTimeout + expiryMargin
///      (default margin 1h). E-1c: the same bound is checked when the adapter first observes the
///      submission; if the kernel job no longer has that much time left, no eval window starts:
///      the job moves to ExpiryRefused, exposure is released without a slash, ExpiryRisk is emitted
///      and the kernel job is left to the kernel's own refund path (claimRefund after expiredAt).
///      A kernel call that still fails (e.g. a non-conforming kernel) ends in KernelCallFailed.
///
///      ACP v2 / ERC-8183 hooked kernels (docs/ERC8183-ACPV2.md): the adapter can ALSO be named as the
///      job `hook`. Then the kernel's afterAction(submit) starts the eval window at the real submission
///      time without anyone calling noteSubmission (keeper-free). The hook never reverts (a reverting
///      hook would block the provider's submit, spec "Hook security"), only acts for assignments keyed
///      by (msg.sender kernel, jobId), and ignores every other selector. Using it is optional.
contract ERC8183EvaluatorAdapter is IArbitrable, IACPHook, IERC165, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant BPS = 10_000;
    uint8 public constant SLASH_MISSED_VERDICT = 1;
    uint8 public constant SLASH_OVERTURNED_VERDICT = 2;
    bytes32 public constant REASON_MISSED_VERDICT = keccak256("agentcoin.adapter.missed-verdict");

    enum State {
        None,
        Proposed, // client named a staked evaluator; awaiting evaluator acceptance
        Active, // evaluator accepted; exposure locked; awaiting submission / verdict
        Held, // verdict recorded; challenge window running
        Disputed, // challenged; awaiting arbitrator
        Executed, // kernel complete()/reject() succeeded
        KernelCallFailed, // kernel call reverted (e.g. kernel already expired/refunded); stake side settled
        Withdrawn, // client withdrew a Proposed assignment
        KernelEnded, // kernel job ended outside the adapter (e.g. claimRefund) before a submission was seen (E-1d)
        ExpiryRefused // E-1c: submission observed with too little kernel time left; no eval window, exposure released
    }

    struct Config {
        uint64 evalWindow; // seconds after submission noticed. default 24h
        uint64 challengeWindow; // seconds after verdict. default 24h (E-1a)
        uint64 arbitrationTimeout; // seconds after challenge. default 7d (E-1a)
        uint64 expiryMargin; // extra seconds on top of the three windows. default 1h (E-1a)
        uint256 minChallengeBond; // default 1e6
        uint16 challengeBondBps; // default 500
        uint16 missedVerdictSlashBps; // of minStake pinned at accept. default 1000
        uint16 wrongVerdictSlashBps; // of minStake pinned at accept. default 2500
        uint16 failedChallengeEvaluatorShareBps; // default 5000; remainder to treasury
        uint16 completeThresholdBps; // payoutBps >= this => kernel.complete. default 5000
    }

    struct AdapterJob {
        address kernel;
        uint256 kernelJobId;
        address client;
        address provider;
        address evaluator; // staked evaluator in EvaluatorRegistry
        uint32 configVersion;
        State state;
        bool completes; // mapped outcome of the verdict currently in force
        uint16 payoutBps; // verdict (or ruling) in bps
        uint64 submittedAt; // when the adapter observed kernel status Submitted
        uint64 verdictAt;
        uint64 disputedAt;
        uint256 budget;
        uint256 slashBase; // registry.minStake() pinned at accept (E-22)
        bytes32 reasonHash;
    }

    struct Dispute {
        address challenger;
        address arbitrator;
        uint256 bond;
        uint256 arbFee;
        uint256 disputeId;
    }

    /// @dev The single payment token of this deployment (stake, bonds, fees and the kernel job's
    ///      paymentToken must all be it). Set per chain/deployment at construction; assign() refuses
    ///      kernel jobs priced in anything else (TokenMismatch). Also readable as acceptedToken().
    IERC20 public immutable token;
    IEvaluatorRegistry public immutable registry;
    address public treasury;
    IArbitrator public arbitrator;
    uint32 public currentConfigVersion;
    uint256 public jobCount;

    mapping(uint32 => Config) internal _configs;
    mapping(uint256 => AdapterJob) internal _jobs;
    mapping(uint256 => Dispute) internal _disputes;
    /// @notice keccak256(kernel, kernelJobId) => adapter job id of the live assignment (0 = none).
    mapping(bytes32 => uint256) public assignmentOf;

    event ConfigUpdated(uint32 indexed version, Config config);
    event TreasurySet(address treasury);
    event ArbitratorSet(address arbitrator);
    event Assigned(
        uint256 indexed id,
        address indexed kernel,
        uint256 indexed kernelJobId,
        address client,
        address provider,
        address evaluator,
        uint256 budget,
        uint32 configVersion
    );
    /// @dev informational: the kernel job's `hook` at assign time (address(this) = hook-driven submission)
    event KernelHookObserved(uint256 indexed id, address indexed hook, bool hookIsAdapter);
    event AssignmentWithdrawn(uint256 indexed id);
    event AssignmentAccepted(uint256 indexed id, address indexed evaluator, uint256 slashBase);
    event SubmissionNoted(uint256 indexed id, uint64 submittedAt);
    event VerdictHeld(
        uint256 indexed id, address indexed evaluator, uint16 payoutBps, bool completes, bytes32 reasonHash
    );
    event VerdictTimedOut(uint256 indexed id, address indexed evaluator, uint256 slashed);
    event Challenged(
        uint256 indexed id,
        address indexed challenger,
        address indexed arbitrator,
        uint256 bond,
        uint256 arbFee,
        uint256 disputeId,
        bytes32 reasonHash
    );
    event Ruled(uint256 indexed id, uint16 verdictPayoutBps, uint16 rulingPayoutBps, bool overturned);
    event DisputeTimedOut(uint256 indexed id);
    event ChallengeBondDistributed(
        uint256 indexed id, address indexed challenger, uint256 toChallenger, uint256 toEvaluator, uint256 toTreasury
    );
    event ArbitrationFeeReimbursed(uint256 indexed id, address indexed challenger, uint256 amount);
    event Slashed(uint256 indexed id, address indexed evaluator, uint8 reason, uint256 amount);
    event KernelExecuted(uint256 indexed id, address indexed kernel, uint256 indexed kernelJobId, bool completed);
    event KernelCallFailed(uint256 indexed id, address indexed kernel, uint256 indexed kernelJobId, bool completed);
    event EvaluatorFeeForwarded(uint256 indexed id, address indexed evaluator, uint256 amount);
    event KernelJobEnded(uint256 indexed id, uint8 kernelStatus);
    /// @notice E-1c: the submission was observed when the kernel job had less time left than
    ///         eval + challenge + arbitrationTimeout + margin. Always paired with state ExpiryRefused
    ///         (no eval window, exposure released, no slash); the kernel's refund path applies.
    event ExpiryRisk(uint256 indexed id, uint256 expiredAt, uint256 requiredExpiredAt);
    event ArbitrationFeeEscrowed(
        uint256 indexed id, address indexed challenger, address indexed arbitrator, uint256 fee
    );
    event ArbitrationFeePaid(uint256 indexed id, address indexed arbitrator, uint256 fee);
    event ArbitrationFeeRefunded(uint256 indexed id, address indexed challenger, uint256 fee);

    error ZeroAddress();
    error InvalidConfig();
    error NotAdapterEvaluator();
    error AlreadyAssigned();
    error WrongKernelStatus(IERC8183.JobStatus status);
    error TokenMismatch();
    /// @dev assign() accepts only kernel jobs with hook == address(0) or hook == address(this)
    error ForeignHookNotAllowed(address hook);
    error ExpiryTooSoon(uint256 expiredAt, uint256 minExpiredAt);
    error EvaluatorNotActive(address evaluator);
    error InvalidParty();
    error JobNotFound(uint256 id);
    error WrongState(State current);
    error Unauthorized();
    error EvalWindowClosed();
    error EvalWindowOpen();
    error NotSubmitted();
    error ChallengeWindowClosed();
    error ChallengeWindowOpen();
    error ArbitrationTimeoutNotReached();
    error InvalidPayout();
    error NoArbitrator();

    constructor(
        IERC20 token_,
        IEvaluatorRegistry registry_,
        address treasury_,
        IArbitrator arbitrator_,
        Config memory config_,
        address owner_
    ) Ownable(owner_) {
        if (address(token_) == address(0) || address(registry_) == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        token = token_;
        registry = registry_;
        treasury = treasury_;
        arbitrator = arbitrator_;
        _setConfig(config_);
    }

    // ---------------- admin ----------------

    function acceptedToken() external view returns (address) {
        return address(token);
    }

    function setConfig(Config calldata c) external onlyOwner {
        _setConfig(c);
    }

    function setTreasury(address t) external onlyOwner {
        if (t == address(0)) revert ZeroAddress();
        treasury = t;
        emit TreasurySet(t);
    }

    function setArbitrator(IArbitrator a) external onlyOwner {
        arbitrator = a;
        emit ArbitratorSet(address(a));
    }

    function _setConfig(Config memory c) internal {
        if (
            c.evalWindow == 0 || c.challengeWindow == 0 || c.arbitrationTimeout == 0 || c.challengeBondBps > BPS
                || c.missedVerdictSlashBps > BPS || c.wrongVerdictSlashBps > BPS
                || c.failedChallengeEvaluatorShareBps > BPS || c.completeThresholdBps == 0
                || c.completeThresholdBps > BPS
        ) revert InvalidConfig();
        uint32 v = currentConfigVersion + 1;
        currentConfigVersion = v;
        _configs[v] = c;
        emit ConfigUpdated(v, c);
    }

    // ---------------- assignment ----------------

    /// @notice Kernel client names a staked evaluator for a kernel job whose evaluator is this adapter.
    ///         Kernel job must be Funded or Submitted, priced in `token`, and expire no sooner than
    ///         minKernelExpiry() (E-1a).
    function assign(address kernel, uint256 kernelJobId, address evaluator) external nonReentrant returns (uint256 id) {
        if (kernel == address(0) || evaluator == address(0)) revert ZeroAddress();
        bytes32 key = keccak256(abi.encode(kernel, kernelJobId));
        if (assignmentOf[key] != 0) revert AlreadyAssigned();
        IERC8183.Job memory kj = IERC8183(kernel).getJob(kernelJobId);
        if (kj.evaluator != address(this)) revert NotAdapterEvaluator();
        if (msg.sender != kj.client) revert Unauthorized();
        if (kj.status != IERC8183.JobStatus.Funded && kj.status != IERC8183.JobStatus.Submitted) {
            revert WrongKernelStatus(kj.status);
        }
        if (IERC8183(kernel).paymentToken() != address(token)) revert TokenMismatch();
        // a third-party hook can revert complete()/reject() and strand the verdict (kernel claimRefund only)
        if (kj.hook != address(0) && kj.hook != address(this)) revert ForeignHookNotAllowed(kj.hook);
        Config storage c = _configs[currentConfigVersion];
        uint256 minExpiry = block.timestamp + _requiredDuration(c);
        if (kj.expiredAt < minExpiry) revert ExpiryTooSoon(kj.expiredAt, minExpiry);
        if (evaluator == kj.client || evaluator == kj.provider) revert InvalidParty();
        if (!registry.isActive(evaluator)) revert EvaluatorNotActive(evaluator);

        id = ++jobCount;
        AdapterJob storage j = _jobs[id];
        j.kernel = kernel;
        j.kernelJobId = kernelJobId;
        j.client = kj.client;
        j.provider = kj.provider;
        j.evaluator = evaluator;
        j.configVersion = currentConfigVersion;
        j.state = State.Proposed;
        j.budget = kj.budget;
        assignmentOf[key] = id;
        emit Assigned(id, kernel, kernelJobId, kj.client, kj.provider, evaluator, kj.budget, j.configVersion);
        emit KernelHookObserved(id, kj.hook, kj.hook == address(this));
    }

    /// @notice Client withdraws an assignment the evaluator has not accepted (so another can be named).
    function withdrawAssignment(uint256 id) external nonReentrant {
        AdapterJob storage j = _job(id);
        if (msg.sender != j.client) revert Unauthorized();
        if (j.state != State.Proposed) revert WrongState(j.state);
        j.state = State.Withdrawn;
        delete assignmentOf[keccak256(abi.encode(j.kernel, j.kernelJobId))];
        emit AssignmentWithdrawn(id);
    }

    /// @notice Named evaluator opts in. Locks exposure and pins the slash base. Opt-in prevents a
    ///         fake kernel from attaching slashing liability to an evaluator who never agreed.
    function acceptAssignment(uint256 id) external nonReentrant {
        AdapterJob storage j = _job(id);
        if (msg.sender != j.evaluator) revert Unauthorized();
        if (j.state != State.Proposed) revert WrongState(j.state);
        IERC8183.Job memory kj = IERC8183(j.kernel).getJob(j.kernelJobId);
        if (kj.status != IERC8183.JobStatus.Funded && kj.status != IERC8183.JobStatus.Submitted) {
            revert WrongKernelStatus(kj.status);
        }
        // E-1a: re-check at opt-in (time passed since assign); refuses liability the kernel may not honour
        uint256 minExpiry = block.timestamp + _requiredDuration(_configs[j.configVersion]);
        if (kj.expiredAt < minExpiry) revert ExpiryTooSoon(kj.expiredAt, minExpiry);
        j.state = State.Active;
        j.slashBase = registry.minStake();
        registry.lockExposure(j.evaluator, id, j.budget);
        emit AssignmentAccepted(id, j.evaluator, j.slashBase);
        if (kj.status == IERC8183.JobStatus.Submitted) _noteSubmission(id, j, kj.expiredAt);
    }

    /// @notice Anyone: record that the kernel job is Submitted. Starts the eval window, or, if the
    ///         kernel job has too little time left (E-1c), moves the job to ExpiryRefused.
    ///         ERC-8183 kernels do not store a submission timestamp, so the window starts when
    ///         the adapter first observes Submitted (acceptAssignment, noteSubmission or verdict).
    function noteSubmission(uint256 id) external nonReentrant {
        AdapterJob storage j = _job(id);
        if (j.state != State.Active) revert WrongState(j.state);
        if (j.submittedAt != 0) return;
        IERC8183.Job memory kj = IERC8183(j.kernel).getJob(j.kernelJobId);
        if (kj.status != IERC8183.JobStatus.Submitted) revert NotSubmitted();
        _noteSubmission(id, j, kj.expiredAt);
    }

    // ---------------- ERC-8183 hook (IACPHook) ----------------

    /// @inheritdoc IACPHook
    function beforeAction(uint256, bytes4, bytes calldata) external pure {}

    /// @inheritdoc IACPHook
    /// @dev Only `submit` matters. Never reverts. `data` is not decoded (the EIP table and the reference
    ///      code encode it differently: the code prepends msg.sender).
    function afterAction(uint256 kernelJobId, bytes4 selector, bytes calldata) external {
        if (selector != ACPSelectors.SUBMIT) return;
        uint256 id = assignmentOf[keccak256(abi.encode(msg.sender, kernelJobId))];
        if (id == 0) return;
        try this.hookNoteSubmission(id) {} catch {}
    }

    /// @dev self-call only; lets afterAction swallow any failure (e.g. registry revert)
    function hookNoteSubmission(uint256 id) external nonReentrant {
        if (msg.sender != address(this)) revert Unauthorized();
        AdapterJob storage j = _job(id);
        if (j.state != State.Active || j.submittedAt != 0) return;
        IERC8183.Job memory kj = IERC8183(j.kernel).getJob(j.kernelJobId);
        if (kj.status != IERC8183.JobStatus.Submitted) return;
        _noteSubmission(id, j, kj.expiredAt);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IACPHook).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    /// @notice Anyone: close an accepted assignment whose kernel job is no longer Funded/Submitted
    ///         (e.g. the client called claimRefund after expiredAt, or the provider never submitted)
    ///         while the adapter never saw a submission. Releases the evaluator's exposure; no
    ///         slash, since no evaluation window ever started. Without this, exposure and openJobs
    ///         stayed locked forever and the evaluator could never withdraw (found by the adapter
    ///         invariant suite, see docs/SECURITY-NOTES.md).
    ///         E-1d: also closes a Proposed (never accepted) assignment on an ended kernel job; it
    ///         holds no exposure, so this only clears the assignment slot.
    function closeKernelEnded(uint256 id) external nonReentrant {
        AdapterJob storage j = _job(id);
        State st = j.state;
        if (st != State.Active && st != State.Proposed) revert WrongState(st);
        if (j.submittedAt != 0) revert WrongState(st);
        IERC8183.JobStatus ks = IERC8183(j.kernel).getJob(j.kernelJobId).status;
        if (ks == IERC8183.JobStatus.Funded || ks == IERC8183.JobStatus.Submitted) revert WrongKernelStatus(ks);
        j.state = State.KernelEnded;
        delete assignmentOf[keccak256(abi.encode(j.kernel, j.kernelJobId))];
        if (st == State.Active) registry.releaseExposure(j.evaluator, id, j.budget);
        emit KernelJobEnded(id, uint8(ks));
    }

    // ---------------- evaluator ----------------

    /// @notice Staked evaluator records a payout in bps. Held through the challenge window.
    function verdict(uint256 id, uint16 payoutBps, bytes32 reasonHash) external nonReentrant {
        AdapterJob storage j = _job(id);
        if (msg.sender != j.evaluator) revert Unauthorized();
        if (j.state != State.Active) revert WrongState(j.state);
        if (payoutBps > BPS) revert InvalidPayout();
        if (j.submittedAt == 0) {
            IERC8183.Job memory kj = IERC8183(j.kernel).getJob(j.kernelJobId);
            if (kj.status != IERC8183.JobStatus.Submitted) revert NotSubmitted();
            // E-1c: refused (state ExpiryRefused, persisted); the verdict is not recorded
            if (!_noteSubmission(id, j, kj.expiredAt)) return;
        }
        Config storage c = _configs[j.configVersion];
        if (block.timestamp > uint256(j.submittedAt) + c.evalWindow) revert EvalWindowClosed();
        j.state = State.Held;
        j.payoutBps = payoutBps;
        j.completes = payoutBps >= c.completeThresholdBps;
        j.reasonHash = reasonHash;
        j.verdictAt = uint64(block.timestamp);
        emit VerdictHeld(id, msg.sender, payoutBps, j.completes, reasonHash);
    }

    /// @notice Anyone, after evalWindow with no verdict: evaluator slashed (harmed party = provider,
    ///         as in JobEscrow E-12), kernel job rejected (client refunded by the kernel).
    function timeoutRelease(uint256 id) external nonReentrant {
        AdapterJob storage j = _job(id);
        if (j.state != State.Active) revert WrongState(j.state);
        if (j.submittedAt == 0) revert NotSubmitted();
        Config storage c = _configs[j.configVersion];
        if (block.timestamp <= uint256(j.submittedAt) + c.evalWindow) revert EvalWindowOpen();
        uint256 slashed = registry.slash(
            j.evaluator, id, (j.slashBase * c.missedVerdictSlashBps) / BPS, j.provider, SLASH_MISSED_VERDICT
        );
        emit Slashed(id, j.evaluator, SLASH_MISSED_VERDICT, slashed);
        emit VerdictTimedOut(id, j.evaluator, slashed);
        j.completes = false;
        j.payoutBps = 0;
        j.reasonHash = REASON_MISSED_VERDICT;
        _execute(id, j);
    }

    // ---------------- challenge / arbitration ----------------

    /// @notice Kernel client or provider challenges within challengeWindow. Pays challenge bond +
    ///         the arbitrator's quoted arbitrationCost; both are held here until a ruling
    ///         (loser pays, E-17; held fee, E-17a).
    function challenge(uint256 id, bytes32 reasonHash) external nonReentrant {
        AdapterJob storage j = _job(id);
        if (j.state != State.Held) revert WrongState(j.state);
        Config storage c = _configs[j.configVersion];
        if (block.timestamp > uint256(j.verdictAt) + c.challengeWindow) revert ChallengeWindowClosed();
        if (msg.sender != j.client && msg.sender != j.provider) revert Unauthorized();
        IArbitrator arb = arbitrator;
        if (address(arb) == address(0)) revert NoArbitrator();

        uint256 bond = challengeBond(j.configVersion, j.budget);
        uint256 fee = arb.arbitrationCost(id, j.budget);
        j.state = State.Disputed;
        j.disputedAt = uint64(block.timestamp);
        Dispute storage d = _disputes[id];
        d.challenger = msg.sender;
        d.arbitrator = address(arb);
        d.bond = bond;
        d.arbFee = fee;
        token.safeTransferFrom(msg.sender, address(this), bond + fee);
        if (fee > 0) emit ArbitrationFeeEscrowed(id, msg.sender, address(arb), fee);
        d.disputeId = arb.requestRuling(id, msg.sender, j.payoutBps, reasonHash);
        emit Challenged(id, msg.sender, address(arb), bond, fee, d.disputeId, reasonHash);
    }

    /// @inheritdoc IArbitrable
    /// @dev Overturned = the ruling's mapped binary outcome differs from the verdict's (the kernel
    ///      can only express that difference).
    function rule(uint256 id, uint16 payoutBps) external nonReentrant {
        AdapterJob storage j = _job(id);
        if (j.state != State.Disputed) revert WrongState(j.state);
        Dispute storage d = _disputes[id];
        if (msg.sender != d.arbitrator) revert Unauthorized();
        if (payoutBps > BPS) revert InvalidPayout();
        Config storage c = _configs[j.configVersion];
        bool rulingCompletes = payoutBps >= c.completeThresholdBps;
        bool overturned = rulingCompletes != j.completes;
        emit Ruled(id, j.payoutBps, payoutBps, overturned);

        if (overturned) {
            uint256 reimbursed = d.arbFee > 0 ? registry.reimburse(j.evaluator, id, d.arbFee, d.challenger) : 0;
            if (reimbursed > 0) emit ArbitrationFeeReimbursed(id, d.challenger, reimbursed);
            uint256 slashed = registry.slash(
                j.evaluator, id, (j.slashBase * c.wrongVerdictSlashBps) / BPS, d.challenger, SLASH_OVERTURNED_VERDICT
            );
            emit Slashed(id, j.evaluator, SLASH_OVERTURNED_VERDICT, slashed);
            _out(d.challenger, d.bond);
            emit ChallengeBondDistributed(id, d.challenger, d.bond, 0, 0);
        } else {
            uint256 toEval = (d.bond * c.failedChallengeEvaluatorShareBps) / BPS;
            _out(j.evaluator, toEval);
            _out(treasury, d.bond - toEval);
            emit ChallengeBondDistributed(id, d.challenger, 0, toEval, d.bond - toEval);
        }
        if (d.arbFee > 0) {
            _out(d.arbitrator, d.arbFee);
            emit ArbitrationFeePaid(id, d.arbitrator, d.arbFee);
        }
        j.payoutBps = payoutBps;
        j.completes = rulingCompletes;
        _execute(id, j);
    }

    /// @notice Anyone, if the arbitrator has not ruled within arbitrationTimeout: execute the held
    ///         verdict and return the challenge bond and the held arbitration cost (E-17a).
    function resolveStaleDispute(uint256 id) external nonReentrant {
        AdapterJob storage j = _job(id);
        if (j.state != State.Disputed) revert WrongState(j.state);
        Config storage c = _configs[j.configVersion];
        if (block.timestamp < uint256(j.disputedAt) + c.arbitrationTimeout) revert ArbitrationTimeoutNotReached();
        Dispute storage d = _disputes[id];
        emit DisputeTimedOut(id);
        _out(d.challenger, d.bond);
        emit ChallengeBondDistributed(id, d.challenger, d.bond, 0, 0);
        if (d.arbFee > 0) {
            _out(d.challenger, d.arbFee);
            emit ArbitrationFeeRefunded(id, d.challenger, d.arbFee);
        }
        _execute(id, j);
    }

    /// @notice Anyone, after challengeWindow with no challenge: call complete()/reject() on the kernel.
    function finalize(uint256 id) external nonReentrant {
        AdapterJob storage j = _job(id);
        if (j.state != State.Held) revert WrongState(j.state);
        Config storage c = _configs[j.configVersion];
        if (block.timestamp <= uint256(j.verdictAt) + c.challengeWindow) revert ChallengeWindowOpen();
        _execute(id, j);
    }

    // ---------------- views ----------------

    function getJob(uint256 id) external view returns (AdapterJob memory) {
        return _jobs[id];
    }

    function getDispute(uint256 id) external view returns (Dispute memory) {
        return _disputes[id];
    }

    function config(uint32 version) external view returns (Config memory) {
        return _configs[version];
    }

    function currentConfig() external view returns (Config memory) {
        return _configs[currentConfigVersion];
    }

    function challengeBond(uint32 version, uint256 budget) public view returns (uint256 bond) {
        Config storage c = _configs[version];
        bond = (budget * c.challengeBondBps) / BPS;
        if (bond < c.minChallengeBond) bond = c.minChallengeBond;
    }

    /// @notice Seconds a kernel job must still have before expiredAt when the adapter takes it on:
    ///         evalWindow + challengeWindow + arbitrationTimeout + expiryMargin (E-1a).
    function requiredExpiryDuration(uint32 version) public view returns (uint256) {
        return _requiredDuration(_configs[version]);
    }

    /// @notice Earliest kernel expiredAt that assign() accepts right now (current config).
    function minKernelExpiry() public view returns (uint256) {
        return block.timestamp + _requiredDuration(_configs[currentConfigVersion]);
    }

    /// @notice Price and timing facts for a prospective adapter job under the current config.
    /// @return challengeBond_ bond to challenge a verdict on a job with this budget
    /// @return arbitrationCost_ arbitrator quote the challenger pays with the bond (0 if none)
    /// @return requiredExpiry_ minimum kernel expiredAt - now, in seconds
    /// @return minKernelExpiry_ earliest kernel expiredAt accepted at this block
    /// @return configVersion config version a new assignment would pin
    function quote(uint256 budget)
        external
        view
        returns (
            uint256 challengeBond_,
            uint256 arbitrationCost_,
            uint256 requiredExpiry_,
            uint256 minKernelExpiry_,
            uint32 configVersion
        )
    {
        configVersion = currentConfigVersion;
        challengeBond_ = challengeBond(configVersion, budget);
        if (address(arbitrator) != address(0)) arbitrationCost_ = arbitrator.arbitrationCost(0, budget);
        requiredExpiry_ = _requiredDuration(_configs[configVersion]);
        minKernelExpiry_ = block.timestamp + requiredExpiry_;
    }

    /// @notice The kernel action a payout would map to under a config version.
    function mapsToComplete(uint32 version, uint16 payoutBps) external view returns (bool) {
        return payoutBps >= _configs[version].completeThresholdBps;
    }

    // ---------------- internals ----------------

    function _job(uint256 id) internal view returns (AdapterJob storage j) {
        j = _jobs[id];
        if (j.state == State.None) revert JobNotFound(id);
    }

    function _requiredDuration(Config storage c) internal view returns (uint256) {
        return uint256(c.evalWindow) + c.challengeWindow + c.arbitrationTimeout + c.expiryMargin;
    }

    /// @return started true if the eval window started; false if refused (E-1c)
    function _noteSubmission(uint256 id, AdapterJob storage j, uint256 expiredAt) internal returns (bool started) {
        uint256 required = block.timestamp + _requiredDuration(_configs[j.configVersion]);
        if (expiredAt < required) {
            j.state = State.ExpiryRefused;
            delete assignmentOf[keccak256(abi.encode(j.kernel, j.kernelJobId))];
            registry.releaseExposure(j.evaluator, id, j.budget);
            emit ExpiryRisk(id, expiredAt, required);
            return false;
        }
        j.submittedAt = uint64(block.timestamp);
        emit SubmissionNoted(id, j.submittedAt);
        return true;
    }

    /// @dev State is final before the external kernel call. A reverting kernel (e.g. already
    ///      Expired via claimRefund) does not block release of the evaluator's exposure.
    function _execute(uint256 id, AdapterJob storage j) internal {
        bool completes = j.completes;
        j.state = State.Executed;
        registry.releaseExposure(j.evaluator, id, j.budget);
        uint256 before = token.balanceOf(address(this));
        bool ok;
        if (completes) {
            try IERC8183(j.kernel).complete(j.kernelJobId, j.reasonHash, "") {
                ok = true;
            } catch {}
        } else {
            try IERC8183(j.kernel).reject(j.kernelJobId, j.reasonHash, "") {
                ok = true;
            } catch {}
        }
        if (ok) {
            emit KernelExecuted(id, j.kernel, j.kernelJobId, completes);
            // Kernels like the ERC-8183 reference pay an evaluator fee to job.evaluator (this
            // adapter). Forward whatever arrived during the call to the staked evaluator.
            uint256 afterBal = token.balanceOf(address(this));
            if (afterBal > before) {
                uint256 fee = afterBal - before;
                token.safeTransfer(j.evaluator, fee);
                emit EvaluatorFeeForwarded(id, j.evaluator, fee);
            }
        } else {
            j.state = State.KernelCallFailed;
            emit KernelCallFailed(id, j.kernel, j.kernelJobId, completes);
        }
    }

    function _out(address to, uint256 amount) internal {
        if (amount > 0) token.safeTransfer(to, amount);
    }
}
