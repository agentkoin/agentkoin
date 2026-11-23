// Every MCP tool (router + Exchange + legacy escrow set) carries all five annotations and is clearly read-only or a write.
import test from "node:test";
import assert from "node:assert/strict";
import { routerTools, completeAnnotations } from "../router/tools.mjs";
import { TOOLS as LEGACY } from "../mcp/tools.mjs";

const stubEx = new Proxy({}, { get: (_t, k) => (k === "then" ? undefined : () => ({})) });
const READ_ONLY = new Set(["find_service", "route_task", "get_order", "verify", "get_agent_profile", "find_earning_opportunities", "list_open_jobs", "get_fee_credits", "list_evaluators", "quote", "get_job_status", "get_evaluator_reputation", "verify_attestation"]);

test("MCP annotations: title + readOnly/destructive/idempotent/openWorld hints on every tool; reads and writes split", () => {
  const tools = [...routerTools({ router: {}, exchange: stubEx }), ...completeAnnotations(LEGACY)];
  const names = tools.map((t) => t.name);
  assert.ok(names.includes("record_payment") && names.includes("get_order"), "get_order split into read + record_payment write");
  for (const t of tools) {
    const a = t.config.annotations;
    assert.equal(typeof a.title, "string", `${t.name} title`);
    assert.ok(a.title.length > 3);
    for (const k of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) assert.equal(typeof a[k], "boolean", `${t.name} ${k}`);
    assert.equal(a.readOnlyHint, READ_ONLY.has(t.name), `${t.name} read-only classification`);
    if (a.readOnlyHint) assert.equal(a.idempotentHint, true);
    assert.equal(a.destructiveHint, false, `${t.name}: no tool deletes or overwrites data`);
  }
  // read-only get_order exposes no write parameter
  const go = tools.find((t) => t.name === "get_order");
  assert.equal("receipt" in go.config.inputSchema, false);
  assert.ok("receipt" in tools.find((t) => t.name === "record_payment").config.inputSchema);
  assert.throws(() => completeAnnotations([{ name: "x", config: { title: "X" } }]), /readOnlyHint/);
});
