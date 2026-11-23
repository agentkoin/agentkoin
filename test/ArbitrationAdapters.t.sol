// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {IArbitrator} from "../src/interfaces/IArbitrator.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {KlerosArbitratorAdapter} from "../src/arbitration/KlerosArbitratorAdapter.sol";
import {UMAArbitratorAdapter} from "../src/arbitration/UMAArbitratorAdapter.sol";
import {IERC792Arbitrator, IOptimisticOracleV3} from "../src/arbitration/IExternalArbitration.sol";
import {MockERC792Arbitrator, MockOptimisticOracleV3} from "./mocks/MockExternalArbitration.sol";

/// v0.3: thin Kleros (ERC-792) and UMA (OOv3) IArbitrator adapters, against mocks only.
contract ArbitrationAdaptersTest is BaseTest {
    MockERC792Arbitrator internal kc;
    KlerosArbitratorAdapter internal kl;
    MockOptimisticOracleV3 internal oo;
    UMAArbitratorAdapter internal uma;
    address internal proposer = makeAddr("proposer");

    function setUp() public override {
        super.setUp();
        kc = new MockERC792Arbitrator(0.01 ether);
        kl = new KlerosArbitratorAdapter(IERC792Arbitrator(address(kc)), hex"01", owner, ARB_FEE);
        oo = new MockOptimisticOracleV3(2 * USDC);
        uma = new UMAArbitratorAdapter(IOptimisticOracleV3(address(oo)), IERC20(address(usdc)), owner, 2 hours, 0);
        vm.startPrank(owner);
        kl.setArbitrable(address(escrow), true);
        uma.setArbitrable(address(escrow), true);
        vm.stopPrank();
        usdc.mint(proposer, 100 * USDC);
        vm.prank(proposer);
        usdc.approve(address(uma), type(uint256).max);
    }

    function _rejectedJob() internal returns (uint256 id) {
        id = _openAndSubmit(10 * USDC);
        _verdict(id, JobEscrow.Outcome.Reject, 0);
    }

    // ---------------- Kleros ----------------

    function test_kleros_overturn_paysProvider_slashesEvaluator() public {
        vm.prank(owner);
        escrow.setArbitrator(IArbitrator(address(kl)));
        vm.deal(address(kl), 1 ether);
        uint256 id = _rejectedJob();
        uint256 p0 = usdc.balanceOf(provider);
        uint256 s0 = registry.stakeOf(evaluator);
        vm.prank(provider);
        escrow.challenge(id, REASON);
        assertEq(address(kc).balance, 0.01 ether, "native cost fronted");
        (,,,, uint256 ext,) = kl.requests(1);
        kc.giveRuling(ext, kl.RULING_PAY_PROVIDER());
        assertEq(uint8(_state(id)), uint8(JobEscrow.State.Settled));
        assertEq(escrow.getJob(id).payoutBps, 10000);
        assertLt(registry.stakeOf(evaluator), s0, "evaluator slashed");
        assertGt(usdc.balanceOf(provider), p0, "provider paid");
        assertEq(usdc.balanceOf(address(kl)), ARB_FEE, "token fee to adapter");
        vm.prank(owner);
        kl.withdrawToken(IERC20(address(usdc)), owner, ARB_FEE);
        assertEq(usdc.balanceOf(owner), ARB_FEE);
    }

    function test_kleros_refusedRuling_verdictStands() public {
        vm.prank(owner);
        escrow.setArbitrator(IArbitrator(address(kl)));
        vm.deal(address(kl), 1 ether);
        uint256 id = _rejectedJob();
        uint256 s0 = registry.stakeOf(evaluator);
        vm.prank(provider);
        escrow.challenge(id, REASON);
        kc.giveRuling(1, 0);
        assertEq(escrow.getJob(id).payoutBps, 0);
        assertEq(registry.stakeOf(evaluator), s0, "no slash when verdict stands");
    }

    function test_kleros_noPrepayment_challengeReverts() public {
        vm.prank(owner);
        escrow.setArbitrator(IArbitrator(address(kl)));
        uint256 id = _rejectedJob();
        vm.prank(provider);
        vm.expectRevert(abi.encodeWithSelector(KlerosArbitratorAdapter.InsufficientPrepayment.selector, 0, 0.01 ether));
        escrow.challenge(id, REASON);
    }

    function test_kleros_access() public {
        vm.expectRevert(KlerosArbitratorAdapter.NotArbitrable.selector);
        kl.requestRuling(1, outsider, 0, REASON);
        vm.expectRevert(KlerosArbitratorAdapter.NotKleros.selector);
        kl.rule(1, 1);
        vm.prank(outsider);
        vm.expectRevert(KlerosArbitratorAdapter.NotOwner.selector);
        kl.setTokenFee(0);
    }

    function test_kleros_invalidRuling_reverts_and_noDoubleRule() public {
        vm.prank(owner);
        escrow.setArbitrator(IArbitrator(address(kl)));
        vm.deal(address(kl), 1 ether);
        uint256 id = _rejectedJob();
        vm.prank(provider);
        escrow.challenge(id, REASON);
        vm.expectRevert(abi.encodeWithSelector(KlerosArbitratorAdapter.InvalidRuling.selector, 3));
        kc.giveRuling(1, 3);
        kc.giveRuling(1, 2);
        vm.expectRevert(KlerosArbitratorAdapter.AlreadyRuled.selector);
        kc.giveRuling(1, 1);
    }

    // ---------------- UMA ----------------

    function test_uma_truthfulAssertion_forwardsRuling() public {
        vm.prank(owner);
        escrow.setArbitrator(IArbitrator(address(uma)));
        uint256 id = _rejectedJob();
        vm.prank(provider);
        escrow.challenge(id, REASON);
        vm.prank(proposer);
        bytes32 aid = uma.proposeRuling(1, 10000);
        assertEq(
            string(oo.claimOf(aid)),
            string(
                abi.encodePacked(
                    "AgentCoin dispute 1 of arbitrable 0x",
                    _lowerHex(address(escrow)),
                    " job ",
                    vm.toString(id),
                    ": payoutBps = 10000"
                )
            )
        );
        vm.expectRevert(abi.encodeWithSelector(UMAArbitratorAdapter.ProposalPending.selector, aid));
        uma.proposeRuling(1, 0);
        uint256 b0 = usdc.balanceOf(proposer);
        oo.resolve(aid, true);
        assertEq(usdc.balanceOf(proposer), b0 + 2 * USDC, "bond returned");
        assertEq(uint8(_state(id)), uint8(JobEscrow.State.Settled));
        assertEq(escrow.getJob(id).payoutBps, 10000);
    }

    function test_uma_falseAssertion_allowsNewProposal() public {
        vm.prank(owner);
        escrow.setArbitrator(IArbitrator(address(uma)));
        uint256 id = _rejectedJob();
        vm.prank(provider);
        escrow.challenge(id, REASON);
        vm.prank(proposer);
        bytes32 a1 = uma.proposeRuling(1, 10000);
        oo.resolve(a1, false);
        assertEq(uint8(_state(id)), uint8(JobEscrow.State.Disputed), "still disputed");
        vm.prank(proposer);
        bytes32 a2 = uma.proposeRuling(1, 0);
        oo.resolve(a2, true);
        assertEq(escrow.getJob(id).payoutBps, 0);
        assertEq(uint8(_state(id)), uint8(JobEscrow.State.Settled));
    }

    function test_uma_access() public {
        vm.expectRevert(UMAArbitratorAdapter.NotArbitrable.selector);
        uma.requestRuling(1, outsider, 0, REASON);
        vm.expectRevert(UMAArbitratorAdapter.NotOracle.selector);
        uma.assertionResolvedCallback(bytes32(uint256(1)), true);
        vm.expectRevert(UMAArbitratorAdapter.UnknownDispute.selector);
        uma.proposeRuling(7, 0);
    }

    function _lowerHex(address a) internal pure returns (string memory) {
        bytes memory s = new bytes(40);
        bytes16 h = "0123456789abcdef";
        uint160 x = uint160(a);
        for (uint256 i = 40; i > 0; i--) {
            s[i - 1] = h[x & 0xf];
            x >>= 4;
        }
        return string(s);
    }
}
