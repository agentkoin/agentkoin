#!/usr/bin/env bash
# Export the public client side (plugins + client libraries) into a separate repo with its own history.
# Allowlist-based: only paths listed in ALLOW are copied, only git-tracked files, minus DENY patterns.
# Never adds remotes, pushes, or commits. Re-run to resync: tracked content in DEST is replaced.
# usage: tools/export-public.sh [dest]   (default /workspace/agentcoin-public)
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-/workspace/agentcoin-public}"
TPL="$SRC/tools/public-export"
case "$DEST" in "$SRC"|"$SRC"/*) echo "refusing: dest inside private repo" >&2; exit 1;; esac

# Paths relative to integrations/ (copied to the repo root).
ALLOW=(
  package.json package-lock.json tsconfig.base.json
  core-ts agentkit x402-fetch x402-escrow-hint langchain-js openai-agents-js vercel-ai mcp
  examples scripts
  python/pytest.ini python/agentcoin-core python/crewai-agentcoin python/langchain-agentcoin python/openai-agents-agentcoin
)
DENY_RE='(^|/)(node_modules|\.venv|dist|out|__pycache__|\.pytest_cache|\.secrets)(/|$)|\.(key|pem|env|tsbuildinfo|pyc)$|\.local\.json$|(^|/)\.env'

mkdir -p "$DEST"
if [ -d "$DEST/.git" ]; then
  if [ -n "$(git -C "$DEST" remote)" ]; then echo "note: dest has a remote; this script never pushes" >&2; fi
  git -C "$DEST" ls-files -z | (cd "$DEST" && xargs -0 -r rm -f)
else
  git -C "$DEST" init -q -b main
fi

cd "$SRC/integrations"
n=0
while IFS= read -r -d '' f; do
  [[ "$f" =~ $DENY_RE ]] && continue
  [ -f "$f" ] || continue
  mkdir -p "$DEST/$(dirname "$f")"; cp -p "$f" "$DEST/$f"; n=$((n+1))
done < <(git ls-files -z -- "${ALLOW[@]}")
echo "copied $n files"

cp "$TPL/README.md" "$DEST/README.md"; cp "$TPL/LICENSE" "$DEST/LICENSE"; cp "$TPL/gitignore" "$DEST/.gitignore"
cp "$TPL/CONTRIBUTING.md" "$DEST/CONTRIBUTING.md"; cp "$TPL/SECURITY.md" "$DEST/SECURITY.md"; cp "$TPL/REPO-META.md" "$DEST/REPO-META.md"

# Public subset of the deployment record: addresses and parameters only (no deployer, keeper, tx or operator fields).
mkdir -p "$DEST/deployments"
node -e '
const d = require(process.argv[1]);
const o = { network: d.network, chainId: d.chainId, usdc: { address: d.usdc.address, kind: d.usdc.kind },
  params: d.params, contracts: Object.fromEntries(Object.entries(d.contracts).map(([k, v]) => [k, { address: v.address }])) };
process.stdout.write(JSON.stringify(o, null, 2) + "\n");' "$SRC/deployments/base-sepolia.json" > "$DEST/deployments/base-sepolia.json"

cd "$DEST"
# patch FILE OLD NEW: literal replace, fails if OLD is absent (detects upstream drift).
patch() { node -e '
const fs = require("fs"); const [f, a, b] = process.argv.slice(1); const s = fs.readFileSync(f, "utf8");
if (!s.includes(a)) { console.error("patch miss: " + f + " :: " + a); process.exit(3); }
fs.writeFileSync(f, s.split(a).join(b));' "$@"; }
patch x402-escrow-hint/test/hint.test.mjs 'path.resolve(here, "../../..")' 'path.resolve(here, "../..")'
patch x402-escrow-hint/test/hint.test.mjs '"integrations/python/.venv/bin/python"' '"python/.venv/bin/python"'
patch examples/run-live.sh 'examples/run-live.sh ../.secrets/testnet-buyer.key examples/langchain_py.py' 'examples/run-live.sh ~/my-base-sepolia-test-key.txt examples/langchain_py.py'
patch core-ts/src/constants.ts 'in the AgentCoin repo' 'in the AgentCoin router repo (deployments/base-sepolia.json here is a public subset)'
for f in $(git ls-files -o --exclude-standard -- '*README.md' ; git ls-files -- '*README.md'); do
  [ "$f" = README.md ] && continue
  node -e 'const fs=require("fs");const f=process.argv[1];let s=fs.readFileSync(f,"utf8");s=s.split("./integrations/").join("./").split("<repo>/integrations/").join("<repo>/").split("in `integrations/python/`").join("in `python/`").split("in `integrations/`").join("at the repo root").split("`integrations/python/").join("`python/").split("integrations/out/").join("out/ (git-ignored)");fs.writeFileSync(f,s)' "$f"
done
patch python/agentcoin-core/tests/test_escrow_hint.py 'resolve().parents[4]' 'resolve().parents[3]'
patch python/langchain-agentcoin/pyproject.toml 'classifiers = ["Private :: Do Not Upload"]' 'classifiers = ["Private :: Do Not Upload"]

[project.optional-dependencies]
test = ["langgraph>=0.2"]'
patch python/agentcoin-core/src/agentcoin_core/escrow_hint.py 'Mirrors integrations/x402-escrow-hint/index.mjs' 'Mirrors x402-escrow-hint/index.mjs'
# License metadata: MIT everywhere (LICENSE: MIT, Copyright (c) 2026 STOS Technologies LLC). Fails if any package says otherwise.
node -e '
const fs = require("fs"); let bad = [];
for (const f of process.argv.slice(1)) { const j = JSON.parse(fs.readFileSync(f, "utf8")); if (j.license !== "MIT") bad.push(f); }
const l = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
for (const [k, v] of Object.entries(l.packages)) if (!k.startsWith("node_modules/") && k !== "" && v.license !== "MIT") bad.push("package-lock.json:" + k);
if (bad.length) { console.error("non-MIT license field: " + bad.join(", ")); process.exit(5); }' */package.json
for f in python/*/pyproject.toml; do grep -q 'license = { text = "MIT" }' "$f" || { echo "non-MIT license: $f" >&2; exit 5; }; done
grep -q 'Copyright (c) 2026 STOS Technologies LLC' LICENSE || { echo "LICENSE copyright is not STOS Technologies LLC" >&2; exit 5; }
node -e '
const fs = require("fs"); let bad = [];
for (const f of process.argv.slice(1)) {
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  if (j.author !== "STOS Technologies LLC" || j.publisher !== "STOS Technologies LLC") bad.push(f);
  if (j.private !== true) bad.push(f + ":private");
}
if (bad.length) { console.error("author/publisher/private mismatch: " + bad.join(", ")); process.exit(5); }' package.json */package.json
for f in python/*/pyproject.toml; do grep -q 'authors = \[{ name = "STOS Technologies LLC" }\]' "$f" || { echo "missing STOS authors: $f" >&2; exit 5; }; done
for f in mcp/snippets/*; do node -e 'const fs=require("fs");const f=process.argv[1];fs.writeFileSync(f,fs.readFileSync(f,"utf8").split("/ABSOLUTE/PATH/agentcoin/integrations/").join("/ABSOLUTE/PATH/agentcoin-public/"))' "$f"; done
# Guard: forbidden patterns. Public export must not contain the droplet IP, sslip hostname, or private paths.
hits=$(rg -n --hidden -g '!.git' -g '!.gitignore' -g '!node_modules' -g '!.venv' -g '!package-lock.json' \
  -e 'PRIVATE KEY' -e 'BEGIN OPENSSH' -e 'ssh-(ed25519|rsa)' -e '143\.244\.167\.51' -e '\.secrets' -e '/etc/agentcoin' \
  -e 'testnet\.env' -e 'droplet' -e 'ai-agents-01' -e 'mnemonic' -e 'integrations/' -e '(?i)polyform' --pcre2 . || true)
other=$(rg -n --hidden -g '!.git' -g '!node_modules' -g '!.venv' -g '!package-lock.json' -e 'sslip' -e '143-244-167-51' . || true)
if [ -n "$hits$other" ]; then echo "FORBIDDEN PATTERN HITS:"; echo "$hits"; echo "$other"; exit 4; fi
echo "export ok: $DEST (not committed; review, then commit locally)"
