// Single source of the service/MCP version (service/app.mjs re-exports it as VERSION; package.json is not authoritative).
export const VERSION = "0.5.40";
/** MCP serverInfo.name: AgentKoin identifier; the former agentcoin-<network> name stays as an alias on the server card. */
export const mcpServerName = (network) => `agentkoin-${network}`;
export const mcpServerAlias = (network) => `agentcoin-${network}`;
