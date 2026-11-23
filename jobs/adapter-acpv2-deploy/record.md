# ERC8183EvaluatorAdapter (ACP v2 hooks) - Base Sepolia deploy record

Date: 2026-11-18 (ET). Chain 84532. Approval: Carter, "do it, yes" to "Yes, deploy the updated Virtuals judge contract on testnet" (verified by parent in Research's transcript).
Source commit: 8a8579e (hook refusal, acceptedToken) + deploy scripts (this commit). Tests before deploy: full suite 293 passed, 0 failed, 2 skipped.

- Deployer 0x78e2C0164A80F3e337AE17e3bA4b8EA2C0Fa488e (script aborts unless key derives this and owns registry); key read from file only.
- Adapter: **0xc8eD835872CFEe62Bc5E55Ee4B537B2817f48B8B**
  - deploy tx 0x29c15271f314043e394cac902e1310ca90e802fa515e83e7d0cbba4bd069f59d, block 60685292, gas 4,065,145
  - args: token 0x036CbD53842c5426634e7929541eC2318f3dCF7e, registry 0x30576DE005df028D1947C56dEcc85a2a5612036a, treasury+owner = deployer, arbitrator MockArbitrator 0x3C4587eD99B1969581cA4f041FD9535a0D269736, Defaults.adapterConfig()
- Token choice: Circle USDC 0x036C... because registry 0x3057... stakes that token and the adapter must use the same token. Virtuals' USDC (0xECc22a8F6fD62388498fBa19813E214605a2BDb3, acp-node-v2 @392dcc6 constants.ts) would need a separate registry+stack. Consequence: this adapter refuses (TokenMismatch) jobs on Virtuals' own Base Sepolia kernel (0x0b93793923CD5De81850aF8604a233f3f24d461e), which is priced in their USDC.
- Slasher rights: needed (adapter locks exposure/slashes via registry). proposeSlasher(adapter,true): tx 0x66bc9d68b7696dc3aef7d88c5e69071f8a2032552be9ac5f06942ebbec4835ba, block 60685497. pendingSlasher eta = 1795231768 = Fri 2026-11-20 22:29:28 ET (48h timelock). executeSlasher NOT run.
- Sourcify: exact_match. https://repo.sourcify.dev/contracts/full_match/84532/0xc8eD835872CFEe62Bc5E55Ee4B537B2817f48B8B/
- Basescan: not done (needs an API key).
- Not done: Virtuals hook-whitelist application, push, posts, Arc, mainnet.
- Deployer balance after: 0.000051258353957735 ETH.
- Note: a first cast send attempt failed locally (no signer), nothing sent; the proposeSlasher was then sent via script/ProposeSlasherAdapterACPv2.s.sol.

## executeSlasher (Nov 20 2026)
- tx: 0x1532ae99af761e9c8f80fa1a87f583c8494c8927e8f19dbd244746d77fb39851
- block: 61555622
- status: 0x1
- time: 2026-11-20 10:49:53 PM ET
- isSlasher(0xc8eD835872CFEe62Bc5E55Ee4B537B2817f48B8B) readback: true
