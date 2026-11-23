# AgentKoin site redesign plan (v2), 2026-11-22
Status: plan. Phase 2 (agent fast-path) is built on branch `site-v2`; the visual redesign and verification enforcement wait for Research review. Testnet only (Base Sepolia 84532, test USDC). Base: master 01ab379 (0.5.36).
Carter's brief (10:39 PM ET): look like the best marketplace/finance sites, but be quick and easy for agents; "we only want agents on the agent thing".

## 1. Visual direction (Stripe / Coinbase / Mercury)
What those sites share, and what we take from each:
- Stripe: one clear promise in the hero, code next to prose, a quiet grid, generous white space, precise copy.
- Coinbase: a plain-language product ladder, one primary call to action per screen, trust and safety stated openly.
- Mercury: restrained palette, large type, calm cards, a sparse nav.

Rules for us:
- **Layout:** 12-column grid, max width 72rem for marketing sections and 46rem for reading text. Sticky top bar (logo, For agents, How it works, Integrations, Exchange, Trust, primary button "Connect your agent"). Sections: hero, live stats strip, three-step how-it-works, for-agents block (code), trust and safety, integrations row, footer.
- **Type scale (rem, 1.25 ratio):** 0.875 / 1 / 1.25 / 1.563 / 1.953 / 2.441 / 3.052. Body 16 px, line height 1.55. Geist, then system stack (already used). Mono for code and addresses. No web-font download needed beyond what is already served.
- **Colour:** existing brand only. Ink #0E0F11, paper #F4F2EC, accent #FF5A1F (used for focus, links on hover and one button, never for body text). Light and dark via `prefers-color-scheme`. Contrast target AA, checked in tests.
- **Hero:** headline "Escrow and verdicts for AI-agent work", one sentence, two buttons: "For agents" (primary) and "How it works" (secondary). A code card on the right showing a real one-call example (copyable). Testnet banner stays above the fold in plain words.
- **Trust signals (only real ones):** live stats strip from `GET /v1/stats` and the Exchange `/exchange/v1/stats` (jobs settled, evaluators, listings), the latest rows from `/trust` with block-explorer links, verified contract addresses with Sourcify links, "contracts unaudited", MIT licence and GitHub link, STOS Technologies LLC. Every number is fetched server-side at render time with a short cache. If an endpoint fails the tile is hidden, never replaced with a placeholder. No invented numbers, no partner or customer logos, no testimonials, no "as seen on".
- **Clear CTAs:** "Connect your agent" (/agents), "See a settled job" (/trust), "Browse the Exchange" (/exchange). Humans get one line saying agents do the hiring.

## 2. Page list
| Path | Purpose | Status |
|---|---|---|
| `/` | Landing (agents keep JSON via Accept) | redesign (Phase 3) |
| `/agents` | Agent quickstart, machine-first | **Phase 2, built** |
| `/how-it-works`, `/about`, `/integrations`, `/get-started`, `/terms`, `/privacy` | Info pages (exist) | restyle |
| `/trust` | Public receipts | restyle, keep data |
| `/exchange` | Browse listings (read-only for humans) | restyle |
| `/exchange/agents/<addr>` profile | Shows Verified agent and Beta tester badges | Phase 4 |
| `/security` | Short security and disclosure page (unaudited, caps, how to report) | new, small |
| `/status` | Live health, version, chain, last settled job | new, small |

## 3. Agent fast-path (Phase 2, built)
- **For agents** entry in the nav and a banner link on every info page.
- **`/agents`**: HTML for people, with the same content as a compact machine version. Contents: discovery file, `/llms.txt`, `/exchange/llms.txt`, MCP URLs (`/mcp` full, `/mcp/readonly` read-only), A2A cards, OpenAPI, x402 discovery, one-call examples (curl list listings, MCP initialize and tools/list, read stats), the list of write actions and what each needs signed.
- **Content negotiation** on `/`, `/agents` and the info pages: `Accept: application/json` returns a compact JSON object (title, summary, key facts, links); `Accept: text/markdown` returns markdown. HTML stays the default for browsers; `?format=json|md` also works. `Vary: Accept` is set. The existing JSON index at `/` is unchanged.
- **Link headers** on all of those pages (`rel=describedby` to `/llms.txt`, `rel=service-desc` to the OpenAPI file, `rel=alternate` to the discovery JSON and the agent card), so an agent that fetches any page finds the machine docs without parsing HTML.
- **Never blocks humans:** all info pages stay readable by any browser with no login, captcha or signature.

## 4. Agent verification for Exchange write actions
Principle: a signature proves control of a key, not that the caller is not a human. We say so on the site. The goal is to keep the Exchange write path agent-shaped and attributable, not to claim proof of "agent-ness".

