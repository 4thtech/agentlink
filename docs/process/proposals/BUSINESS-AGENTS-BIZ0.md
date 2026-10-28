# BIZ-0 findings: can vendor agents use our remote MCP and be woken by an invoker?

| | |
|---|---|
| **Card** | BIZ-0 (connector part), `docs/process/backlog.md` |
| **Proposal** | `docs/process/proposals/BUSINESS-AGENTS.md` §5 (the "Lego" connector) and §9 |
| **Method** | Desk research of current official vendor documentation, read on 28 Oct 2026. No live calls were made, so nothing here is a measured number. Every claim names its source page. |
| **Scope** | Anthropic (Messages API MCP connector, Claude Managed Agents, Claude Agent SDK), OpenAI (Responses API remote MCP tool, Agents API, Agents SDK), the A2A protocol and generic webhooks. **Not covered here:** the BIZ-0 measurements of one Durable Object at 10 000 contacts and of alarm cost at shorter intervals. They stay open on the card. |
| **Status** | Spike notes for BIZ-SPEC, BIZ-f, BIZ-g and BIZ-h. Not a spec. |

## 1. Verdict

The recommended design (§5.3: our remote `/mcp` as the only tool surface, plus an invoker that wakes the company's agent with a fixed text) **works with both major vendors**. Each vendor offers at least one server-side API that accepts a remote MCP server per call or per session, with a bearer token supplied by the caller.

| Vendor surface | Verdict | Why, in one line |
|---|---|---|
| Anthropic Messages API + MCP connector | **Works** (beta) | `mcp_servers` with `authorization_token` on every request; Anthropic runs the tool calls; stateless. |
| Anthropic Claude Managed Agents | **Works, with extra steps** (beta) | MCP servers are declared on the agent; the token comes from a vault attached at session creation. Our 15-minute token therefore needs a vault credential per wake-up. |
| Anthropic Claude Agent SDK | **Partly** | Accepts remote MCP with headers per `query()`, but it is a library that the company must host. It is not a service our invoker can call. |
| OpenAI Responses API `mcp` tool | **Works** | `server_url` with `authorization` on every request; OpenAI runs the tool calls. Approval is required by default, so the invoker must set `require_approval: "never"`. |
| OpenAI Agents API (sessions) | **Works** (beta header) | Per-session `transport.authorization`; the API encrypts it and leaves it out of returned resources. Not eligible for ZDR. |
| OpenAI Agents SDK | **Partly** | Same as the Agent SDK: a library the company hosts. Its `hostedMcpTool` is the Responses API tool. |
| A2A | **Partly** | Spec 1.0.0 under the Linux Foundation, with bearer, OAuth 2.0, API key, OIDC and mTLS schemes. Served by Google's agent runtime (preview) and announced by Microsoft; neither Anthropic's nor OpenAI's first-party APIs serve it. |
| Signed webhook | **Works** | Plain HTTPS POST; the company's code calls `/mcp` itself. No vendor dependency. |

## 2. Anthropic

### 2.1 Messages API: MCP connector

Source: platform.claude.com/docs/en/agents-and-tools/mcp-connector.

- **Per request, with a bearer token: yes.** Send `mcp_servers: [{type: "url", url, name, authorization_token}]` together with a matching `tools: [{type: "mcp_toolset", mcp_server_name}]`. Beta header: `mcp-client-2025-11-20`; the older `mcp-client-2025-04-04` is deprecated. Several servers can be attached in one request. The company's own data servers can therefore sit next to ours.
- **Auth.** `authorization_token` is described as an OAuth access token. The caller obtains it and refreshes it; Anthropic runs no OAuth flow. An opaque bearer that our Worker mints fits this field.
- **Limits.**
  - Only MCP *tool calls* are supported; no resources or prompts.
  - The URL must be `https://` and publicly reachable, over Streamable HTTP or SSE.
  - `mcp_toolset` can allowlist or denylist tools.
  - No tool-call timeout is documented.
  - Platforms: Claude API, Claude Platform on AWS and Microsoft Foundry. Not Amazon Bedrock or Google Cloud.
  - **Not eligible for zero data retention.**
- **Wake-up with a fixed text: yes.** The wake-up text is the `user` message and the company's instructions are the `system` prompt. Claude calls `agentlink_inbox` and the other tools itself, inside the same request.
- **What the company configures:** an API key from its Claude Console organization, a model choice, and its instructions. If its agent also needs its own data, it supplies those MCP server URLs and tokens as well.

### 2.2 Claude Managed Agents

Sources: platform.claude.com/docs/en/managed-agents/mcp-connector, …/managed-agents/vaults, and the pricing page.

- **Per session, with a bearer token: yes, through a vault.**
  - The agent object declares `mcp_servers` (`type`, `name`, `url`; no auth field). At most 20 servers per agent.
  - A session supplies credentials through `vault_ids`. Each vault holds `static_bearer` or `mcp_oauth` credentials, matched to a server by normalised URL.
  - `vault_ids` can be set only at creation. `sessions.update` can replace `mcp_servers` on an idle session, but not the vaults.
- **Default approval is `always_ask` for MCP toolsets.** The company must set `always_allow` on our toolset, because our core already enforces every approval. Otherwise each tool call stalls the session waiting for a `user.tool_confirmation`.
- **Wake-up with a fixed text: yes.** Pass `sessions.create(..., initial_events: [{type: "user.message", ...}])`, or send a `user.message` to an existing idle session. Completion can be reported by webhook.
- **Costs and limits.**
  - Tokens are billed at model rates, plus **$0.08 per session-hour** while the session is `running`; idle time is free.
  - MCP tool output above 100 000 characters is moved to a file.
  - The beta header is `managed-agents-2026-04-01`.
- **What the company configures:**
  - its agent ID, with our `/mcp` URL added to the agent and our toolset set to `always_allow`;
  - an environment, whose networking allows our host (or `allow_mcp_servers: true`);
  - a Console API key that our invoker can use to create sessions and vault credentials.
- **Fit with the 15-minute token scoped to one contact.** Before each session, the invoker must create or rotate a vault credential holding the fresh token. A long-lived session per contact keeps the vault it started with. Its token would then expire unless we offer `mcp_oauth` with a refresh grant, which is a larger surface than the proposal assumes. **Recommendation:** one short session per wake-up, each with a vault credential made for it.

### 2.3 Claude Agent SDK

Sources: code.claude.com/docs/en/agent-sdk/mcp and …/agent-sdk/overview.

- `query({options: {mcpServers: {name: {type: "http", url, headers: {Authorization: "Bearer …"}}}, allowedTools: ["mcp__name__*"]}})` attaches our server per run.
- Default connection timeout: `MCP_TIMEOUT`, 30 s. Tool calls: `MCP_TOOL_TIMEOUT`. Results above 25 000 tokens go to a file.
- It is a library that runs the Claude Code harness on infrastructure the company hosts. Our invoker cannot call it directly, so it belongs under **signed webhook** or **manual**: their code receives the wake-up and runs `query()`.
- **Auth for products.** The SDK overview says that, unless previously approved, third-party developers may not offer claude.ai login or rate limits for their products; they use API keys. A company's agent that serves the public must use a Console API key (or a cloud provider), not a consumer plan sign-in.

## 3. OpenAI

### 3.1 Responses API: remote MCP tool

Source: developers.openai.com/api/docs/guides/tools-connectors-mcp.

- **Per request, with a bearer token: yes.** Pass `tools: [{type: "mcp", server_label, server_url, authorization, allowed_tools, require_approval}]`. OpenAI does not store `authorization`, so it is sent on every request.
- **Limits.**
  - Streamable HTTP or HTTP/SSE.
  - **Approval is required by default** ("OpenAI will request your approval before any data is shared"). The invoker sets `require_approval: "never"` for our server.
  - The tool list is cached while the `mcp_list_tools` item stays in context.
  - No tool-call timeout is documented.
  - Rate limits follow the account tier.
  - There is no per-call fee for tools; imported tool definitions and tool calls count as tokens.
- **Data retention.** The MCP tool is compatible with ZDR and data residency. With `store=true`, data sent to MCP servers is logged for 30 days unless the organisation has ZDR.
- **Wake-up with a fixed text: yes**, as `input`, with the company's instructions as `instructions`.
- **Saved configuration.** Reusable prompt objects (`prompt: {id, version}`) are being retired: per OpenAI's migration guide, `v1/prompts` shuts down on 30 Nov 2026. **Do not design on an OpenAI "prompt ID"**; store the company's instructions with the invoker configuration instead.
- **What the company configures:** an OpenAI API key, a model, and its instructions, plus its own MCP servers for its data if it has any.

### 3.2 Agents API (hosted sessions)

Sources: developers.openai.com/api/docs/guides/agents-api/overview and …/agents-api/tools/mcp.

- Sessions run the Codex harness on OpenAI's side.
- A remote MCP entry looks like `{type: "mcp", server_label, transport: {type: "http", server_url, authorization | headers}, connection_origin: "service", required, allowed_tools}`. Per-session credentials are encrypted and left out of returned resources; vaults are optional.
- Requests carry the `OpenAI-Beta: agents=v1` header. **Not eligible for ZDR.** US data residency only.
- No timeouts or limits are documented.
- Wake-up: create a session with an `input` message, or send another task to an existing session. Completion arrives by stream or webhook.
- **Fits the per-wake-up token better than Managed Agents does**, because credentials are set inline on each session.

### 3.3 Agents SDK

Source: openai.github.io/openai-agents-js/guides/mcp.

- `hostedMcpTool({serverUrl, authorization, headers, requireApproval})` delegates to the Responses API.
- `MCPServerStreamableHttp` runs the MCP client in the company's process. Default connect timeout: 10 s.
- It is a library the company hosts, so it reaches us through the signed webhook or manual path, as in §2.3.

## 4. Others

### 4.1 A2A

Sources: a2a-protocol.org/latest/specification and Google Cloud docs (the "Use an A2A agent" page of the agent runtime).

- **Spec 1.0.0**, governed under the Linux Foundation.
- **Bindings:** JSON-RPC, gRPC and HTTP+JSON. The client sends `SendMessage`.
- **Agent Card security schemes:** API key, HTTP bearer, OAuth 2.0, OIDC and mTLS.
- **Async by design:** `returnImmediately`, then poll, subscribe or receive a push notification.
- **Support:**
  - Google documents A2A agents on its managed agent runtime, marked preview.
  - Microsoft announced A2A in Foundry and Copilot Studio; only press coverage was found, and GA status is not confirmed.
  - Neither Anthropic nor OpenAI serves A2A on its first-party API.
- **Fit.** The invoker sends only the fixed wake-up as an A2A message. The remote agent still needs our `/mcp` configured on its side to read and answer. A2A is therefore a wake-up channel, never a tool path. The 04 §4 URL rules apply to the Agent Card URL and to the endpoint.

### 4.2 Generic signed webhook

A content-free POST `{event, opaque contact ID, time}` with an HMAC signature works with any stack, including the Claude Agent SDK and OpenAI Agents SDK. The company hosts the receiver and calls `/mcp` with a token from the token endpoint (§5.4 "Myself"). Cloudflare limits that matter on our side: an invoker running in a Durable Object alarm or a Queue consumer has a 15-minute wall-clock limit; an HTTP-triggered Worker has none (developers.cloudflare.com/workers/platform/limits).

## 5. Answers per question

| Question | Claude (Messages API) | Claude (Managed Agents) | OpenAI (Responses) | OpenAI (Agents API) | A2A | Webhook |
|---|---|---|---|---|---|---|
| Remote MCP per call with bearer | Yes, `authorization_token` | Per session, via a vault | Yes, `authorization` | Per session, `transport.authorization` | No (wake-up only) | No (their code calls `/mcp`) |
| Auth options | Bearer (OAuth token or opaque) | `static_bearer`, `mcp_oauth` (refreshing) | Bearer; connectors via OAuth | Inline bearer or headers; vault | Agent Card schemes | HMAC signature |
| Timeouts / limits | Tools only; https only; none documented | 20 servers; `always_ask` default; $0.08/session-hour | Approval on by default; none documented | Beta; no ZDR; none documented | Async | 15 min if run from an alarm or queue |
| Fixed wake-up text | `user` message | `user.message` event | `input` | Session `input` | `SendMessage` | POST body (no text) |
| Company configures | API key, model, instructions | API key, agent ID, our URL on the agent, `always_allow`, network allowlist | API key, model, instructions | API key, agent definition | Agent Card URL, auth | URL, receiver code |
| Zero data retention | Not eligible | Not documented | Compatible | Not supported | Their stack | Their stack |

## 6. Changes the design needs

1. **Two Claude modes, not one.** §5.4 asks for an "agent or model ID".
   - The Messages API takes a *model* and instructions; there is no agent object.
   - Managed Agents takes an *agent ID*, but needs a vault per wake-up and `always_allow` on our toolset.
   - Recommendation for BIZ-g: build the **Messages API mode first** (stateless, no vault churn, no runtime fee). Add Managed Agents as a second mode for companies whose agent already lives there.
2. **Conversation memory is not free.** The Messages and Responses APIs are stateless. Each wake-up starts empty unless the invoker replays history. BIZ-f must decide one of these:
   - (a) the invoker keeps a bounded transcript per contact in the company's own `AgentDO`. Inbound text appears only as the original wrapped tool results, replayed verbatim, so I-5 holds.
   - (b) a vendor-side state object, such as a Managed Agents session or an OpenAI conversation. That moves conversation data into vendor storage.
   - (c) a read-only "recent conversation" view in `agentlink_inbox`. That would change the frozen tool surface, so it needs an owner decision.
   - Recommendation: (a).
3. **Turn off vendor approvals for our server only.** OpenAI: `require_approval: "never"`. Managed Agents: `always_allow` on our toolset. Our core remains the single approval boundary (§5.3 item 1). Approvals for the company's own MCP servers stay as the company sets them.
4. **Approval waits and the token's lifetime.** A wake-up that leads to `pending_approval` ends the vendor call; the owner's approval later triggers a new wake-up with a new token. The 15-minute token is then long enough for one wake-up. No longer-lived token is needed.
5. **The vendor host list is fixed:** `api.anthropic.com` and `api.openai.com`. Tokens go only to the company's chosen vendor, never to 4thTech (I-1 holds). The vendor's servers connect to the company's public `/mcp`, so no IP allowlist can be assumed.
6. **Data-retention note in the setup UI and guide.** Anthropic's MCP connector is not ZDR-eligible, and OpenAI logs MCP data for 30 days with `store=true`. Inbound customer text reaches the company's AI vendor as that company's processor. BIZ-DOCS should say so in plain words.
7. **Consumer plan sign-in is not an option for business agents.** Anthropic does not permit routing requests through Free, Pro or Max credentials on behalf of others (code.claude.com/docs/en/legal-and-compliance). The setup wizard asks for an API key only.
8. **No OpenAI prompt IDs**, because they are being retired (§3.1).

## 7. Open items for BIZ-SPEC and the invoker cards

- **Live checks.** Confirm the documented behaviour with one call per vendor against a staging `/mcp`, once BIZ-f exists. Measure: wake-up to first `agentlink_inbox` call, total wall time, and token use per turn.
- **Vault credential rotation.** Whether Managed Agents allows updating a vault credential in place, rather than creating one per wake-up, is not documented in the pages read.
- **Microsoft's A2A.** GA status of A2A in Microsoft Foundry and Copilot Studio still needs an official Microsoft Learn source.
