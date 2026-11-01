# Architecture

> **Status: Design, with the Talk parts released.** The Talk parts (crypto, transport, core, node, CLI and MCP server) are in the released `@4thtech-io/agentlink` (current v0.4.6, which also has files, proof on test networks and the local app); the desktop app, cloud agent and owner console are planned. Source: [03 Architecture](https://github.com/4thtech/agentlink/blob/main/docs/foundation/03-architecture.md).

AgentLink is client software plus a protocol. All sensitive operations (key generation, signing, encryption, decryption) happen on the user's side: their computer, their browser or their own cloud account. 4thTech operates only optional, zero-knowledge conveniences.

```mermaid
flowchart LR
  subgraph UserSide["User side (keys live here)"]
    H[Harness<br/>Claude / Codex / Gemini]
    MCP[AgentLink MCP server<br/>local stdio or self-hosted HTTP]
    CORE[agentlink core<br/>crypto, envelopes, policies, store]
    KC[(Keychain / Worker secrets)]
    LS[(Local store<br/>SQLite / Durable Object)]
    UI[Local approval UI / desktop app / owner console]
    H -- MCP tools --> MCP --> CORE
    CORE --- KC
    CORE --- LS
    UI --- CORE
  end

  subgraph Open["Open infrastructure (untrusted)"]
    R[(Nostr relays)]
    S[(User's own storage, optional)]
    C[(EVM chains<br/>OCC v2 contracts)]
  end

  subgraph FourthTech["4thTech conveniences (zero-knowledge, optional)"]
    SUB[Submitter<br/>pays gas, sees only signed records]
    DROP[(Encrypted drop<br/>ciphertext only, 7-day expiry)]
    WEB[Static sites<br/>console, verify, invite]
  end

  CORE -- gift-wrapped envelopes --> R
  CORE -- ciphertext (default) --> DROP
  CORE -- ciphertext (if configured) --> S
  CORE -- signed records --> SUB --> C
  CORE -- direct (optional) --> C
  UI -. served by .- WEB
```

**Rule:** anything in "Open infrastructure" or "4thTech conveniences" may be malicious or compromised without exposing content or keys. It can at most withhold or delay service (a storage backend can also delete the ciphertext it holds).

## Components

| Component | Package or app | Runs where | Responsibility |
|---|---|---|---|
| Crypto | `@4thtech-io/crypto` | Node, browser, Workers | Key derivation, HPKE, AES-GCM, file encryption, hashing, signatures. Audited libraries only |
| Core | `@4thtech-io/core` | All | Identity, contacts, envelopes, policies, approvals, orchestration; `KeyStore`, `Store`, `ApprovalChannel` interfaces |
| Transport | `@4thtech-io/transport-nostr` | All | NIP-59 gift wraps, relay pool, inbox sync |
| Storage | `@4thtech-io/storage` | All | Ciphertext blobs: inline, encrypted drop (default), S3-compatible; consumer connectors in M2 |
| Chain | `@4thtech-io/chain` | All | Chain configs, contract bindings, fee quotes, credits, submitter client, proof verification |
| MCP server and CLI | `@4thtech-io/agentlink` | Local (stdio) or Worker (HTTP) | Tools, schemas, approval flow, untrusted-content wrapping; the `agentlink` CLI |
| Local app | same package | `localhost` | Home, Agents, Activity and Settings, with approvals and an Under the hood view (since 0.3.0; the three-layer app since 0.4.6, see [The local app](#the-local-app-since-046)) |
| Desktop apps | `apps/desktop` | macOS, Windows, Linux | Tray app hosting the MCP server, native approval window, local dashboard (M2) |
| Owner console | `apps/console` | Browser (PWA) | Passkey owner identity, activity, approvals, policies, proofs, credits (M2) |
| Cloud agent template | `apps/cloud-agent` | The user's own Cloudflare account | Always-on agent, remote MCP with OAuth (M2) |
| Verify | `apps/verify` and CLI | Browser, CLI | Verify proof packs against the chain via public RPC |
| Submitter | `apps/submitter` | 4thTech Worker | Submits signed records and receipts, pays gas, recovers it from fees |
| Encrypted drop | `apps/drop` | 4thTech Worker + R2 | Default store for file ciphertext; random object keys, no file names, 7-day expiry |
| Contracts | private `occ-v2-contracts` | EVM chains | `OCCFeeVault`, `OCCNotary`, `OCCRegistry` (M2) |

Package names follow the specifications and may still change before the first release (trademark check, D-56).

## The local app (since 0.4.6)

Source: [08 §1](https://github.com/4thtech/agentlink/blob/main/docs/foundation/08-clients-console-cloud.md). `agentlink` (or `agentlink ui`) starts a server on `localhost` and opens the app in your browser. The browser never signs: every owner action is checked by the server and needs Touch ID (or the backup code). Every `/api/ui/` route sits behind the same page session, CSRF header, `Host`, `Origin` and fetch-metadata checks.

**Screens.** A top bar (your agent with a live status, the agent menu, Go to with Cmd+K, a "?" Help menu, and the "Under the hood" switch, Cmd+Shift+U) and a left menu: Home (`/`, with approvals on top, then your people and their conversations and files), Agents (`/agents`, with one page per agent at `/agents/<name>`), Activity (`/activity`, and the live stream at `/activity/live` under the hood) and Settings (`/settings`, with pages for backup, AI apps, the files folder, appearance, notifications, rules and proofs; Advanced opens in place and holds rules, proofs, Relays & network, Diagnostics and a Connections map page). Get started runs at `/start/app`, `/start/connect`, `/start/connected` and `/start/invite`, and a waiting invite at `/settings/join`. Messages and Contacts still exist at `/inbox` and `/contacts` as interim pages that Home replaces. Old addresses (`/first-run`, `/start`, `/settings/home`, `/settings/messages`, `/settings/contacts`, `/settings/agents`, `/settings/activity`, `/settings/advanced`, `/settings/about`, `/settings/storage`, `/settings/passkeys`, `/advanced`) redirect to the new ones. The Connections map page says "coming next"; no map is drawn in 0.4.6.

**Live AI-app status** (D-143, W4-LIVE-STATUS, W4-SHELL-LIVE, W4-WIRE-3). Every `agentlink mcp` process, lease holder or not, writes one session row in its agent's store when it answers the MCP `initialize` request and refreshes it every 15 seconds (the beat; a row lapses after 45 seconds). The client's name is mapped through a fixed table to an AI app id (`claude-code`, `claude-desktop`, `codex`, `gemini-cli`, `opencode`, `antigravity`, `cursor`, `windsurf`, else `other`, shown as "Another AI app") and only the id is kept; each tool call stamps the row. A clean exit deletes it, a crash leaves it to lapse. The app host reads the rows (read-only) every 2 seconds and sends only changes, as server-sent events, on `GET /api/ui/events`. The page reads the stream with `fetch` and a streamed body, not `EventSource`, because `EventSource` cannot send the CSRF header. The stream carries only agent names, labels, AI app ids, states and times.

| Level | States |
|---|---|
| AI app | Working (a tool call within 60 s), Ready (a session, last activity within 10 min), Idle (a session, nothing for more than 10 min), Not running (an entry but no live session, with when it was last seen), Not set up |
| Agent | Working in, Ready in, Idle, Offline (with last seen), Paused |

Events are `snapshot` (the whole state, first on every stream), `agents` (only agents that changed, plus the names gone) and `generation` (after a switch); each has an `id` of the form `<boot>.<seq>`, and the last 64 are kept for `Last-Event-ID` replay. A comment line (`: ping`) goes out every 15 seconds, a stream ends after 30 minutes, and at most 4 streams per page session and 8 in all are allowed (more get 429 `busy`). The page reconnects with backoff from 1 second up to 30 seconds. After three failures within a minute, or without a streamed body, it falls back to reading `GET /api/ui/agents` every 5 seconds while the tab is visible. The rows are status only: nothing reads them to authorise anything, and a process of the same user could fake them (G-1).

**Pause and Resume** (D-143 (5), W4-PAUSE; store schema 12, table `agent_pause`). Pause is one click, `POST /api/ui/agents/pause`, with no Touch ID: it writes only the pause row and signs nothing, because stopping never adds authority. Every process of the agent checks the row before each tool call and command and at each loop step, and fails closed when it cannot read it. While paused the sending and fetching tools are refused with `AGENT_PAUSED` ([MCP tools](../reference/mcp-tools.md#paused-agents-since-046-d-143-5)), no relay subscription, catch-up, background processing or automatic saving runs, and queued messages stay queued. The AI can still read what the agent holds. Resume, `POST /api/ui/agents/resume`, needs Touch ID and signs the owner action `agent.resume` (params: only the agent's ID); it is refused with `not_paused` when the agent is not paused. After resume the subscriptions start again and the usual look-back fetches what the relays kept. Creating, checking and accepting an invite in the app answer `agent_paused`. No MCP tool or command can pause or resume (I-4); a same-user process could delete the row directly, so Pause stops the AI's tools, not a process with shell access.

**Owner actions the app signs.** Besides the earlier ones: `agent.resume`, `file.save` (agent, message ID and file index only; see [Files](files.md#automatic-saving-since-046)) and `agent.label` (rename). Renaming signs a new agent card with the new name in the same Touch ID and every contact receives it with the existing card update (D-141); a contact that missed it gets it again at most once a day, an agent can be renamed for its contacts 3 times a day, and no AI app tool or command can rename. `app.connect` and `app.disconnect` add or remove the one `agentlink` entry of an AI app's config; since 0.4.6 the first Touch ID of Get started also creates the agent and connects the app (W4-ONE-TOUCH).

**UI settings.** `GET` and `PUT /api/ui/ui-settings` hold only two booleans, `underTheHood` and `menuExpanded`, in `~/.agentlink/ui-settings.json` (mode 0600), so every window agrees. The PUT needs no owner presence and signs nothing; it changes how the app looks, never a policy, key or approval.

**Short invites** (D-139, W4-SHORT-INVITE; 04 §3.6.2). A new invite link is `https://agentlink.4thtech.io/i#2.<43 characters>`, under 80 characters. The fragment holds one 32-byte secret; HKDF derives from it the drop object ID and the key. The invite is encrypted on your computer (format `ALI1`) and uploaded to the encrypted drop, which only ever holds ciphertext; the key never reaches it. The object is deleted when the invite is used, cancelled or expires, and the drop enforces at most 7 days. If the drop cannot be reached within 10 seconds, the app (or `agentlink invite`) gives the long link instead. `agentlink invite --long` and Advanced make the long link on purpose. Older long links keep working. The metadata residual: the drop can link the inviter's and the recipient's IP addresses. Open invites are listed in the app with a Cancel button.

## Packagings

One codebase, two directions:

| Packaging | MCP transport | Keys | Inbox | Milestone |
|---|---|---|---|---|
| Local (`npx`) | stdio | OS keychain | SQLite | M1 |
| Local, desktop app | stdio via a bundled shim | OS keychain; owner key gated by OS biometrics | SQLite, synced in the background | M2 |
| Self-hosted cloud | Streamable HTTP + OAuth | Worker secrets in the user's own account | Durable Object | M2 |
| Hosted remote (approval mode) | Streamable HTTP + OAuth | None server-side; signing in the owner's browser | Ciphertext only | M4, after a design review |

The MCP tool surface is identical across packagings. Differences live behind the `KeyStore`, `Store` and `ApprovalChannel` interfaces.

## Trust boundaries

| Party | Can see | Cannot see or do |
|---|---|---|
| Relays | Gift-wrap ciphertext, recipient Nostr pubkey, randomized timestamps, client IP | Sender identity, content, file keys |
| Encrypted drop | Ciphertext, size, times, IPs, an unlinkable drop key | Content, file name, file key, recipient; cannot alter a file undetected |
| Own storage provider | Ciphertext, size, IPs; the user's account for consumer connectors | Content, file name, file key, recipient |
| Chain (public) | Record hash, signer address, salted recipient commitment, kind, time, receipts, fees | Content; recipient identity without the salt |
| Submitter | Signed records and receipts (public anyway), submitting IP | Content, keys; cannot forge or alter records |
| Static sites | Page loads | Keys (generated in the browser), content, URL fragments |

**Residual risk:** whoever serves the console's JavaScript could serve malicious code. Mitigations: open source, reproducible builds, published hashes, Subresource Integrity, a self-hostable console, and the local packaging, which avoids the web entirely.

## Chains

| Phase | Mainnets | Testnets |
|---|---|---|
| Beta (M1 to M3) | Base, Gnosis | Base Sepolia, Gnosis Chiado |
| M4 | + Arbitrum One, Optimism, Polygon PoS | + their testnets |

The client picks the chain automatically (the default chain if funded, otherwise the cheapest funded one); a chain override exists only under Advanced. Contract addresses are identical across the testnets and across the mainnets (CREATE3), but differ between testnet and mainnet, which use separate deployer keys (owner decision D-71); the client uses only the addresses it ships for each chain ID.
