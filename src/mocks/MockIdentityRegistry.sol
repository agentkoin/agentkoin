// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";

/// @title MockIdentityRegistry
/// @notice TEST ONLY. Minimal subset of the ERC-8004 Identity Registry (register / setAgentURI /
///         tokenURI) so the local registration flow can be exercised on Anvil. Not the 8004 singleton.
contract MockIdentityRegistry is ERC721URIStorage {
    uint256 public agentCount;

    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);

    error NotAgentOwner();

    constructor() ERC721("Local ERC-8004 Identity (test only)", "AGENT-LOCAL") {}

    function register(string calldata agentURI) external returns (uint256 agentId) {
        agentId = ++agentCount;
        _safeMint(msg.sender, agentId);
        _setTokenURI(agentId, agentURI);
        emit Registered(agentId, agentURI, msg.sender);
    }

    function setAgentURI(uint256 agentId, string calldata newURI) external {
        if (ownerOf(agentId) != msg.sender) revert NotAgentOwner();
        _setTokenURI(agentId, newURI);
        emit URIUpdated(agentId, newURI, msg.sender);
    }
}