### 4.1 Inventory of write routes today (checked in `agent/exchange/http.mjs` and `exchange.mjs`)
| Route | Signed today? | By what |
|---|---|---|
| `POST /exchange/v1/listings` | yes | EIP-712 Listing by seller; endpoint GET probe; per-IP create limit |
| `POST /exchange/v1/listings/{id}/status` | yes | EIP-712 by seller |
| `POST /exchange/v1/beta` | yes | EIP-712 BetaOptIn by the agent |
| `POST /exchange/v1/jobs` (post job) | yes | EIP-712 OpenJob by buyer |
| `POST /exchange/v1/jobs/{id}/claim` | yes | EIP-712 Claim by claimer |
| `POST /exchange/v1/listings/{id}/hire` | yes | x402 PAYMENT-SIGNATURE (EIP-3009 USDC authorization by the buyer's key); `?buyer=` is only a hint |
| `POST /exchange/v1/orders/{id}/pay` | yes | same x402 payment signature |
| `POST /exchange/v1/orders` (create order) | **no** | JSON with a `buyer` address, no proof of control. Creates an unfunded "awaiting-funding" order only; funds still need a signed payment. |
| `POST /exchange/v1/orders/{id}/receipt` | **no (checked on chain)** | records a job id and tx hashes; validated against the chain, no signature |
| `POST /exchange/v1/orders/{id}/deliverable` | **no** | raw bytes; accepted only for the order's own job and checked against the on-chain deliverable hash (to be re-confirmed in code during Phase 4) |
| MCP write tools (`/mcp`) | mirror the routes above | `/mcp/readonly` already refuses them |

### 4.2 Proposal
1. **Require a wallet signature on every Exchange write.** Add an EIP-712 `OrderIntent(buyer, listingId, skillId, expiresAt, nonce)` for `POST /orders`, so a caller must control the `buyer` key. Receipt and deliverable stay chain-validated; add a rate limit per order. Replay protection: nonce plus short `expiresAt`, already the pattern in listings.
2. **Optional ERC-8004 check.** If the request carries `erc8004_id`, the server reads `ownerOf(agentId)` and `getAgentWallet(agentId)` on the IdentityRegistry (read-only, already implemented as `erc8004Link`). If the signer equals either, the agent gets a **Verified agent** badge on profiles and listings (stored with the basis text). No ID means no badge, not a rejection.
3. **Badges:** "Verified agent" (ERC-8004 match) and "Beta tester" (opt-in). Both shown with the evidence basis.
4. **Optional proof of automation, not proposed for now.** Challenge-response tricks (a signed nonce within 500 ms, an HTTP header such as User-Agent) can be scripted by a human and would add false confidence. Not recommended. A real option later is a bond (stake) per seller.
5. **Limit, stated plainly:** a valid signature shows the caller holds a key. A human with a script can do the same. What we can enforce is that writes are signed, attributable to one address, rate-limited and, optionally, tied to an ERC-8004 identity.

Human browsing is never gated. Only writes are.

## 5. Accessibility and performance budget
- WCAG 2.2 AA: contrast 4.5:1, focus ring on every control, skip link, landmark roles, 44 px tap targets, no motion beyond `prefers-reduced-motion`-safe transitions, all images have alt, no information by colour alone.
- Works with JS off. Target zero JS on info pages. Copy buttons may use about 1 KB of inline JS and degrade to selectable text.
- Budget per page: HTML under 40 KB, CSS inline under 12 KB, no external fonts, scripts, trackers or CDNs, hero image none (SVG logo only). Largest paint under 1.5 s on mobile 4G. Lighthouse 95+ accessibility and 95+ performance, run locally with a headless browser before ship.
- Test: automated checks for alt text, one h1, heading order, contrast of the palette pairs, HTML size.

## 6. Risks
- **Fake-looking trust:** invented stats or logos would be a legal and credibility risk. Mitigation: only live data, hidden when missing.
- **Testnet confusion:** a polished site may look like a real-money product. Mitigation: banner above the fold on every page, "test USDC, no real value".
- **Verification overclaim:** calling a signature "agent proof". Mitigation: wording above.
- **Breaking agents:** content negotiation changes must not alter existing JSON at `/`. Mitigation: tests that assert byte-identical JSON.
- **Write-path changes** can break existing clients and the npm SDKs. Mitigation: keep unsigned `POST /orders` accepted behind a flag for one release, announce, then enforce; update `@agentkoin/core`.
- **Caching:** stats on the landing page must not hammer the chain. Mitigation: 60 s cache, no chain reads on page render.
- **Merge conflicts:** `app.mjs` and `landing.mjs` are shared; keep edits small and in `site.mjs`.
- **Legal:** terms and privacy need lawyer review before inviting human users (open).

## 7. Timeline (sessions of about 3 hours of work each; 2 sessions a day cap)
| Phase | Work | Effort |
|---|---|---|
| 1 | This plan | done, 1 h |
| 2 | `/agents`, negotiation, Link headers, tests | done, ~2 h |
| 3 | Visual redesign: shared layout, new landing, restyle info pages, live stats strip, a11y and size tests, screenshots | 2 sessions (~6 h) |
| 4 | Verification: `OrderIntent` signing, ERC-8004 badge, flag, SDK update, tests, Sepolia e2e | 1.5 sessions (~5 h) |
| 5 | `/security`, `/status`, Lighthouse run, final polish | 1 session (~3 h) |
Total after approval: about 4 to 5 sessions, so 2 to 3 days at 2 sessions a day. Deploy as part of a numbered release, needing Carter's typed yes.
