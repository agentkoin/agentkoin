// Side-effect-free network profile (no file or RPC access), shared by config.mjs and the pure modules
// (exchange/, router/, service/site, lib/pages) that label their JSON. AGENTCOIN_NETWORK selects:
//   local | base-sepolia (testnets; labels unchanged) | base (Base mainnet, chainId 8453, real USDC).
// publicChainId / x402Network / explorer are what public JSON and pages show. local keeps the Base Sepolia
// labels it has always shown (byte-identical testnet/local output).
export const BASE_MAINNET_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Circle USDC on Base
export const NETWORK_PROFILES = Object.freeze({
  local: Object.freeze({ chainId: 31337, publicChainId: 84532, x402Network: "eip155:84532", explorer: "https://sepolia.basescan.org", x402V1Network: "base-sepolia", testnet: true }),
  "base-sepolia": Object.freeze({ chainId: 84532, publicChainId: 84532, x402Network: "eip155:84532", explorer: "https://sepolia.basescan.org", x402V1Network: "base-sepolia", testnet: true }),
  base: Object.freeze({ chainId: 8453, publicChainId: 8453, x402Network: "eip155:8453", explorer: "https://basescan.org", x402V1Network: "base", testnet: false }),
});

export function resolveNetwork(name = process.env.AGENTCOIN_NETWORK ?? "local") {
  const p = NETWORK_PROFILES[name];
  if (!p) throw new Error(`unknown AGENTCOIN_NETWORK ${name}; expected ${Object.keys(NETWORK_PROFILES).join(" | ")}`);
  return { name, ...p };
}

export const PROFILE = resolveNetwork();
/** true on local and base-sepolia, false only on base. Used for every `testnet` flag (realValue = !TESTNET). */
export const TESTNET = PROFILE.testnet;
export const X402_NETWORK = PROFILE.x402Network;
export const PUBLIC_CHAIN_ID = PROFILE.publicChainId;
export const EXPLORER = PROFILE.explorer;
/** x402 v1 network name (Dexter facilitator v1 exact): "base-sepolia" on testnets, "base" on Base mainnet. */
export const X402_V1_NETWORK = PROFILE.x402V1Network;

// Public copy on Base mainnet. On testnets/local netCopy and netHide are the identity, so testnet output is
// byte-identical by construction. Phrase-level only: JSON keys such as "testnet" are never touched.
/** Exchange escrow default: "always" (testnets) or "optin" (base). AGENTCOIN_ESCROW_DEFAULT=always|optin overrides. */
export const ESCROW_DEFAULT = ["always", "optin"].includes(process.env.AGENTCOIN_ESCROW_DEFAULT) ? process.env.AGENTCOIN_ESCROW_DEFAULT : TESTNET ? "always" : "optin";
/** Exchange fee (bps) on escrow opt-in orders in optin mode (list fee 80 bps; min unchanged). AGENTCOIN_ESCROW_FEE_BPS overrides. */
export const ESCROW_FEE_BPS = /^[0-9]{1,4}$/.test(String(process.env.AGENTCOIN_ESCROW_FEE_BPS ?? "")) ? Number(process.env.AGENTCOIN_ESCROW_FEE_BPS) : 60;
/** judge-kit npm reference: dist-tag "testnet" on testnets; on base AGENTCOIN_JUDGE_KIT_TAG (default "mainnet", to be published). */
export const JUDGE_KIT_TAG = TESTNET ? "testnet" : process.env.AGENTCOIN_JUDGE_KIT_TAG ?? "mainnet";
export const JUDGE_KIT_REF = `@agentkoin/judge-kit@${JUDGE_KIT_TAG}`;

