#!/bin/bash
# Deploy agentcoin-testnet:0.5.38 on ai-agents-01 (visual redesign: new landing + shared layout, live stat tiles, /security, /status). Previous header:
# Deploy 0.5.37 (agent fast-path: /agents, Accept json/markdown negotiation, Link headers). Older header:
# Deploy agentcoin-testnet:0.5.36 (adds /terms draft and the read-only MCP endpoint /mcp/readonly). Older header:
# Deploy agentcoin-testnet:0.5.35 on ai-agents-01 (Exchange earn: open-jobs board, find_earning_opportunities, earn.md; buyer fee
# 0.8% min 0.05 test USDC as an off-chain fee leg to the operator wallet; beta opt-in/waiver/credits; MCP annotations; site pages).
# Modeled on deploy-0.5.34.sh. Testnet (Base Sepolia) only, CDP_SETTLE stays unset, no contract changes.
# Scoped to agentcoin-* only. Does not touch Caddy, other services, agentcoin-evaluator-a/b, or host-wide docker prune. AGC stays off. Never prints env values.
# Expects /root/agentcoin-context-0.5.38.tgz (built with deploy/make-context.sh from the release 0.5.36 commit).
set -euo pipefail
T=0.5.38
PREV=0.5.37
# Extra inputs staged in /root by the operator (never printed): ccd-anchors.json (frozen cores + anchor txs for jobs 30/31),
# ccd-anchor.json (Concordium TESTNET anchor account key), concordium-agent-card.json (exact card bytes, sha256 checked below).
CARD_SHA=1b026237354044055fb1f5d81d6b569afaed86bdcb5c496a68986c1a92671582
echo "=== AGC / CDP_SETTLE check (names and values of those two only) ==="
if grep -E '^AGC_' /etc/agentcoin/testnet.env >/dev/null; then echo "AGC env present; refusing"; exit 1; fi
echo "AGC_ lines: 0"
if grep -E '^CDP_SETTLE=1' /etc/agentcoin/testnet.env >/dev/null; then echo "CDP_SETTLE=1 present; refusing"; exit 1; fi
echo "CDP_SETTLE=1: absent"
[ "$(sha256sum /var/lib/agentcoin/concordium-agent-card.json | cut -d' ' -f1)" = "$CARD_SHA" ] || { echo "hosted card sha256 mismatch; refusing"; exit 1; }
echo "hosted card sha256 ok"
grep -q '^CCD_EVALUATOR_BADGES=' /etc/agentcoin/testnet.env || { echo "CCD_EVALUATOR_BADGES missing; refusing"; exit 1; }
echo "=== preflight ==="
docker inspect agentcoin-testnet --format '{{.Config.Image}}' | grep -qx "agentcoin-testnet:$PREV" || { echo "running image is not $PREV; refusing"; exit 1; }
if docker inspect agentcoin-testnet-$PREV >/dev/null 2>&1; then echo "agentcoin-testnet-$PREV already exists; refusing swap"; exit 1; fi
echo "=== backups bak-pre-$T ==="
for f in router.sqlite router.sqlite-wal router.sqlite-shm jobcache.sqlite jobs.json stats.json optouts.json stake-scan-cache.json; do
  if [ -f /var/lib/agentcoin/$f ]; then cp -a /var/lib/agentcoin/$f /var/lib/agentcoin/$f.bak-pre-$T; echo "backed up $f"; else echo "skip missing $f"; fi
