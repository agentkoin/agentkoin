#!/usr/bin/env bash
# Account-free hosting: Cloudflare quick tunnel (trycloudflare.com). Needs a machine whose network allows outbound
# QUIC/UDP or TCP 7844 to Cloudflare (this repo's build box does not). Ephemeral URL; dies with the process.
# Usage (repo root, keys in .secrets/ or AGENTCOIN_*_KEY env):  bash deploy/quick-tunnel.sh
set -euo pipefail
cd "$(dirname "$0")/.."
command -v cloudflared >/dev/null || { echo "install cloudflared first: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" >&2; exit 1; }
export AGENTCOIN_NETWORK=base-sepolia
LOG=$(mktemp)
cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8402 >"$LOG" 2>&1 & CF=$!
trap 'kill $CF ${SVC:-} 2>/dev/null || true' EXIT
for i in $(seq 1 60); do URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$LOG" | head -1 || true); [ -n "${URL:-}" ] && break; sleep 1; done
[ -n "${URL:-}" ] || { echo "no tunnel URL; see $LOG" >&2; exit 1; }
echo "public URL: $URL"
export AGENTCOIN_BASE_URL="$URL" AGENTCOIN_HOSTED=1 TRUST_PROXY=1
(cd agent && node scripts/sign-artifacts.mjs >/dev/null)   # re-sign artifacts with the public URL
node agent/service/app.mjs & SVC=$!
wait $SVC
