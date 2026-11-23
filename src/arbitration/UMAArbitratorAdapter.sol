// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IArbitrator, IArbitrable} from "../interfaces/IArbitrator.sol";
import {IOptimisticOracleV3, IOptimisticOracleV3CallbackRecipient} from "./IExternalArbitration.sol";

/// @title UMAArbitratorAdapter (STUB, v0.3)
/// @notice Bridges AgentCoin IArbitrator to the UMA Optimistic Oracle V3. Tested against mocks only;
///         not deployed to any network.
/// @dev Flow: requestRuling records the dispute. Anyone proposes a ruling with proposeRuling(id, bps),
///      posting the OOv3 bond in `currency` (pulled from the proposer); the adapter asserts the claim
///      "AgentCoin dispute <id> of <arbitrable> job <jobId>: payoutBps = <bps>" with itself as callback
///      recipient. If the assertion resolves true (undisputed through liveness, or upheld by the DVM)
///      the ruling is forwarded to the arbitrable once. If it resolves false, the proposal is cleared
///      and a new one can be made. One live proposal per dispute. Bonds and DVM fees are UMA's;
///      the adapter holds no bond after assertTruth. tokenFee is what arbitrables pay in rule()
///      (withdrawable by owner; may be 0).
contract UMAArbitratorAdapter is IArbitrator, IOptimisticOracleV3CallbackRecipient, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Request {
        address arbitrable;
        uint256 jobId;
        address challenger;
        uint16 verdictPayoutBps;
        bytes32 pendingAssertion;
        uint16 pendingBps;
        bool ruled;
    }

    IOptimisticOracleV3 public immutable oracle;
    IERC20 public immutable currency;
    address public immutable owner;
    uint64 public liveness;
    uint256 public tokenFee;
    uint256 public disputeCount;
    mapping(address => bool) public isArbitrable;
    mapping(uint256 => Request) public requests;
    mapping(bytes32 => uint256) public disputeOfAssertion;

    event ArbitrableSet(address indexed arbitrable, bool allowed);
    event DisputeRecorded(uint256 indexed disputeId, address indexed arbitrable, uint256 jobId, address challenger);
    event RulingProposed(uint256 indexed disputeId, bytes32 indexed assertionId, address proposer, uint16 payoutBps);
    event ProposalRejected(uint256 indexed disputeId, bytes32 indexed assertionId);
    event RulingForwarded(uint256 indexed disputeId, bytes32 indexed assertionId, uint16 payoutBps);
    event LivenessSet(uint64 liveness);
    event TokenFeeSet(uint256 fee);

    error NotOwner();
    error NotArbitrable();
    error NotOracle();
    error UnknownDispute();
    error AlreadyRuled();
    error ProposalPending(bytes32 assertionId);
    error InvalidPayout();
    error ZeroAddress();

    constructor(IOptimisticOracleV3 oracle_, IERC20 currency_, address owner_, uint64 liveness_, uint256 tokenFee_) {
        if (address(oracle_) == address(0) || address(currency_) == address(0) || owner_ == address(0)) {
            revert ZeroAddress();
        }
        oracle = oracle_;
        currency = currency_;
        owner = owner_;
        liveness = liveness_;
        tokenFee = tokenFee_;
        emit LivenessSet(liveness_);
        emit TokenFeeSet(tokenFee_);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function setArbitrable(address a, bool allowed) external onlyOwner {
        isArbitrable[a] = allowed;
        emit ArbitrableSet(a, allowed);
    }

    function setLiveness(uint64 l) external onlyOwner {
        liveness = l;
        emit LivenessSet(l);
    }

    function setTokenFee(uint256 fee) external onlyOwner {
        tokenFee = fee;
        emit TokenFeeSet(fee);
    }

    function withdrawToken(IERC20 t, address to, uint256 amount) external onlyOwner {
        t.safeTransfer(to, amount);
    }

    /// @inheritdoc IArbitrator
    function arbitrationCost(uint256, uint256) external view returns (uint256) {
        return tokenFee;
    }

    /// @inheritdoc IArbitrator
    function requestRuling(uint256 jobId, address challenger, uint16 verdictPayoutBps, bytes32)
        external
        returns (uint256 disputeId)
    {
        if (!isArbitrable[msg.sender]) revert NotArbitrable();
        disputeId = ++disputeCount;
        Request storage r = requests[disputeId];
        r.arbitrable = msg.sender;
        r.jobId = jobId;
        r.challenger = challenger;
        r.verdictPayoutBps = verdictPayoutBps;
        emit DisputeRecorded(disputeId, msg.sender, jobId, challenger);
    }

    /// @notice Bond required by the oracle for one proposal.
    function proposalBond() public view returns (uint256) {
        return oracle.getMinimumBond(address(currency));
    }

    function claimFor(uint256 disputeId, uint16 payoutBps) public view returns (bytes memory) {
        Request storage r = requests[disputeId];
        return abi.encodePacked(
            "AgentCoin dispute ",
            _u(disputeId),
            " of arbitrable 0x",
            _hex(r.arbitrable),
            " job ",
            _u(r.jobId),
            ": payoutBps = ",
            _u(payoutBps)
        );
    }

    /// @notice Anyone: propose the ruling; pulls proposalBond() of `currency` from the caller.
    function proposeRuling(uint256 disputeId, uint16 payoutBps) external nonReentrant returns (bytes32 assertionId) {
        Request storage r = requests[disputeId];
        if (r.arbitrable == address(0)) revert UnknownDispute();
        if (r.ruled) revert AlreadyRuled();
        if (r.pendingAssertion != bytes32(0)) revert ProposalPending(r.pendingAssertion);
        if (payoutBps > 10000) revert InvalidPayout();
        uint256 bond = proposalBond();
        if (bond > 0) {
            currency.safeTransferFrom(msg.sender, address(this), bond);
            currency.forceApprove(address(oracle), bond);
        }
        assertionId = oracle.assertTruth(
            claimFor(disputeId, payoutBps),
            msg.sender,
            address(this),
            address(0),
            liveness,
            currency,
            bond,
            oracle.defaultIdentifier(),
            bytes32(0)
        );
        r.pendingAssertion = assertionId;
        r.pendingBps = payoutBps;
        disputeOfAssertion[assertionId] = disputeId;
        emit RulingProposed(disputeId, assertionId, msg.sender, payoutBps);
    }

    /// @inheritdoc IOptimisticOracleV3CallbackRecipient
    function assertionResolvedCallback(bytes32 assertionId, bool assertedTruthfully) external {
        if (msg.sender != address(oracle)) revert NotOracle();
        uint256 id = disputeOfAssertion[assertionId];
        if (id == 0) revert UnknownDispute();
        Request storage r = requests[id];
        delete disputeOfAssertion[assertionId];
        if (r.pendingAssertion != assertionId) return;
        r.pendingAssertion = bytes32(0);
        if (!assertedTruthfully) {
            emit ProposalRejected(id, assertionId);
            return;
        }
        if (r.ruled) revert AlreadyRuled();
        r.ruled = true;
        emit RulingForwarded(id, assertionId, r.pendingBps);
        IArbitrable(r.arbitrable).rule(r.jobId, r.pendingBps);
    }

    /// @inheritdoc IOptimisticOracleV3CallbackRecipient
    function assertionDisputedCallback(bytes32) external view {
        if (msg.sender != address(oracle)) revert NotOracle();
    }

    function _u(uint256 v) internal pure returns (bytes memory s) {
        if (v == 0) return "0";
        uint256 n;
        for (uint256 t = v; t != 0; t /= 10) {
            n++;
        }
        s = new bytes(n);
        for (; v != 0; v /= 10) {
            s[--n] = bytes1(uint8(48 + (v % 10)));
        }
    }

    function _hex(address a) internal pure returns (bytes memory s) {
        s = new bytes(40);
        bytes16 h = "0123456789abcdef";
        uint160 x = uint160(a);
        for (uint256 i = 40; i > 0; i--) {
            s[i - 1] = h[x & 0xf];
            x >>= 4;
        }
    }
}
