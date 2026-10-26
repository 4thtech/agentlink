# 08 — Clients: Local UI, Owner Console, Cloud Agent, Public Pages, Desktop Apps

UX requirements and screen inventory are in `11-claude-design-brief.md`. This document covers behaviour and engineering.

---

## 1. Local approval UI (P0)

- Served by the MCP/CLI process on `http://localhost:<random port>`, listening on `127.0.0.1` and `::1` with the same port and on no other interface (D-79; a machine with no IPv6 loopback listens on `127.0.0.1` only). A random **session token** is kept in memory only and included in the URL the process opens (`/?t=…`); it is never written to disk. Reject requests without the token, with a wrong `Host` header, or from other origins (DNS-rebinding protection). Reject any `Host` other than exactly `localhost:<port>` (including `127.0.0.1:<port>`), and any `Origin` other than `http://localhost:<port>`. A POST must carry that Origin.
- The token only grants *viewing*. Every owner operation (approve, policy, folders, storage, backup) additionally requires **owner presence**: a WebAuthn passkey registered for `localhost` (PRF unwraps the owner key) or the owner passphrase. So a shell-capable agent that opens the page still cannot approve (04 §2.5). The passkey is registered on this page with one entry of the owner code, stored as `ALKP` v1 under `owner-passkey`, and checked as in 04 §2.3.1 (M1-8e; proposed, owner confirms at merge).
- **Owner setup on the first-run page (M1-11s-c, D-120 (1); proposed, owner confirms at merge).** While no owner exists anywhere, `/first-run` offers setup: `POST /api/ui/first-run/owner/begin` (empty body) returns the WebAuthn creation values, and `POST /api/ui/first-run/owner/finish` (the creation response) creates the owner with that passkey, a backup owner code returned once for a collapsed "Backup way to approve" display, and the agent's first card, all or nothing (04 §2.2, §2.3.1). Both are `presence: 'setup'` routes behind their own setup gate (session, CSRF, Origin, fetch metadata, octet-stream body, backoff, then "no owner exists"), never the owner-presence gate. Once an owner exists they answer `owner_exists` and the page shows "Approvals are already protected on this computer". A failure answers `failed` with a fixed `reason` (`rolled_back`: nothing kept, start again; `keychain`: items may remain, `agentlink doctor`; `check_failed`; `internal`); `done_unconfirmed` means the owner was kept and its code is shown, but the card could not be confirmed (`agentlink doctor`). After setup the page shows the owner fingerprint, and the CLI logs it in a fixed line; the race this leaves is in 04 §2.5 (G-1).
- **First run v2 (0.3.0; D-130 (1), (2); flow decided by the owner, details proposed, owner confirms at merge; card M1-UX-FIRSTRUN-V2).** The first-run page leads with the passkey on a platform authenticator: the passkey is created with `authenticatorSelection: {authenticatorAttachment: "platform", residentKey: "required", userVerification: "required"}`, the PRF extension and `hints: ["client-device"]`, and the button names the platform ("Use Touch ID", "Use Windows Hello", otherwise "Use a passkey"). Before the gesture the page shows the folders that setup creates (`~/AgentLink/Send`, `~/AgentLink/Inbox`, `~/AgentLink/Proofs`, mode 0700) and that Send will be allowed. The one confirmation then creates the owner, registers the passkey, signs the first card and signs the first policy (the 06 §3 defaults with `files.allowedFolders` = the real path of `~/AgentLink/Send`, which must be a real folder, never a link (at either level), new or empty; anything else is refused before the gesture, as for `policy allow-send-folder`, 06 §8), all or nothing, as one owner flow (04 §2.5; M1-36b-2-b); where PRF comes only from a following `get()`, that second gesture follows in the same flow (M1-11s-c-c). The owner code is then shown once as "Your backup code", in a real `<form>` whose username field is `autocomplete="username"` with the fixed value "AgentLink backup code – <computer name>" and whose code field is `autocomplete="new-password"`, so "Save in my password manager" lets the browser's own save sheet appear; "Copy" is secondary and warns that other apps can read the clipboard; the page continues only after "I saved it". The setup routes never return the code to anything but this page (never to a tool, a log or terminal output). Then the recovery kit (D-120 (2)) and "Ready". If the browser offers no platform passkey with PRF, the page says which browser on this computer works (M1-UX-PRF-MATRIX) and offers to continue with the backup code only. An owner who already has an owner code (0.2.0) enters it once to register the passkey (the bullet above; design adjustment B-9).
- **Approving with the passkey (D-130 (1)).** On every approval card the main button is "Approve with Touch ID" (or the platform's name, as above); "Use backup code instead" is a secondary link that opens a wide field that accepts paste, with show and hide (card M1-11b-5). Proposed (Q-130-1, 04 §2.5): the backup-code field on approval cards sets `autocomplete="off"`, which asks the browser not to fill in a saved code (browsers may ignore this). A password manager keys the saved code by host, so it may also offer it to a look-alike page on another local port: part of the fake-prompt residual (04 §2.5).
- Opens automatically (or via OS notification) when approval is needed; `agentlink ui` opens it manually.
- **Opened for the owner by the AI (D-130 (3); decided by the owner, details proposed, owner confirms at merge; card M1-UX-OPEN-APP).** An agent-run `agentlink ui` (no TTY or a harness marker) opens the page through the OS opener, as in the owner's terminal, and prints one fixed line built with `cliPrefix()`: that the page opened in the browser, or, when no browser can be opened (SSH, headless), the command to run in the owner's own terminal. It never prints the link. The MCP server opens the approval page on `pending_approval` (06 §2.5) and the Files page on `needs_setup` with code `NO_ALLOWED_FOLDER` (06 §2.3), with no new tool (D-53). The rules are in 04 §2.5 ("What the AI may cause"): OS opener only, no link or secret in a result, no value taken from a URL parameter, only after this agent's own tool call, at most one open per 30 s. On a missing folder the Files page shows a banner with the fixed default only: "Allow ~/AgentLink/Send for sending files?", with one passkey gesture (`policy.set`; card M1-UX-SEND-FOLDER-EXISTING). This replaces M1-11b-9's "run by an agent, it opens nothing".
- Pages: Approvals · Activity · Contacts · Files (allowed folders, inbox folder) · Storage (optional, Advanced: shows whether files go through the encrypted drop or own storage, with drop usage; own S3-compatible storage is connected in the terminal (`agentlink storage connect`, 06 §8); the page shows its status and a "connect in terminal" step, and tests it, D-48, D-117) · Proofs & credits (balances, agent address QR, top-up options) · Policies · Backup (export behind the owner's passkey; restore is terminal only, D-117 A) · Advanced (keys fingerprint, relays, RPCs, chains).
- Approvals and policy changes produce owner-signed actions that the core verifies.
- Same React component library as the console (shared `packages/ui`), bundled into the npm package.
- The local UI is a React app in `apps/local-ui` (Vite, browser-only, uses `packages/ui`), built into static assets that the CLI embeds and serves through this server; `packages/node` carries no React. Owner presence and signing stay on the server and the browser never signs; every mutating route is presence-gated centrally (D-118).
- Known limit: a passkey registered for `localhost` can be requested by any page on any localhost port (04 §2.5). The desktop app (§8, M2) removes this with a native approval window; this page stays for `npx` users.
- **Top-up link (D-111, format decided in D-113, 2026-10-21).** `needs_credits` (06 §2.4), `agentlink_status` `topUpUrl`, `agentlink credits --topup` and the Proofs & credits page all give one link to the pay page (§2.3): `https://{payHost}/#v=1&a=<agent address>&usd=<suggested amount>`. Address and amount sit in the fragment, so they never reach the pay host's server; the link names no network or token (D-40); `usd` is the shortfall rounded up to the first preset and at least the minimum, and is optional; `v=1` versions the format. `{payHost}` comes from the shipped chain config (`PAY_PAGE` in `@4thtech-io/chain`), never from inbound content. **Gated on a live pay page (M1-26-e review):** the config also says whether the page is `live` (default no, until it is deployed); while it is not, no tool or command gives a link, a QR code or opens a browser, and `needs_credits` says adding credits is not available yet. Design: `docs/design/topup-ux.md` §5.

---

## 2. Owner console (P1, M2)

**Static PWA**, hosted by 4thTech on Cloudflare (and self-hostable). No backend; it talks only to relays, public RPCs, the encrypted drop or the user's storage (for previews) and submitters. Its screens (`packages/ui`) also serve as the desktop app's local dashboard (§8, D-41).

### 2.1 Identity

- **New owner:** passkey creation with PRF → owner seed generated in browser (see 04 §2.2) → encrypted backup published to relays → recovery kit download offered.
- **Existing local owner (CLI-created):** `agentlink owner link` shows a QR / link with a one-time transfer: the CLI encrypts the owner seed to an ephemeral X25519 key generated by the console page (key exchange via QR + 6-digit code shown on both sides). The console then wraps the seed with a new passkey.
- **Sign-in on a new device:** passkey → `user.id` gives owner Nostr pubkey → fetch encrypted backup → PRF unwrap.
- If PRF is unavailable: generated recovery code flow (04 §2.3).

### 2.2 Functions

| Area | Behaviour |
|---|---|
| **Agents** | List owner's agents (from agent cards); add agent (pairs a local or cloud agent to this owner); revoke |
| **Activity** | Subscribe with the owner Nostr key on the relays of all the owner's agents, as their owner-signed cards authenticate them (07 §4.3, G-24; accepted with D-65); decrypt all envelope copies; unified timeline across agents. Reading owner copies, including NIP-42 AUTH, needs an `OwnerSession` opened with presence, and a copy appears on an agent's thread only under the attribution rules of 04 §3.1.1 ("Where the owner shows a copy"). That reading needs presence is a UX trade-off for the owner to confirm (D-39, D-40) |
| **Threads** | Per contact; messages, files (download + decrypt in browser), proof badges and receipts |
| **Approvals** | Approval requests arrive as encrypted `approval-request` envelopes from agents; owner approves/denies; decision returned as an owner-signed `approval` envelope (04 §3.4.1) |
| **Policies** | Edit per-agent policies; sent to the agent as an owner-signed `policy` envelope; agents accept only if signed by the owner key in their agent card (satisfies I-4) |
| **Proofs** | List notarized records, receipts, export proof pack, open verify page |
| **Credits** | Balances per agent and chain; "Add credits" opens the pay page (§2.3) for that agent with the top-up link (§1, D-111): crypto first, the user's own account or an exchange, and card last once live; fee history, including top-ups |
| **Storage** | Optional, advanced: show whether each agent uses the encrypted drop or own storage (D-48); guided own-storage setup for cloud agents |
| **Settings** | Passkeys, recovery kit, relays (the owner's own additions to the bootstrap set, local only and never published, 07 §4.3), RPC overrides, language |
| **Push** | Web Push for approval requests: the subscription endpoint is stored only in the agent card extension / owner-signed config sent to the user's own agents; 4thTech runs no push server in beta (cloud agents send Web Push directly with VAPID keys generated by the owner) |

### 2.3 Web security

- Strict CSP: `default-src 'self'`; `script-src 'self'` with SRI; `connect-src 'self' https: wss:` (required because counterparties' storage hosts and relays are arbitrary; content is still end-to-end encrypted); no third-party scripts or analytics; `Trusted Types`.
- The **deposit page** (which may load a wallet connector such as WalletConnect) runs on a **separate origin** (`pay.`) with no access to owner keys; it only receives the agent address.
- **Pay page methods (D-111; direction, owner decides details).** Crypto first: the page works with no card path (decided). Free test credits come first on testnets, then **use crypto you already have**, connecting the user's own account (WalletConnect, EIP-6963 providers), detecting the network from the account's stablecoin balances with the D-40 rule and asking for one confirmation, a transfer of the exact amount to the agent's address that the agent turns into credits gaslessly (M3-4b); and **send from an exchange**, the agent's address with a QR code, the coin and the network named only inside the exchange steps, as information and never a choice (D-117 B), with the $5 minimum (D-117 D) and wrong-network guidance. **Pay by card** comes last, after the legal entity is decided (D-15): a provider's own hosted checkout (no provider script inside `pay.` unless a CSP review accepts it; the provider gets only the agent address and the amount; approach and provider open, M2-18a, M3-4c). Every cost is the user's (12 §1). Progress is read in the browser from public RPC (balance at the agent's address, `creditsOf`); the page stores nothing server-side and offers a payment record built in the browser. Each method states its privacy effect once (D-109, 12 §4.4). Design brief: `docs/design/topup-ux.md`.
- Reproducible build; release artifacts and their hashes published on GitHub; the console shows its build hash in Settings.
- Separate origins: `console.`, `verify.`, `invite.` (or path-based with care).

---

## 3. Cloud agent template (P1, 0.4.0, D-131)

**Repo:** `apps/cloud-agent` in the monorepo. It is generated one way into the public template repository `4thtech/agentlink-cloud-agent` at a release tag, for the "Deploy to Cloudflare" button (D-131 (7), `release-and-deployment.md` §4.8).

**What 0.4.0 gives the user (D-131).** An always-on agent in the user's **own** Cloudflare account, used from Claude on the web and in the Claude iOS and Android apps: "Send this to Ana's agent" works from a phone. 0.4.0 is Claude only; ChatGPT web comes later and ChatGPT mobile is not supported (D-131 (5)). The supported plan is Workers Paid, $5 a month (D-131 (4)). 4thTech hosts nothing that holds a key (D-37).

### 3.1 Components

- **Worker** (entry), on one host, `https://agentlink.<account>.workers.dev` by default: `/mcp` (streamable HTTP MCP, served directly with no redirect), the OAuth endpoints and metadata, the owner pages (`/setup`, the sign-in page, `/approve/<id>`, `/status`), `/health`. Preview URLs are off, and `/mcp` is never redirected (proposed, owner confirms at merge).
- **AgentDO** (Durable Object, SQLite-backed): exactly one per deployment (`idFromName("agent")`), so it is the single publisher (06 §6; proposed, owner confirms at merge). It holds the store (the local schema, 07 §3), the agent `KeyStore`, the outbox, approvals, the owner-signed grant list (§3.3) and the owner's `ALKP` and `ALKR` blobs (opaque to the Worker). Relay sync runs on alarms only (default 60 s; proposed, owner confirms at merge: no always-open relay socket, because outbound sockets keep the object in memory and billed, spike S-5). The alarm re-arms itself first, is idempotent, keeps a per-relay cursor (cold start reads back at most 48 h) and opens at most 5 relay sockets per run.
- **MCP:** a stateless MCP handler in the Worker (the MCP SDK's web-standard streamable HTTP transport, the same SDK major as the stdio server) that calls the shared tool handlers (`packages/mcp-tools`, 06 §1) against `AgentDO`. Not the Agents SDK `McpAgent`, which is deprecated (D-131 (10)).
- **OAuth:** `@cloudflare/workers-oauth-provider`, inside the narrow crypto exception of D-131 (11) and 04 §8; sign-in needs the owner (§3.3).
- **Storage:** the user's R2 bucket binding, created by the template. Received files are saved there and handed out as a short-lived link (06 §2.3, G-14). Own S3-compatible credentials stay a later option.
- **Logs:** Workers logs, traces, Tail and Logpush are off in the template's Wrangler config, and a deploy check refuses a config that turns one on (I-7, as for the drop, 07 §5.4).

### 3.2 Keys and the owner

- **Agent seed, desktop path (certified first, D-131 (3)).** `npx -y @4thtech-io/agentlink cloud deploy`, which the user's desktop AI app can run, opens Cloudflare's own sign-in in the browser (Wrangler), generates the agent seed **on the user's computer**, sets it with `wrangler secret put AGENT_SEED` in the **user's** account, deploys, and prints the setup link with the setup code in the link's `#` part (never sent to a server; proposed, owner confirms at merge). Wrangler keeps its sign-in on the computer, so the CLI then says to run `wrangler logout` (04 §2.5 "Deploy credentials on the computer"). 4thTech never sees the seed or a Cloudflare token.
- **Agent seed, Deploy-button path.** Cloudflare copies the template into the user's GitHub or GitLab account (the guide says a free account is needed) and asks for two secrets. The guide page generates both in the browser, with copy buttons, and never sends them anywhere (D-131 (9)): `SETUP_CODE` and `SEED_WRAP_KEY`. On the first `/setup`, the Worker generates the agent seed and stores it in `AgentDO` sealed under `SEED_WRAP_KEY` through `@4thtech-io/crypto`. Both stay in the user's account.
- **Owner (D-131 (1), (2)).** The cloud agent has its **own** owner. `/setup` asks for the setup code, then "Protect your agent with Face ID": one passkey gesture creates the owner seed **in the browser**, wraps it under the passkey PRF (`ALKP`, 04 §2.3.1), signs the agent's first card and first rules (06 §3 defaults) and shows the recovery code once (`ALKR`, 04 §2.3.2), with a save step. The Worker receives only the public keys, the signed objects and the two wrapped blobs; it hands the blobs to any browser that asks, which is safe because neither opens without the passkey or the recovery code (04 §2.5). If the owner loses both, nobody can approve for this agent again: the user deploys a new agent and pairs again with each contact. `/setup` then closes for good: it is single use, and refused once an owner exists. Owner presence on the cloud is in 04 §2.5 "Cloud owner presence".
- **Pairing with a desktop agent.** Like any contact; the accept card offers the local label "my other computer" (D-130 (5)). One owner across devices is later (M2-UX-DEVICE-LINK).
- **Host name.** The passkey belongs to the exact Worker host (04 §2.5). Renaming the Worker, changing the account subdomain or moving to a custom domain means enrolling again with the recovery code; the guide says "keep the address" (spike S-6).

### 3.3 OAuth sign-in (Claude connectors; D-131 (6), (11); details proposed, owner confirms at merge)

1. The user adds `https://<host>/mcp` as a custom connector on claude.ai (Settings → Connectors). It then appears in the Claude iOS and Android apps on the same account; connectors cannot be added on a phone.
2. `/mcp` without a token answers 401 with the protected-resource metadata. Its `resource` is the exact public `/mcp` URL, fixed at deploy time (or pinned at `/setup`), never taken from the request's `Host` header. The authorisation server metadata advertises PKCE `S256`, dynamic client registration and client ID metadata documents (CIMD, with `none` as the token auth method), and the `iss` response parameter. Claude's redirect URI is `https://claude.ai/api/mcp/auth_callback`. In 0.4.0 the redirect host is pinned to `claude.ai` by default: a registration or sign-in for any other redirect host is refused unless the owner allows that host under Advanced on `/status` (D-131 (j)). CIMD fetches use the Workers public-only fetch flag.
3. The sign-in page (design `Cloud-signin`) names the app asking, its redirect host and what it gets: "talk, files and proof within your rules; never your rules or keys". The owner approves with the passkey (or the fallback code); the browser signs `connector.authorize` (04 §2.5.1) for that grant. Registering a client grants nothing without this step, and there is no "remember this approval".
4. **On every `/mcp` request** the handler takes the grant ID and client ID from the library's verified token data and `AgentDO` checks that an owner-signed `connector.authorize` exists for them, with a matching scope, not expired and not revoked. Otherwise it answers 401 (`invalid_token`) and revokes the library's grant too. The scope is checked by our handler (the library does not enforce scopes). Access tokens live 1 h; refresh tokens rotate and live at most 30 days.
5. `/status` lists the grants (app name, when added, last used) and removes one with `connector.revoke`, signed on that page. A removed grant fails at its next request, whatever the library's token state is (it keeps the previous refresh token valid once, spike S-1).
6. A token is equivalent to a compromised AI app: it can talk and spend within the signed rules and budget, never sign an owner action (I-4). The 4thTech console's signed challenge and `agentlink cloud login` (a one-time access code from the CLI) come later with the console.

### 3.4 Autonomy

Cloud agents can be **autonomous** (act on inbound messages without a harness, e.g. auto-acknowledge, auto-reply via a configured LLM) only within policy. Default: autonomous actions off; inbound queued for harness or owner. Not in 0.4.0.

### 3.5 Updates, cost and leaving (D-131 (4), (9); details proposed, owner confirms at merge)

- **Updates.** Users deploy into their own accounts, so 4thTech cannot update or roll back their agents. The Worker compares its template version with the latest release tag (a plain public read, nothing about the agent sent) and, when newer, `agentlink_status` says "An update for your cloud agent is available" with the steps ("Sync fork" on GitHub for button users, `agentlink cloud update` from a computer), and `/status` shows the same.
- **Cost.** The guide states Workers Paid ($5 a month) before the deploy. Limits per IP on `/mcp` and the OAuth endpoints and the unknown-sender limits (07 §3.2) keep floods from raising the bill.
- **Leaving (I-10).** `/status` downloads an `ALKK` recovery kit after the owner's gesture (04 §2.3.3); the guide lists the uninstall steps.

---

## 4. Public pages (static, P1)

| Page | Behaviour |
|---|---|
| **Verify** | Drop a proof pack (or open a link with the pack compressed in the URL fragment; format and caps below, G-52). Verifies against chain via public RPC in the browser. Shows plain-language result: "Recorded on Base on 12 Oct 2026 14:02 UTC by *Tali's agent*; delivered 14:05; opened 14:20." For accepted terms it shows a **proof of agreement**: the terms, who proposed and who accepted them and when, and what this does not prove (legal effect) (04 §3.4). Advanced section shows hashes, tx links |
| **Invite landing** | URL `…/i#<invite>`; fragment never sent to the server. Shows inviter name and fingerprint (decoded locally), "I use Claude / ChatGPT / Gemini / Other" → **one install-and-accept prompt** to copy into the user's own agent (06 §7.1, D-53): one paste installs AgentLink if needed and accepts the invite. From M2 it also offers **"View and accept in browser"** (§7) |
| **Docs / landing** | Product site and developer docs (separate from this foundation pack) |

**One link installs and pairs (D-53).** From M1 (the static page, backlog M1-19) the invite page builds the install-and-accept prompt in the browser:
- **Script and headers.** One first-party script file served with the page; no inline script, no third-party scripts, no analytics. CSP: `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'` (plus what 08 §2.3 requires), and `Referrer-Policy: no-referrer`. The script reads `location.hash`, decodes the invite with a size cap, and checks its version, schema and expiry. It never sends the fragment or anything derived from it: no request, beacon or storage write carries it.
- **Untrusted fields.** Every payload field the page shows (the inviter's name, the expiry) is set with `textContent` only, never as HTML; under Trusted Types no HTML sink accepts a string. The name is shown under the contact-name rule (06 §2.1: restricted characters, at most 32, with the "Self-declared" label, 11 §5.2).
- **Prompt.** The prompt is the official per-harness template (06 §7.1) plus the canonical invite link rebuilt from the checked payload. Nothing the inviter chose (name, label, relays) goes into it. It sits in its own section, introduced by our own heading, visually and structurally separate from the inviter details (never inside or next to an element holding payload text). The copy button copies the prompt string held by the script, not text read back from the page.
- **States.** A damaged, expired or oversized invite shows the matching state and no prompt.
- **User action only.** Copying is a user action (the copy button); the page never pastes or opens anything by itself.
- **Test (M1-19).** With a name containing `<img src=x onerror=…>`, `<div>`, a fake "Copy this to your AI" line, control and bidi characters, no DOM element derives from the name, no script runs, and the copy button yields exactly the template plus the canonical link. The test runs in Chromium, where Trusted Types is enforced; `textContent` is the primary control in every browser. The page refuses to be framed.

**Proof-pack links (G-52; decided by the owner in D-71 (6), 15 Oct 2026, on the orchestrator's recommendation).**
- **Format.** A proof pack (07 §8) shared as a link uses the invite's link format (04 §3.6, D-69): `base64url(deflateRaw(utf8(JSON)))` of the pack, in the URL fragment of the verify page, so it never reaches a server. Compressed bytes are never hashed, signed or compared.
- **Decoder.** The verify page decodes it in the browser with the same bounded, strict decoder as the invite (04 §3.6): the input bounded before any parsing, inflation in bounded slices with a running output count and a cap, the stream ending exactly at the end of the input, fatal UTF-8, I-JSON and the strict pack schema. *Derived (proposed; owner confirms at merge):* one generic capped-inflate function in `@4thtech-io/core` serves both, with its caps set per payload type.
- **Pack caps.** The pack has its own inflated-size cap, derived from the largest pack the 07 §8 schema allows, and the matching payload-character limit. The exact numbers are set when the M1b proof work starts (proposed until then).
- **Larger packs are files.** A pack above the link limit is never offered as a link; it is shared as a file (the drop zone, or a download). A pack can carry a disclosed envelope of up to 24 KB of mostly incompressible ciphertext, so such a pack can pass the link limit.
- **Copy** (derived; proposed, owner confirms at merge). Where a pack link is offered, the copy says that a link carrying a disclosed key is itself a disclosure (11 §5).

---

## 5. Hosted remote MCP — approval mode (P2, M4)

For users who want ChatGPT web / claude.ai without self-hosting:

- 4thTech Worker exposes the tool surface; holds **no keys**.
- Read tools return data only from the owner's console session (P2 design TBD: the console relays decrypted views to the hosted MCP over an end-to-end encrypted channel only while the console is open; otherwise "open your console").
- Mutating tools create **proposals**; the owner signs them in the console (passkey); the console publishes the result.
- Requires a design review against I-1–I-3 before implementation.

---

## 6. Hosting summary (4thTech-operated)

| Service | Platform | Holds user secrets? |
|---|---|---|
| Console (incl. browser view-and-accept, §7), verify, invite, docs (static) | Cloudflare Workers static assets | No |
| Desktop app downloads and update feed (M2) | Static hosting of signed artifacts | No (signed binaries and manifests only) |
| Submitter | Cloudflare Worker + DO (rate limits) | No (only its own gas keys) |
| Encrypted drop (D-48) | Cloudflare Worker + R2 (+ Durable Objects for quotas and nonces) | No (ciphertext only; no file keys, file names or accounts; objects deleted within 7 days) |
| Optional relay | VM or container (strfry) | No (ciphertext only) |
| Hosted remote MCP (P2) | Cloudflare Worker | No (by design review) |

---

## 7. Browser counterparty: view and accept (P1, M2)

For a counterparty who has no agent yet (D-35, 02 F-15). Design is part of D2 (11 §6.5).

1. The **invite landing** (§4) decodes the invite locally and shows the inviter's name ("self-declared" or "verified domain", 04 §2.7), owner fingerprint and expiry. It cannot show a safety code: the code needs both sides' pairing messages (04 §3.6.1). Next to the "I use…" picker it offers **View and accept in browser**.
2. This hands off to the console origin with the invite still in the URL fragment (`https://console.…/accept#<invite>`). Keys then live on one origin, under the console's web-security controls (§2.3), and the invite origin stays a plain static page.
3. **Identity** works as for a new console owner (§2.1): a passkey with PRF, the owner seed generated in the browser, an encrypted backup to relays, and a **recovery kit offered** (recovery code fallback when PRF is unavailable). The page also generates a **browser agent** seed, wrapped the same way and included in the same backup and recovery kit, and the owner signs its agent card (harness label "browser"). The agent key is needed because receipts are signed by the recipient agent (05 §3.1).
4. **Pair:** accepting runs the normal pairing protocol (04 §3.6) from the browser. The confirm-contact screen shows name, label and owner fingerprint, and the user's passkey confirmation is the owner approval. Once the inviter's agent answers the handshake, both sides show the same safety code to compare through another channel; until then the page shows the pairing as waiting (04 §3.6.1).
5. **View:** the page syncs from relays and decrypts in the browser. It shows the thread: messages, offers with `terms` (with the changes between versions), files (fetched from the encrypted drop or the sender's storage and decrypted in the browser under the 04 §4 rules) and proof status.
6. **Accept or reject:** with one passkey gesture, the page sends a typed `accept` / `reject` quoting the `termsHash` (04 §3.4) and, for a notarized record, signs the `ACCEPTED` / `REJECTED` receipt with the browser agent key and submits it through a submitter. The gesture approves one commitment scope (04 §3.4.2, D-55), so a receipt for a record that arrives later is signed under it while the page is open and before the scope expires. The page says so: "Keep this page open, or come back before 20 Oct, to add your Accepted receipt." The browser has no background loop, so it never promises "automatically". The recipient pays nothing (receipts are prepaid, 02 §4). The human here is the owner, so this gesture is the commitment approval (D-31).
7. **Export** the proof pack (a proof of agreement for accepted terms) and open the verify page.
8. **Later:** signing in to the console with the same passkey shows this identity, and the owner can add a local agent or the desktop app (§2.2 Agents).

**Fetching files from the encrypted drop: CORS (M1-27a, IR-D48-1 F15d; proposed, owner confirms at merge).** Only `GET` of an object (`/v1/get/…`) and its preflight carry CORS headers. `Access-Control-Allow-Origin` echoes the request's `Origin` only when it is on the drop's configured list: the console origins, exact `https://host[:port]`, never `*` or `null`. The preflight allows method `GET` only, no request headers and no credentials, with `Vary: Origin` and a max-age of 600 s; any other origin or method gets 403 without CORS headers. Upload, PUT, commit, DELETE, report and health send no CORS headers at all, so no web page can call them cross-origin. Objects are served with `Cross-Origin-Resource-Policy: same-origin`, so other pages cannot embed them.

Scope: view, accept or reject, and export. Not a chat app (02 §6). Counter-offers or free-text replies from the browser: `DECISION NEEDED (owner)` (not in D-35; default: not offered).

**Zero knowledge holds:** the pages are static with no backend; the invite payload stays in the URL fragment, which browsers never send to a server; keys are generated and kept in the browser, wrapped with the passkey; decryption happens only in the browser. 4thTech sees page loads, and through the submitter only the signed receipt, which becomes public anyway (I-1 to I-3). Residual risk is the same as for the console (malicious JavaScript from a compromised host, 04 §7; mitigations §2.3); users who need more use a local agent or the desktop app. Passkeys bind to the console's domain, so the production domain choice applies (D-38).

---

## 8. Desktop apps (P1, M2)

Native apps for macOS, Windows and Linux (D-36, D-41), built on the same core. The MCP tool surface is unchanged (06), and the `npx` package stays supported.

| Part | Behaviour |
|---|---|
| **Tray app** | Menu-bar / tray app started at login. Hosts the local MCP server and keeps relay subscriptions open, so the inbox stays synced between harness sessions. Tray menu: status, approvals waiting, open dashboard, pause agent, quit |
| **Harness connection** | Harness configs point to the app's bundled CLI shim (`agentlink mcp`), which relays stdio to the server inside the app over a local IPC channel (Unix socket / named pipe) restricted to the OS user, and starts the app if needed. Whatever connects gets only the MCP tools; owner operations are never available over IPC (04 §2.5) |
| **Full local dashboard** (D-41) | Every console area for this computer's agents: activity, threads, contacts, approvals, proofs, credits, policies, storage and settings, plus files (allowed folders, inbox folder). Built from the console screens in `packages/ui` (§2.2) with the §1 local-only screens. Local agents are read from the local store; showing the owner's other agents (e.g. a cloud agent) uses the owner key, as in the console. Each owner operation needs a fresh biometric prompt. How long a read unlock of the owner key may last: `DECISION NEEDED (security review)` |
| **Native approval window** | Opens on `pending_approval`, with an OS notification. Same approval card as the console; Approve / Deny confirms with the OS biometric prompt, which unlocks the owner key and signs the owner action (04 §2.5). No localhost page is involved |
| **Storage settings** (D-49) | Settings → Storage. Files go through the encrypted drop by default (D-48), so nothing needs connecting. **Connect** buttons for Google Drive, Dropbox and OneDrive: OAuth in the system browser with PKCE and a loopback redirect, minimal scopes (app folder or app-created files), tokens in the OS keychain, never sent to 4thTech (04 §4, 07 §5.5). Connecting is an owner operation with a biometric prompt. S3-compatible storage stays under Advanced. Shows which storage is in use and drop usage against the quota |
| **Owner key** | Held as in 04 §2.2 (desktop row): macOS Keychain access control with user presence; Windows Hello (DPAPI only as an extra layer); Linux owner passphrase or polkit, documented as weaker |
| **Harness auto-setup** | Detects installed harnesses, shows the exact config diff and applies it after confirmation (same rules as `init`, 06 §7). Also offers the harness permission rules that deny access to `~/.agentlink` and the keychain (04 §2.5) |
| **Signed auto-update** | Manifest and artifacts signed with an update key pinned in the app and verified before install; HTTPS only; no downgrades; staged rollout; reproducible builds, SBOM and published hashes; release promotion needs the owner's approval (D-25); the update signing key is kept offline or in an HSM, separate from CI |
| **Code signing and notarization** | macOS: Developer ID signing, hardened runtime and notarization of every embedded binary, including any sidecar. Windows: Authenticode. Linux: signed packages. **Owner action:** obtain an Apple Developer ID (Apple Developer Program) and a Windows code-signing certificate |
| **Framework** | `DECISION NEEDED (architecture task, security review)`: e.g. Tauri (system webview) with a Node sidecar running `@4thtech-io/core`, vs Electron. Criteria: attack surface, OS keystore and biometric APIs, IPC hardening, update signing, sidecar signing and notarization, bundle size, reuse of `packages/ui` |
