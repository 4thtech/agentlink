# @4thtech-io/agentlink

## 0.1.1

### Patch Changes

- 088b5fd: Live relay subscriptions (M1-9s): `Transport.subscribe` and `AgentLinkClient.subscribeInbox` in the core; the MCP server's background loop receives new messages and handshakes as they reach a relay, with a 5-minute fallback catch-up, and closes the subscription on lease loss and on shutdown.
- 8a3f76e: Local approval page (not opened by the CLI yet): review your waiting approvals together and confirm the list with one passkey or owner code entry (terms are still approved one at a time); each page link opens once; repeated wrong owner codes make you wait before the next try.
- 3aa3ffa: crypto: passkey PRF owner seed wrap (ALKP v1) and recovery-code wrap (ALKR v1) with the generated recovery code (M1-1k, D-82)
- 2cb36f8: cli: declare termsParties in the agentlink_inbox output schema
- 9da67d4: tools: offers in `agentlink_inbox` carry contact names ("you", a contact's name) for the agent addresses in their terms, and identical open offers from one contact get a single hint line
- 4c6bb4f: core: an owner approval for terms no longer fails when the clock crosses a second while it is being asked
- 743ff84: core: policy rules for files (allowed folders, size caps, storage choice) and proofs (per-action maximum, rolling 24 h daily budget with a transactional ledger reservation, per-contact rules)
- 3c9a59f: owner init asks for your agent's name for contacts; the owner-key rollback and card signing are tighter
- b7f004a: Status and doctor name the missing owner card instead of suggesting init
- 1367c0a: init: Claude Desktop (`--harness claude-desktop`); Gemini CLI detection no longer matches a bare `~/.gemini` folder
- e768cd1: `owner add-agent` recovers an owner with no attached agent: the owner keys come from the saved owner itself after the owner code, and the owner confirms the fingerprint (M1-9x).
- db68613: Require Node.js 22.14 or newer, with one clear message on an older Node instead of a crash; the one-shot commands no longer print structured info log lines (set `AGENTLINK_LOG=info` or `debug` to see them).
- 1ba92cb: Add `agentlink owner change-code` to replace an exposed owner code without changing the owner
- 58df129: M1-9za: owner commands `contacts rename` and `contacts remove`, signed as the new owner actions `contact.rename` and `contact.remove`; `contacts` lists each contact's ID.
- 547c699: Approving an invite shows the inviter's self-declared name and owner fingerprint.
- 83c03cd: README: install and MCP setup
- 50e8a02: The terms tools pass `clientRequestId` for idempotency, like `agentlink_send`.

## 0.1.0

### Minor Changes

- 714f2ff: Fresh sessions can find open offers and finish approved actions (M1-22). Core adds `TermsService.openOffers()` (received offers still waiting for an answer, read from the store: newest open version, from an active contact, not accepted, not rejected by this agent, not expired), `ApprovalService.resumeOf(approvalId)` (the tool and only its structured, re-verified args while the agent still has something to run) and an `envelopeIds` filter on the inbox page. `agentlink_status` adds `openOffers` and `offers` (counts by contact) and a summary line; `agentlink_inbox` takes `openOffers: true` to list them, read ones included; `agentlink_get_approval` adds `action` (tool, and for a terms accept or reject the `envelopeId` and `decision`) and, once approved, a `nextStep` that says how to finish.
- 0218824: `agentlink owner init` now signs your agent's first card in the same owner step, so a new agent can pair as soon as it has an owner. The owner key signs only the agent card and the owner decisions AgentLink defines; anything else is refused before you are asked for the owner code.
- 7d9ab7f: Add the owner commands: `agentlink owner init`, `agentlink approve <id>`, `agentlink approve` with no ID (one owner code entry for one agent's reviewed list), `agentlink deny <id>` and `agentlink cancel <id>`. Each needs you at an interactive terminal and your owner code at its prompt.
- a1465a6: Wire `agentlink_get_approval` and the `pendingApprovals` count of `agentlink_status` to the core approval read (M1-9c-b). Every request from an unknown sender now carries its sender code from core (`RequestEntry.senderCode`, and the code on an inbox request item): the short form, or the extended form when two unknown senders share the short form (04 §2.9). `agentlink requests` shows it. `@agentlink/types` adds `toolResultCommonSchema`, the one rule set for the common tool-result fields.
- 0442639: Add `agentlink mcp`: the stdio MCP server with the frozen M1a tool list (input and output schemas, all four annotations, a committed tool-surface snapshot), the 06 §4 untrusted-content wrapper, and the read-only `agentlink_status` and `agentlink_list_contacts` handlers in the runtime-agnostic `src/tools/` module. `agentlink_get_approval` (waiting on a core read), send, inbox, invites and terms answer "not available yet" for now.
- c084e30: Add the `agentlink` command runtime: `openAgent` (recorded config under `~/.agentlink`, recorded KeyStore backend, the shared SQLite store and the core client), the M1a local approval channel (ticket without a URL; `pending` or `unknown`, never `signed`) and its `agentlink approve <id>` next step, the command dispatcher with every M1a command registered and owner commands guarded, and the terminal output sanitiser of 06 §8.
- 1f31f5c: Add the everyday `agentlink` commands: `invite`, `accept <url>` (under the default policy it asks for approval and prints the `agentlink approve <id>` command, then proceeds once with `--approval <id>`), `contacts`, `status [--brief]` (read-only: a fetch-only catch-up, nothing processed), `doctor`, and `requests` (list, accept, ignore, ignore --all, block, blocked, unblock). Every printed value another party chose is sanitized, and a request's content is shown only inside the marked untrusted region.
- daa3af6: The `agentlink_create_invite` and `agentlink_accept_invite` tools now work. Your AI can create an invite for you to share. When it accepts one for you, it waits for your approval, which you give in your own terminal with `agentlink approve`.
- 77c7fce: While `agentlink mcp` runs, it now keeps receiving and delivering in the background: a pairing completes, acknowledgements and card updates are applied, and queued messages are retried without your AI calling a tool. When several AI apps share one agent, only one server does this at a time and another takes over if it stops. Apps that support it can subscribe to `agentlink://inbox` to hear about new messages.
- 96f6a35: Several agents on one computer can now share one owner: `agentlink owner add-agent --agent <name>` gives a further agent its first card from the owner key already set up, with one entry of your owner code in your own terminal. `agentlink init --harness <app>` sets up one app only (`claude-code`, `codex`, `gemini-cli`, `opencode`, `antigravity`), `--harness none` creates the agent alone, and answering no to every change keeps the agent. `init` now also configures OpenCode and Antigravity, with `--config <path>` for a config file in another place.
- 3d7a39c: First npm release of the command line and MCP server as `@4thtech-io/agentlink` (`npx -y @4thtech-io/agentlink`): one bundled file with the AgentLink libraries built in, and exactly pinned dependencies. Published from CI with npm provenance.

### Patch Changes

- c887320: `agentlink_accept_invite` now spells out its two steps: after the owner approves, call it again with the same invite link and the `approvalId`. Calling it again without the `approvalId` returns the request it already made instead of asking the owner a second time; once the owner has approved, it runs nothing and names the `approvalId` to use. Core adds `ApprovalService.findOpen`.
- 53ebf61: The `agentlink_status` summary no longer asks the user whether to read new messages; it says to call `agentlink_inbox`. The skill now reads messages right away when the user directly asks.
