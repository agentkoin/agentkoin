// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @dev Circle FiatToken v2.2 receiveWithAuthorization (bytes signature overload).
interface IUSDCReceive {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;
}

/// @title AGC (AD-010, Base Sepolia testnet)
/// @notice ERC-20 (6 decimals) minted only by depositing USDC 1:1 (wrap*) and burned only by redeeming 1:1 for USDC
///         (unwrap*). EIP-2612 permit and EIP-3009 with FiatToken v2.2 function signatures and typehashes.
///         No owner, no proxy, no pause, no freeze, no fee, no rescue. Reserve check after every wrap and unwrap:
///         USDC.balanceOf(this) >= totalSupply(). USDC sent directly to this contract stays as permanent surplus.
///         Testnet: test USDC has no value, so AGC on Base Sepolia has none either.
contract AGC is ERC20, ERC20Permit {
    using SafeERC20 for IERC20;

    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH =
        keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");
    bytes32 public constant UNWRAP_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "UnwrapWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    IERC20 public immutable USDC;

    mapping(address => mapping(bytes32 => bool)) internal _authorizationStates;

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);
    event Wrapped(address indexed payer, address indexed to, uint256 amount);
    event Unwrapped(address indexed from, address indexed to, uint256 amount);

    error ZeroAmount();
    error ZeroAddress();
    error UnsupportedDecimals(uint8 decimals);
    error PullMismatch(uint256 expected, uint256 received);
    error ReserveShortfall(uint256 reserve, uint256 supply);
    error UseUnwrap();
    error AuthorizationNotYetValid();
    error AuthorizationExpired();
    error AuthorizationAlreadyUsed();
    error InvalidSignature();
    error CallerMustBePayee();

    constructor(IERC20 usdc_) ERC20("AgentCoin", "AGC") ERC20Permit("AgentCoin") {
        if (address(usdc_) == address(0)) revert ZeroAddress();
        uint8 d = IERC20Metadata(address(usdc_)).decimals();
        if (d != 6) revert UnsupportedDecimals(d);
        USDC = usdc_;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    // ---------------- wrap (mint) ----------------

    function wrap(uint256 amount) external {
        _pullAndMint(msg.sender, msg.sender, amount);
    }

    function wrapTo(address to, uint256 amount) external {
        _pullAndMint(msg.sender, to, amount);
    }

    /// @notice USDC permit, then wrap. The permit is in try/catch so a front-run permit (allowance already set) does not
    ///         block the wrap; the pull still needs the allowance.
    function wrapWithPermit(uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external {
        try IERC20Permit(address(USDC)).permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {}
        _pullAndMint(msg.sender, msg.sender, amount);
    }

    /// @notice One-signature wrap any relayer may submit. The USDC ReceiveWithAuthorization signature does not name a mint
    ///         recipient, so the mint always goes to `from`.
    function wrapWithAuthorization(
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        if (value == 0) revert ZeroAmount();
        uint256 before = USDC.balanceOf(address(this));
        IUSDCReceive(address(USDC))
            .receiveWithAuthorization(from, address(this), value, validAfter, validBefore, nonce, signature);
        _mintChecked(from, from, value, before);
    }

    // ---------------- unwrap (burn) ----------------

    function unwrap(uint256 amount) external {
        _burnAndPay(msg.sender, msg.sender, amount);
    }

    function unwrapTo(address to, uint256 amount) external {
        _burnAndPay(msg.sender, to, amount);
    }

    /// @notice Gasless redemption: `from` signs UnwrapWithAuthorization (EIP-712, this contract's domain; shares the
    ///         EIP-3009 nonce space). Anyone may submit; burn from `from`, then pay `to`.
    function unwrapWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        _useAuthorization(
            UNWRAP_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, signature
        );
        _burnAndPay(from, to, value);
    }

    // ---------------- EIP-3009 (FiatToken v2.2 signatures) ----------------

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) public {
        _useAuthorization(
            TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, signature
        );
        _transfer(from, to, value);
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, abi.encodePacked(r, s, v));
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) public {
        if (msg.sender != to) revert CallerMustBePayee();
        _useAuthorization(
            RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce, signature
        );
        _transfer(from, to, value);
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        receiveWithAuthorization(from, to, value, validAfter, validBefore, nonce, abi.encodePacked(r, s, v));
    }

    function cancelAuthorization(address authorizer, bytes32 nonce, bytes memory signature) public {
        if (_authorizationStates[authorizer][nonce]) revert AuthorizationAlreadyUsed();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce)));
        if (!SignatureChecker.isValidSignatureNow(authorizer, digest, signature)) revert InvalidSignature();
        _authorizationStates[authorizer][nonce] = true;
        emit AuthorizationCanceled(authorizer, nonce);
    }

    function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external {
        cancelAuthorization(authorizer, nonce, abi.encodePacked(r, s, v));
    }

    // ---------------- proof of reserve ----------------

    function reserve() public view returns (uint256) {
        return USDC.balanceOf(address(this));
    }

    function surplus() external view returns (uint256) {
        return reserve() - totalSupply();
    }

    function isFullyBacked() external view returns (bool) {
        return reserve() >= totalSupply();
    }

    function backing() external view returns (uint256 reserve_, uint256 supply_) {
        return (reserve(), totalSupply());
    }

    // ---------------- internal ----------------

    function _pullAndMint(address payer, address to, uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();
        uint256 before = USDC.balanceOf(address(this));
        USDC.safeTransferFrom(payer, address(this), amount);
        _mintChecked(payer, to, amount, before);
    }

    /// @dev The only _mint call site. Mints exactly the measured USDC inflow; reverts on any mismatch.
    function _mintChecked(address payer, address to, uint256 amount, uint256 before) internal {
        if (to == address(0)) revert ZeroAddress();
        uint256 got = USDC.balanceOf(address(this)) - before;
        if (got != amount) revert PullMismatch(amount, got);
        _mint(to, amount);
        emit Wrapped(payer, to, amount);
        _checkReserve();
    }

    function _burnAndPay(address from, address to, uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();
        if (to == address(0) || to == address(this)) revert ZeroAddress();
        _burn(from, amount);
        USDC.safeTransfer(to, amount);
        emit Unwrapped(from, to, amount);
        _checkReserve();
    }

    function _checkReserve() internal view {
        uint256 bal = USDC.balanceOf(address(this));
        uint256 sup = totalSupply();
        if (bal < sup) revert ReserveShortfall(bal, sup);
    }

    function _useAuthorization(
        bytes32 typehash,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) internal {
        if (block.timestamp <= validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        if (_authorizationStates[from][nonce]) revert AuthorizationAlreadyUsed();
        bytes32 digest =
            _hashTypedDataV4(keccak256(abi.encode(typehash, from, to, value, validAfter, validBefore, nonce)));
        if (!SignatureChecker.isValidSignatureNow(from, digest, signature)) revert InvalidSignature();
        _authorizationStates[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
    }

    /// @dev Transfers to this contract would strand AGC (no admin can sweep it): use unwrap instead.
    function _update(address from, address to, uint256 value) internal override {
        if (to == address(this)) revert UseUnwrap();
        super._update(from, to, value);
    }
}
