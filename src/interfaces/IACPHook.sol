// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IACPHook
/// @notice ERC-8183 hook interface (ethereum/ERCs ERCS/erc-8183.md, "Hooks"). ACP v2 (Virtuals) kernels
///         call beforeAction/afterAction around setProvider, setBudget, fund, submit, complete and
///         reject. claimRefund is NOT hookable. In the EIP the interface also extends IERC165; the
///         adapter implements supportsInterface separately.
interface IACPHook {
    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
}

/// @notice Selectors the kernel passes as `selector` (= msg.sig of the kernel function).
///         Signatures follow the ERC-8183 reference `AgenticCommerce`; a kernel with other
///         parameter lists produces other selectors (see docs/ERC8183-ACPV2.md).
library ACPSelectors {
    bytes4 internal constant SUBMIT = bytes4(keccak256("submit(uint256,bytes32,bytes)"));
    bytes4 internal constant COMPLETE = bytes4(keccak256("complete(uint256,bytes32,bytes)"));
    bytes4 internal constant REJECT = bytes4(keccak256("reject(uint256,bytes32,bytes)"));
}
