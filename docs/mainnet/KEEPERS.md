# Mainnet deposit-route keepers (Base 8453)

The `EscrowDepositRouteFactory` credits a deposit only after **2 of 2** allowlisted keepers attest the same
Transfer (`attestDeposit`). Each keeper is one process with its own key. Keepers cannot move escrowed funds:
they only vote on deposits into routes; route sweeps go to the RecoveryVault, never to the treasury.

| Keeper | Address | Key file (box, 0600) |
|---|---|---|
| 1 | `0xb300C82e88560a854D109aAdc83702D32580D2e5` | `/workspace/agentcoin/.secrets/mainnet-keeper-1.key` |
| 2 | `0xa9d34898B6EbFd084b3B47320c92C4AaF16d2586` | `/workspace/agentcoin/.secrets/mainnet-keeper-2.key` |

Neither is the deployer (`0xd53D68F294c0F680d8cDD4fDF08B4e8ea115Fe00`). Both are set as keepers in the factory
constructor by `DeployMainnet.s.sol` (`KEEPERS=...`, `KEEPER_THRESHOLD=2`).

## Funding
Send **0.005 ETH on Base to each keeper** when the keepers go live (not before the deploy). Basis: an
`attestDeposit` vote is ~80–120k gas; at 0.006–0.011 gwei that is ≈ 0.000001 ETH per vote, so 0.005 ETH covers
several thousand votes, well over ~3 months at the 500 USDC total cap, with margin for gas spikes. Re-check the
balances monthly (`cast balance <addr> --ether --rpc-url https://mainnet.base.org`).

## Where they run
Off the droplet is preferred (two different hosts, so one compromise or outage cannot both attest and stall).
Keys stay in `/workspace/agentcoin/.secrets/` on the box until Carter decides the hosts; copy each key only to its
own host, `chmod 600`, never into the repo, an image or logs. `scripts/keeper.mjs` refuses a key file that is group-
or world-readable and never prints the key (only the keeper address).

## Run
```
cd agent
AGENTCOIN_NETWORK=base \
AGENTCOIN_DEPLOYMENT_FILE=../deployments/8453.json \
RPC_URL=https://mainnet.base.org \
node scripts/keeper.mjs --network base --key-file /etc/agentcoin/keeper.key \
  --offers /etc/agentcoin/offers.json --state /var/lib/agentcoin-keeper/state.json \
  --confirmations 2 --interval-ms 15000
```
- `--network base` forces the `finalized` block tag (votes only on finalized blocks) and disables Anvil keys.
- `--offers`: required off-local. JSON array of the service's route offers (`GET /v1/notarize` →
  `accepts[].extra.agentcoin.offer`). Refresh it when the service's offers change.
- `--state`: persists `nextFromBlock`; first run starts at `deployBlock` from the deployment file.
- Env alternative to `--key-file`: `AGENTCOIN_KEEPER_KEY_FILE` (preferred) or `AGENTCOIN_KEEPER_KEY`.
- A public RPC rate-limits `eth_getLogs`; use a dedicated Base RPC URL for `RPC_URL` in production.

## systemd unit (one per keeper; names scoped `agentcoin-*`)
```
# /etc/systemd/system/agentcoin-keeper@.service   (instance = 1 or 2)
[Unit]
Description=AgentKoin deposit-route keeper %i (Base mainnet)
After=network-online.target
Wants=network-online.target

[Service]
User=agentcoin
WorkingDirectory=/opt/agentcoin/agent
Environment=AGENTCOIN_NETWORK=base
Environment=AGENTCOIN_DEPLOYMENT_FILE=/opt/agentcoin/deployments/8453.json
EnvironmentFile=/etc/agentcoin/keeper-%i.env
ExecStart=/usr/bin/node scripts/keeper.mjs --network base --key-file /etc/agentcoin/keeper-%i.key --offers /etc/agentcoin/offers.json --state /var/lib/agentcoin-keeper-%i/state.json --interval-ms 15000
StateDirectory=agentcoin-keeper-%i
Restart=always
RestartSec=10
NoNewPrivileges=true
ProtectSystem=strict
ReadOnlyPaths=/etc/agentcoin

[Install]
WantedBy=multi-user.target
```
`/etc/agentcoin/keeper-%i.env` holds `RPC_URL=...`. Start: `systemctl enable --now agentcoin-keeper@1`.

## Docker alternative
```
docker run -d --name agentcoin-keeper-1 --restart unless-stopped \
  -e AGENTCOIN_NETWORK=base -e RPC_URL=<base rpc> -e AGENTCOIN_DEPLOYMENT_FILE=/cfg/8453.json \
  -v /etc/agentcoin/keeper-1.key:/run/secrets/keeper.key:ro -v /etc/agentcoin:/cfg:ro -v agentcoin-keeper-1:/state \
  -w /app/agent agentcoin-agent:<version> \
  node scripts/keeper.mjs --network base --key-file /run/secrets/keeper.key --offers /cfg/offers.json --state /state/state.json
```

## Health
Logs are JSON lines with the keeper address and each vote's tx hash. Alert if a keeper's ETH drops below
0.001 ETH, if the process restarts repeatedly, or if `factory` deposits sit at 1 of 2 attestations for > 10 min.
