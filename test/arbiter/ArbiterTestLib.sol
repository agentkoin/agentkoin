// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAuthCaptureEscrow} from "../../src/arbiter/IAuthCaptureEscrow.sol";
import {AgentKoinAuthCaptureArbiter} from "../../src/arbiter/AgentKoinAuthCaptureArbiter.sol";

interface IERC3009Domain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// Shared helpers for the arbiter unit and fork tests: build a terms-committed PaymentInfo and sign the
/// client's ERC-3009 ReceiveWithAuthorization exactly as the x402 auth-capture EVM client does
/// (to = ERC3009PaymentCollector, value = maxAmount, validAfter = 0, validBefore = preApprovalExpiry,
/// nonce = escrow.getHash(paymentInfo with payer = 0)).
abstract contract ArbiterTestBase is Test {
    bytes32 internal constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    /// [0, 2500, 5000, 7500, 10000] for requiredTotal 4 (job 2 shape), JobEscrow v0.6 packing.
    uint256 internal constant JOB2_TABLE = 0x27101d4c138809c40000;
    /// sha256 of the canonical result bytes the receiver commits at submit (v0.2 resultDigest).
    // = sha256("agentkoin sample result bytes v1"); a literal so it is not a precompile call that eats vm.prank.
    bytes32 internal constant RD = 0x5ae62e9041ae216f5a434479e59aeced7bc8e107088c1ab0b39cb6b9db385386;

    function _terms(address evaluator, uint48 submitBy, uint32 evalWindow)
        internal
        pure
        returns (AgentKoinAuthCaptureArbiter.Terms memory t)
    {
        t = AgentKoinAuthCaptureArbiter.Terms({
            evaluator: evaluator,
            criteriaHash: keccak256("criteria.json"),
            scheduleHash: keccak256("schedule.json"),
            requiredTotal: 4,
            bpsTable: JOB2_TABLE,
            submitBy: submitBy,
            evalWindow: evalWindow
        });
    }

    function _paymentInfo(
        AgentKoinAuthCaptureArbiter arbiter,
        address payer,
        address receiver,
        address token,
        uint120 maxAmount,
        uint48 preApprovalExpiry,
        uint48 authorizationExpiry,
        AgentKoinAuthCaptureArbiter.Terms memory t,
        uint256 saltNonce
    ) internal view returns (IAuthCaptureEscrow.PaymentInfo memory p) {
        p = IAuthCaptureEscrow.PaymentInfo({
            operator: address(arbiter),
            payer: payer,
            receiver: receiver,
            token: token,
            maxAmount: maxAmount,
            preApprovalExpiry: preApprovalExpiry,
            authorizationExpiry: authorizationExpiry,
            refundExpiry: authorizationExpiry,
            minFeeBps: 0,
            maxFeeBps: 0,
            feeReceiver: address(0),
            salt: arbiter.termsSalt(_termsHashCalldata(arbiter, t), saltNonce)
        });
    }

    function _termsHashCalldata(AgentKoinAuthCaptureArbiter arbiter, AgentKoinAuthCaptureArbiter.Terms memory t)
        internal
        view
        returns (bytes32)
    {
        return arbiter.termsHash(t);
    }

    function _sign3009(
        IAuthCaptureEscrow escrow,
        address token,
        uint256 payerKey,
        address collector,
        IAuthCaptureEscrow.PaymentInfo memory p
    ) internal view returns (bytes memory) {
        address payer = p.payer;
        p.payer = address(0);
        bytes32 nonce = escrow.getHash(p);
        p.payer = payer;
        bytes32 structHash = keccak256(
            abi.encode(
                RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
                payer,
                collector,
                uint256(p.maxAmount),
                uint256(0),
                uint256(p.preApprovalExpiry),
                nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", IERC3009Domain(token).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerKey, digest);
        return abi.encodePacked(r, s, v);
    }
}
