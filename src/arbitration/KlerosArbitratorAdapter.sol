// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IArbitrator, IArbitrable} from "../interfaces/IArbitrator.sol";
import {IERC792Arbitrator, IERC792Arbitrable} from "./IExternalArbitration.sol";

/// @title KlerosArbitratorAdapter (STUB, v0.3)
/// @notice Bridges AgentCoin IArbitrator (JobEscrow / ERC8183EvaluatorAdapter) to an ERC-792 arbitrator
///         such as Kleros Court. Tested against mocks only; not deployed to any network.
/// @dev Fee model (ASSUMPTIONS E-17c): Kleros requires native-currency prepayment at createDispute,
///      while AgentCoin arbitrables pay the quoted cost in the payment token inside rule(). This
///      adapter therefore FRONTS the native cost from its own balance (operator-funded via receive())
///      and quotes `tokenFee` to arbitrables; the token fee it receives in rule() is withdrawable by
///      the owner. No conversion or oracle is involved; the operator sets tokenFee.
///      Ruling mapping (2 choices): 1 = pay provider (10000 bps), 2 = refund client (0 bps),
///      0 = refused to arbitrate -> the challenged verdict stands (verdictPayoutBps).
///      Only allowlisted arbitrables may open disputes (prevents draining the prepayment balance).
contract KlerosArbitratorAdapter is IArbitrator, IERC792Arbitrable {
    using SafeERC20 for IERC20;

    uint256 public constant CHOICES = 2;
    uint256 public constant RULING_PAY_PROVIDER = 1;
    uint256 public constant RULING_REFUND_CLIENT = 2;

    struct Request {
        address arbitrable;
        uint256 jobId;
        address challenger;
        uint16 verdictPayoutBps;
        uint256 externalId;
        bool ruled;
    }

    IERC792Arbitrator public immutable kleros;
    address public immutable owner;
    bytes public extraData;
    uint256 public tokenFee;
    uint256 public disputeCount;
    mapping(address => bool) public isArbitrable;
    mapping(uint256 => Request) public requests; // local disputeId => request
    mapping(uint256 => uint256) public localIdOf; // kleros disputeID => local disputeId

    event ArbitrableSet(address indexed arbitrable, bool allowed);
    event TokenFeeSet(uint256 fee);
    event DisputeOpened(
        uint256 indexed disputeId,
        uint256 indexed externalId,
        address indexed arbitrable,
        uint256 jobId,
        uint256 ethCost
    );
    event RulingForwarded(uint256 indexed disputeId, uint256 externalRuling, uint16 payoutBps);

    error NotOwner();
    error NotArbitrable();
    error NotKleros();
    error UnknownDispute();
    error AlreadyRuled();
    error InsufficientPrepayment(uint256 balance, uint256 cost);
    error InvalidRuling(uint256 ruling);
    error ZeroAddress();

    constructor(IERC792Arbitrator kleros_, bytes memory extraData_, address owner_, uint256 tokenFee_) {
        if (address(kleros_) == address(0) || owner_ == address(0)) revert ZeroAddress();
        kleros = kleros_;
        extraData = extraData_;
        owner = owner_;
        tokenFee = tokenFee_;
        emit TokenFeeSet(tokenFee_);
    }

    receive() external payable {}

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function setArbitrable(address a, bool allowed) external onlyOwner {
        isArbitrable[a] = allowed;
        emit ArbitrableSet(a, allowed);
    }

    function setTokenFee(uint256 fee) external onlyOwner {
        tokenFee = fee;
        emit TokenFeeSet(fee);
    }

    function withdrawToken(IERC20 t, address to, uint256 amount) external onlyOwner {
        t.safeTransfer(to, amount);
    }

    function withdrawNative(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        (bool ok,) = to.call{value: amount}("");
        require(ok, "native transfer");
    }

    /// @inheritdoc IArbitrator
    function arbitrationCost(uint256, uint256) external view returns (uint256) {
        return tokenFee;
    }

    /// @notice Native cost the adapter must hold to open one Kleros dispute now.
    function nativeCost() public view returns (uint256) {
        return kleros.arbitrationCost(extraData);
    }

    /// @inheritdoc IArbitrator
    function requestRuling(uint256 jobId, address challenger, uint16 verdictPayoutBps, bytes32)
        external
        returns (uint256 disputeId)
    {
        if (!isArbitrable[msg.sender]) revert NotArbitrable();
        uint256 cost = nativeCost();
        if (address(this).balance < cost) revert InsufficientPrepayment(address(this).balance, cost);
        disputeId = ++disputeCount;
        uint256 ext = kleros.createDispute{value: cost}(CHOICES, extraData);
        requests[disputeId] = Request(msg.sender, jobId, challenger, verdictPayoutBps, ext, false);
        localIdOf[ext] = disputeId;
        emit DisputeOpened(disputeId, ext, msg.sender, jobId, cost);
    }

    /// @inheritdoc IERC792Arbitrable
    function rule(uint256 disputeID, uint256 ruling) external {
        if (msg.sender != address(kleros)) revert NotKleros();
        uint256 id = localIdOf[disputeID];
        if (id == 0) revert UnknownDispute();
        Request storage r = requests[id];
        if (r.ruled) revert AlreadyRuled();
        uint16 bps;
        if (ruling == RULING_PAY_PROVIDER) bps = 10000;
        else if (ruling == RULING_REFUND_CLIENT) bps = 0;
        else if (ruling == 0) bps = r.verdictPayoutBps;
        else revert InvalidRuling(ruling);
        r.ruled = true;
        emit RulingForwarded(id, ruling, bps);
        IArbitrable(r.arbitrable).rule(r.jobId, bps);
    }
}
