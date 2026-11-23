// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {console2} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {EscrowDepositRoute, EscrowDepositRouteFactory} from "../src/EscrowDepositRoute.sol";
import {Defaults} from "../script/Defaults.sol";

/// Measurement-only proxy for docs/A-1e-commitment-routes.md: an EIP-1167 clone whose initializer
/// stores what a per-payment commitment route would need (offer + payer/value/nonce/validBefore +
/// approval). NOT a protocol contract; it only prices "one fresh route per payment" as a clone.
contract CommitRouteCloneProbe {
    using SafeERC20 for IERC20;

    address public payer;
    uint256 public value;
    bytes32 public nonce;
    uint256 public validBefore;
    address public provider;
    address public evaluator;
    uint256 public amount;
    uint64 public deadlineSeconds;
    bytes32 public specHash;
    bool internal init;

    function initialize(IERC20 t, address escrow, address[3] calldata a, uint256[3] calldata u, bytes32[2] calldata b)
        external
    {
        require(!init);
        init = true;
        (payer, provider, evaluator) = (a[0], a[1], a[2]);
        (value, validBefore, amount) = (u[0], u[1], u[2]);
        (nonce, specHash) = (b[0], b[1]);
        deadlineSeconds = 1 days;
        t.forceApprove(escrow, type(uint256).max);
    }
}

/// Gas measurements for A-1e (printed with -vv). Each test also asserts the measured path works.
contract GasA1eTest is BaseTest {
    EscrowDepositRouteFactory internal f;
    address internal payer;
    uint256 internal pk;

    function setUp() public override {
        super.setUp();
        f = _newFactory(Defaults.ROUTE_SWEEP_DELAY, treasury);
        (payer, pk) = makeAddrAndKey("payer");
        usdc.mint(payer, 100 * USDC);
    }

    function _offer(bytes32 spec) internal view returns (EscrowDepositRouteFactory.Offer memory) {
        return EscrowDepositRouteFactory.Offer({
            provider: provider, evaluator: evaluator, amount: 2 * USDC, deadlineSeconds: 1 days, specHash: spec
        });
    }

    function _sign(address to, bytes32 nonce) internal view returns (bytes memory) {
        bytes32 sh = keccak256(
            abi.encode(
                usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), payer, to, 2 * USDC, 0, block.timestamp + 1 hours, nonce
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), sh)));
        return abi.encodePacked(r, s, v);
    }

    function test_Gas_A1e_SettleColdVsWarm_Attest_CloneProbe() public {
        EscrowDepositRouteFactory.Offer memory o = _offer(SPEC);
        address route = f.routeFor(o);
        uint256 vb = block.timestamp + 1 hours;
        bytes memory s1 = _sign(route, bytes32(uint256(1)));
        uint256 g = gasleft();
        f.settle(o, payer, 2 * USDC, 0, vb, bytes32(uint256(1)), s1);
        uint256 cold = g - gasleft();
        bytes memory s2 = _sign(route, bytes32(uint256(2)));
        g = gasleft();
        f.settle(o, payer, 2 * USDC, 0, vb, bytes32(uint256(2)), s2);
        uint256 warm = g - gasleft();
        console2.log("settle, route not deployed (CREATE2 deploy + settle):", cold);
        console2.log("settle, route already deployed:", warm);
        console2.log("=> full route deployment overhead per new route:", cold - warm);

        usdc.mint(route, 2 * USDC);
        vm.prank(keeper);
        g = gasleft();
        f.attestDeposit(o, keccak256("t"), 0, payer, 2 * USDC, false);
        console2.log("attestDeposit vote 1 of 2 (records only):", g - gasleft());
        vm.prank(keeper2);
        g = gasleft();
        (bool credited,,) = f.attestDeposit(o, keccak256("t"), 0, payer, 2 * USDC, false);
        console2.log("attestDeposit vote 2 of 2 (credits: job opened, route deployed):", g - gasleft());
        assertTrue(credited);

        // v0.1.2 RecoveryVault claim: a deposit swept into the vault, then 2-of-3 attested
        usdc.mint(route, 2 * USDC);
        vm.prank(keeper);
        EscrowDepositRoute(route).startSweep();
        vm.warp(block.timestamp + Defaults.ROUTE_SWEEP_DELAY);
        g = gasleft();
        EscrowDepositRoute(route).sweep();
        console2.log("sweep into RecoveryVault:", g - gasleft());
        vm.prank(keeper);
        f.attestDeposit(o, keccak256("t2"), 0, payer, 2 * USDC, true);
        vm.prank(keeper2);
        g = gasleft();
        f.attestDeposit(o, keccak256("t2"), 0, payer, 2 * USDC, true);
        console2.log("attestDeposit vote 2 of 2 paid from RecoveryVault:", g - gasleft());
        assertEq(f.vault().unclaimed(route), 0);

        CommitRouteCloneProbe impl = new CommitRouteCloneProbe();
        g = gasleft();
        address cl = Clones.cloneDeterministic(address(impl), keccak256("salt"));
        CommitRouteCloneProbe(cl)
            .initialize(
                usdc,
                address(escrow),
                [payer, provider, evaluator],
                [uint256(2 * USDC), vb, 2 * USDC],
                [bytes32(uint256(3)), SPEC]
            );
        console2.log("EIP-1167 clone + initialize (commitment-route proxy):", g - gasleft());
        assertEq(CommitRouteCloneProbe(cl).payer(), payer);
    }
}
