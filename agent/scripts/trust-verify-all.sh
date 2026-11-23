#!/usr/bin/env bash
# Runs the public verify CLI on every job in dist/jobs.json (read-only, no keys). Writes verify-logs/ + verify-summary.txt.
set -euo pipefail; cd "$(dirname "$0")"; mkdir -p verify-logs
jq -r '.jobs[]|"\(.escrowVersion) \(.jobId) \(.escrow)"' dist/jobs.json | xargs -P 4 -L 1 bash -c 'v=$0; id=$1; e=$2; a=""; [ $v = v0.6 ] && a="--escrow $e"; timeout 180 npx -y @agentkoin/judge-kit@testnet verify $id $a > verify-logs/${v}_$id.log 2>&1 || true; echo "$v $id $(tail -1 verify-logs/${v}_$id.log)"' | sort -k1,1 -k2,2n > verify-summary.txt
