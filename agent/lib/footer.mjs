// Receipt footer: one additive `agentcoin` field on order, verdict and score responses.
// Factual metadata only. Never placed inside a signed payload (signatures verify exactly as before).
// `verified` is true only when this response's checks passed (EIP-191 signature recovery against the
// operator signer and/or an on-chain read); `checks` lists what was checked.

export const FOOTER_VERSION = "agentcoin-footer/v1";

// Client libraries and framework plugins live in the public source repository.
// They are not published to npm or PyPI yet (published: false; no install commands).
export const PLUGINS = [
  ["@agentcoin/core", "npm", "integrations/core-ts"],
  ["@agentcoin/mcp", "npm", "integrations/mcp"],
  ["@agentcoin/x402-fetch", "npm", "integrations/x402-fetch"],
  ["@agentcoin/x402-escrow-hint", "npm", "integrations/x402-escrow-hint"],
  ["@agentcoin/agentkit", "npm", "integrations/agentkit"],
  ["@agentcoin/langchain", "npm", "integrations/langchain-js"],
  ["@agentcoin/openai-agents", "npm", "integrations/openai-agents-js"],
  ["@agentcoin/vercel-ai", "npm", "integrations/vercel-ai"],
  ["agentcoin-core", "pypi", "integrations/python/agentcoin-core"],
  ["langchain-agentcoin", "pypi", "integrations/python/langchain-agentcoin"],
  ["openai-agents-agentcoin", "pypi", "integrations/python/openai-agents-agentcoin"],
  ["crewai-agentcoin", "pypi", "integrations/python/crewai-agentcoin"],
].map(([name, ecosystem, localPath]) => ({ name, ecosystem, published: false, localPath, localPathBase: "https://github.com/stos-technologies/agentcoin" }));

/** @param {string} publicUrl */
export function makeFooter(publicUrl) {
  const base = String(publicUrl ?? "").replace(/\/+$/, "");
  return function footer({ serviceId = null, verified = false, checks = {} } = {}) {
    return {
      v: FOOTER_VERSION,
      verified: verified === true,
      checks,
      network: "base-sepolia",
      chain_id: 84532,
      testnet: true,
      ...(serviceId ? { seller_score_url: `${base}/v1/reputation/${serviceId}` } : {}),
      get_your_score_url: `${base}/v1/services`,
      get_your_score: { method: "POST", url: `${base}/v1/services`, body: { url: "<agent card, MCP or x402 resource URL>" }, result: "serviceId; signed score at GET /v1/reputation/{serviceId}" },
      how_to_route: {
        llms_txt: `${base}/llms.txt`,
        openapi: `${base}/openapi.json`,
        mcp: { transport: "streamable-http", url: `${base}/mcp`, server_card: `${base}/.well-known/mcp/server-card.json` },
        a2a: `${base}/.well-known/agent-card.json`,
        plugins: PLUGINS,
      },
    };
  };
}
