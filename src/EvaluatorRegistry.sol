// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IEvaluatorRegistry} from "./interfaces/IEvaluatorRegistry.sol";

/// @title EvaluatorRegistry
/// @notice Evaluators stake the payment token (mUSDC locally, USDC in production) to be nameable
///         on jobs. Stake caps concurrent exposure and is slashable by authorised escrow contracts.
/// @dev Spec: specs/SPEC-v0.md section 3. Assumptions: docs/ASSUMPTIONS.md (R-*).
contract EvaluatorRegistry is IEvaluatorRegistry, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 internal constant BPS = 10_000;

    uint8 public constant SLASH_MISSED_VERDICT = 1;
    uint8 public constant SLASH_OVERTURNED_VERDICT = 2;

    struct Config {
        uint256 minStake; // token units (6 decimals). default 100e6
        uint64 unbondingPeriod; // seconds. default 7 days
        uint32 exposureMultiplier; // sum of open job amounts <= stake * multiplier. default 5
        uint16 slashHarmedShareBps; // share of each slash paid to the harmed party. default 5000
        address treasury; // receives the remainder of each slash
    }

    struct PendingSlasher {
        bool allowed;
        uint64 eta;
    }

    struct Evaluator {
        uint256 stake;
        uint256 exposure; // sum of amounts of open jobs naming this evaluator
        uint32 openJobs;
        uint64 unbondingEndsAt; // 0 = not unbonding
        uint256 slashedTotal;
    }

    IERC20 public immutable token;
    /// @notice Delay between proposing and executing a slasher change (R-5). Fixed at deploy so
    ///         the owner cannot shorten it later. default 48h.
    uint64 public immutable slasherTimelock;
    Config internal _config;
    /// @notice Pending slasher changes: slasher => (allowed, executable-at). eta 0 = none.
    mapping(address => PendingSlasher) public pendingSlasher;
    mapping(address => bool) public isSlasher;
    mapping(address => Evaluator) internal _evaluators;

    // ---- events ----
    event ConfigUpdated(
        uint256 minStake,
        uint64 unbondingPeriod,
        uint32 exposureMultiplier,
        uint16 slashHarmedShareBps,
        address treasury
    );
    event SlasherSet(address indexed slasher, bool allowed);
    event SlasherChangeProposed(address indexed slasher, bool allowed, uint64 eta);
    event SlasherChangeCancelled(address indexed slasher);
    event Reimbursed(
        address indexed evaluator, uint256 indexed jobId, address indexed to, uint256 amount, address slasher
    );
    event Staked(address indexed evaluator, uint256 amount, uint256 newStake);
    event UnstakeRequested(address indexed evaluator, uint64 unbondingEndsAt);
    event Withdrawn(address indexed evaluator, uint256 amount);
    event ExposureLocked(address indexed evaluator, uint256 indexed jobId, uint256 amount, uint256 totalExposure);
    event ExposureReleased(address indexed evaluator, uint256 indexed jobId, uint256 amount, uint256 totalExposure);
    event Slashed(
        address indexed evaluator,
        uint256 indexed jobId,
        uint8 indexed reason,
        uint256 amount,
        address harmedParty,
        uint256 toHarmedParty,
        uint256 toTreasury,
        address slasher
    );

    // ---- errors ----
    error ZeroAmount();
    error ZeroAddress();
    error InvalidConfig();
    error BelowMinStake(uint256 newStake, uint256 minStake);
    error AlreadyUnbonding();
    error NotUnbonding();
    error UnbondingNotElapsed(uint64 unbondingEndsAt);
    error HasOpenJobs(uint32 openJobs);
    error NotSlasher();
    error EvaluatorNotActive(address evaluator);
    error ExposureCapExceeded(uint256 requested, uint256 available);
    error NoPendingChange();
    error TimelockNotElapsed(uint64 eta);

    modifier onlySlasher() {
        if (!isSlasher[msg.sender]) revert NotSlasher();
        _;
    }

    /// @param initialSlashers Slashers authorised at deploy (R-5). Further changes only via
    ///        proposeSlasher/executeSlasher after `slasherTimelock_` seconds.
    constructor(
        IERC20 token_,
        Config memory config_,
        address owner_,
        address[] memory initialSlashers,
        uint64 slasherTimelock_
    ) Ownable(owner_) {
        if (address(token_) == address(0)) revert ZeroAddress();
        token = token_;
        slasherTimelock = slasherTimelock_;
        _setConfig(config_);
        for (uint256 i = 0; i < initialSlashers.length; i++) {
            if (initialSlashers[i] == address(0)) revert ZeroAddress();
            isSlasher[initialSlashers[i]] = true;
            emit SlasherSet(initialSlashers[i], true);
        }
    }

    // ---------------- admin ----------------

    function setConfig(Config calldata config_) external onlyOwner {
        _setConfig(config_);
    }

    /// @notice Queue adding (allowed = true) or removing (false) a slasher. Both directions are
    ///         timelocked: removal would freeze timeouts/slashes of open jobs in that slasher.
    function proposeSlasher(address slasher, bool allowed) external onlyOwner {
        if (slasher == address(0)) revert ZeroAddress();
        uint64 eta = uint64(block.timestamp) + slasherTimelock;
        pendingSlasher[slasher] = PendingSlasher(allowed, eta);
        emit SlasherChangeProposed(slasher, allowed, eta);
    }

    function cancelSlasher(address slasher) external onlyOwner {
        if (pendingSlasher[slasher].eta == 0) revert NoPendingChange();
        delete pendingSlasher[slasher];
        emit SlasherChangeCancelled(slasher);
    }

    /// @notice Anyone, once the timelock elapsed: apply a queued slasher change.
    function executeSlasher(address slasher) external {
        PendingSlasher memory p = pendingSlasher[slasher];
        if (p.eta == 0) revert NoPendingChange();
        if (block.timestamp < p.eta) revert TimelockNotElapsed(p.eta);
        delete pendingSlasher[slasher];
        isSlasher[slasher] = p.allowed;
        emit SlasherSet(slasher, p.allowed);
    }

    function _setConfig(Config memory c) internal {
        if (c.minStake == 0 || c.exposureMultiplier == 0 || c.slashHarmedShareBps > BPS || c.treasury == address(0)) {
            revert InvalidConfig();
        }
        _config = c;
        emit ConfigUpdated(c.minStake, c.unbondingPeriod, c.exposureMultiplier, c.slashHarmedShareBps, c.treasury);
    }

    // ---------------- evaluator actions ----------------

    /// @notice Add stake. Resulting stake must be >= minStake. Not allowed while unbonding.
    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Evaluator storage e = _evaluators[msg.sender];
        if (e.unbondingEndsAt != 0) revert AlreadyUnbonding();
        uint256 newStake = e.stake + amount;
        if (newStake < _config.minStake) revert BelowMinStake(newStake, _config.minStake);
        e.stake = newStake;
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount, newStake);
    }

    /// @notice Start unbonding. The evaluator immediately stops being assignable to new jobs but
    ///         remains slashable for open jobs and until withdraw().
    function requestUnstake() external {
        Evaluator storage e = _evaluators[msg.sender];
        if (e.stake == 0) revert ZeroAmount();
        if (e.unbondingEndsAt != 0) revert AlreadyUnbonding();
        uint64 endsAt = uint64(block.timestamp) + _config.unbondingPeriod;
        e.unbondingEndsAt = endsAt;
        emit UnstakeRequested(msg.sender, endsAt);
    }

    /// @notice Withdraw full remaining stake after the unbonding period, once no jobs are open.
    function withdraw() external nonReentrant {
        Evaluator storage e = _evaluators[msg.sender];
        if (e.unbondingEndsAt == 0) revert NotUnbonding();
        if (block.timestamp < e.unbondingEndsAt) revert UnbondingNotElapsed(e.unbondingEndsAt);
        if (e.openJobs != 0) revert HasOpenJobs(e.openJobs);
        uint256 amount = e.stake;
        e.stake = 0;
        e.unbondingEndsAt = 0;
        if (amount > 0) token.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ---------------- escrow hooks ----------------

    function lockExposure(address evaluator, uint256 jobId, uint256 amount) external onlySlasher {
        if (!isActive(evaluator)) revert EvaluatorNotActive(evaluator);
        Evaluator storage e = _evaluators[evaluator];
        uint256 cap = e.stake * _config.exposureMultiplier;
        uint256 available = cap > e.exposure ? cap - e.exposure : 0;
        if (amount > available) revert ExposureCapExceeded(amount, available);
        e.exposure += amount;
        e.openJobs += 1;
        emit ExposureLocked(evaluator, jobId, amount, e.exposure);
    }

    function releaseExposure(address evaluator, uint256 jobId, uint256 amount) external onlySlasher {
        Evaluator storage e = _evaluators[evaluator];
        e.exposure = amount > e.exposure ? 0 : e.exposure - amount;
        if (e.openJobs > 0) e.openJobs -= 1;
        emit ExposureReleased(evaluator, jobId, amount, e.exposure);
    }

    function slash(address evaluator, uint256 jobId, uint256 amount, address harmedParty, uint8 reason)
        external
        nonReentrant
        onlySlasher
        returns (uint256 slashed)
    {
        Evaluator storage e = _evaluators[evaluator];
        slashed = amount > e.stake ? e.stake : amount;
        if (slashed == 0) return 0;
        e.stake -= slashed;
        e.slashedTotal += slashed;
        uint256 toHarmed = harmedParty == address(0) ? 0 : (slashed * _config.slashHarmedShareBps) / BPS;
        uint256 toTreasury = slashed - toHarmed;
        if (toHarmed > 0) token.safeTransfer(harmedParty, toHarmed);
        if (toTreasury > 0) token.safeTransfer(_config.treasury, toTreasury);
        emit Slashed(evaluator, jobId, reason, slashed, harmedParty, toHarmed, toTreasury, msg.sender);
    }

    /// @notice Pay up to `amount` of stake 100% to `to` (arbitration-fee reimbursement, E-17).
    function reimburse(address evaluator, uint256 jobId, uint256 amount, address to)
        external
        nonReentrant
        onlySlasher
        returns (uint256 paid)
    {
        if (to == address(0)) revert ZeroAddress();
        Evaluator storage e = _evaluators[evaluator];
        paid = amount > e.stake ? e.stake : amount;
        if (paid == 0) return 0;
        e.stake -= paid;
        e.slashedTotal += paid;
        token.safeTransfer(to, paid);
        emit Reimbursed(evaluator, jobId, to, paid, msg.sender);
    }

    // ---------------- views ----------------

    function config() external view returns (Config memory) {
        return _config;
    }

    function minStake() external view returns (uint256) {
        return _config.minStake;
    }

    function stakeOf(address evaluator) external view returns (uint256) {
        return _evaluators[evaluator].stake;
    }

    function evaluatorInfo(address evaluator) external view returns (Evaluator memory) {
        return _evaluators[evaluator];
    }

    /// @notice True if stake >= minStake and not unbonding.
    function isActive(address evaluator) public view returns (bool) {
        Evaluator storage e = _evaluators[evaluator];
        return e.unbondingEndsAt == 0 && e.stake >= _config.minStake;
    }

    function availableExposure(address evaluator) external view returns (uint256) {
        Evaluator storage e = _evaluators[evaluator];
        uint256 cap = e.stake * _config.exposureMultiplier;
        return cap > e.exposure ? cap - e.exposure : 0;
    }
}
