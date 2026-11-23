#!/usr/bin/env bash
# LOCAL ONLY end-to-end demo. Starts a fresh Anvil on 127.0.0.1:8545, deploys, seeds, signs artifacts,
# starts the x402 server on 127.0.0.1:4020, runs demo/run-demo.mjs and the v0.4 service e2e, then stops both.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export PATH="$HOME/.foundry/bin:$PATH"
cd "$ROOT"
ANVIL_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 # public Anvil dev key #0
if curl -s -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' http://127.0.0.1:8545 >/dev/null 2>&1; then
  echo "port 8545 in use; stop the running anvil first" >&2; exit 1
fi
anvil --host 127.0.0.1 --port 8545 --silent & ANVIL_PID=$!
cleanup() { kill ${X402_PID:-} $ANVIL_PID 2>/dev/null || true; }
trap cleanup EXIT
for i in $(seq 1 50); do curl -s -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' http://127.0.0.1:8545 >/dev/null 2>&1 && break; sleep 0.2; done
forge build -q
forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --private-key $ANVIL_KEY -q >/dev/null
cd agent
node scripts/gen-keys.mjs >/dev/null
node scripts/seed-local.mjs
node scripts/gen-interface.mjs
node scripts/sign-artifacts.mjs >/dev/null
node scripts/verify-artifacts.mjs --tamper
node x402/server.mjs & X402_PID=$!
for i in $(seq 1 50); do curl -s http://127.0.0.1:4020/facilitator/supported >/dev/null 2>&1 && break; sleep 0.2; done
node demo/run-demo.mjs
node service/e2e-local.mjs   # v0.4 public service: paid notarize -> verdict -> finalize, facilitator, MCP over HTTP, caps, stats
