# AgentCoin door-knocker (Phase B, DRY RUN)

It finds agents in public registries and plans **one** short, signed, testnet-labelled offer per agent. Offers go over
the agent's own machine channel only: an A2A `message/send` to the endpoint in the agent's published A2A card. There is
no email, DM, or social channel, and no human is contacted.

**Status (v0.4.0): nothing has been sent to any agent.** The `KILL` file is committed. While it exists, nothing is sent,
whatever the env vars say.

## Run

```bash
npm run doorknock:crawl      # read-only crawl -> out/targets.json, out/top25.json
npm run doorknock:dry-run    # plans knocks with fetch disabled -> out/dry-run-plan.json, out/offer.json, out/knock-log.dry-run.jsonl
```

## Sources (read-only)

| Source | Endpoint | Auth |
|---|---|---|
| x402 Bazaar (CDP) | `GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources` | none |
| Official MCP Registry | `GET https://registry.modelcontextprotocol.io/v0/servers?search=` | none |
| ERC-8004 IdentityRegistry, Base Sepolia | `tokenURI(id)` on `0x8004A818BFB912233c491871b3d84c89A494BD9e` (most recent ids) | none (RPC read) |
| Public A2A cards | `GET https://<host>/.well-known/agent-card.json`, legacy `agent.json` | none |
| Virtuals ACP directory | `GET https://acpx.virtuals.io/api/agents` | none. ACP's own channel is on-chain jobs on Base **mainnet**, so these agents are listed but never knocked. |

Ranking adds up factual signals: a reachable A2A endpoint, ERC-8004 registration on Base Sepolia, an x402 seller on
Base Sepolia or Base, a remote MCP server, keyword matches in the agent's own description, and ACP job count. Each
target's `reason` lists exactly which signals applied. Entries on the same host are merged and counted once, and
duplicate A2A endpoints are knocked once. Localhost and private hosts are dropped.

## Safety rails (`knock.mjs`)

- `DRY_RUN` defaults to `1`. A live send needs **all** of: `DRY_RUN=0`, `DOORKNOCK_LIVE_ACK=send-to-outside-agents`,
  no `KILL` file, `DOORKNOCK_KILL` not set to `1`, and a real public https `AGENTCOIN_BASE_URL` (placeholders are
  refused).
- One knock per agent endpoint, ever (from the log).
- At most one follow-up, and only if the agent replied with content (`engaged`). Errors and empty acks do not count.
- 50 sends per rolling 24 h (`DAILY_LIMIT`).
- Opt-out: a reply that contains `{"agentcoin":"opt-out"}` or opt-out wording adds the endpoint to
  `do-not-contact.json`. Self-service `POST /v1/optout` on the service is merged in too. Cards that say do-not-contact
  or no-solicit are skipped.
- Log: `out/knock-log.jsonl` for live runs (gitignored), `out/knock-log.dry-run.jsonl` for dry runs.
- The offer is EIP-191 signed by the operator (the ERC-8004 #10494 owner) over RFC 8785 JSON. Recipients can check it
  against `ownerOf(10494)`.
