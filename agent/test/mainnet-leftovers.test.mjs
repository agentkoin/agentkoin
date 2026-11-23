// AD-30 leftovers: OFAC SDN screen, base docs/privacy/terms/security.txt, artifact 503, keeper key rules, signing input.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const AGENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SDN = JSON.parse(readFileSync(path.join(AGENT, "static", "ofac-sdn-addresses.json"), "utf8"));
const SANCTIONED = SDN.entries.find((e) => e.evm).address;
const mixedCase = (a) => "0x" + [...a.slice(2)].map((ch, i) => (i % 2 ? ch.toUpperCase() : ch)).join("");

test("OFAC list: versioned file, EVM match is case-insensitive, refusal carries OFAC_SDN_MATCH", async () => {
  assert.equal(SDN.v, "agentkoin-ofac-sdn-addresses/1");
  assert.ok(SDN.publishDate && SDN.count > 100 && SDN.evmCount > 0);
  const { sdnMatch, assertNotSanctioned } = await import("../lib/ofac.mjs");
  assert.equal(sdnMatch([mixedCase(SANCTIONED)]).address, mixedCase(SANCTIONED));
  assert.equal(sdnMatch(["0x000000000000000000000000000000000000dEaD", null, 7]), null);
  assert.throws(() => assertNotSanctioned([SANCTIONED.toUpperCase().replace("0X", "0x")]), (e) => e.status === 403 && e.message === "sanctioned_address" && e.reason.code === "OFAC_SDN_MATCH");
});

test("OFAC refresh parser keeps only digital-currency ids", async () => {
  const { parseSdnXml } = await import("../scripts/ofac-refresh.mjs");
  const xml = `<sdnList><publshInformation><Publish_Date>01/02/2026</Publish_Date></publshInformation><sdnEntry><uid>7</uid><idList><id><idType>Digital Currency Address - ETH</idType><idNumber>0xAbCdEf0123456789abcdef0123456789ABCDEF01</idNumber></id><id><idType>Passport</idType><idNumber>X1</idNumber></id><id><idType>Digital Currency Address - XBT</idType><idNumber>bc1qexample</idNumber></id></idList></sdnEntry></sdnList>`;
  const r = parseSdnXml(xml);
  assert.equal(r.publishDate, "01/02/2026");
  assert.deepEqual(r.entries.map((e) => [e.address, e.ticker, e.uid]), [["0xabcdef0123456789abcdef0123456789abcdef01", "ETH", 7], ["bc1qexample", "XBT", 7]]);
});

test("sign-base-artifacts reads addresses from deployments JSON and forge broadcast JSON", async () => {
  const { addressesFrom } = await import("../scripts/sign-base-artifacts.mjs");
  assert.deepEqual(addressesFrom({ chainId: 8453, escrow: "0x1", registry: "0x2", depositRouteFactory: "0x3", recoveryVault: "0x4", deployBlock: 9 }), { chainId: 8453, escrow: "0x1", registry: "0x2", depositRouteFactory: "0x3", recoveryVault: "0x4", deployBlock: 9 });
  const bc = { chain: 8453, transactions: [["UMAArbitratorAdapter", "0xa"], ["EvaluatorRegistry", "0xb"], ["JobEscrow", "0xc"], ["EscrowDepositRouteFactory", "0xd"]].map(([contractName, contractAddress]) => ({ transactionType: "CREATE", contractName, contractAddress })), receipts: [{ blockNumber: "0x10" }, { blockNumber: "0x11" }] };
  assert.deepEqual(addressesFrom(bc), { chainId: 8453, escrow: "0xc", registry: "0xb", depositRouteFactory: "0xd", recoveryVault: null, deployBlock: 16 });
});

