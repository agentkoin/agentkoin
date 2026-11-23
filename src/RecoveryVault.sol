// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IRouteRegistry {
    function isRoute(address) external view returns (bool);
}

/// @title RecoveryVault
/// @notice v0.1.2 (A-1a/A-1e): destination of every route sweep instead of the treasury. Swept funds stay
///         attributed to the route they came from. A payer whose Transfer into that route was never
///         credited can still be paid out of the vault: k-of-n keepers attest the Transfer on the factory
///         (same (txHash, logIndex) dedupe as a route credit, so a transfer is paid at most once, route or
///         vault), and the factory calls payout(). Only what stays unclaimed for `horizon` seconds after the
///         route's last sweep into the vault can be released to the treasury (anyone may trigger it).
/// @dev Deployed by the route factory in its constructor; `factory` is the only payout caller and the
///      registry of routes allowed to record sweeps. Tokens sent to the vault directly (not via a route
///      sweep) are not attributed to any route and cannot be claimed or released (documented OPEN QUESTION).
contract RecoveryVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    address public immutable factory;
    address public immutable treasury;
    /// @notice Seconds after a route's last sweep into the vault before its unclaimed funds may go to treasury.
    uint64 public immutable horizon;

    /// @notice route => swept funds not yet claimed or released
    mapping(address => uint256) public unclaimed;
    /// @notice route => time of the route's last sweep into the vault (each sweep restarts the horizon)
    mapping(address => uint64) public lastSweptAt;
    /// @notice sum of unclaimed[] over all routes (== attributed vault balance)
    uint256 public totalUnclaimed;

    event SweptIn(address indexed route, uint256 amount, uint256 unclaimed, uint64 releasableAt);
    event Claimed(address indexed route, bytes32 indexed transferId, address indexed to, uint256 value);
    event ReleasedToTreasury(address indexed route, address indexed treasury, uint256 amount);

    error OnlyFactory();
    error NotRoute();
    error NotReceived();
    error InsufficientUnclaimed(uint256 available, uint256 value);
    error HorizonNotElapsed(uint64 releasableAt);
    error NothingToRelease();
    error InvalidConfig();

    constructor(IERC20 token_, address treasury_, uint64 horizon_) {
        if (treasury_ == address(0) || horizon_ == 0) revert InvalidConfig();
        token = token_;
        factory = msg.sender;
        treasury = treasury_;
        horizon = horizon_;
    }

    /// @notice Route only, right after it transferred `amount` here.
    function recordSweep(uint256 amount) external nonReentrant {
        if (!IRouteRegistry(factory).isRoute(msg.sender)) revert NotRoute();
        if (token.balanceOf(address(this)) < totalUnclaimed + amount) revert NotReceived();
        uint256 u = unclaimed[msg.sender] + amount;
        unclaimed[msg.sender] = u;
        totalUnclaimed += amount;
        uint64 now_ = uint64(block.timestamp);
        lastSweptAt[msg.sender] = now_;
        emit SweptIn(msg.sender, amount, u, now_ + horizon);
    }

    /// @notice Factory only, after k-of-n keeper attestation of a Transfer into `route` (or a timelocked
    ///         admin resolution of a frozen one): pay `value` to the Transfer's sender.
    function payout(address route, bytes32 transferId, address to, uint256 value) external nonReentrant {
        if (msg.sender != factory) revert OnlyFactory();
        uint256 u = unclaimed[route];
        if (u < value) revert InsufficientUnclaimed(u, value);
        unclaimed[route] = u - value;
        totalUnclaimed -= value;
        token.safeTransfer(to, value);
        emit Claimed(route, transferId, to, value);
    }

    /// @notice Anyone, `horizon` after the route's last sweep: release what is still unclaimed to treasury.
    function releaseExpired(address route) external nonReentrant returns (uint256 amount) {
        amount = unclaimed[route];
        if (amount == 0) revert NothingToRelease();
        uint64 at = lastSweptAt[route] + horizon;
        if (block.timestamp < at) revert HorizonNotElapsed(at);
        unclaimed[route] = 0;
        totalUnclaimed -= amount;
        token.safeTransfer(treasury, amount);
        emit ReleasedToTreasury(route, treasury, amount);
    }

    function releasableAt(address route) external view returns (uint64) {
        return unclaimed[route] == 0 ? 0 : lastSweptAt[route] + horizon;
    }
}