done
cp -a /etc/agentcoin/testnet.env /etc/agentcoin/testnet.env.bak-pre-$T
cp -a /var/lib/agentcoin/ccd-anchors.json /var/lib/agentcoin/ccd-anchors.json.bak-pre-$T
grep -E '^CCD_' /etc/agentcoin/testnet.env | sed 's/=.*/=<set>/'
echo "=== build image ==="
echo "context sha256: $(sha256sum /root/agentcoin-context-$T.tgz | cut -d' ' -f1)"
rm -rf /root/agentcoin-build-$T
mkdir /root/agentcoin-build-$T
tar xzf /root/agentcoin-context-$T.tgz -C /root/agentcoin-build-$T
docker build -q -t agentcoin-testnet:$T /root/agentcoin-build-$T
echo -n "IMAGE_ID="; docker image inspect agentcoin-testnet:$T --format '{{.Id}}'
docker run --rm -w /app/agent --entrypoint node agentcoin-testnet:$T -e 'import("/app/agent/lib/ccd-anchor.mjs").then(async (m)=>{const sdk=await import("@concordium/web-sdk"); console.log("sdk ok", typeof sdk.Transaction.registerData, m.anchorPayloadHex({coreSha256:"0x"+"ab".repeat(32),jobId:1,escrow:"0x"+"11".repeat(20),chainId:84532}).length)})' | grep -q "sdk ok function 136" || { echo "image check failed"; exit 1; }
echo "image check ok (SDK loads, payload builder works)"
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
  cp -a /etc/agentcoin/testnet.env.bak-pre-$T /etc/agentcoin/testnet.env || true
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
cc=$(curl -sS -o /tmp/agentcoin-card.json -w '%{http_code}' http://127.0.0.1:8402/.well-known/concordium-agent-card.json); echo "card $cc"; [ "$cc" = "200" ] || rollback
[ "$(sha256sum /tmp/agentcoin-card.json | cut -d' ' -f1)" = "$CARD_SHA" ] || rollback
echo "card bytes sha256 match"
for id in 30 31; do
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); a=d["anchors"]["concordium"]; assert a["status"]=="finalized" and a["txHash"]; print("badges", d.get("badges")); print("anchor", sys.argv[1][-7:-5], a["status"], a["txHash"])' /tmp/agentcoin-proof-$id.json || rollback
done
fc=$(curl -sS -o /tmp/agentcoin-free.json -w '%{http_code}' http://127.0.0.1:8402/free); echo "free $fc"; [ "$fc" = "200" ] || rollback
python3 -c 'import json; d=json.load(open("/tmp/agentcoin-free.json")); assert d["v"]=="agentkoin-free-offer/v1"' || rollback
rb=$(curl -sS http://127.0.0.1:8402/robots.txt); [ "$rb" = "$(printf 'User-agent: *\nAllow: /')" ] || rollback; echo "robots ok"
sp=$(curl -sS http://127.0.0.1:8402/specs/criteria/notarize-binding-v1.json | sha256sum | cut -d" " -f1); [ "$sp" = "79f3978f30e5dc3251011f5369269fda14ac05ac7472e7fbff7cff87ad1d9272" ] || rollback; echo "spec sha ok"
for pr in "agent.json:agent-card.json" "mcp:mcp/server-card.json"; do a=${pr%%:*}; b=${pr##*:}; [ "$(curl -sS http://127.0.0.1:8402/.well-known/$a | sha256sum)" = "$(curl -sS http://127.0.0.1:8402/.well-known/$b | sha256sum)" ] || rollback; echo "alias $a ok"; done
ac=$(curl -sS -o /tmp/agentcoin-agents.json -w '%{http_code}' http://127.0.0.1:8402/.well-known/agents.json); echo "agents.json $ac"; [ "$ac" = "200" ] || rollback
# ---- Exchange (0.5.34) ----
ec=$(curl -sS -o /tmp/agentcoin-ex.json -w '%{http_code}' -H 'accept: application/json' http://127.0.0.1:8402/exchange); echo "exchange json $ec"; [ "$ec" = "200" ] || rollback
eh=$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8402/exchange); echo "exchange html $eh"; [ "$eh" = "200" ] || rollback
wk=$(curl -sS -o /tmp/agentcoin-exwk.json -w '%{http_code}' http://127.0.0.1:8402/.well-known/agentkoin-exchange.json); echo "exchange well-known $wk"; [ "$wk" = "200" ] || rollback
python3 -c 'import json; d=json.load(open("/tmp/agentcoin-exwk.json")); assert d["v"]=="agentkoin-exchange/0.1" and d["realValue"] is False and d["chainId"]==84532; print("well-known ok", d["contracts"]["escrow"])' || rollback
for p in /exchange/llms.txt /exchange/openapi.json /exchange/.well-known/agent-card.json /exchange/v1/stats /exchange/v1/evaluators /trust/jobs.json; do
  c=$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8402$p); echo "$p $c"; [ "$c" = "200" ] || rollback
done
n=0
for i in $(seq 1 24); do
  n=$(curl -sS http://127.0.0.1:8402/exchange/v1/listings | python3 -c 'import json,sys; print(json.load(sys.stdin).get("total",0))' || echo 0)
  [ "$n" -ge 3 ] && break; sleep 5
done
echo "exchange seed listings: $n"; [ "$n" -ge 3 ] || rollback
# ---- Exchange earn (0.5.35) ----
for p in /exchange/earn.md /exchange/v1/earn /exchange/v1/jobs /exchange/v1/beta /about /how-it-works /integrations /get-started /brand/plated-512.png /brand/plated-1024.png /brand/plated.svg; do
  c=$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8402$p); echo "$p $c"; [ "$c" = "200" ] || rollback
done
# ---- 0.5.36: /terms + /mcp/readonly ----
c=$(curl -sS -o /tmp/agentcoin-terms.html -w '%{http_code}' http://127.0.0.1:8402/terms); echo "/terms $c"; [ "$c" = "200" ] || rollback
grep -q "Draft, not lawyer-reviewed" /tmp/agentcoin-terms.html || rollback
ro=$(curl -sS -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' http://127.0.0.1:8402/mcp/readonly | python3 -c 'import json,sys; t=json.load(sys.stdin)["result"]["tools"]; assert all(x["annotations"]["readOnlyHint"] for x in t); print(len(t))' || echo 0)
echo "/mcp/readonly tools $ro"; [ "$ro" = "9" ] || rollback
curl -sS http://127.0.0.1:8402/.well-known/agentkoin-exchange.json -o /tmp/agentcoin-exwk.json
python3 -c 'import json; f=json.load(open("/tmp/agentcoin-exwk.json"))["fees"]; e=f["exchangeFee"]; assert f["exchangeFeeBps"]==80 and e["min"]=="50000"; print("fee fields ok", f["exchangeFeeBps"], e["min"], e.get("minAppliesBelow"))' || rollback
# ---- 0.5.37: agent fast-path ----
B=http://127.0.0.1:8402
for pr in "text/html:text/html" "application/json:application/json" "text/markdown:text/markdown"; do a=${pr%%:*}; t=${pr##*:}
  ct=$(curl -sS -o /tmp/agentcoin-agents-$$.out -D /tmp/agentcoin-agents-$$.hdr -w '%{content_type}' -H "accept: $a" $B/agents); echo "/agents ($a) $ct"; echo "$ct" | grep -q "$t" || rollback
  grep -qi '^link: .*llms.txt' /tmp/agentcoin-agents-$$.hdr || rollback
done
python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); assert d["v"]=="agentkoin-page/v1" and d["testnet"] is True' < <(curl -sS -H 'accept: application/json' $B/agents) || rollback
echo "agents json ok"
for a in application/json text/markdown; do c=$(curl -sS -o /dev/null -w '%{http_code} %{content_type}' -H "accept: $a" $B/how-it-works); echo "/how-it-works $a $c"; case "$c" in "200 "*) ;; *) rollback;; esac; done
curl -sS -H 'accept: application/json' $B/ | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["service"]=="AgentKoin testnet service" and d["version"]=="'$T'"' || rollback
echo "/ json unchanged"
curl -sS -D - -o /dev/null $B/ -H 'accept: application/json' | grep -qi '^link: .*llms.txt' || rollback
m=$(curl -sS -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' $B/mcp | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["result"]["tools"]))' || echo 0); echo "/mcp tools $m"; [ "$m" -ge 10 ] || rollback
# ---- 0.5.38: redesign ----
for p in /security /status /agents; do c=$(curl -sS -o /tmp/agentcoin-pg.html -w '%{http_code}' -H 'accept: text/html' $B$p); echo "$p $c"; [ "$c" = "200" ] || rollback; done
curl -sS -H 'accept: text/html' $B/ -o /tmp/agentcoin-home.html; grep -q 'class="hero"' /tmp/agentcoin-home.html || rollback
! grep -qi '<script' /tmp/agentcoin-home.html || rollback
echo "home bytes $(wc -c < /tmp/agentcoin-home.html)"; [ "$(wc -c < /tmp/agentcoin-home.html)" -lt 40000 ] || rollback
curl -sS -H 'accept: text/html' $B/status | grep -q 'responding' || rollback
echo "status page ok"
# pipefail-safe listing (no head: SIGPIPE under pipefail failed the 0.5.34 run after DEPLOY checks)
docker ps -a --filter name=agentcoin-testnet --format "table {{.Names}}\t{{.Image}}\t{{.Status}}" > /tmp/agentcoin-ps.txt || true
sed -n 1,4p /tmp/agentcoin-ps.txt
echo "DEPLOY_OK"