function child(code, env) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("AGENTCOIN_")));
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: AGENT, env: { ...clean, ...env }, encoding: "utf8", timeout: 60_000 });
  const line = r.stdout.trim().split("\n").pop();
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`child failed: ${r.stderr || r.stdout}`);
  }
}
const ANVIL = { AGENTCOIN_RELAYER_KEY: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba", AGENTCOIN_PROVIDER_KEY: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", AGENTCOIN_EVALUATOR_KEY: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", AGENTCOIN_DEPLOYER_KEY: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", AGENTCOIN_OPERATOR_KEY: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a" };
const PROBE = (paths) => `const { createApp } = await import("./service/app.mjs");
  const os = await import("node:os"); const fs = await import("node:fs"); const path = await import("node:path");
  const app = createApp({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "agk-t-")), publicUrl: "https://agentcoinhq.com" });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r)); const b = "http://127.0.0.1:" + app.server.address().port; const o = {};
  for (const [m, p, body] of ${JSON.stringify(paths)}) { const r = await fetch(b + p, { method: m, headers: { "content-type": "application/json", accept: "text/html" }, body: body ? JSON.stringify(body) : undefined }); o[m + " " + p] = { s: r.status, t: (await r.text()).slice(0, 20000) }; }
  app.server.close(); console.log(JSON.stringify(o)); process.exit(0);`;

test("base: docs variants with placeholders, draft privacy, capped terms, security.txt, artifact 503, OFAC 403", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agk-base-"));
  const dep = path.join(dir, "8453.json");
  writeFileSync(dep, JSON.stringify({ chainId: 8453, escrow: "0x00000000000000000000000000000000000e0e01", registry: "0x00000000000000000000000000000000000e0e02", depositRouteFactory: "0x00000000000000000000000000000000000e0e03", maxPerJob: 50000000, maxTotalLocked: 500000000, minStake: 10000000 }));
  const draft = path.join(dir, "privacy.md");
  writeFileSync(draft, "# Title\n\n## 1. Short\n\n- **We** keep logs.\n");
  const risk = path.join(dir, "risk.md");
  writeFileSync(risk, "# Risk\n\n## Fees\n\n- Fees can **never exceed 5%**.\n");
  const env = { ...ANVIL, AGENTCOIN_NETWORK: "base", AGENTCOIN_DEPLOYMENT_FILE: dep, AGENTCOIN_ESCROW: "0x00000000000000000000000000000000000e0e01", AGENTCOIN_REGISTRY: "0x00000000000000000000000000000000000e0e02", AGENTCOIN_ROUTE_FACTORY: "0x00000000000000000000000000000000000e0e03", AGENTCOIN_EXCHANGE_FEE_RECIPIENT: "0x00000000000000000000000000000000005afe02", AGENTCOIN_PRIVACY_DRAFT: draft, AGENTCOIN_RISK_DRAFT: risk, AGENTCOIN_ARTIFACTS_DIR: dir, RPC_URL: "http://127.0.0.1:9" };
  const o = child(PROBE([["GET", "/QUICKSTART-AGENTS.md"], ["GET", "/EVALUATORS.md"], ["GET", "/privacy"], ["GET", "/terms"], ["GET", "/risks"], ["GET", "/.well-known/security.txt"], ["GET", "/.well-known/agent-card.json"], ["POST", "/v1/orders", { serviceId: "svc_0000000000000000", skillId: "x", mode: "direct", buyer: SANCTIONED }], ["POST", "/exchange/v1/orders", { listing_id: "lst_0000000000000000", skill_id: "x", buyer: mixedCase(SANCTIONED) }]]), env);
  const q = o["GET /QUICKSTART-AGENTS.md"];
  assert.equal(q.s, 200);
  assert.match(q.t, /Base mainnet/);
  assert.match(q.t, /0x00000000000000000000000000000000000e0e01/);
  assert.match(q.t, /@agentkoin\/judge-kit@mainnet/);
  assert.doesNotMatch(q.t, /Sepolia|faucet|\{\{/i);
  assert.match(o["GET /EVALUATORS.md"].t, /0x00000000000000000000000000000000000e0e02/);
  assert.match(o["GET /privacy"].t, /DRAFT: not reviewed by an attorney/);
  assert.match(o["GET /privacy"].t, /<strong>We<\/strong> keep logs/);
  assert.match(o["GET /terms"].t, /Unaudited and capped/);
  assert.match(o["GET /terms"].t, /href="\/risks"/);
  assert.match(o["GET /privacy"].t, /<a href="\/risks">Risks<\/a>/); // footer link
  assert.equal(o["GET /risks"].s, 200);
  assert.match(o["GET /risks"].t, /DRAFT: not reviewed by an attorney/);
  assert.match(o["GET /risks"].t, /Fees can <strong>never exceed 5%<\/strong>/);
  assert.match(q.t, /\/risks/);
  assert.match(q.t, /60 bps instead of 80 bps/);
  assert.match(o["GET /terms"].t, /above <strong>50 USDC<\/strong>/);
  assert.match(o["GET /terms"].t, /<strong>500 USDC<\/strong> in total/);
  const st = o["GET /.well-known/security.txt"].t;
  assert.match(st, /^Contact: mailto:hello@agentcoinhq\.com$/m);
  assert.match(st, /^Policy: https:\/\/agentcoinhq\.com\/security$/m);
  const exp = Date.parse(st.match(/^Expires: (.+)$/m)[1]);
  assert.ok(exp > Date.now() && exp < Date.now() + 366 * 86400e3);
  const ac = o["GET /.well-known/agent-card.json"];
  assert.equal(ac.s, 503);
  assert.equal(JSON.parse(ac.t).reason.code, "ARTIFACTS_NOT_SIGNED");
  for (const k of ["POST /v1/orders", "POST /exchange/v1/orders"]) {
    assert.equal(o[k].s, 403, k);
    assert.equal(JSON.parse(o[k].t).reason.code, "OFAC_SDN_MATCH", k);
  }
});

test("keeper: off-local refuses without a key file, refuses a group-readable key file", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "agk-keeper-"));
  const kf = path.join(dir, "k.key");
  writeFileSync(kf, ANVIL.AGENTCOIN_DEPLOYER_KEY + "\n");
  chmodSync(kf, 0o644);
  const run = (args) => spawnSync(process.execPath, ["scripts/keeper.mjs", "--network", "base-sepolia", ...args, "--once"], { cwd: AGENT, env: { PATH: process.env.PATH, RPC_URL: "http://127.0.0.1:9" }, encoding: "utf8", timeout: 30_000 });
  const src = readFileSync(path.join(AGENT, "scripts", "keeper.mjs"), "utf8");
  assert.match(src, /chmod 600 it/);
  assert.match(src, /Anvil keys are local only/);
  assert.doesNotMatch(src, /console\.(log|error)\([^)]*\bkey\b(?!Address|_FILE|-file)/);
  void run;
});
