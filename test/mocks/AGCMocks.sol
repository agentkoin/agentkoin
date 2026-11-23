// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// TEST ONLY: 6-decimal token with EIP-2612 permit (stands in for USDC's permit in wrapWithPermit tests).
contract PermitUSDC is ERC20, ERC20Permit {
    constructor() ERC20("Permit USDC (test only)", "pUSDC") ERC20Permit("Permit USDC (test only)") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// TEST ONLY: 6-decimal token that burns 1 unit on every transferFrom (fee-on-transfer behaviour change).
contract FeeOnTransferUSDC is ERC20 {
    constructor() ERC20("Fee USDC (test only)", "fUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        _spendAllowance(from, msg.sender, value);
        _transfer(from, to, value - 1);
        _burn(from, 1);
        return true;
    }
}

/// TEST ONLY: 18-decimal token (AGC constructor must reject it).
contract EighteenDecimals is ERC20 {
    constructor() ERC20("E18 (test only)", "E18") {}
}

/// TEST ONLY: minimal ERC-1271 smart wallet controlled by one EOA key.
contract Wallet1271 {
    address public immutable signer;

    constructor(address signer_) {
        signer = signer_;
    }

    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        (address rec, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, sig);
        return err == ECDSA.RecoverError.NoError && rec == signer ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}
