// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {MockACPv2Kernel} from "../src/mocks/MockACPv2Kernel.sol";
import {IERC8183} from "../src/interfaces/IERC8183.sol";
import {IACPHook, ACPSelectors} from "../src/interfaces/IACPHook.sol";
import {ERC8183EvaluatorAdapter} from "../src/ERC8183EvaluatorAdapter.sol";

/// Third-party hook that records calls, optionally reverting on one selector.
contract RecordingHook is IACPHook, IERC165 {
    bytes4 public revertOn;
    uint256 public calls;
    bytes4 public lastSelector;
    bytes public lastData;

    function setRevertOn(bytes4 s) external {
        revertOn = s;
    }

    function beforeAction(uint256, bytes4 s, bytes calldata) external view {
        if (s == revertOn && s != bytes4(0)) revert("hook-blocked");
    }

    function afterAction(uint256, bytes4 s, bytes calldata d) external {
        calls++;
        lastSelector = s;
        lastData = d;
    }

    function supportsInterface(bytes4 i) external pure returns (bool) {
        return i == type(IACPHook).interfaceId || i == type(IERC165).interfaceId;
    }
}

/// ERC-8183 / Virtuals ACP v2 hooked-kernel flow against the adapter.
contract AdapterACPv2Test is BaseTest {
    MockACPv2Kernel internal k;
    RecordingHook internal foreignHook;
    address internal kTreasury = makeAddr("acpTreasury");
    uint256 internal constant BUDGET = 100e6;
    uint256 internal constant KEXP = 10 days;

    function setUp() public override {
        super.setUp();
        k = new MockACPv2Kernel(IERC20(address(usdc)), kTreasury, 100, 50);
        foreignHook = new RecordingHook();
        k.setHookWhitelist(address(adapter), true);
        k.setHookWhitelist(address(foreignHook), true);
        vm.prank(client);
        usdc.approve(address(k), type(uint256).max);
    }

    function _job(address hook, uint256 expiresIn) internal returns (uint256 kid) {
        vm.prank(client);
        kid = k.createJob(provider, address(adapter), block.timestamp + expiresIn, "acp v2 job", hook);
        vm.prank(provider);
        k.setBudget(kid, BUDGET, "");
        vm.prank(client);
        k.fund(kid, "");
    }

    function _assign(uint256 kid) internal returns (uint256 id) {
        vm.prank(client);
        id = adapter.assign(address(k), kid, evaluator);
        vm.prank(evaluator);
        adapter.acceptAssignment(id);
    }

    function _astate(uint256 id) internal view returns (ERC8183EvaluatorAdapter.State) {
        return adapter.getJob(id).state;
    }

    // ---- interface / registration ----

    function test_Hook_SupportsInterfaces() public view {
        assertTrue(adapter.supportsInterface(type(IACPHook).interfaceId));
        assertTrue(adapter.supportsInterface(type(IERC165).interfaceId));
        assertFalse(adapter.supportsInterface(0xffffffff));
    }

    function test_Hook_KernelRefusesNonWhitelistedAndNon165() public {
        MockACPv2Kernel k2 = new MockACPv2Kernel(IERC20(address(usdc)), kTreasury, 0, 0);
        vm.prank(client);
        vm.expectRevert(MockACPv2Kernel.HookNotWhitelisted.selector);
        k2.createJob(provider, address(adapter), block.timestamp + KEXP, "x", address(adapter));
        k2.setHookWhitelist(address(usdc), true);
        vm.prank(client);
        vm.expectRevert(MockACPv2Kernel.InvalidHook.selector);
        k2.createJob(provider, address(adapter), block.timestamp + KEXP, "x", address(usdc));
    }

    function test_Selectors_MatchKernel() public pure {
        assertEq(ACPSelectors.SUBMIT, MockACPv2Kernel.submit.selector);
        assertEq(ACPSelectors.COMPLETE, MockACPv2Kernel.complete.selector);
        assertEq(ACPSelectors.REJECT, MockACPv2Kernel.reject.selector);
    }

    // ---- full flow, adapter as evaluator AND hook ----

    function test_ACPv2_FullFlow_Complete_HookStartsEvalWindow() public {
        uint256 kid = _job(address(adapter), KEXP);
        vm.recordLogs();
        uint256 id = _assign(kid);
        assertEq(uint8(_astate(id)), uint8(ERC8183EvaluatorAdapter.State.Active));

        vm.warp(block.timestamp + 3 hours);
        vm.prank(provider);
        k.submit(kid, DELIVERABLE, "");
        // no noteSubmission() call: the hook did it at the real submission time
        assertEq(adapter.getJob(id).submittedAt, uint64(block.timestamp));

        vm.prank(evaluator);
        adapter.verdict(id, 10_000, REASON);
        vm.warp(block.timestamp + 24 hours + 1);
        adapter.finalize(id);

        assertEq(uint8(k.getJob(kid).status), uint8(IERC8183.JobStatus.Completed));
        assertEq(uint8(_astate(id)), uint8(ERC8183EvaluatorAdapter.State.Executed));
        assertEq(usdc.balanceOf(provider), 10_000 * USDC + 98.5e6); // 100 - 1% platform - 0.5% evaluator
        assertEq(usdc.balanceOf(kTreasury), 1e6);
        assertEq(usdc.balanceOf(address(adapter)), 0);
        assertEq(registry.evaluatorInfo(evaluator).exposure, 0);
    }

    function test_ACPv2_FullFlow_Reject_RefundsClient() public {
        uint256 kid = _job(address(adapter), KEXP);
        uint256 id = _assign(kid);
        uint256 c0 = usdc.balanceOf(client);
        vm.prank(provider);
        k.submit(kid, DELIVERABLE, "");
        vm.prank(evaluator);
        adapter.verdict(id, 0, REASON);
        vm.warp(block.timestamp + 24 hours + 1);
        adapter.finalize(id);
        assertEq(uint8(k.getJob(kid).status), uint8(IERC8183.JobStatus.Rejected));
        assertEq(usdc.balanceOf(client), c0 + BUDGET);
    }

    function test_ACPv2_AssignEmitsHookObserved() public {
        uint256 kid = _job(address(adapter), KEXP);
        vm.expectEmit(true, true, false, true);
        emit ERC8183EvaluatorAdapter.KernelHookObserved(1, address(adapter), true);
        vm.prank(client);
        adapter.assign(address(k), kid, evaluator);
    }

    function test_ACPv2_SubmitBeforeAssign_AcceptNotes() public {
        uint256 kid = _job(address(adapter), KEXP);
        vm.prank(provider);
        k.submit(kid, DELIVERABLE, ""); // hook fires, no assignment: no-op, no revert
        uint256 id = _assign(kid);
        assertEq(adapter.getJob(id).submittedAt, uint64(block.timestamp));
    }

    function test_ACPv2_Hook_NeverBlocksSubmit_OnExpiryRefused() public {
        uint256 kid = _job(address(adapter), KEXP);
        uint256 id = _assign(kid);
        vm.warp(block.timestamp + KEXP - 1 days); // too little kernel time left for the windows
        vm.prank(provider);
        k.submit(kid, DELIVERABLE, "");
        assertEq(uint8(_astate(id)), uint8(ERC8183EvaluatorAdapter.State.ExpiryRefused));
        assertEq(uint8(k.getJob(kid).status), uint8(IERC8183.JobStatus.Submitted));
        assertEq(registry.evaluatorInfo(evaluator).exposure, 0);
    }

    // ---- hook safety ----

    function test_Hook_OtherSelectorsAndUnknownCallersAreNoOps() public {
        uint256 kid = _job(address(adapter), KEXP);
        uint256 id = _assign(kid);
        adapter.beforeAction(kid, ACPSelectors.SUBMIT, "");
        // arbitrary caller poses as a kernel with the same job id: keyed by msg.sender, so nothing happens
        address fake = makeAddr("fakeKernel");
        vm.prank(fake);
        adapter.afterAction(kid, ACPSelectors.SUBMIT, "");
        // real kernel, non-submit selector
        vm.prank(address(k));
        adapter.afterAction(kid, ACPSelectors.COMPLETE, "");
        assertEq(adapter.getJob(id).submittedAt, 0);
    }

    function test_Hook_NoteSubmissionSelfOnly() public {
        vm.expectRevert(ERC8183EvaluatorAdapter.Unauthorized.selector);
        adapter.hookNoteSubmission(1);
    }

    function test_Hook_RealKernelBeforeSubmitStatusIsNoOp() public {
        // kernel claims submit but job is not Submitted: hook must not note anything
        uint256 kid = _job(address(adapter), KEXP);
        uint256 id = _assign(kid);
        vm.prank(address(k));
        adapter.afterAction(kid, ACPSelectors.SUBMIT, "");
        assertEq(adapter.getJob(id).submittedAt, 0);
    }

    function test_Hook_GasCappedKernel_StillWorks() public {
        k.setHookGasLimit(600_000);
        uint256 kid = _job(address(adapter), KEXP);
        uint256 id = _assign(kid);
        vm.prank(provider);
        k.submit(kid, DELIVERABLE, "");
        assertGt(adapter.getJob(id).submittedAt, 0);
    }

    function test_Hook_StarvedGas_SubmitStillSucceeds_ManualNoteWorks() public {
        k.setHookGasLimit(30_000); // too little for the adapter to act; submit must not revert
        uint256 kid = _job(address(adapter), KEXP);
        uint256 id = _assign(kid);
        vm.prank(provider);
        k.submit(kid, DELIVERABLE, "");
        assertEq(adapter.getJob(id).submittedAt, 0);
        adapter.noteSubmission(id); // permissionless fallback unchanged
        assertGt(adapter.getJob(id).submittedAt, 0);
    }

    // Superseded: third-party-hook kernel jobs can no longer be assigned (see test_Assign_ThirdPartyHookRefused).

    // ---- kernel hook plumbing (mock fidelity) ----

    function test_Mock_FundBothOverloads_AndHookData() public {
        vm.prank(client);
        uint256 kid = k.createJob(provider, address(adapter), block.timestamp + KEXP, "x", address(foreignHook));
        vm.prank(provider);
        k.setBudget(kid, BUDGET, hex"01");
        vm.prank(client);
        vm.expectRevert(MockACPv2Kernel.BudgetMismatch.selector);
        k.fund(kid, BUDGET + 1, "");
        vm.prank(client);
        k.fund(kid, BUDGET, hex"02");
        assertEq(foreignHook.lastSelector(), bytes4(keccak256("fund(uint256,bytes)")));
        assertEq(foreignHook.lastData(), abi.encode(client, hex"02"));
    }

    function test_Mock_ClaimRefundIsNotHooked() public {
        uint256 kid = _job(address(foreignHook), KEXP);
        uint256 calls0 = foreignHook.calls();
        vm.warp(block.timestamp + KEXP);
        k.claimRefund(kid);
        assertEq(foreignHook.calls(), calls0);
    }

    // ---- assign(): hook policy and payment token ----

    function test_Assign_ThirdPartyHookRefused() public {
        uint256 kid = _job(address(foreignHook), KEXP);
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(ERC8183EvaluatorAdapter.ForeignHookNotAllowed.selector, address(foreignHook)));
        adapter.assign(address(k), kid, evaluator);
    }

    function test_Assign_ZeroHookOk() public {
        uint256 kid = _job(address(0), KEXP);
        vm.prank(client);
        uint256 id = adapter.assign(address(k), kid, evaluator);
        assertGt(id, 0);
    }

    function test_Assign_AdapterHookOk() public {
        uint256 kid = _job(address(adapter), KEXP);
        vm.prank(client);
        assertGt(adapter.assign(address(k), kid, evaluator), 0);
    }

    function test_Assign_OtherPaymentTokenRefused_EvenWithAdapterHook() public {
        MockUSDC virtualsUsdc = new MockUSDC();
        MockACPv2Kernel k2 = new MockACPv2Kernel(IERC20(address(virtualsUsdc)), kTreasury, 0, 0);
        k2.setHookWhitelist(address(adapter), true);
        virtualsUsdc.mint(client, BUDGET);
        vm.startPrank(client);
        virtualsUsdc.approve(address(k2), BUDGET);
        uint256 kid = k2.createJob(provider, address(adapter), block.timestamp + KEXP, "x", address(adapter));
        vm.stopPrank();
        vm.prank(provider);
        k2.setBudget(kid, BUDGET, "");
        vm.prank(client);
        k2.fund(kid, "");
        vm.prank(client);
        vm.expectRevert(ERC8183EvaluatorAdapter.TokenMismatch.selector);
        adapter.assign(address(k2), kid, evaluator);
    }

    function test_AcceptedToken_IsConstructorToken() public view {
        assertEq(adapter.acceptedToken(), address(usdc));
        assertEq(adapter.acceptedToken(), k.paymentToken());
    }
}
