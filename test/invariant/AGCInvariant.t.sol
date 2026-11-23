// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {AGC} from "../../src/AGC.sol";

/// Random wrap / wrapWithAuthorization / unwrap / unwrapWithAuthorization / transfer / transferWithAuthorization /
/// donation sequences over 4 actors, amounts up to 2^128.
contract AGCHandler is Test {
    MockUSDC public usdc;
    AGC public agc;
    uint256[4] internal pks = [uint256(0xA1), 0xA2, 0xA3, 0xA4];
    address[4] public actors;
    uint256 internal nonceSeq;
    uint256 public calls;

    constructor(MockUSDC usdc_, AGC agc_) {
        usdc = usdc_;
        agc = agc_;
        for (uint256 i = 0; i < 4; i++) {
            actors[i] = vm.addr(pks[i]);
        }
    }

    function _sig(uint256 pk, bytes32 domain, bytes32 th, address from, address to, uint256 v, bytes32 n)
        internal
        view
        returns (bytes memory)
    {
        bytes32 sh = keccak256(abi.encode(th, from, to, v, uint256(0), block.timestamp + 1 hours, n));
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", domain, sh)));
        return abi.encodePacked(r, s, vv);
    }

    function wrap(uint256 who, uint256 amount) external {
        address a = actors[who % 4];
        amount = bound(amount, 1, type(uint128).max);
        usdc.mint(a, amount);
        vm.startPrank(a);
        usdc.approve(address(agc), amount);
        agc.wrap(amount);
        vm.stopPrank();
        calls++;
    }

    function wrapWithAuthorization(uint256 who, uint256 amount) external {
        uint256 i = who % 4;
        amount = bound(amount, 1, type(uint128).max);
        usdc.mint(actors[i], amount);
        bytes32 n = bytes32(++nonceSeq);
        bytes memory sig = _sig(
            pks[i],
            usdc.DOMAIN_SEPARATOR(),
            usdc.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
            actors[i],
            address(agc),
            amount,
            n
        );
        agc.wrapWithAuthorization(actors[i], amount, 0, block.timestamp + 1 hours, n, sig);
        calls++;
    }

    function unwrap(uint256 who, uint256 amount) external {
        address a = actors[who % 4];
        uint256 bal = agc.balanceOf(a);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(a);
        agc.unwrap(amount);
        calls++;
    }

    function unwrapWithAuthorization(uint256 who, uint256 to, uint256 amount) external {
        uint256 i = who % 4;
        uint256 bal = agc.balanceOf(actors[i]);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        address dst = actors[to % 4];
        bytes32 n = bytes32(++nonceSeq);
        bytes memory sig =
            _sig(pks[i], agc.DOMAIN_SEPARATOR(), agc.UNWRAP_WITH_AUTHORIZATION_TYPEHASH(), actors[i], dst, amount, n);
        agc.unwrapWithAuthorization(actors[i], dst, amount, 0, block.timestamp + 1 hours, n, sig);
        calls++;
    }

    function transfer(uint256 who, uint256 to, uint256 amount) external {
        address a = actors[who % 4];
        amount = bound(amount, 0, agc.balanceOf(a));
        vm.prank(a);
        agc.transfer(actors[to % 4], amount);
        calls++;
    }

    function transferWithAuthorization(uint256 who, uint256 to, uint256 amount) external {
        uint256 i = who % 4;
        amount = bound(amount, 0, agc.balanceOf(actors[i]));
        address dst = actors[to % 4];
        bytes32 n = bytes32(++nonceSeq);
        bytes memory sig =
            _sig(pks[i], agc.DOMAIN_SEPARATOR(), agc.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(), actors[i], dst, amount, n);
        agc.transferWithAuthorization(actors[i], dst, amount, 0, block.timestamp + 1 hours, n, sig);
        calls++;
    }

    function donate(uint256 amount) external {
        amount = bound(amount, 1, type(uint128).max);
        usdc.mint(address(agc), amount); // USDC sent straight to the contract: surplus, never minted
        calls++;
    }
}

contract AGCInvariantTest is Test {
    MockUSDC internal usdc;
    AGC internal agc;
    AGCHandler internal h;

    function setUp() public {
        usdc = new MockUSDC();
        agc = new AGC(IERC20(address(usdc)));
        h = new AGCHandler(usdc, agc);
        targetContract(address(h));
    }

    function invariant_ReserveCoversSupply() public view {
        assertGe(usdc.balanceOf(address(agc)), agc.totalSupply());
        assertTrue(agc.isFullyBacked());
    }

    function invariant_SumOfBalancesEqualsSupply() public view {
        uint256 sum;
        for (uint256 i = 0; i < 4; i++) {
            sum += agc.balanceOf(h.actors(i));
        }
        assertEq(sum, agc.totalSupply());
        assertEq(agc.balanceOf(address(agc)), 0);
    }
}
