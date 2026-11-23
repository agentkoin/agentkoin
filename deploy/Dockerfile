# AgentCoin public TESTNET service (Base Sepolia only). Build from the repo root:
#   docker build -f deploy/Dockerfile -t agentcoin-testnet .
# Keys are NOT baked in: provide AGENTCOIN_RELAYER_KEY, AGENTCOIN_PROVIDER_KEY, AGENTCOIN_EVALUATOR_KEY,
# AGENTCOIN_OPERATOR_KEY as host secrets (throwaway testnet keys only).
FROM ghcr.io/foundry-rs/foundry:stable AS contracts
WORKDIR /src
COPY foundry.toml ./
COPY lib ./lib
COPY src ./src
COPY script ./script
RUN forge build --skip test

FROM node:20-slim
WORKDIR /app
COPY agent/package.json agent/package-lock.json ./agent/
RUN cd agent && npm ci --omit=dev
COPY --from=contracts /src/out ./out
COPY agent ./agent
COPY integrations/x402-escrow-hint ./integrations/x402-escrow-hint
COPY deployments/base-sepolia.json ./deployments/base-sepolia.json
COPY docs ./docs
COPY specs ./specs
ENV AGENTCOIN_NETWORK=base-sepolia TRUST_PROXY=1 SERVICE_PORT=8402 NODE_ENV=production
EXPOSE 8402
# the service binds 127.0.0.1 by default; container platforms need 0.0.0.0
ENV SERVICE_HOST=0.0.0.0
CMD ["sh", "-c", "node agent/scripts/sign-artifacts.mjs >/dev/null && exec node agent/service/app.mjs"]
