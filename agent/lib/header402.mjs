// PAYMENT-REQUIRED header copy of a 402 challenge (pure; shared by the service and tests).
// Kept small for proxies with 8 KB header limits. Same x402Version/error/resource/exampleUrl/responseSchemaUrl and the
// same USDC exact entry as the body; parts listed in `bodyOnly` are present only in the JSON body.
import { isAgcExact, slimAgcForHeader } from "./agc.mjs";

export const HEADER_BUDGET_BYTES = 6144;
export const HEADER_MARGIN_BYTES = 256;
export const HEADER_LIMIT_BYTES = HEADER_BUDGET_BYTES - HEADER_MARGIN_BYTES; // 5,888 B, all response headers of a 402
const BODY_ONLY_SCHEMES = ["agentcoin-swap"]; // quote-bound entries: full terms (quote, settlement) only in the body

/** @param agc agcConfig(); with an AGC exact entry present (AD-010 6.2) the agentcoin-escrow entry is body-only too. */
export function headerCopy(pr, agc = null) {
  const ext = { ...(pr.extensions ?? {}) };
  delete ext["agentcoin-escrow"];
  if (ext.bazaar?.info?.output) ext.bazaar = { ...ext.bazaar, info: { ...ext.bazaar.info, output: { type: ext.bazaar.info.output.type ?? "json" } } };
  // The full output schema (the published response schema, see responseSchemaUrl / accepts[].extra.responseSchemaHash) is
  // body-only; the header keeps the generic output shape so the header declaration still validates.
  if (ext.bazaar?.schema?.properties?.output?.properties?.example) {
    const sch = ext.bazaar.schema;
    ext.bazaar = { ...ext.bazaar, schema: { ...sch, properties: { ...sch.properties, output: { ...sch.properties.output, properties: { ...sch.properties.output.properties, example: { type: "object" } } } } } };
  }
  const hasAgc = pr.accepts.some((a) => isAgcExact(a, agc));
  const bodyOnlySchemes = hasAgc ? [...BODY_ONLY_SCHEMES, "agentcoin-escrow"] : BODY_ONLY_SCHEMES;
  const accepts = pr.accepts.filter((a) => !bodyOnlySchemes.includes(a.scheme)).map((a) => (isAgcExact(a, agc) ? slimAgcForHeader(a) : a));
  const omitted = bodyOnlySchemes.filter((s) => pr.accepts.some((a) => a.scheme === s)).map((s) => `accepts.${s}`);
  const { evaluators, ...rest } = pr; // AD-011 evaluator listing: body only
  return { ...rest, accepts, extensions: ext, bodyOnly: ["extensions.bazaar.info.output.example", "extensions.agentcoin-escrow", ...omitted, ...(evaluators ? ["evaluators"] : [])] };
}
