// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {RecoveryVault} from "./RecoveryVault.sol";

interface IEIP3009 {
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;
}

interface IRouteFactory {
    function sweepDelay() external view returns (uint64);
    function sweepTo() external view returns (address);
    function isKeeper(address) external view returns (bool);
}

interface IJobEscrowFor {
    function createAndFundFor(
        address client,
        address provider,
        address evaluator,
        uint256 amount,
        uint64 deadline,
        bytes32 specHash
    ) external returns (uint256 jobId);
}

/// @title EscrowDepositRoute
/// @notice x402 `exact` payTo address for one escrow offer (A-1). A standard x402 client signs an
///         EIP-3009 TransferWithAuthorization with `to` = this contract. settle() executes it and
///         opens a funded JobEscrow job with client = the authorizer. The offer (provider,
///         evaluator, amount, deadline offset, specHash) is fixed per route and bound into the
///         route address via CREATE2, so the client's signature over `to` commits to the offer.
/// @dev A-1e (v0.1.1): a payment is credited in exactly two ways.
///      (i) Atomic: settle() itself calls transferWithAuthorization, so the authorization that is
///          credited is provably the one that moved the funds (the token reverts if its nonce was
///          already used). There is no "front-run" path that credits an already-executed
///          authorization: EIP-3009 does not record which struct used a nonce, which made the old
///          path exploitable (same-nonce double-sign).
///      (ii) Keeper attestation: funds that reached the route any other way (an authorization
///          submitted straight to the token, a plain transfer) are credited only by an allowlisted
///          keeper (factory.attestDeposit) that cites the specific token Transfer log
///          (txHash, logIndex) into this route, which it checked off-chain. The factory rejects a
///          second attestation of the same (txHash, logIndex). The credit goes to the log's `from`:
///          a job if value == amount (refund if the job cannot open), otherwise a refund.
///      v0.1.2: an attestation credits only once k-of-n keepers attested the same
///      (route, from, value, refundOnly) for that (txHash, logIndex); see the factory.
///      There is no permissionless refund. Sweep (A-1a/A-1c/A-1d, v0.1.2): any keeper may
///      startSweep(); attested credits during the delay are deducted from the snapshot; after
///      sweepDelay anyone may sweep() what is left of the snapshot to `sweepTo` = the factory's
///      RecoveryVault (fixed at route creation), where it stays claimable by the payer (k-of-n
///      attestation) until the vault's horizon. Nothing goes to the treasury from a route.
contract EscrowDepositRoute is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable factory;
    IERC20 public immutable token;
    address public immutable escrow;
    address public immutable provider;
    address public immutable evaluator;
    uint256 public immutable amount;
    uint64 public immutable deadlineSeconds;
    bytes32 public immutable specHash;
    /// @notice Sweep destination, fixed at route creation (A-1d): the factory's RecoveryVault (v0.1.2).
    address public immutable sweepTo;

    /// @notice authorizer => nonce => settled atomically by this route
    mapping(address => mapping(bytes32 => bool)) public settled;
    /// @notice Total credited from keeper attestations (jobs opened + refunds).
    uint256 public attestedTotal;
    /// @notice Pending sweep: balance snapshot and the time sweep() becomes callable (0 = none).
    uint256 public sweepAmount;
    uint64 public sweepableAt;

    event DepositSettled(address indexed from, bytes32 indexed nonce, uint256 indexed jobId);
    event DepositAttested(
        bytes32 indexed transferId, address indexed from, uint256 value, uint256 indexed jobId, bool refunded
    );
    event SweepStarted(address indexed caller, uint256 amount, uint64 sweepableAt);
    event Swept(address indexed caller, address indexed sweepTo, uint256 amount);
    event FlushedToVault(address indexed vault, uint256 amount);

    error WrongValue(uint256 value, uint256 expected);
    error AlreadySettled();
    error OnlyFactory();
    error NotKeeper();
    error InsufficientRouteBalance();
    error NothingToSweep();
    error SweepPending(uint64 sweepableAt);
    error SweepNotStarted();
    error SweepDelayNotElapsed(uint64 sweepableAt);
    error ZeroAddress();

    constructor(
        IERC20 token_,
        address escrow_,
        address provider_,
        address evaluator_,
        uint256 amount_,
        uint64 deadlineSeconds_,
        bytes32 specHash_
    ) {
        if (escrow_ == address(0) || provider_ == address(0) || evaluator_ == address(0)) revert ZeroAddress();
        factory = msg.sender;
        token = token_;
        escrow = escrow_;
        provider = provider_;
        evaluator = evaluator_;
        amount = amount_;
        deadlineSeconds = deadlineSeconds_;
        specHash = specHash_;
        address st = IRouteFactory(msg.sender).sweepTo();
        require(st != address(0), "sweepTo");
        sweepTo = st;
        token_.forceApprove(escrow_, type(uint256).max);
    }

    /// @notice Anyone (normally the x402 facilitator). Atomic path only: executes the authorization
    ///         and opens the job in the same call. Reverts (payer not charged) if the token rejects
    ///         the authorization (bad signature, window, or nonce already used) or the job cannot open.
    function settle(
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external nonReentrant returns (uint256 jobId) {
        if (value != amount) revert WrongValue(value, amount);
        if (settled[from][nonce]) revert AlreadySettled();
        settled[from][nonce] = true;
        IEIP3009(address(token))
            .transferWithAuthorization(from, address(this), value, validAfter, validBefore, nonce, signature);
        jobId = _open(from);
        emit DepositSettled(from, nonce, jobId);
    }

    /// @notice Factory only (after its keeper and (txHash, logIndex) checks): credit a deposit the
    ///         keeper attested from a Transfer log into this route. value == amount and !refundOnly
    ///         opens a job for `from` (refund if it cannot open); anything else refunds `from`.
    function creditAttested(bytes32 transferId, address from, uint256 value, bool refundOnly)
        external
        nonReentrant
        returns (uint256 jobId, bool refunded)
    {
        if (msg.sender != factory) revert OnlyFactory();
        if (token.balanceOf(address(this)) < value) revert InsufficientRouteBalance();
        attestedTotal += value;
        _attributedOut(value);
        if (!refundOnly && value == amount) {
            try IJobEscrowFor(escrow)
                .createAndFundFor(
                    from, provider, evaluator, amount, uint64(block.timestamp) + deadlineSeconds, specHash
                ) returns (
                uint256 id
            ) {
                jobId = id;
            } catch {
                refunded = true;
            }
        } else {
            refunded = true;
        }
        if (refunded) token.safeTransfer(from, value);
        emit DepositAttested(transferId, from, value, jobId, refunded);
    }

    /// @notice Keeper only (any one allowlisted keeper): start the sweep clock for the route's current
    ///         balance. Keepers are expected to attest every attributable deposit they know of first;
    ///         anything swept anyway stays claimable from the RecoveryVault (v0.1.2).
    function startSweep() external nonReentrant {
        if (!IRouteFactory(factory).isKeeper(msg.sender)) revert NotKeeper();
        if (sweepableAt != 0) revert SweepPending(sweepableAt);
        uint256 bal = token.balanceOf(address(this));
        if (bal == 0) revert NothingToSweep();
        uint64 at = uint64(block.timestamp) + IRouteFactory(factory).sweepDelay();
        sweepAmount = bal;
        sweepableAt = at;
        emit SweepStarted(msg.sender, bal, at);
    }

    /// @notice Anyone, after sweepDelay: move min(snapshot, balance) to `sweepTo` (the RecoveryVault),
    ///         recorded there under this route.
    function sweep() external nonReentrant returns (uint256 amount_) {
        uint64 at = sweepableAt;
        if (at == 0) revert SweepNotStarted();
        if (block.timestamp < at) revert SweepDelayNotElapsed(at);
        uint256 bal = token.balanceOf(address(this));
        amount_ = sweepAmount < bal ? sweepAmount : bal;
        sweepAmount = 0;
        sweepableAt = 0;
        if (amount_ > 0) _toVault(amount_);
        emit Swept(msg.sender, sweepTo, amount_);
    }

    /// @notice Factory only: an attested deposit is larger than the route balance (part or all of it
    ///         was swept), so move the whole balance into the vault, where the claim is paid from the
    ///         route's pooled unclaimed funds. Cancels a pending sweep (the balance is now 0).
    function flushToVault() external nonReentrant returns (uint256 bal) {
        if (msg.sender != factory) revert OnlyFactory();
        bal = token.balanceOf(address(this));
        sweepAmount = 0;
        sweepableAt = 0;
        if (bal > 0) _toVault(bal);
        emit FlushedToVault(sweepTo, bal);
    }

    function _toVault(uint256 amount_) internal {
        token.safeTransfer(sweepTo, amount_);
        RecoveryVault(sweepTo).recordSweep(amount_);
    }

    /// @dev Attested credits during a pending sweep are deducted from its snapshot. Conservative:
    ///      a deposit that arrived after the snapshot is deducted too, which can only shrink the sweep.
    function _attributedOut(uint256 value) internal {
        if (sweepableAt == 0) return;
        uint256 a = sweepAmount;
        sweepAmount = a > value ? a - value : 0;
    }

    function _open(address from) internal returns (uint256) {
        return IJobEscrowFor(escrow)
            .createAndFundFor(from, provider, evaluator, amount, uint64(block.timestamp) + deadlineSeconds, specHash);
    }
}

