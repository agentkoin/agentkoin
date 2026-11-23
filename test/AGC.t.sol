// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {BaseTest} from "./Base.t.sol";
import {AGC} from "../src/AGC.sol";
import {AGCSettlerAdapter, IJobEscrowAGC} from "../src/AGCSettlerAdapter.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {EvaluatorRegistry} from "../src/EvaluatorRegistry.sol";
import {EscrowDepositRouteFactory} from "../src/EscrowDepositRoute.sol";
import {IEvaluatorRegistry} from "../src/interfaces/IEvaluatorRegistry.sol";
import {IArbitrator} from "../src/interfaces/IArbitrator.sol";
import {CrossCurrencySettler} from "../src/CrossCurrencySettler.sol";
import {ISwapRouterV3} from "../src/interfaces/ISwapRouterV3.sol";
import {MockEURC} from "../src/mocks/MockEURC.sol";
import {MockSwapRouter} from "../src/mocks/MockSwapRouter.sol";
import {Defaults} from "../script/Defaults.sol";
import {PermitUSDC, FeeOnTransferUSDC, EighteenDecimals, Wallet1271} from "./mocks/AGCMocks.sol";

/// AD-010 Stage 2: AGC unit tests and the AGC escrow stack (registry, escrow, route factory, settler adapter) on mocks.
contract AGCTest is BaseTest {
    AGC internal agc;
    EvaluatorRegistry internal agcRegistry;
    JobEscrow internal agcEscrow;
    EscrowDepositRouteFactory internal agcFactory;
    AGCSettlerAdapter internal agcAdapter;

    uint256 internal alicePk = 0xA11CE;
    address internal alice;
    address internal relayer = makeAddr("relayer");
    address internal bob = makeAddr("bob");

    uint256 internal constant PRICE = 10_000; // 0.01 USDC / AGC, the notary price

    function setUp() public override {
        super.setUp();
        alice = vm.addr(alicePk);
        agc = new AGC(IERC20(address(usdc)));
        // DeployAGC order: registry names the escrow (next CREATE) as its only initial slasher (no timelock wait).
        address predictedEscrow = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        address[] memory slashers = new address[](1);
        slashers[0] = predictedEscrow;
        agcRegistry = new EvaluatorRegistry(
            IERC20(address(agc)), Defaults.registryConfig(treasury), owner, slashers, Defaults.SLASHER_TIMELOCK
        );
        JobEscrow.Config memory c = Defaults.escrowConfig();
        c.feeBps = 0;
        c.evaluatorFeeBps = 0;
        agcEscrow = new JobEscrow(
            IERC20(address(agc)),
            IEvaluatorRegistry(address(agcRegistry)),
            treasury,
            IArbitrator(address(arb)),
            c,
            owner, owner, type(uint256).max, type(uint256).max
        );
        require(address(agcEscrow) == predictedEscrow, "escrow prediction");
        address[] memory ks = new address[](1);
        ks[0] = keeper;
        agcFactory = new EscrowDepositRouteFactory(
            IERC20(address(agc)),
            address(agcEscrow),
            owner,
            EscrowDepositRouteFactory.Config({
                sweepDelay: Defaults.ROUTE_SWEEP_DELAY,
                treasury: treasury,
                recoveryHorizon: Defaults.RECOVERY_HORIZON,
                keeperTimelock: Defaults.KEEPER_TIMELOCK,
                threshold: 1
            }),
            ks
        );
        agcAdapter = new AGCSettlerAdapter(agc, IJobEscrowAGC(address(agcEscrow)));
        usdc.mint(alice, 1_000 * USDC);
        // evaluator wraps and stakes AGC in the AGC registry (its USDC stake in the USDC registry is untouched)
        vm.startPrank(evaluator);
        usdc.approve(address(agc), type(uint256).max);
        agc.wrap(100 * USDC);
        agc.approve(address(agcRegistry), type(uint256).max);
        agcRegistry.stake(100 * USDC);
        vm.stopPrank();
    }

    // ---------------- helpers ----------------

    function _sig(
        uint256 pk,
        bytes32 domain,
        bytes32 typehash,
        address from,
        address to,
        uint256 value,
        uint256 va,
        uint256 vb,
        bytes32 nonce
    ) internal pure returns (bytes memory) {
        bytes32 sh = keccak256(abi.encode(typehash, from, to, value, va, vb, nonce));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", domain, sh)));
        return abi.encodePacked(r, s, v);
    }

    function _agcSig(bytes32 typehash, address to, uint256 value, uint256 va, uint256 vb, bytes32 nonce)
        internal
        view
        returns (bytes memory)
    {
        return _sig(alicePk, agc.DOMAIN_SEPARATOR(), typehash, alice, to, value, va, vb, nonce);
    }

    function _wrapAlice(uint256 amount) internal {
        vm.startPrank(alice);
        usdc.approve(address(agc), amount);
        agc.wrap(amount);
        vm.stopPrank();
    }

    function _assertBacked() internal view {
        assertGe(usdc.balanceOf(address(agc)), agc.totalSupply(), "reserve >= supply");
        (uint256 r, uint256 s) = agc.backing();
        assertEq(r, usdc.balanceOf(address(agc)));
        assertEq(s, agc.totalSupply());
        assertTrue(agc.isFullyBacked());
    }

    function _count(bytes memory hay, bytes memory needle) internal pure returns (uint256 n) {
        if (hay.length < needle.length) return 0;
        for (uint256 i = 0; i <= hay.length - needle.length; i++) {
            bool m = true;
            for (uint256 j = 0; j < needle.length; j++) {
                if (hay[i + j] != needle[j]) {
                    m = false;
                    break;
                }
            }
            if (m) n++;
        }
    }

    // ---------------- identity / constructor ----------------

    function test_Identity() public view {
        assertEq(agc.name(), "AgentCoin");
        assertEq(agc.symbol(), "AGC");
        assertEq(agc.decimals(), 6);
        assertEq(address(agc.USDC()), address(usdc));
        (, string memory n, string memory v, uint256 chainId, address vc,,) = agc.eip712Domain();
        assertEq(n, "AgentCoin");
        assertEq(v, "1");
        assertEq(chainId, block.chainid);
        assertEq(vc, address(agc));
        // typehashes byte-identical to Circle FiatToken v2.2 (MockUSDC mirrors them)
        assertEq(agc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), usdc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH());
        assertEq(agc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH());
        assertEq(agc.CANCEL_AUTHORIZATION_TYPEHASH(), usdc.CANCEL_AUTHORIZATION_TYPEHASH());
    }

    function test_Constructor_RejectsNon6Decimals() public {
        EighteenDecimals e = new EighteenDecimals();
        vm.expectRevert(abi.encodeWithSelector(AGC.UnsupportedDecimals.selector, uint8(18)));
        new AGC(IERC20(address(e)));
        vm.expectRevert(AGC.ZeroAddress.selector);
        new AGC(IERC20(address(0)));
    }

    // ---------------- wrap / unwrap ----------------

    function test_Wrap_Unwrap_1to1() public {
        uint256 s0 = agc.totalSupply();
        vm.startPrank(alice);
        usdc.approve(address(agc), 5 * USDC);
        vm.expectEmit(address(usdc));
        emit IERC20.Transfer(alice, address(agc), 5 * USDC);
        vm.expectEmit(address(agc));
        emit IERC20.Transfer(address(0), alice, 5 * USDC);
        agc.wrap(5 * USDC);
        assertEq(agc.balanceOf(alice), 5 * USDC);
        assertEq(agc.totalSupply(), s0 + 5 * USDC);
        vm.expectEmit(address(agc));
        emit IERC20.Transfer(alice, address(0), 2 * USDC);
        vm.expectEmit(address(usdc));
        emit IERC20.Transfer(address(agc), alice, 2 * USDC);
        agc.unwrap(2 * USDC);
        vm.stopPrank();
        assertEq(agc.balanceOf(alice), 3 * USDC);
        assertEq(usdc.balanceOf(alice), 997 * USDC);
        _assertBacked();
        assertEq(agc.surplus(), 0);
    }

    function test_WrapTo_UnwrapTo() public {
        vm.startPrank(alice);
        usdc.approve(address(agc), 4 * USDC);
        agc.wrapTo(bob, 4 * USDC);
        vm.stopPrank();
        assertEq(agc.balanceOf(bob), 4 * USDC);
        assertEq(agc.balanceOf(alice), 0);
        vm.prank(bob);
        agc.unwrapTo(alice, 1 * USDC);
        assertEq(usdc.balanceOf(alice), 997 * USDC);
        assertEq(agc.balanceOf(bob), 3 * USDC);
        _assertBacked();
    }

    function test_Wrap_ZeroAndUnbacked_Revert() public {
        vm.prank(alice);
        vm.expectRevert(AGC.ZeroAmount.selector);
        agc.wrap(0);
        vm.prank(alice);
        vm.expectRevert(); // no allowance
        agc.wrap(1);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, bob, 0, 1));
        agc.unwrap(1);
        vm.prank(alice);
        vm.expectRevert(AGC.ZeroAddress.selector);
        agc.unwrapTo(address(agc), 1);
    }

    function test_WrapWithPermit_AndFrontRunPermit() public {
        PermitUSDC p = new PermitUSDC();
        AGC a2 = new AGC(IERC20(address(p)));
        p.mint(alice, 10 * USDC);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 PERMIT_TH =
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
        bytes32 sh = keccak256(abi.encode(PERMIT_TH, alice, address(a2), 3 * USDC, p.nonces(alice), deadline));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(alicePk, keccak256(abi.encodePacked("\x19\x01", p.DOMAIN_SEPARATOR(), sh)));
        // front-runner consumes the permit first: wrapWithPermit still succeeds (allowance is set)
        p.permit(alice, address(a2), 3 * USDC, deadline, v, r, s);
        vm.prank(alice);
        a2.wrapWithPermit(3 * USDC, deadline, v, r, s);
        assertEq(a2.balanceOf(alice), 3 * USDC);
        // fresh permit, normal path
        sh = keccak256(abi.encode(PERMIT_TH, alice, address(a2), 2 * USDC, p.nonces(alice), deadline));
        (v, r, s) = vm.sign(alicePk, keccak256(abi.encodePacked("\x19\x01", p.DOMAIN_SEPARATOR(), sh)));
        vm.prank(alice);
        a2.wrapWithPermit(2 * USDC, deadline, v, r, s);
        assertEq(a2.balanceOf(alice), 5 * USDC);
        assertEq(p.balanceOf(address(a2)), a2.totalSupply());
    }

    function test_WrapWithAuthorization_RelayerSubmits_MintGoesToFrom() public {
        bytes32 nonce = keccak256("wrap-1");
        uint256 vb = block.timestamp + 10 minutes;
        bytes memory sig = _sig(
            alicePk,
            usdc.DOMAIN_SEPARATOR(),
            usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
            alice,
            address(agc),
            7 * USDC,
            0,
            vb,
            nonce
        );
        vm.expectEmit(address(agc));
        emit IERC20.Transfer(address(0), alice, 7 * USDC);
        vm.prank(relayer);
        agc.wrapWithAuthorization(alice, 7 * USDC, 0, vb, nonce, sig);
        assertEq(agc.balanceOf(alice), 7 * USDC);
        assertEq(agc.balanceOf(relayer), 0);
        assertTrue(usdc.authorizationState(alice, nonce));
        vm.prank(relayer);
        vm.expectRevert(); // USDC nonce used
        agc.wrapWithAuthorization(alice, 7 * USDC, 0, vb, nonce, sig);
        _assertBacked();
    }

    function test_UnwrapWithAuthorization_Gasless_SharesNonceSpace() public {
        _wrapAlice(10 * USDC);
        bytes32 nonce = keccak256("unwrap-1");
        uint256 vb = block.timestamp + 10 minutes;
        bytes memory sig = _agcSig(agc.UNWRAP_WITH_AUTHORIZATION_TYPEHASH(), bob, 4 * USDC, 0, vb, nonce);
        vm.prank(relayer);
        agc.unwrapWithAuthorization(alice, bob, 4 * USDC, 0, vb, nonce, sig);
        assertEq(usdc.balanceOf(bob), 4 * USDC);
        assertEq(agc.balanceOf(alice), 6 * USDC);
        assertTrue(agc.authorizationState(alice, nonce));
        // replay reverts; a transferWithAuthorization with the same nonce reverts too (one nonce space)
        vm.expectRevert(AGC.AuthorizationAlreadyUsed.selector);
        agc.unwrapWithAuthorization(alice, bob, 4 * USDC, 0, vb, nonce, sig);
        bytes memory tsig = _agcSig(agc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), bob, 1, 0, vb, nonce);
        vm.expectRevert(AGC.AuthorizationAlreadyUsed.selector);
        agc.transferWithAuthorization(alice, bob, 1, 0, vb, nonce, tsig);
        // relayer cannot redirect: changing `to` breaks the signature
        bytes32 n2 = keccak256("unwrap-2");
        bytes memory sig2 = _agcSig(agc.UNWRAP_WITH_AUTHORIZATION_TYPEHASH(), bob, 1 * USDC, 0, vb, n2);
        vm.expectRevert(AGC.InvalidSignature.selector);
        agc.unwrapWithAuthorization(alice, relayer, 1 * USDC, 0, vb, n2, sig2);
        _assertBacked();
    }

    // ---------------- permit / EIP-3009 ----------------

    function test_Permit() public {
        _wrapAlice(5 * USDC);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 PERMIT_TH =
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
        bytes32 sh = keccak256(abi.encode(PERMIT_TH, alice, bob, 2 * USDC, agc.nonces(alice), deadline));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(alicePk, keccak256(abi.encodePacked("\x19\x01", agc.DOMAIN_SEPARATOR(), sh)));
        agc.permit(alice, bob, 2 * USDC, deadline, v, r, s);
        assertEq(agc.allowance(alice, bob), 2 * USDC);
        vm.prank(bob);
        agc.transferFrom(alice, bob, 2 * USDC);
        assertEq(agc.balanceOf(bob), 2 * USDC);
    }

    function test_TransferWithAuthorization_BothOverloads() public {
        _wrapAlice(5 * USDC);
        uint256 vb = block.timestamp + 10 minutes;
        bytes memory sig =
            _agcSig(agc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), bob, 1 * USDC, 0, vb, bytes32(uint256(1)));
        vm.prank(relayer);
        agc.transferWithAuthorization(alice, bob, 1 * USDC, 0, vb, bytes32(uint256(1)), sig);
        bytes32 sh = keccak256(
            abi.encode(agc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), alice, bob, 1 * USDC, 0, vb, bytes32(uint256(2)))
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(alicePk, keccak256(abi.encodePacked("\x19\x01", agc.DOMAIN_SEPARATOR(), sh)));
        vm.prank(relayer);
        agc.transferWithAuthorization(alice, bob, 1 * USDC, 0, vb, bytes32(uint256(2)), v, r, s);
        assertEq(agc.balanceOf(bob), 2 * USDC);
        vm.expectRevert(AGC.AuthorizationAlreadyUsed.selector);
        agc.transferWithAuthorization(alice, bob, 1 * USDC, 0, vb, bytes32(uint256(2)), v, r, s);
    }

    function test_ReceiveWithAuthorization_CallerMustBePayee() public {
        _wrapAlice(5 * USDC);
        uint256 vb = block.timestamp + 10 minutes;
        bytes32 nonce = keccak256("recv");
        bytes memory sig = _agcSig(agc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), bob, 1 * USDC, 0, vb, nonce);
        vm.prank(relayer);
        vm.expectRevert(AGC.CallerMustBePayee.selector);
        agc.receiveWithAuthorization(alice, bob, 1 * USDC, 0, vb, nonce, sig);
        vm.prank(bob);
        agc.receiveWithAuthorization(alice, bob, 1 * USDC, 0, vb, nonce, sig);
        assertEq(agc.balanceOf(bob), 1 * USDC);
        // v,r,s overload
        bytes32 n2 = keccak256("recv2");
        bytes32 sh = keccak256(abi.encode(agc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(), alice, bob, 1 * USDC, 0, vb, n2));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(alicePk, keccak256(abi.encodePacked("\x19\x01", agc.DOMAIN_SEPARATOR(), sh)));
        vm.prank(bob);
        agc.receiveWithAuthorization(alice, bob, 1 * USDC, 0, vb, n2, v, r, s);
        assertEq(agc.balanceOf(bob), 2 * USDC);
    }

    function test_CancelAuthorization_BothOverloads() public {
        _wrapAlice(5 * USDC);
        uint256 vb = block.timestamp + 10 minutes;
        bytes32 nonce = keccak256("cancel");
        bytes32 csh = keccak256(abi.encode(agc.CANCEL_AUTHORIZATION_TYPEHASH(), alice, nonce));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(alicePk, keccak256(abi.encodePacked("\x19\x01", agc.DOMAIN_SEPARATOR(), csh)));
        agc.cancelAuthorization(alice, nonce, v, r, s);
        assertTrue(agc.authorizationState(alice, nonce));
        bytes memory sig = _agcSig(agc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), bob, 1, 0, vb, nonce);
        vm.expectRevert(AGC.AuthorizationAlreadyUsed.selector);
        agc.transferWithAuthorization(alice, bob, 1, 0, vb, nonce, sig);
        vm.expectRevert(AGC.AuthorizationAlreadyUsed.selector);
        agc.cancelAuthorization(alice, nonce, abi.encodePacked(r, s, v));
        bytes32 n2 = keccak256("cancel2");
        csh = keccak256(abi.encode(agc.CANCEL_AUTHORIZATION_TYPEHASH(), alice, n2));
        (v, r, s) = vm.sign(alicePk, keccak256(abi.encodePacked("\x19\x01", agc.DOMAIN_SEPARATOR(), csh)));
        agc.cancelAuthorization(alice, n2, abi.encodePacked(r, s, v));
        assertTrue(agc.authorizationState(alice, n2));
    }

    function test_Authorization_ExpiredAndNotYetValid() public {
        _wrapAlice(5 * USDC);
        uint256 t = block.timestamp;
        bytes memory early =
            _agcSig(agc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), bob, 1, t + 100, t + 200, bytes32(uint256(7)));
        vm.expectRevert(AGC.AuthorizationNotYetValid.selector);
        agc.transferWithAuthorization(alice, bob, 1, t + 100, t + 200, bytes32(uint256(7)), early);
        bytes memory late = _agcSig(agc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), bob, 1, 0, t, bytes32(uint256(8)));
        vm.expectRevert(AGC.AuthorizationExpired.selector);
        agc.transferWithAuthorization(alice, bob, 1, 0, t, bytes32(uint256(8)), late);
        vm.expectRevert(AGC.InvalidSignature.selector);
        agc.transferWithAuthorization(alice, bob, 2, 0, t + 200, bytes32(uint256(7)), early); // tampered value
    }

    function test_ERC1271_SmartWallet_Signs() public {
        Wallet1271 w = new Wallet1271(alice);
        usdc.mint(address(w), 3 * USDC);
        vm.startPrank(address(w));
        usdc.approve(address(agc), 3 * USDC);
        agc.wrap(3 * USDC);
        vm.stopPrank();
        uint256 vb = block.timestamp + 10 minutes;
        bytes memory sig = _sig(
            alicePk,
            agc.DOMAIN_SEPARATOR(),
            agc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(),
            address(w),
            bob,
            1 * USDC,
            0,
            vb,
            bytes32(uint256(9))
        );
        agc.transferWithAuthorization(address(w), bob, 1 * USDC, 0, vb, bytes32(uint256(9)), sig);
        assertEq(agc.balanceOf(bob), 1 * USDC);
        bytes memory usig = _sig(
            alicePk,
            agc.DOMAIN_SEPARATOR(),
            agc.UNWRAP_WITH_AUTHORIZATION_TYPEHASH(),
            address(w),
            address(w),
            1 * USDC,
            0,
            vb,
            bytes32(uint256(10))
        );
        agc.unwrapWithAuthorization(address(w), address(w), 1 * USDC, 0, vb, bytes32(uint256(10)), usig);
        assertEq(usdc.balanceOf(address(w)), 1 * USDC);
    }

    function test_TransferToContract_Reverts() public {
        _wrapAlice(5 * USDC);
        vm.startPrank(alice);
        vm.expectRevert(AGC.UseUnwrap.selector);
        agc.transfer(address(agc), 1);
        agc.approve(bob, 1);
        vm.stopPrank();
        vm.prank(bob);
        vm.expectRevert(AGC.UseUnwrap.selector);
        agc.transferFrom(alice, address(agc), 1);
        uint256 vb = block.timestamp + 10 minutes;
        bytes memory sig =
            _agcSig(agc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), address(agc), 1, 0, vb, bytes32(uint256(11)));
        vm.expectRevert(AGC.UseUnwrap.selector);
        agc.transferWithAuthorization(alice, address(agc), 1, 0, vb, bytes32(uint256(11)), sig);
    }

    // ---------------- no admin / reserve guard ----------------

    function test_NoAdminSelectors_InCompiledABI() public view {
        string memory j = vm.readFile("out/AGC.sol/AGC.json");
        string[] memory sigs = vm.parseJsonKeys(j, ".methodIdentifiers");
        assertGt(sigs.length, 20);
        string[9] memory banned =
            ["owner", "pause", "mint", "upgrade", "rescue", "blacklist", "set", "transferOwnership", "renounce"];
        for (uint256 i = 0; i < sigs.length; i++) {
            bytes memory s = bytes(sigs[i]);
            for (uint256 k = 0; k < banned.length; k++) {
                bytes memory b = bytes(banned[k]);
                bool prefix = s.length >= b.length;
                for (uint256 x = 0; prefix && x < b.length; x++) {
                    if (s[x] != b[x]) prefix = false;
                }
                assertFalse(prefix, sigs[i]);
            }
        }
        // low-level probes: common admin selectors are not callable (no fallback)
        bytes4[8] memory probes = [
            bytes4(keccak256("owner()")),
            bytes4(keccak256("pause()")),
            bytes4(keccak256("mint(address,uint256)")),
            bytes4(keccak256("upgradeTo(address)")),
            bytes4(keccak256("upgradeToAndCall(address,bytes)")),
            bytes4(keccak256("transferOwnership(address)")),
            bytes4(keccak256("blacklist(address)")),
            bytes4(keccak256("rescueERC20(address,address,uint256)"))
        ];
        for (uint256 i = 0; i < probes.length; i++) {
            (bool ok,) = address(agc).staticcall(abi.encodeWithSelector(probes[i], address(1), uint256(1)));
            assertFalse(ok);
        }
    }

    function test_OnlyOneMintCallSite_InSource() public view {
        bytes memory src = bytes(vm.readFile("src/AGC.sol"));
        assertEq(_count(src, bytes("_mint(")), 1);
        assertEq(_count(src, bytes("delegatecall")), 0);
        assertEq(_count(src, bytes("selfdestruct")), 0);
    }

    function test_EIP1967SlotsEmpty_NotAProxy() public view {
        bytes32 impl = bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1);
        bytes32 admin = bytes32(uint256(keccak256("eip1967.proxy.admin")) - 1);
        bytes32 beacon = bytes32(uint256(keccak256("eip1967.proxy.beacon")) - 1);
        assertEq(vm.load(address(agc), impl), bytes32(0));
        assertEq(vm.load(address(agc), admin), bytes32(0));
        assertEq(vm.load(address(agc), beacon), bytes32(0));
    }

    function test_FeeOnTransferUSDC_WrapReverts_PullMismatch() public {
        FeeOnTransferUSDC f = new FeeOnTransferUSDC();
        AGC a2 = new AGC(IERC20(address(f)));
        f.mint(alice, 10 * USDC);
        vm.startPrank(alice);
        f.approve(address(a2), 10 * USDC);
        vm.expectRevert(abi.encodeWithSelector(AGC.PullMismatch.selector, 5 * USDC, 5 * USDC - 1));
        a2.wrap(5 * USDC);
        vm.stopPrank();
        assertEq(a2.totalSupply(), 0);
    }

    function test_Donation_IsSurplus_NotMinted() public {
        _wrapAlice(5 * USDC);
        uint256 sup = agc.totalSupply();
        vm.prank(alice);
        usdc.transfer(address(agc), 1 * USDC);
        assertEq(agc.totalSupply(), sup);
        assertEq(agc.surplus(), 1 * USDC);
        _assertBacked();
    }

    // ---------------- AGC escrow stack ----------------

    function test_Registry_EscrowIsSlasherAtDeploy_EvaluatorStakedInAGC() public view {
        assertTrue(agcRegistry.isSlasher(address(agcEscrow)));
        assertFalse(agcRegistry.isSlasher(address(agcAdapter)));
        assertEq(address(agcRegistry.token()), address(agc));
        assertGe(agcRegistry.stakeOf(evaluator), agcRegistry.minStake());
        assertEq(registry.stakeOf(evaluator), 100 * USDC, "USDC registry stake untouched");
        assertEq(agcEscrow.currentConfig().feeBps, 0);
        assertEq(agcEscrow.currentConfig().evaluatorFeeBps, 0);
    }

    function test_AGCExact_ViaRoute_OpensJob_FeeZero() public {
        _wrapAlice(1 * USDC);
        EscrowDepositRouteFactory.Offer memory o = EscrowDepositRouteFactory.Offer({
            provider: provider, evaluator: evaluator, amount: PRICE, deadlineSeconds: 3600, specHash: SPEC
        });
        address payTo = agcFactory.routeFor(o);
        uint256 vb = block.timestamp + 5 minutes;
        bytes32 nonce = keccak256("x402-agc");
        bytes memory sig = _agcSig(agc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), payTo, PRICE, 0, vb, nonce);
        vm.prank(relayer);
        (address route, uint256 id) = agcFactory.settle(o, alice, PRICE, 0, vb, nonce, sig);
        assertEq(route, payTo);
        JobEscrow.Job memory j = agcEscrow.getJob(id);
        assertEq(j.client, alice);
        assertEq(j.amount, PRICE);
        vm.prank(provider);
        agcEscrow.submit(id, DELIVERABLE);
        vm.prank(evaluator);
        agcEscrow.verdict(id, JobEscrow.Outcome.Complete, 10_000, REASON);
        vm.warp(block.timestamp + 48 hours + 1);
        agcEscrow.finalize(id);
        assertEq(agc.balanceOf(provider), PRICE, "provider gets full amount");
        assertEq(agc.balanceOf(treasury), 0, "fee 0");
        _assertBacked();
    }

    MockEURC internal eurc;
    MockSwapRouter internal router;
    CrossCurrencySettler internal settler;

    function _swapSetup() internal {
        eurc = new MockEURC();
        router = new MockSwapRouter(owner, 0);
        vm.prank(owner);
        router.setRate(address(eurc), address(usdc), 1.0175e18, "test fixture");
        usdc.mint(address(router), 1_000 * USDC);
        settler = new CrossCurrencySettler(ISwapRouterV3(address(router)));
        eurc.mint(alice, 100 * USDC);
    }

    function _quote(uint256 amountIn, uint256 minOut, address evaluator_)
        internal
        view
        returns (CrossCurrencySettler.Quote memory q)
    {
        q = CrossCurrencySettler.Quote({
            buyer: alice,
            tokenIn: address(eurc),
            tokenOut: address(usdc),
            amountIn: amountIn,
            minOut: minOut,
            poolFee: 500,
            expiry: uint64(block.timestamp + 300),
            quoteId: keccak256("agc-quote"),
            recipient: provider,
            escrow: address(agcAdapter),
            evaluator: evaluator_,
            deadlineSeconds: 3600,
            specHash: SPEC
        });
    }

    function _signQuote(CrossCurrencySettler.Quote memory q)
        internal
        view
        returns (CrossCurrencySettler.Auth memory a)
    {
        uint256 vb = block.timestamp + 600;
        bytes32 sh = keccak256(
            abi.encode(
                eurc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                q.buyer,
                address(settler),
                q.amountIn,
                0,
                vb,
                settler.quoteHash(q)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(alicePk, keccak256(abi.encodePacked("\x19\x01", eurc.DOMAIN_SEPARATOR(), sh)));
        a = CrossCurrencySettler.Auth({validAfter: 0, validBefore: vb, v: v, r: r, s: s});
    }

    function test_EURCtoAGC_EscrowMode_OpensAGCJob() public {
        _swapSetup();
        CrossCurrencySettler.Quote memory q = _quote(9_883, 10_000, evaluator);
        uint256 sup = agc.totalSupply();
        vm.expectEmit(address(agc));
        emit IERC20.Transfer(address(0), address(agcAdapter), 10_055);
        (bool ok, uint256 out, uint256 id) = settler.settle(q, _signQuote(q));
        assertTrue(ok);
        assertEq(out, 10_055); // 9883 * 1.0175
        assertGt(id, 0);
        JobEscrow.Job memory j = agcEscrow.getJob(id);
        assertEq(j.client, alice);
        assertEq(j.provider, provider);
        assertEq(j.amount, out);
        assertEq(agc.totalSupply(), sup + out);
        assertEq(agc.balanceOf(address(agcAdapter)), 0);
        assertEq(usdc.balanceOf(address(agcAdapter)), 0);
        assertEq(usdc.allowance(address(agcAdapter), address(agc)), 0);
        assertEq(agc.allowance(address(agcAdapter), address(agcEscrow)), 0);
        assertEq(usdc.allowance(address(settler), address(agcAdapter)), 0);
        _assertBacked();
    }

    function test_EURCtoAGC_ConvertMode_PaysWallet_JobIdZero() public {
        _swapSetup();
        CrossCurrencySettler.Quote memory q = _quote(9_883, 10_000, address(agcAdapter));
        q.recipient = alice; // convert own EURC into AGC
        (bool ok, uint256 out, uint256 id) = settler.settle(q, _signQuote(q));
        assertTrue(ok);
        assertEq(id, 0);
        assertEq(agc.balanceOf(alice), out);
        assertEq(agc.balanceOf(address(agcAdapter)), 0);
        _assertBacked();
    }

    function test_EURCtoAGC_SwapFailure_RefundsEURC_NoMint() public {
        _swapSetup();
        CrossCurrencySettler.Quote memory q = _quote(9_883, 1_000_000, evaluator); // impossible minOut
        uint256 sup = agc.totalSupply();
        uint256 e0 = eurc.balanceOf(alice);
        // MockSwapRouter enforces amountOutMinimum, so the swap reverts inside the settler's try and is refunded
        (bool ok,, uint256 id) = settler.settle(q, _signQuote(q));
        assertFalse(ok);
        assertEq(id, 0);
        assertEq(eurc.balanceOf(alice), e0);
        assertEq(agc.totalSupply(), sup);
    }

    function test_TimeoutRelease_SlashesInAGC_ClaimRefundReturnsAGC() public {
        _wrapAlice(20 * USDC);
        vm.startPrank(alice);
        agc.approve(address(agcEscrow), type(uint256).max);
        uint256 id = agcEscrow.createAndFund(provider, evaluator, 5 * USDC, uint64(block.timestamp + 3 days), SPEC);
        uint256 id2 = agcEscrow.createAndFund(provider, evaluator, 3 * USDC, uint64(block.timestamp + 1 days), SPEC);
        vm.stopPrank();
        vm.prank(provider);
        agcEscrow.submit(id, DELIVERABLE);
        vm.warp(block.timestamp + 24 hours + 1);
        uint256 st0 = agcRegistry.stakeOf(evaluator);
        agcEscrow.timeoutRelease(id); // evaluator missed the verdict window
        assertLt(agcRegistry.stakeOf(evaluator), st0, "slashed in AGC");
        assertGt(agc.balanceOf(provider), 0);
        vm.warp(block.timestamp + 1 days);
        uint256 a0 = agc.balanceOf(alice);
        vm.prank(alice);
        agcEscrow.claimRefund(id2);
        assertEq(agc.balanceOf(alice), a0 + 3 * USDC);
        _assertBacked();
    }

    function test_Adapter_RejectsEscrowWithOtherToken() public {
        vm.expectRevert(AGCSettlerAdapter.EscrowTokenNotAGC.selector);
        new AGCSettlerAdapter(agc, IJobEscrowAGC(address(escrow)));
    }

    function testFuzz_WrapUnwrap_RoundTrip(uint128 amount, uint128 back) public {
        vm.assume(amount > 0);
        back = uint128(bound(back, 1, amount));
        usdc.mint(bob, amount);
        vm.startPrank(bob);
        usdc.approve(address(agc), amount);
        agc.wrap(amount);
        agc.unwrap(back);
        vm.stopPrank();
        assertEq(agc.balanceOf(bob), uint256(amount) - back);
        assertEq(usdc.balanceOf(bob), back);
        _assertBacked();
    }
}
