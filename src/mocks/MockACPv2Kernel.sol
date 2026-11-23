// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import {IERC8183} from "../interfaces/IERC8183.sol";
import {IACPHook} from "../interfaces/IACPHook.sol";

/// @title MockACPv2Kernel
/// @notice TEST ONLY. Hooked ERC-8183 kernel modelled on the reference `AgenticCommerce` in the
///         ERC-8183 draft (ethereum/ERCs ERCS/erc-8183.md @ a078cab, 2026-03-13), i.e. the
///         contract Virtuals ACP v2 documents as its ERC-8183 implementation:
///         - hook whitelist + ERC-165 IACPHook check at createJob
///         - beforeAction/afterAction around setProvider(not here)/setBudget/fund/submit/complete/reject;
///           claimRefund is NOT hookable
///         - hook `data` = abi.encode(msg.sender, <params>, optParams) exactly as the reference CODE does
///           (the EIP's data table omits msg.sender: documented discrepancy)
///         - setBudget by provider only; fund(jobId, optParams) as in the reference code. The EIP text
///           says fund(jobId, expectedBudget, optParams); both overloads exist here
///         - platform fee + evaluator fee on complete; evaluator fee goes to job.evaluator
///         - optional gas cap on hook calls (spec: SHOULD) via hookGasLimit (0 = unlimited)
contract MockACPv2Kernel is IERC8183, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// fund hook selector: reference-code fund(uint256,bytes) for both overloads
    bytes4 internal constant FUND_SEL = bytes4(keccak256("fund(uint256,bytes)"));
    IERC20 internal immutable _token;
    address public immutable admin;
    uint256 public platformFeeBP;
    address public platformTreasury;
    uint256 public evaluatorFeeBP;
    uint256 public jobCounter;
    uint256 public hookGasLimit;
    mapping(uint256 => Job) public jobs;
    mapping(address => bool) public whitelistedHooks;

    event JobCreated(
        uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt, address hook
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
    error ProviderNotSet();
    error HookNotWhitelisted();
    error InvalidHook();
    error BudgetMismatch();

    constructor(IERC20 token_, address treasury_, uint256 platformFeeBP_, uint256 evaluatorFeeBP_) {
        if (address(token_) == address(0) || treasury_ == address(0)) revert ZeroAddress();
        _token = token_;
        admin = msg.sender;
        platformTreasury = treasury_;
        platformFeeBP = platformFeeBP_;
        evaluatorFeeBP = evaluatorFeeBP_;
        whitelistedHooks[address(0)] = true;
    }

    function paymentToken() external view returns (address) {
        return address(_token);
    }

    function setHookWhitelist(address hook, bool status) external {
        if (msg.sender != admin) revert Unauthorized();
        whitelistedHooks[hook] = status;
    }

    function setHookGasLimit(uint256 g) external {
        if (msg.sender != admin) revert Unauthorized();
        hookGasLimit = g;
    }

    function _before(address hook, uint256 jobId, bytes4 sel, bytes memory data) internal {
        if (hook == address(0)) return;
        if (hookGasLimit == 0) IACPHook(hook).beforeAction(jobId, sel, data);
        else IACPHook(hook).beforeAction{gas: hookGasLimit}(jobId, sel, data);
    }

    function _after(address hook, uint256 jobId, bytes4 sel, bytes memory data) internal {
        if (hook == address(0)) return;
        if (hookGasLimit == 0) IACPHook(hook).afterAction(jobId, sel, data);
        else IACPHook(hook).afterAction{gas: hookGasLimit}(jobId, sel, data);
    }

    function createJob(address provider, address evaluator, uint256 expiredAt, string calldata description, address hook)
        external
        nonReentrant
        returns (uint256 jobId)
    {
        if (evaluator == address(0)) revert ZeroAddress();
        if (expiredAt <= block.timestamp + 5 minutes) revert ExpiryTooShort();
        if (!whitelistedHooks[hook]) revert HookNotWhitelisted();
        if (hook != address(0) && !ERC165Checker.supportsInterface(hook, type(IACPHook).interfaceId)) revert InvalidHook();
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
            hook: hook
        });
        emit JobCreated(jobId, msg.sender, provider, evaluator, expiredAt, hook);
        _after(hook, jobId, msg.sig, abi.encode(msg.sender, provider, evaluator));
    }

    function setProvider(uint256 jobId, address provider_) external {
        Job storage job = _get(jobId);
        if (job.status != JobStatus.Open) revert WrongStatus();
        if (msg.sender != job.client) revert Unauthorized();
        if (job.provider != address(0)) revert WrongStatus();
        if (provider_ == address(0)) revert ZeroAddress();
        job.provider = provider_;
        emit ProviderSet(jobId, provider_);
    }

    function setBudget(uint256 jobId, uint256 amount, bytes calldata optParams) external nonReentrant {
        Job storage job = _get(jobId);
        if (job.status != JobStatus.Open) revert WrongStatus();
        if (msg.sender != job.provider) revert Unauthorized();
        bytes memory data = abi.encode(msg.sender, amount, optParams);
        _before(job.hook, jobId, msg.sig, data);
        job.budget = amount;
        emit BudgetSet(jobId, amount);
        _after(job.hook, jobId, msg.sig, data);
    }

    /// @dev reference-code signature
    function fund(uint256 jobId, bytes calldata optParams) external nonReentrant {
        _fund(jobId, optParams);
    }

    /// @dev EIP-text signature (front-running protection)
    function fund(uint256 jobId, uint256 expectedBudget, bytes calldata optParams) external nonReentrant {
        if (_get(jobId).budget != expectedBudget) revert BudgetMismatch();
        _fund(jobId, optParams);
    }

    function _fund(uint256 jobId, bytes calldata optParams) internal {
        Job storage job = _get(jobId);
        if (job.status != JobStatus.Open) revert WrongStatus();
        if (msg.sender != job.client) revert Unauthorized();
        if (job.provider == address(0)) revert ProviderNotSet();
        if (block.timestamp >= job.expiredAt) revert WrongStatus();
        bytes memory data = abi.encode(msg.sender, optParams);
        _before(job.hook, jobId, FUND_SEL, data);
        job.status = JobStatus.Funded;
        if (job.budget > 0) _token.safeTransferFrom(job.client, address(this), job.budget);
        emit JobFunded(jobId, job.client, job.budget);
        _after(job.hook, jobId, FUND_SEL, data);
    }

    function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external nonReentrant {
        Job storage job = _get(jobId);
        if (job.status != JobStatus.Funded) revert WrongStatus();
        if (msg.sender != job.provider) revert Unauthorized();
        bytes memory data = abi.encode(msg.sender, deliverable, optParams);
        _before(job.hook, jobId, msg.sig, data);
        job.status = JobStatus.Submitted;
        emit JobSubmitted(jobId, job.provider, deliverable);
        _after(job.hook, jobId, msg.sig, data);
    }

    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external nonReentrant {
        Job storage job = _get(jobId);
        if (job.status != JobStatus.Submitted) revert WrongStatus();
        if (msg.sender != job.evaluator) revert Unauthorized();
        bytes memory data = abi.encode(msg.sender, reason, optParams);
        _before(job.hook, jobId, msg.sig, data);
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
        _after(job.hook, jobId, msg.sig, data);
    }

    function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external nonReentrant {
        Job storage job = _get(jobId);
        if (job.status == JobStatus.Open) {
            if (msg.sender != job.client) revert Unauthorized();
        } else if (job.status == JobStatus.Funded || job.status == JobStatus.Submitted) {
            if (msg.sender != job.evaluator) revert Unauthorized();
        } else {
            revert WrongStatus();
        }
        bytes memory data = abi.encode(msg.sender, reason, optParams);
        _before(job.hook, jobId, msg.sig, data);
        JobStatus prev = job.status;
        job.status = JobStatus.Rejected;
        if ((prev == JobStatus.Funded || prev == JobStatus.Submitted) && job.budget > 0) {
            _token.safeTransfer(job.client, job.budget);
            emit Refunded(jobId, job.client, job.budget);
        }
        emit JobRejected(jobId, msg.sender, reason);
        _after(job.hook, jobId, msg.sig, data);
    }

    /// @dev NOT hookable (spec: permissionless safety mechanism)
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