/// @title EscrowDepositRouteFactory
/// @notice Deterministic (CREATE2) deposit routes. routeFor(offer) is computable before deployment,
///         so a 402 response can name it as payTo; settle() deploys on first use.
/// @dev v0.1.2 k-of-n keeper attestation (A-1e):
///      - Keepers are allowlisted at deploy with a threshold k (default 2-of-3). k < 2 is accepted only on
///        local / test chains (chainid 31337, 1337, 11155111, 84532); anywhere else it reverts.
///      - A deposit is identified by transferId = keccak256(txHash, logIndex). The first attestation fixes
///        its digest = keccak256(route, from, value, refundOnly); each further keeper must attest the same
///        digest. At k matching attestations (distinct keepers, same keeper-set epoch) the deposit is
///        credited, once: route balance first; if the route holds less, from the RecoveryVault.
///      - A keeper attesting a different digest for the same transferId FREEZES it (DepositFrozen). A frozen
///        deposit can only be resolved by the owner through a timelocked (keeperTimelock) resolution:
///        Credit(route, from, value, refundOnly) or Reset (clears the votes so keepers attest afresh).
///      - Every executed keeper-set or threshold change bumps `keeperEpoch`; votes cast in an older epoch
///        never count, so removing a keeper or lowering k cannot complete an attestation that the new set
///        did not attest. Frozen deposits stay frozen across epochs.
///      Keeper-set and threshold changes: proposeX / cancelX (owner) and executeX (anyone after
///      `keeperTimelock`, default 48h), the same pattern as registry slashers.
contract EscrowDepositRouteFactory is Ownable2Step {
    struct Offer {
        address provider;
        address evaluator;
        uint256 amount;
        uint64 deadlineSeconds;
        bytes32 specHash;
    }

    struct Config {
        uint64 sweepDelay; // A-1a
        address treasury; // RecoveryVault release destination after `recoveryHorizon`
        uint64 recoveryHorizon; // RecoveryVault claim horizon (default 365d)
        uint64 keeperTimelock; // keeper-set / threshold / resolution timelock (default 48h)
        uint8 threshold; // k (default 2)
    }

    enum Status {
        None,
        Pending,
        Credited,
        Frozen
    }

    struct Claim {
        bytes32 digest; // keccak256(route, from, value, refundOnly) of the first attestation this round
        uint64 epoch; // keeper-set epoch the votes were cast in
        uint32 round; // bumped when the votes are discarded (new epoch or admin Reset)
        uint16 count; // matching votes this round
        Status status;
    }

    enum ResolutionKind {
        None,
        Credit,
        Reset
    }

    struct Resolution {
        ResolutionKind kind;
        uint64 eta;
        bool refundOnly;
        address route;
        address from;
        uint256 value;
    }

    struct PendingKeeper {
        bool allowed;
        uint64 eta;
    }

    struct PendingThreshold {
        uint8 k;
        uint64 eta;
    }

    IERC20 public immutable token;
    address public immutable escrow;
    /// @notice Seconds between startSweep() and sweep() on every route of this factory (A-1a).
    uint64 public immutable sweepDelay;
    /// @notice Recovery vault deployed by this factory: every route's immutable sweep destination.
    RecoveryVault public immutable vault;
    /// @notice == address(vault); copied into every route at creation (A-1d). Immutable.
    address public immutable sweepTo;
    /// @notice Delay between proposing and executing a keeper / threshold change or a frozen-deposit
    ///         resolution. Fixed at deploy.
    uint64 public immutable keeperTimelock;

    mapping(address => bool) public isKeeper;
    uint256 public keeperCount;
    /// @notice k: matching attestations needed to credit a deposit.
    uint256 public threshold;
    /// @notice Bumped by every executed keeper-set or threshold change.
    uint64 public keeperEpoch;
    mapping(address => PendingKeeper) public pendingKeeper;
    PendingThreshold public pendingThreshold;
    /// @notice Routes deployed by this factory (the vault accepts sweeps only from them).
    mapping(address => bool) public isRoute;

    mapping(bytes32 => Claim) internal _claims;
    /// @notice transferId => round => keeper => voted
    mapping(bytes32 => mapping(uint32 => mapping(address => bool))) internal _voted;
    mapping(bytes32 => Resolution) public pendingResolution;

    event KeeperSet(address indexed keeper, bool allowed, uint64 epoch);
    event KeeperChangeProposed(address indexed keeper, bool allowed, uint64 eta);
    event KeeperChangeCancelled(address indexed keeper);
    event ThresholdSet(uint256 k, uint256 keeperCount, uint64 epoch);
    event ThresholdChangeProposed(uint256 k, uint64 eta);
    event ThresholdChangeCancelled(uint256 k);
    event AttestationRecorded(
        bytes32 indexed transferId, address indexed keeper, bytes32 indexed digest, uint256 count, uint64 epoch
    );
    event AttestationRoundReset(bytes32 indexed transferId, uint32 round, uint64 epoch);
    event DepositFrozen(
        bytes32 indexed transferId, address indexed keeper, bytes32 recordedDigest, bytes32 conflictingDigest
    );
    /// @notice A deposit was credited (k-of-n attestation or a Credit resolution).
    event DepositAttested(
        address indexed route,
        bytes32 indexed transferId,
        address indexed from,
        uint256 value,
        uint256 jobId,
        bool refunded,
        bool fromVault
    );
    event ResolutionProposed(
        bytes32 indexed transferId,
        ResolutionKind kind,
        address route,
        address from,
        uint256 value,
        bool refundOnly,
        uint64 eta
    );
    event ResolutionCancelled(bytes32 indexed transferId);
    event DepositResolved(bytes32 indexed transferId, ResolutionKind kind, uint256 jobId, bool refunded);

    event RouteDeployed(
        address indexed route,
        address indexed provider,
        address indexed evaluator,
        uint256 amount,
        uint64 deadlineSeconds,
        bytes32 specHash
    );

    error InvalidSweepDelay();
    error InvalidTreasury();
    error ZeroAddress();
    error NotKeeper();
    error AlreadyAttested(bytes32 txHash, uint256 logIndex);
    error AlreadyVoted(bytes32 transferId);
    error DepositIsFrozen(bytes32 transferId);
    error NotFrozen(bytes32 transferId);
    error WrongRoute();
    error InvalidAttestation();
    error InvalidThreshold(uint256 k, uint256 keeperCount);
    error ThresholdBelowTwoOnProductionChain(uint256 chainId);
    error NoPendingChange();
    error TimelockNotElapsed(uint64 eta);

    constructor(IERC20 token_, address escrow_, address owner_, Config memory cfg, address[] memory initialKeepers)
        Ownable(owner_)
    {
        if (cfg.sweepDelay == 0) revert InvalidSweepDelay();
        if (cfg.treasury == address(0)) revert InvalidTreasury();
        if (address(token_) == address(0) || escrow_ == address(0)) revert ZeroAddress();
        token = token_;
        escrow = escrow_;
        sweepDelay = cfg.sweepDelay;
        keeperTimelock = cfg.keeperTimelock;
        RecoveryVault v = new RecoveryVault(token_, cfg.treasury, cfg.recoveryHorizon);
        vault = v;
        sweepTo = address(v);
        uint256 n;
        for (uint256 i = 0; i < initialKeepers.length; i++) {
            address k = initialKeepers[i];
            if (k == address(0)) revert ZeroAddress();
            if (isKeeper[k]) continue;
            isKeeper[k] = true;
            n++;
            emit KeeperSet(k, true, 0);
        }
        keeperCount = n;
        _checkThreshold(cfg.threshold, n);
        threshold = cfg.threshold;
        emit ThresholdSet(cfg.threshold, n, 0);
    }

    // ---------------- keeper set + threshold (timelocked) ----------------

    /// @notice True on chains where a 1-of-n keeper threshold is allowed (local / public testnets).
    function lowThresholdAllowed() public view returns (bool) {
        uint256 id = block.chainid;
        return id == 31337 || id == 1337 || id == 11155111 || id == 84532;
    }

    function _checkThreshold(uint256 k, uint256 n) internal view {
        if (k == 0 || k > n) revert InvalidThreshold(k, n);
        if (k < 2 && !lowThresholdAllowed()) revert ThresholdBelowTwoOnProductionChain(block.chainid);
    }

    function proposeKeeper(address keeper, bool allowed) external onlyOwner {
        if (keeper == address(0)) revert ZeroAddress();
        uint64 eta = uint64(block.timestamp) + keeperTimelock;
        pendingKeeper[keeper] = PendingKeeper(allowed, eta);
        emit KeeperChangeProposed(keeper, allowed, eta);
    }

    function cancelKeeper(address keeper) external onlyOwner {
        if (pendingKeeper[keeper].eta == 0) revert NoPendingChange();
        delete pendingKeeper[keeper];
        emit KeeperChangeCancelled(keeper);
    }

    /// @notice Anyone, once the timelock elapsed: apply a queued keeper change. Reverts if it would leave
    ///         fewer keepers than k. Bumps the epoch (pending votes are discarded).
    function executeKeeper(address keeper) external {
        PendingKeeper memory p = pendingKeeper[keeper];
        if (p.eta == 0) revert NoPendingChange();
        if (block.timestamp < p.eta) revert TimelockNotElapsed(p.eta);
        delete pendingKeeper[keeper];
        uint256 n = keeperCount;
        if (p.allowed && !isKeeper[keeper]) n++;
        else if (!p.allowed && isKeeper[keeper]) n--;
        _checkThreshold(threshold, n);
        keeperCount = n;
        isKeeper[keeper] = p.allowed;
        uint64 e = ++keeperEpoch;
        emit KeeperSet(keeper, p.allowed, e);
    }

    function proposeThreshold(uint8 k) external onlyOwner {
        if (k == 0) revert InvalidThreshold(k, keeperCount);
        uint64 eta = uint64(block.timestamp) + keeperTimelock;
        pendingThreshold = PendingThreshold(k, eta);
        emit ThresholdChangeProposed(k, eta);
    }

    function cancelThreshold() external onlyOwner {
        PendingThreshold memory p = pendingThreshold;
        if (p.eta == 0) revert NoPendingChange();
        delete pendingThreshold;
        emit ThresholdChangeCancelled(p.k);
    }

    /// @notice Anyone, once the timelock elapsed. Re-checks k against the keeper count at execution.
    ///         Bumps the epoch (pending votes are discarded).
    function executeThreshold() external {
        PendingThreshold memory p = pendingThreshold;
        if (p.eta == 0) revert NoPendingChange();
        if (block.timestamp < p.eta) revert TimelockNotElapsed(p.eta);
        delete pendingThreshold;
        _checkThreshold(p.k, keeperCount);
        threshold = p.k;
        uint64 e = ++keeperEpoch;
        emit ThresholdSet(p.k, keeperCount, e);
    }

    // ---------------- k-of-n keeper attestation (A-1e) ----------------

    /// @notice Keeper only. Attest a token Transfer log (txHash, logIndex) that moved `value` from `from`
    ///         into routeFor(o), verified off-chain at finality (the contract cannot see logs).
    ///         The k-th matching attestation (same digest, distinct keepers, current epoch) credits it:
    ///         value == amount && !refundOnly opens a job for `from` (refund if it cannot open), anything
    ///         else refunds `from`; if the route holds less than `value` it is paid from the RecoveryVault
    ///         (refund only). A mismatching attestation freezes the deposit instead (no revert).
    /// @return credited whether this call credited the deposit
    function attestDeposit(
        Offer calldata o,
        bytes32 txHash,
        uint256 logIndex,
        address from,
        uint256 value,
        bool refundOnly
    ) external returns (bool credited, uint256 jobId, bool refunded) {
        if (!isKeeper[msg.sender]) revert NotKeeper();
        if (txHash == bytes32(0) || from == address(0) || value == 0) revert InvalidAttestation();
        bytes32 id = transferId(txHash, logIndex);
        Status st = _claims[id].status;
        if (st == Status.Credited) revert AlreadyAttested(txHash, logIndex);
        if (st == Status.Frozen) revert DepositIsFrozen(id);
        if (!_vote(id, attestationDigest(routeFor(o), from, value, refundOnly))) return (false, 0, false);
        _claims[id].status = Status.Credited;
        (jobId, refunded) = _credit(o, id, from, value, refundOnly);
        credited = true;
    }

    /// @dev Records msg.sender's vote; returns true when this vote is the k-th matching one.
    function _vote(bytes32 id, bytes32 d) internal returns (bool) {
        Claim storage c = _claims[id];
        uint64 e = keeperEpoch;
        if (c.status == Status.None || c.epoch != e) {
            if (c.status != Status.None) {
                c.round += 1; // stale votes from an older keeper set are discarded
                emit AttestationRoundReset(id, c.round, e);
            }
            c.digest = d;
            c.epoch = e;
            c.count = 0;
            c.status = Status.Pending;
        }
        mapping(address => bool) storage voted = _voted[id][c.round];
        if (voted[msg.sender]) revert AlreadyVoted(id);
        voted[msg.sender] = true;
        if (c.digest != d) {
            c.status = Status.Frozen;
            emit DepositFrozen(id, msg.sender, c.digest, d);
            return false;
        }
        uint16 count = c.count + 1;
        c.count = count;
        emit AttestationRecorded(id, msg.sender, d, count, e);
        return count >= threshold;
    }

    function _credit(Offer calldata o, bytes32 id, address from, uint256 value, bool refundOnly)
        internal
        returns (uint256 jobId, bool refunded)
    {
        address r = deploy(o);
        bool fromVault;
        if (token.balanceOf(r) >= value) {
            (jobId, refunded) = EscrowDepositRoute(r).creditAttested(id, from, value, refundOnly);
        } else {
            EscrowDepositRoute(r).flushToVault();
            vault.payout(r, id, from, value);
            refunded = true;
            fromVault = true;
        }
        emit DepositAttested(r, id, from, value, jobId, refunded, fromVault);
    }

    // ---------------- frozen deposits: timelocked admin resolution ----------------

    /// @notice Owner: queue the resolution of a frozen deposit. Credit pays (from, value, refundOnly)
    ///         into/out of `route` exactly like a k-of-n credit; Reset discards all votes so the keepers
    ///         attest afresh. Executable by anyone after keeperTimelock.
    function proposeResolution(
        bytes32 id,
        ResolutionKind kind,
        address route,
        address from,
        uint256 value,
        bool refundOnly
    ) external onlyOwner {
        if (_claims[id].status != Status.Frozen) revert NotFrozen(id);
        if (kind == ResolutionKind.None) revert InvalidAttestation();
        if (kind == ResolutionKind.Credit && (from == address(0) || value == 0 || route == address(0))) {
            revert InvalidAttestation();
        }
        uint64 eta = uint64(block.timestamp) + keeperTimelock;
        pendingResolution[id] = Resolution(kind, eta, refundOnly, route, from, value);
        emit ResolutionProposed(id, kind, route, from, value, refundOnly, eta);
    }

    function cancelResolution(bytes32 id) external onlyOwner {
        if (pendingResolution[id].eta == 0) revert NoPendingChange();
        delete pendingResolution[id];
        emit ResolutionCancelled(id);
    }

    /// @notice Anyone, after the timelock. `o` must be the offer of the resolution's route (Credit only;
    ///         ignored for Reset).
    function executeResolution(bytes32 id, Offer calldata o) external returns (uint256 jobId, bool refunded) {
        Resolution memory r = pendingResolution[id];
        if (r.eta == 0) revert NoPendingChange();
        if (block.timestamp < r.eta) revert TimelockNotElapsed(r.eta);
        Claim storage c = _claims[id];
        if (c.status != Status.Frozen) revert NotFrozen(id);
        delete pendingResolution[id];
        if (r.kind == ResolutionKind.Credit) {
            if (routeFor(o) != r.route) revert WrongRoute();
            c.status = Status.Credited;
            (jobId, refunded) = _credit(o, id, r.from, r.value, r.refundOnly);
        } else {
            c.status = Status.None;
            c.count = 0;
            c.round += 1;
        }
        emit DepositResolved(id, r.kind, jobId, refunded);
    }

    // ---------------- views ----------------

    function transferId(bytes32 txHash, uint256 logIndex) public pure returns (bytes32) {
        return keccak256(abi.encode(txHash, logIndex));
    }

    function attestationDigest(address route, address from, uint256 value, bool refundOnly)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(route, from, value, refundOnly));
    }

    /// @notice transferId credited (by k-of-n attestation or a Credit resolution).
    function attested(bytes32 id) external view returns (bool) {
        return _claims[id].status == Status.Credited;
    }

    function claimOf(bytes32 id) external view returns (Claim memory) {
        return _claims[id];
    }

    /// @notice Whether `keeper`'s vote on `id` counts right now (cast this round, in the current epoch).
    function hasAttested(bytes32 id, address keeper) external view returns (bool) {
        Claim memory c = _claims[id];
        return c.status == Status.Pending && c.epoch == keeperEpoch && _voted[id][c.round][keeper];
    }

    function routeFor(Offer calldata o) public view returns (address) {
        bytes32 h = keccak256(abi.encodePacked(bytes1(0xff), address(this), _salt(o), keccak256(_initCode(o))));
        return address(uint160(uint256(h)));
    }

    function deploy(Offer calldata o) public returns (address route) {
        route = routeFor(o);
        if (route.code.length > 0) return route;
        if (o.provider == address(0) || o.evaluator == address(0)) revert ZeroAddress();
        bytes memory code = _initCode(o);
        bytes32 salt = _salt(o);
        assembly {
            route := create2(0, add(code, 0x20), mload(code), salt)
        }
        require(route != address(0), "create2 failed");
        isRoute[route] = true;
        emit RouteDeployed(route, o.provider, o.evaluator, o.amount, o.deadlineSeconds, o.specHash);
    }

    /// @notice Deploy the route if needed, then settle an x402 `exact` authorization through it
    ///         (atomic path only).
    function settle(
        Offer calldata o,
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external returns (address route, uint256 jobId) {
        route = deploy(o);
        jobId = EscrowDepositRoute(route).settle(from, value, validAfter, validBefore, nonce, signature);
    }

    function _salt(Offer calldata o) internal pure returns (bytes32) {
        return keccak256(abi.encode(o));
    }

    function _initCode(Offer calldata o) internal view returns (bytes memory) {
        return abi.encodePacked(
            type(EscrowDepositRoute).creationCode,
            abi.encode(token, escrow, o.provider, o.evaluator, o.amount, o.deadlineSeconds, o.specHash)
        );
    }
}
