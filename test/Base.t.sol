// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockArbitrator} from "../src/mocks/MockArbitrator.sol";
import {EvaluatorRegistry} from "../src/EvaluatorRegistry.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {IEvaluatorRegistry} from "../src/interfaces/IEvaluatorRegistry.sol";
import {IArbitrator} from "../src/interfaces/IArbitrator.sol";
import {ERC8183EvaluatorAdapter} from "../src/ERC8183EvaluatorAdapter.sol";
import {Defaults} from "../script/Defaults.sol";
import {EscrowDepositRouteFactory} from "../src/EscrowDepositRoute.sol";

abstract contract BaseTest is Test {
    uint256 internal constant USDC = 1e6;

    MockUSDC internal usdc;
    EvaluatorRegistry internal registry;
    MockArbitrator internal arb;
    JobEscrow internal escrow;
    ERC8183EvaluatorAdapter internal adapter;

    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal client = makeAddr("client");
    address internal provider = makeAddr("provider");
    address internal evaluator = makeAddr("evaluator");
    address internal evaluator2 = makeAddr("evaluator2");
    address internal outsider = makeAddr("outsider");
    address internal keeper = makeAddr("keeper");
    address internal keeper2 = makeAddr("keeper2");
    address internal keeper3 = makeAddr("keeper3");

    bytes32 internal constant SPEC = keccak256("spec-v1");
    bytes32 internal constant DELIVERABLE = keccak256("deliverable");
    bytes32 internal constant REASON = keccak256("reason");

    /// Route factory owned by `owner`, keepers {keeper, keeper2, keeper3}, default threshold 2-of-3
    /// (A-1e v0.1.2). `treasury_` receives RecoveryVault funds unclaimed after the horizon.
    function _newFactory(uint64 sweepDelay, address treasury_) internal returns (EscrowDepositRouteFactory) {
        return _newFactoryK(sweepDelay, treasury_, Defaults.KEEPER_THRESHOLD);
    }

    function _newFactoryK(uint64 sweepDelay, address treasury_, uint8 k) internal returns (EscrowDepositRouteFactory) {
        address[] memory ks = new address[](3);
        (ks[0], ks[1], ks[2]) = (keeper, keeper2, keeper3);
        return new EscrowDepositRouteFactory(
            IERC20(address(usdc)),
            address(escrow),
            owner,
            EscrowDepositRouteFactory.Config({
                sweepDelay: sweepDelay,
                treasury: treasury_,
                recoveryHorizon: Defaults.RECOVERY_HORIZON,
                keeperTimelock: Defaults.KEEPER_TIMELOCK,
                threshold: k
            }),
            ks
        );
    }

    /// Two matching keeper attestations (2-of-3): the first only records, the second credits.
    function _attest2(
        EscrowDepositRouteFactory f,
        EscrowDepositRouteFactory.Offer memory o,
        bytes32 txHash,
        uint256 logIndex,
        address from,
        uint256 value,
        bool refundOnly
    ) internal returns (uint256 jobId, bool refunded) {
        vm.prank(keeper);
        (bool c1,,) = f.attestDeposit(o, txHash, logIndex, from, value, refundOnly);
        require(!c1, "1-of-3 credited");
        vm.prank(keeper2);
        bool c2;
        (c2, jobId, refunded) = f.attestDeposit(o, txHash, logIndex, from, value, refundOnly);
        require(c2, "2-of-3 did not credit");
    }

    function setUp() public virtual {
        usdc = new MockUSDC();
        _deployStack(IERC20(address(usdc)));
        _fundActors();
    }

    uint256 internal constant ARB_FEE = 5e5; // Defaults.MOCK_ARBITRATION_FEE

    function _deployStack(IERC20 token) internal {
        arb = new MockArbitrator(owner, ARB_FEE);
        // R-5: slashers fixed at deploy. Escrow and adapter are the next two CREATEs after the registry.
        uint64 n = vm.getNonce(address(this));
        address[] memory slashers = new address[](2);
        slashers[0] = vm.computeCreateAddress(address(this), n + 1);
        slashers[1] = vm.computeCreateAddress(address(this), n + 2);
        registry =
            new EvaluatorRegistry(token, Defaults.registryConfig(treasury), owner, slashers, Defaults.SLASHER_TIMELOCK);
        escrow = new JobEscrow(
            token,
            IEvaluatorRegistry(address(registry)),
            treasury,
            IArbitrator(address(arb)),
            Defaults.escrowConfig(),
            owner, owner, type(uint256).max, type(uint256).max
        );
        adapter = new ERC8183EvaluatorAdapter(
            token,
            IEvaluatorRegistry(address(registry)),
            treasury,
            IArbitrator(address(arb)),
            Defaults.adapterConfig(),
            owner
        );
        require(registry.isSlasher(address(escrow)) && registry.isSlasher(address(adapter)), "slasher prediction");
    }

    function _fundActors() internal {
        usdc.mint(client, 100_000 * USDC);
        usdc.mint(provider, 10_000 * USDC);
        usdc.mint(evaluator, 1_000 * USDC);
        usdc.mint(evaluator2, 1_000 * USDC);
        _stake(evaluator, 100 * USDC);
        _approveAll(client);
        _approveAll(provider);
    }

    function _stake(address who, uint256 amount) internal {
        vm.startPrank(who);
        usdc.approve(address(registry), type(uint256).max);
        registry.stake(amount);
        vm.stopPrank();
    }

    function _approveAll(address who) internal {
        vm.startPrank(who);
        usdc.approve(address(escrow), type(uint256).max);
        usdc.approve(address(adapter), type(uint256).max);
        vm.stopPrank();
    }

    function _open(uint256 amount) internal returns (uint256 id) {
        vm.prank(client);
        id = escrow.createAndFund(provider, evaluator, amount, uint64(block.timestamp + 3 days), SPEC);
    }

    function _openAndSubmit(uint256 amount) internal returns (uint256 id) {
        id = _open(amount);
        vm.prank(provider);
        escrow.submit(id, DELIVERABLE);
    }

    function _verdict(uint256 id, JobEscrow.Outcome o, uint16 bps) internal {
        vm.prank(evaluator);
        escrow.verdict(id, o, bps, REASON);
    }

    function _state(uint256 id) internal view returns (JobEscrow.State) {
        return escrow.getJob(id).state;
    }

    function _passChallengeWindow() internal {
        vm.warp(block.timestamp + 48 hours + 1);
    }
}
