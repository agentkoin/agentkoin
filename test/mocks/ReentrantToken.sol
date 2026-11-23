// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice TEST ONLY. ERC-20 that, once armed, calls back into `target` when tokens leave `watch`.
contract ReentrantToken is ERC20 {
    address public watch;
    address public target;
    bytes public payload;
    bool public armed;
    bool public attempted;
    bool public lastOk;
    bytes public lastRet;

    constructor() ERC20("Reentrant", "RE") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address watch_, address target_, bytes calldata payload_) external {
        watch = watch_;
        target = target_;
        payload = payload_;
        armed = true;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed && from == watch) {
            armed = false;
            attempted = true;
            (lastOk, lastRet) = target.call(payload);
        }
    }
}
