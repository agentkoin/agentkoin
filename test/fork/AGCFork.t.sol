// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AGCStackBuilder} from "../../script/DeployAGC.s.sol";
import {JobEscrow} from "../../src/JobEscrow.sol";
import {EscrowDepositRouteFactory} from "../../src/EscrowDepositRoute.sol";
import {CrossCurrencySettler} from "../../src/CrossCurrencySettler.sol";

interface IDomain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// Local fork of Base Sepolia (read-only RPC; nothing is broadcast). Runs only with FORK_BASE_SEPOLIA_RPC set:
///   FORK_BASE_SEPOLIA_RPC=https://sepolia.base.org forge test --match-path test/fork/AGCFork.t.sol
/// Builds the AGC stack from the live USDC stack's parameters (same code path as DeployAGC) on the fork, then pays
/// through the LIVE CrossCurrencySettler with real Circle USDC/EURC and the Uniswap v3 EURC/USDC 0.05% pool.
contract AGCForkTest is Test, AGCStackBuilder {
    address constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address constant EURC = 0x808456652fdb597867f38412077A9182bf77359F;
    address constant USDC_ESCROW = 0x4EaF6d09F8C22980Bb16E719779ACe73A7b1CB3D;
    address constant FACTORY = 0x32174eFD01e600E621Cf3f0D19Ff694483B19b95;
    address constant SETTLER = 0x6258D112bf27006287253424a1fa877C607B564a; // live, immutable
    address constant OWNER = 0x78e2C0164A80F3e337AE17e3bA4b8EA2C0Fa488e;
    address constant PROVIDER = 0x745528C4E0CBdA5759175A660da06d0aaA72db7F;
    bytes32 constant RECEIVE_TH = 0xd099cc98ef71107a616c4f0f941f04c322d8e254fe26b3c6668db87aae413de8;
    bytes32 constant TRANSFER_TH = 0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267;

    Stack s;
    bool enabled;
    uint256 buyerPk = 0xA11CE;
    address buyer;
    address evaluator = makeAddr("fork-evaluator");

    function setUp() public {
        string memory rpc = vm.envOr("FORK_BASE_SEPOLIA_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        enabled = true;
        vm.createSelectFork(rpc);
        buyer = vm.addr(buyerPk);
        s = _buildAGCStack(
            USDC,
            JobEscrow(USDC_ESCROW),
            EscrowDepositRouteFactory(FACTORY),
            OWNER,
            address(this),
            uint64(vm.getNonce(address(this))),
            address(vm)
        );
        deal(USDC, evaluator, 10_000_000, false); // local fork only
        deal(USDC, buyer, 10_000_000, false);
        deal(EURC, buyer, 1_000_000, false);
        vm.startPrank(evaluator);
        IERC20(USDC).approve(address(s.agc), type(uint256).max);
        s.agc.wrap(5_000_000);
        IERC20(address(s.agc)).approve(address(s.registry), type(uint256).max);
        s.registry.stake(s.registry.minStake());
        vm.stopPrank();
    }

    function _q(uint256 amountIn, uint256 minOut, address ev)
        internal
        view
        returns (CrossCurrencySettler.Quote memory)
    {
        return CrossCurrencySettler.Quote({
            buyer: buyer,
            tokenIn: EURC,
            tokenOut: USDC,
            amountIn: amountIn,
            minOut: minOut,
            poolFee: 500,
            expiry: uint64(block.timestamp + 300),
            quoteId: keccak256("agc-fork"),
            recipient: PROVIDER,
            escrow: address(s.adapter),
            evaluator: ev,
            deadlineSeconds: 3600,
            specHash: keccak256("fork-spec")
        });
    }

    function _sign(CrossCurrencySettler.Quote memory q) internal view returns (CrossCurrencySettler.Auth memory a) {
        uint256 vb = block.timestamp + 600;
        bytes32 sh = keccak256(
            abi.encode(RECEIVE_TH, q.buyer, SETTLER, q.amountIn, 0, vb, CrossCurrencySettler(SETTLER).quoteHash(q))
        );
        (uint8 v, bytes32 r, bytes32 ss) =
            vm.sign(buyerPk, keccak256(abi.encodePacked("\x19\x01", IDomain(EURC).DOMAIN_SEPARATOR(), sh)));
        a = CrossCurrencySettler.Auth({validAfter: 0, validBefore: vb, v: v, r: r, s: ss});
    }

    function test_Fork_StackMirrorsLiveConfig() public view {
        if (!enabled) return;
        assertEq(address(s.agc.USDC()), USDC);
        assertTrue(s.registry.isSlasher(address(s.escrow)));
        assertEq(s.escrow.currentConfig().feeBps, 0);
        assertEq(s.escrow.currentConfig().evaluatorFeeBps, JobEscrow(USDC_ESCROW).currentConfig().evaluatorFeeBps);
        assertEq(s.registry.minStake(), 2_000_000);
        // AD-011: no STOS admin, arbitrator or fee/treasury recipient on the AGC stack
        assertEq(s.escrow.owner(), NO_RECIPIENT);
        assertEq(s.registry.owner(), NO_RECIPIENT);
        assertEq(s.escrow.treasury(), NO_RECIPIENT);
        assertEq(s.registry.config().treasury, NO_RECIPIENT);
        assertEq(s.factory.vault().treasury(), NO_RECIPIENT);
        assertEq(address(s.escrow.arbitrator()), address(0));
        assertGe(s.registry.stakeOf(evaluator), s.registry.minStake());
    }

    /// Gas of the five CREATEs (same builder as DeployAGC), for the deploy plan's estimate.
    function test_Fork_DeployGas() public {
        if (!enabled) return;
        uint256 g = gasleft();
        _buildAGCStack(
            USDC,
            JobEscrow(USDC_ESCROW),
            EscrowDepositRouteFactory(FACTORY),
            OWNER,
            address(this),
            uint64(vm.getNonce(address(this))),
            address(vm)
        );
        emit log_named_uint("AGC stack deploy gas (execution, excl. 21k/tx intrinsic)", g - gasleft());
        emit log_named_uint("base fee (wei) at fork block", block.basefee);
    }

    function test_Fork_WrapUnwrap_RealUSDC() public {
        if (!enabled) return;
        vm.startPrank(buyer);
        IERC20(USDC).approve(address(s.agc), 1_000_000);
        s.agc.wrap(1_000_000);
        s.agc.unwrap(400_000);
        vm.stopPrank();
        assertEq(IERC20(address(s.agc)).balanceOf(buyer), 600_000);
        assertGe(IERC20(USDC).balanceOf(address(s.agc)), s.agc.totalSupply());
    }

    function test_Fork_EURCtoAGC_EscrowAndConvert_ViaLiveSettler() public {
        if (!enabled) return;
        CrossCurrencySettler.Quote memory q = _q(10_000, 9_000, evaluator);
        (bool ok, uint256 out, uint256 id) = CrossCurrencySettler(SETTLER).settle(q, _sign(q));
        assertTrue(ok);
        assertGt(id, 0);
        assertEq(s.escrow.getJob(id).client, buyer);
        assertEq(s.escrow.getJob(id).amount, out);
        CrossCurrencySettler.Quote memory c = _q(10_000, 9_000, address(s.adapter));
        c.recipient = buyer;
        c.quoteId = keccak256("agc-fork-convert");
        (ok, out, id) = CrossCurrencySettler(SETTLER).settle(c, _sign(c));
        assertTrue(ok);
        assertEq(id, 0);
        assertEq(IERC20(address(s.agc)).balanceOf(buyer), out);
        assertGe(IERC20(USDC).balanceOf(address(s.agc)), s.agc.totalSupply());
    }

    function test_Fork_SwapFailure_RefundsEURC_NoAGC() public {
        if (!enabled) return;
        uint256 sup = s.agc.totalSupply();
        uint256 e0 = IERC20(EURC).balanceOf(buyer);
        CrossCurrencySettler.Quote memory q = _q(10_000, 1_000_000, evaluator);
        (bool ok,,) = CrossCurrencySettler(SETTLER).settle(q, _sign(q));
        assertFalse(ok);
        assertEq(IERC20(EURC).balanceOf(buyer), e0);
        assertEq(s.agc.totalSupply(), sup);
    }

    function test_Fork_AGCExact_RouteOpensJob() public {
        if (!enabled) return;
        vm.startPrank(buyer);
        IERC20(USDC).approve(address(s.agc), 10_000);
        s.agc.wrap(10_000);
        vm.stopPrank();
        EscrowDepositRouteFactory.Offer memory o = EscrowDepositRouteFactory.Offer({
            provider: PROVIDER,
            evaluator: evaluator,
            amount: 10_000,
            deadlineSeconds: 3600,
            specHash: keccak256("fork-spec")
        });
        address payTo = s.factory.routeFor(o);
        uint256 vb = block.timestamp + 300;
        bytes32 sh = keccak256(abi.encode(TRANSFER_TH, buyer, payTo, uint256(10_000), uint256(0), vb, keccak256("n")));
        (uint8 v, bytes32 r, bytes32 ss) =
            vm.sign(buyerPk, keccak256(abi.encodePacked("\x19\x01", s.agc.DOMAIN_SEPARATOR(), sh)));
        (, uint256 id) = s.factory.settle(o, buyer, 10_000, 0, vb, keccak256("n"), abi.encodePacked(r, ss, v));
        assertEq(s.escrow.getJob(id).client, buyer);
        assertEq(s.escrow.getJob(id).amount, 10_000);
    }
}
