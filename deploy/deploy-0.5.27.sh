#!/bin/bash
# Deploy agentcoin-testnet:0.5.27 on ai-agents-01 (signed job proofs, GET /v1/jobs/{id}/proof). Modeled on /root/agentcoin-deploy-0.5.26.sh.
# Scoped to agentcoin-* only. Does not touch Caddy, other services, agentcoin-evaluator-a/b, or host-wide docker prune. AGC stays off. Never prints env values.
# Expects /root/agentcoin-context-0.5.27.tgz (built with deploy/make-context.sh from the release/0.5.27 commit).
set -euo pipefail
T=0.5.27
PREV=0.5.26
echo "=== AGC check (names only) ==="
if grep -E '^AGC_' /etc/agentcoin/testnet.env >/dev/null; then echo "AGC env present; refusing"; exit 1; fi
echo "AGC_ lines: 0"
echo "=== preflight ==="
docker inspect agentcoin-testnet --format '{{.Config.Image}}' | grep -qx "agentcoin-testnet:$PREV" || { echo "running image is not $PREV; refusing"; exit 1; }
if docker inspect agentcoin-testnet-$PREV >/dev/null 2>&1; then echo "agentcoin-testnet-$PREV already exists; refusing swap"; exit 1; fi
echo "=== backups bak-pre-$T ==="
for f in router.sqlite jobcache.sqlite jobs.json stats.json optouts.json; do
  if [ -f /var/lib/agentcoin/$f ]; then cp -a /var/lib/agentcoin/$f /var/lib/agentcoin/$f.bak-pre-$T; echo "backed up $f"; else echo "skip missing $f"; fi
done
cp -a /etc/agentcoin/testnet.env /etc/agentcoin/testnet.env.bak-pre-$T
echo "backed up testnet.env (file only, contents not printed)"
echo "=== build image ==="
echo "context sha256: $(sha256sum /root/agentcoin-context-$T.tgz | cut -d' ' -f1)"
rm -rf /root/agentcoin-build-$T
mkdir /root/agentcoin-build-$T
tar xzf /root/agentcoin-context-$T.tgz -C /root/agentcoin-build-$T
docker build -q -t agentcoin-testnet:$T /root/agentcoin-build-$T
echo -n "IMAGE_ID="; docker image inspect agentcoin-testnet:$T --format '{{.Id}}'
echo "=== swap: keep $PREV as stopped rollback agentcoin-testnet-$PREV ==="
docker stop agentcoin-testnet
docker rename agentcoin-testnet agentcoin-testnet-$PREV
docker run -d --name agentcoin-testnet --restart unless-stopped --network host \
  --env-file /etc/agentcoin/testnet.env \
  -v /var/lib/agentcoin:/var/lib/agentcoin \
  agentcoin-testnet:$T
rollback() {
  echo "CHECK FAILED; rolling back to $PREV"
  docker rm -f agentcoin-testnet || true
  docker rename agentcoin-testnet-$PREV agentcoin-testnet
  docker start agentcoin-testnet
  sleep 2
  curl -sS -o /dev/null -w "rollback healthz %{http_code}\n" http://127.0.0.1:8402/healthz || true
  exit 1
}
ok=0
for i in $(seq 1 30); do
  code=$(curl -sS -o /tmp/agentcoin-healthz.json -w '%{http_code}' http://127.0.0.1:8402/healthz || echo "000")
  if [ "$code" = "200" ]; then echo "healthz $code after ${i}s"; cat /tmp/agentcoin-healthz.json; echo; ok=1; break; fi
  echo "healthz $code, retry $i"; sleep 1
done
[ "$ok" = 1 ] || rollback
ver=$(curl -sS -H 'accept: application/json' http://127.0.0.1:8402/ | python3 -c 'import json,sys; print(json.load(sys.stdin).get("version",""))')
echo "JSON / version=$ver"; [ "$ver" = "$T" ] || rollback
pc=$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8402/privacy); echo "privacy $pc"; [ "$pc" = "200" ] || rollback
nc=$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:8402/v1/notarize); echo "notarize $nc"; [ "$nc" = "402" ] || rollback
for id in 30 31; do
  sc=$(curl -sS -o /tmp/agentcoin-proof-$id.json -w '%{http_code}' http://127.0.0.1:8402/v1/jobs/$id/proof); echo "proof $id $sc"; [ "$sc" = "200" ] || rollback
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["schema"]=="agentkoin-job-proof/v1" and d.get("signature",{}).get("value")' /tmp/agentcoin-proof-$id.json || rollback
done
docker ps -a --filter name=agentcoin-testnet --format "table {{.Names}}\t{{.Image}}\t{{.Status}}" | head -4
echo "DEPLOY_OK"
