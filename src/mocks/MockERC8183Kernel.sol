// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC8183} from "../interfaces/IERC8183.sol";

/// @title MockERC8183Kernel
/// @notice TEST ONLY. Minimal non-hooked ERC-8183 kernel ("external kernel" for adapter tests),
///         modelled on the reference `AgenticCommerce` in ERC-8183: same function names, job
///         struct, statuses, events and fee split (platform fee + evaluator fee). Not upgradeable,
///         no hooks (hook MUST be address(0), which the spec calls fully compliant), no ERC-2771.
///         fund() takes `expectedBudget` per the normative text of the spec.
contract MockERC8183Kernel is IERC8183, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 internal immutable _token;
    address public immutable admin;
    uint256 public platformFeeBP;
    address public platformTreasury;
    uint256 public evaluatorFeeBP;
    uint256 public jobCounter;
    mapping(uint256 => Job) public jobs;

    event JobCreated(
        uint256 indexed jobId,
        address indexed client,
        address indexed provider,
        address evaluator,
        uint256 expiredAt,
        address hook
    );
    event ProviderSet(uint256 indexed jobId, address indexed provider);
    event BudgetSet(uint256 indexed jobId, uint256 amount);
    event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable);
    event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason);
    event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason);
    event JobExpired(uint256 indexed jobId);
    event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount);
    event EvaluatorFeePaid(uint256 indexed jobId, address indexed evaluator, uint256 amount);
    event Refunded(uint256 indexed jobId, address indexed client, uint256 amount);

    error InvalidJob();
    error WrongStatus();
    error Unauthorized();
    error ZeroAddress();
    error ExpiryTooShort();
    error ZeroBudget();
    error ProviderNotSet();
    error FeesTooHigh();
    error HookNotSupported();
    error BudgetMismatch();

    constructor(IERC20 token_, address treasury_, uint256 platformFeeBP_, uint256 evaluatorFeeBP_) {
        if (address(token_) == address(0) || treasury_ == address(0)) revert ZeroAddress();
        if (platformFeeBP_ + evaluatorFeeBP_ > 10000) revert FeesTooHigh();
        _token = token_;
        admin = msg.sender;
        platformTreasury = treasury_;
        platformFeeBP = platformFeeBP_;
        evaluatorFeeBP = evaluatorFeeBP_;
    }

    function paymentToken() external view returns (address) {
        return address(_token);
    }

    function createJob(
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook
    ) external nonReentrant returns (uint256 jobId) {
        if (evaluator == address(0)) revert ZeroAddress();
        if (expiredAt <= block.timestamp + 5 minutes) revert ExpiryTooShort();
        if (hook != address(0)) revert HookNotSupported();
        jobId = ++jobCounter;
        jobs[jobId] = Job({
            id: jobId,
            client: msg.sender,
            provider: provider,
            evaluator: evaluator,
            description: description,
            budget: 0,
            expiredAt: expiredAt,
            status: JobStatus.Open,
            hook: address(0)
        });
        emit JobCreated(jobId, msg.sender, provider, evaluator, expiredAt, address(0));
    }

    function setProvider(uint256 jobId, address provider_, bytes calldata) external {
        Job storage job = _get(jobId);
        if (job.status != JobStatus.Open) revert WrongStatus();
        if (msg.sender != job.client) revert Unauthorized();
        if (job.provider != address(0)) revert WrongStatus();
        if (provider_ == address(0)) revert ZeroAddress();
        job.provider = provider_;
        emit ProviderSet(jobId, provider_);
    }

    function setBudget(uint256 jobId, uint256 amount, bytes calldata) external nonReentrant {
        Job storage job = _get(jobId);
        if (job.status != JobStatus.Open) revert WrongStatus();
        if (msg.sender != job.client && msg.sender != job.provider) revert Unauthorized();
        job.budget = amount;
        emit BudgetSet(jobId, amount);
    }

    function fund(uint256 jobId, uint256 expectedBudget, bytes calldata) external nonReentrant {
        Job storage job = _get(jobId);
        if (job.status != JobStatus.Open) revert WrongStatus();
        if (msg.sender != job.client) revert Unauthorized();
        if (job.budget == 0) revert ZeroBudget();
        if (job.provider == address(0)) revert ProviderNotSet();
        if (job.budget != expectedBudget) revert BudgetMismatch();
        if (block.timestamp >= job.expiredAt) revert WrongStatus();
        job.status = JobStatus.Funded;
        _token.safeTransferFrom(job.client, address(this), job.budget);
        emit JobFunded(jobId, job.client, job.budget);
    }

    function submit(uint256 jobId, bytes32 deliverable, bytes calldata) external nonReentrant {
        Job storage job = _get(jobId);
        if (job.status != JobStatus.Funded) revert WrongStatus();
        if (msg.sender != job.provider) revert Unauthorized();
        job.status = JobStatus.Submitted;
        emit JobSubmitted(jobId, job.provider, deliverable);
    }

    function complete(uint256 jobId, bytes32 reason, bytes calldata) external nonReentrant {
        Job storage job = _get(jobId);
        if (job.status != JobStatus.Submitted) revert WrongStatus();
        if (msg.sender != job.evaluator) revert Unauthorized();
        job.status = JobStatus.Completed;
        uint256 amount = job.budget;
        uint256 platformFee = (amount * platformFeeBP) / 10000;
        uint256 evalFee = (amount * evaluatorFeeBP) / 10000;
        uint256 net = amount - platformFee - evalFee;
        if (platformFee > 0) _token.safeTransfer(platformTreasury, platformFee);
        if (evalFee > 0) {
            _token.safeTransfer(job.evaluator, evalFee);
            emit EvaluatorFeePaid(jobId, job.evaluator, evalFee);
        }
        if (net > 0) _token.safeTransfer(job.provider, net);
        emit JobCompleted(jobId, job.evaluator, reason);
        emit PaymentReleased(jobId, job.provider, net);
    }

    function reject(uint256 jobId, bytes32 reason, bytes calldata) external nonReentrant {
        Job storage job = _get(jobId);
        if (job.status == JobStatus.Open) {
            if (msg.sender != job.client) revert Unauthorized();
        } else if (job.status == JobStatus.Funded || job.status == JobStatus.Submitted) {
            if (msg.sender != job.evaluator) revert Unauthorized();
        } else {
            revert WrongStatus();
        }
        JobStatus prev = job.status;
        job.status = JobStatus.Rejected;
        if ((prev == JobStatus.Funded || prev == JobStatus.Submitted) && job.budget > 0) {
            _token.safeTransfer(job.client, job.budget);
            emit Refunded(jobId, job.client, job.budget);
        }
        emit JobRejected(jobId, msg.sender, reason);
    }

    function claimRefund(uint256 jobId) external nonReentrant {
        Job storage job = _get(jobId);
        if (job.status != JobStatus.Funded && job.status != JobStatus.Submitted) revert WrongStatus();
        if (block.timestamp < job.expiredAt) revert WrongStatus();
        job.status = JobStatus.Expired;
        if (job.budget > 0) {
            _token.safeTransfer(job.client, job.budget);
            emit Refunded(jobId, job.client, job.budget);
        }
        emit JobExpired(jobId);
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return jobs[jobId];
    }

    function _get(uint256 jobId) internal view returns (Job storage job) {
        job = jobs[jobId];
        if (job.id == 0) revert InvalidJob();
    }
}
