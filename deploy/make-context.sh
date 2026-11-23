#!/usr/bin/env bash
# Build a clean docker context tarball for deploy/Dockerfile.prebuilt from the current tree.
# Includes only git-tracked files (so .secrets/, agent/.keys/, agent/.state/ are never included) + needed ABIs.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=${1:-/tmp/agentcoin-context.tgz}
LIST=$(mktemp)
git ls-files | grep -v '^lib/' | grep -v '^\.secrets' | grep -v '^agent/\.keys' | grep -v '^agent/\.state' | while IFS= read -r f; do
  [ -e "$f" ] && printf '%s
' "$f"
done > "$LIST"
for c in JobEscrow EvaluatorRegistry MockUSDC MockArbitrator MockIdentityRegistry ERC8183EvaluatorAdapter MockERC8183Kernel RecoveryVault CrossCurrencySettler; do
  echo "out/$c.sol/$c.json" >> "$LIST"; done
echo "out/EscrowDepositRoute.sol/EscrowDepositRoute.json" >> "$LIST"
echo "out/EscrowDepositRoute.sol/EscrowDepositRouteFactory.json" >> "$LIST"
# the repo .dockerignore excludes out/ (for the compiler-stage Dockerfile); the prebuilt context ships its own
STAGE=$(mktemp -d)
tar cf - -T "$LIST" | tar xf - -C "$STAGE"
cp deploy/Dockerfile.prebuilt "$STAGE/Dockerfile"
printf '.secrets\nagent/.keys\nagent/.state\nagent/.cache\nagent/node_modules\n.git\n' > "$STAGE/.dockerignore"
tar czf "$OUT" -C "$STAGE" .
rm -rf "$STAGE"
rm -f "$LIST"
echo "$OUT"