const BASE_COPY = [
  [/Testnet only: Base Sepolia \(84532\), test USDC, no real value/g, "Base mainnet (8453), Circle USDC with real value"],
  [/Testnet only: Base Sepolia \(84532\), test USDC\./g, "Base mainnet (8453), Circle USDC with real value."],
  [/On testnet, earnings are test USDC with no monetary value\. This is a way to try the system\./g, "Earnings are Circle USDC with real value. The contracts are unaudited and capped; read /risks first."],
  [/ on testnet today/g, " today"],
  [/AgentKoin Exchange: testnet agent services marketplace\. Every hire is a USDC escrow job judged by a staked evaluator\./g, "AgentKoin Exchange: agent services marketplace. Hires are direct USDC payments by default; escrow judged by a staked evaluator is opt-in (escrow: true)."],
  [/A hire opens a USDC escrow job on Base Sepolia that a staked evaluator judges against pinned criteria; the payout follows the verdict after a 600 s challenge window\./g, "A hire is a direct USDC payment to the seller by default. Opt in to escrow (escrow: true) and the payment is held in JobEscrow until a staked evaluator judges it against pinned criteria (lower Exchange fee, escrow-protected badge). Read /risks first."],
  [/AgentKoin Exchange \(testnet\)/g, "AgentKoin Exchange"],
  [/Testnet · test USDC only/g, "Base mainnet · USDC"],
  [/Testnet · USDC only/g, "Base mainnet · USDC"],
  [/Base Sepolia testnet; test value only, no real value/g, "Base mainnet; real value"],
  [/test value only, no real value/g, "real value"],
  [/judging is unpaid on testnet today/g, "judging is unpaid today"],
  [/Use a throwaway testnet key/g, "Use a dedicated key"],
  [/@agentkoin\/\*, testnet tag/g, "@agentkoin/*, mainnet tag"],
  [/AgentKoin testnet/g, "AgentKoin"],
  [/ \(testnet; /g, " ("],
  [/erc8004:84532/g, "erc8004:8453"],
  [/earn test USDC/g, "earn USDC"],
  [/Testnet only\./g, "Base mainnet."],
  [/@agentkoin\/judge-kit@testnet/g, JUDGE_KIT_REF],
  [/ No mainnet deployment exists\./g, ""],
  [/There is no mainnet deployment and no real money\./g, "Base mainnet, real USDC."],
  [/chain ID <code>84532<\/code>/g, "chain ID <code>8453</code>"],
  [/chain ID 84532/g, "chain ID 8453"],
  [/Circle test USDC/g, "Circle USDC"],
  [/\(test USDC, no real value\)/g, "(USDC, real value)"],
  [/Base Sepolia testnet only; test USDC; no real value/g, "Base mainnet; USDC; real value"],
  [/Base Sepolia testnet/g, "Base"],
  [/Base Sepolia \(testnet\)/g, "Base"],
  [/Base Sepolia/g, "Base"],
  [/USDC \(test\)/g, "USDC"],
  [/test USDC/g, "USDC"],
  [/Test USDC/g, "USDC"],
  [/No real value\./g, "Real USDC."],
  [/no real value/g, "real USDC"],
  [/Testnet only \(chainId 84532\)/g, "Base mainnet (chainId 8453)"],
  [/chainId 84532/g, "chainId 8453"],
  [/Testnet, test USDC only/g, "USDC"],
  [/Testnet, USDC only/g, "USDC only"],
  [/Public testnet · /g, ""],
  [/USDC has no monetary value/g, "USDC has real value"],
  [/Testnet, test USDC only/g, "USDC"],
  [/testnet beta/g, "beta"],
  [/testnet API/g, "API"],
  [/testnet agent marketplace/g, "agent marketplace"],
  [/testnet service/g, "service"],
  [/testnet deployment/g, "deployment"],
  [/testnet demo/g, "demo"],
  [/ \(testnet\)/g, ""],
  [/"base-sepolia"/g, '"base"'],
  [/eip155:84532/g, "eip155:8453"],
];
export function netCopy(s, testnet = TESTNET) {
  if (testnet || typeof s !== "string") return s;
  return BASE_COPY.reduce((t, [re, to]) => t.replace(re, to), s);
}
/** Drop testnet-only lines (faucets, Sepolia-only FX quotes) and "(Base Sepolia)" sections from text on base. */
export function netHide(text, testnet = TESTNET) {
  if (testnet) return text;
  const out = [];
  let skip = false;
  for (const line of text.split("\n")) {
    if (/^#{1,3} /.test(line)) skip = /\(Base Sepolia\)/.test(line);
    if (skip || /faucet/i.test(line) || /on Base Sepolia/.test(line)) continue;
    out.push(line);
  }
  return out.join("\n");
}
const ADDR = /^0x[0-9a-fA-F]{40}$/;
/**
 * Exchange buyer-fee recipient. Testnets/local: unchanged behaviour (explicit option, else a well-formed
 * AGENTCOIN_EXCHANGE_FEE_RECIPIENT, else the operator signer, else null). base: the env/option is REQUIRED,
 * must be a well-formed address and must not be the operator signer (no silent fallback); throws otherwise.
 */
export function resolveExchangeFeeRecipient({ network = PROFILE.name, option, env = process.env, operatorAddress = null } = {}) {
  const fromEnv = ADDR.test(String(env.AGENTCOIN_EXCHANGE_FEE_RECIPIENT ?? "")) ? env.AGENTCOIN_EXCHANGE_FEE_RECIPIENT : undefined;
  if (network !== "base") return option ?? (fromEnv ?? (operatorAddress ?? null));
  const r = option ?? env.AGENTCOIN_EXCHANGE_FEE_RECIPIENT;
  if (!r) throw new Error("AGENTCOIN_NETWORK=base: AGENTCOIN_EXCHANGE_FEE_RECIPIENT is required (the fee Safe); refusing to start");
  if (!ADDR.test(String(r))) throw new Error("AGENTCOIN_NETWORK=base: AGENTCOIN_EXCHANGE_FEE_RECIPIENT is not an address; refusing to start");
  if (operatorAddress && String(r).toLowerCase() === String(operatorAddress).toLowerCase()) {
    throw new Error("AGENTCOIN_NETWORK=base: AGENTCOIN_EXCHANGE_FEE_RECIPIENT must not be the operator signer; refusing to start");
  }
  return r;
}
