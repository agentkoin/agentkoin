// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EscrowDepositRouteFactory} from "../src/EscrowDepositRoute.sol";
import {KlerosArbitratorAdapter} from "../src/arbitration/KlerosArbitratorAdapter.sol";
import {UMAArbitratorAdapter} from "../src/arbitration/UMAArbitratorAdapter.sol";
import {IERC792Arbitrator, IOptimisticOracleV3} from "../src/arbitration/IExternalArbitration.sol";
import {MockERC792Arbitrator} from "./mocks/MockExternalArbitration.sol";

/// @dev Hostile OOv3: re-enters proposeRuling from inside assertTruth.
contract ReenteringOracle {
    UMAArbitratorAdapter public target;
    uint256 public disputeId;

    function arm(UMAArbitratorAdapter t, uint256 id) external {
        target = t;
        disputeId = id;
    }

    function assertTruth(bytes calldata, address, address, address, uint64, IERC20, uint256, bytes32, bytes32)
        external
        returns (bytes32)
    {
        target.proposeRuling(disputeId, 5000);
        return keccak256("x");
    }

    function getMinimumBond(address) external pure returns (uint256) {
        return 0;
    }

    function defaultIdentifier() external pure returns (bytes32) {
        return bytes32("ASSERT_TRUTH");
    }
}

/// Mainnet-prep scan fixes (docs/mainnet/SECURITY_SCAN.md): UMA proposeRuling nonReentrant + setter events,
/// zero-address checks on adapters, route factory and routes.
contract MainnetPrepHardeningTest is BaseTest {
    event LivenessSet(uint64 liveness);
    event TokenFeeSet(uint256 fee);

    function test_uma_proposeRuling_nonReentrant() public {
        ReenteringOracle ro = new ReenteringOracle();
        UMAArbitratorAdapter uma =
            new UMAArbitratorAdapter(IOptimisticOracleV3(address(ro)), IERC20(address(usdc)), owner, 2 hours, 0);
        vm.prank(owner);
        uma.setArbitrable(address(this), true);
        uint256 id = uma.requestRuling(1, address(0xBEEF), 0, bytes32(0));
        ro.arm(uma, id);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        uma.proposeRuling(id, 10000);
    }

    function test_uma_constructor_zeroAddress() public {
        IOptimisticOracleV3 oo = IOptimisticOracleV3(makeAddr("oo"));
        vm.expectRevert(UMAArbitratorAdapter.ZeroAddress.selector);
        new UMAArbitratorAdapter(oo, IERC20(address(usdc)), address(0), 2 hours, 0);
        vm.expectRevert(UMAArbitratorAdapter.ZeroAddress.selector);
        new UMAArbitratorAdapter(IOptimisticOracleV3(address(0)), IERC20(address(usdc)), owner, 2 hours, 0);
        vm.expectRevert(UMAArbitratorAdapter.ZeroAddress.selector);
        new UMAArbitratorAdapter(oo, IERC20(address(0)), owner, 2 hours, 0);
    }

    function test_uma_setters_emit() public {
        UMAArbitratorAdapter uma = new UMAArbitratorAdapter(
            IOptimisticOracleV3(makeAddr("oo")), IERC20(address(usdc)), owner, 2 hours, 0
        );
        vm.startPrank(owner);
        vm.expectEmit(address(uma));
        emit LivenessSet(3 hours);
        uma.setLiveness(3 hours);
        vm.expectEmit(address(uma));
        emit TokenFeeSet(7);
        uma.setTokenFee(7);
        vm.stopPrank();
    }

    function test_kleros_zeroAddress() public {
        MockERC792Arbitrator kc = new MockERC792Arbitrator(0.01 ether);
        vm.expectRevert(KlerosArbitratorAdapter.ZeroAddress.selector);
        new KlerosArbitratorAdapter(IERC792Arbitrator(address(kc)), hex"01", address(0), ARB_FEE);
        vm.expectRevert(KlerosArbitratorAdapter.ZeroAddress.selector);
        new KlerosArbitratorAdapter(IERC792Arbitrator(address(0)), hex"01", owner, ARB_FEE);
        KlerosArbitratorAdapter kl = new KlerosArbitratorAdapter(IERC792Arbitrator(address(kc)), hex"01", owner, ARB_FEE);
        vm.deal(address(kl), 1 ether);
        vm.prank(owner);
        vm.expectRevert(KlerosArbitratorAdapter.ZeroAddress.selector);
        kl.withdrawNative(payable(address(0)), 1);
    }

    function test_factory_zeroEscrow_reverts() public {
        address[] memory ks = new address[](3);
        (ks[0], ks[1], ks[2]) = (keeper, keeper2, keeper3);
        EscrowDepositRouteFactory.Config memory cfg = EscrowDepositRouteFactory.Config({
            sweepDelay: 1 days,
            treasury: treasury,
            recoveryHorizon: 365 days,
            keeperTimelock: 2 days,
            threshold: 2
        });
        vm.expectRevert(EscrowDepositRouteFactory.ZeroAddress.selector);
        new EscrowDepositRouteFactory(IERC20(address(usdc)), address(0), owner, cfg, ks);
    }

    function test_factory_deploy_zeroParty_reverts() public {
        EscrowDepositRouteFactory f = _newFactory(1 days, treasury);
        EscrowDepositRouteFactory.Offer memory o = EscrowDepositRouteFactory.Offer({
            provider: address(0),
            evaluator: evaluator,
            amount: 1e6,
            deadlineSeconds: 1 days,
            specHash: bytes32("spec")
        });
        vm.expectRevert(EscrowDepositRouteFactory.ZeroAddress.selector);
        f.deploy(o);
        o.provider = provider;
        o.evaluator = address(0);
        vm.expectRevert(EscrowDepositRouteFactory.ZeroAddress.selector);
        f.deploy(o);
        o.evaluator = evaluator;
        assertTrue(f.deploy(o).code.length > 0, "valid offer still deploys");
    }
}
