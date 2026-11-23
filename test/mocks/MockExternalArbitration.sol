// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {
    IERC792Arbitrator,
    IERC792Arbitrable,
    IOptimisticOracleV3,
    IOptimisticOracleV3CallbackRecipient
} from "../../src/arbitration/IExternalArbitration.sol";

/// TEST ONLY: ERC-792 arbitrator that charges a native fee and lets the test give rulings.
contract MockERC792Arbitrator is IERC792Arbitrator {
    uint256 public cost;
    uint256 public count;
    mapping(uint256 => address) public arbitrableOf;

    constructor(uint256 cost_) {
        cost = cost_;
    }

    function arbitrationCost(bytes calldata) external view returns (uint256) {
        return cost;
    }

    function createDispute(uint256, bytes calldata) external payable returns (uint256 id) {
        require(msg.value >= cost, "fee");
        id = ++count;
        arbitrableOf[id] = msg.sender;
    }

    function giveRuling(uint256 id, uint256 ruling) external {
        IERC792Arbitrable(arbitrableOf[id]).rule(id, ruling);
    }
}

/// TEST ONLY: OOv3 that holds the bond and lets the test resolve assertions.
contract MockOptimisticOracleV3 is IOptimisticOracleV3 {
    struct A {
        address asserter;
        address callback;
        IERC20 currency;
        uint256 bond;
        bytes claim;
        bool settled;
    }

    uint256 public minBond;
    uint256 public count;
    mapping(bytes32 => A) public assertions;

    constructor(uint256 minBond_) {
        minBond = minBond_;
    }

    function getMinimumBond(address) external view returns (uint256) {
        return minBond;
    }

    function defaultIdentifier() external pure returns (bytes32) {
        return "ASSERT_TRUTH";
    }

    function assertTruth(
        bytes calldata claim,
        address asserter,
        address callbackRecipient,
        address,
        uint64,
        IERC20 currency,
        uint256 bond,
        bytes32,
        bytes32
    ) external returns (bytes32 id) {
        require(bond >= minBond, "bond");
        if (bond > 0) require(currency.transferFrom(msg.sender, address(this), bond), "pull");
        id = keccak256(abi.encode(++count));
        assertions[id] = A(asserter, callbackRecipient, currency, bond, claim, false);
    }

    function claimOf(bytes32 id) external view returns (bytes memory) {
        return assertions[id].claim;
    }

    /// truthful: bond back to asserter; false: bond kept (as if a disputer won).
    function resolve(bytes32 id, bool truthful) external {
        A storage a = assertions[id];
        require(!a.settled, "settled");
        a.settled = true;
        if (truthful && a.bond > 0) require(a.currency.transfer(a.asserter, a.bond), "push");
        IOptimisticOracleV3CallbackRecipient(a.callback).assertionResolvedCallback(id, truthful);
    }
}
