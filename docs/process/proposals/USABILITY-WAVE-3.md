# USABILITY-WAVE-3 proposal: a start you can follow, agents and AI apps managed in the app

| | |
|---|---|
| **Status** | Proposal. Nothing here is decided. The owner (Tali) picks the options in §11; the cards in §9 go into `backlog.md` only after that, in a separate cards PR. Spec amendments in §7 are described here and land through cards U3-spec and U3-spec-04, marked "proposed, owner confirms at merge". |
| **Source** | The owner's own try of 0.4.3 on 28 Oct 2026 (evening): "I'm totally lost", "truly not usable yet". Owner decision 28 (28 Oct): usability comes first, before business agents. Owner input the same evening: a live view of who is talking (§4.1). |
| **Specs that win on conflict** | 04 (I-1…I-10, §2.3.3 recovery kit, §2.5 owner presence, §2.5.1 owner actions and `agent.revoke`, §2.8 adding an agent, §4 realpath), 06 §6, §7, §8, 07 §3, §9.1, 08 §1, 11 §5, D-39, D-68, D-78, D-116, D-118, D-130, D-133, D-135, D-137 |
| **Release** | **0.4.4** recommended (decision 1). 0.5.0 stays reserved for the cloud agent and business agents |
| **Date** | 28 Oct 2026 |

## 1. The problem, in plain words

The owner installed 0.4.3 and could not tell how to begin. Four things went wrong:

1. **No start.** `agentlink ui` opened Activity, a log of events, not a place to begin. Start here (UX2-g) lives on Home, which the app did not open.
2. **Agents are a terminal question.** `npx … ui` printed "Agents on this computer:" with four names left over from harness tests (`ag-test`, `cc-gate`, `cc-test`, `oc-test`) and asked for a number. Nothing in the app lists, names, switches or removes agents, or says which AI app uses which.
3. **Connecting an AI app is a terminal job.** Only `init` writes Claude Code, Claude Desktop, Codex and the other configs. The app can't do it, and can't say what is connected.
4. **The path is in pieces.** Install, protect, name, connect, invite, say hello and see a reply each live somewhere else (terminal, AI chat, app), with no thread through them.

**Goal.** Someone who has never seen AgentLink goes from install to a first reply **inside the app**, always seeing one next action, and manages their agents and AI apps there. The terminal is needed once, to start the app.

**Not in scope:** the pairing protocol, the invite format, the policy engine, the cloud agent (0.5.0), the desktop app (M2-11), writing messages from the app (b11 §18 decision 6 stays).

## 2. What exists today (checked 28 Oct, main at d56698d9)

| Area | Today | Gap |
|---|---|---|
| Opening the app | `agentlink ui` (`apps/cli/src/commands/ui.ts` ~l.169) calls `openActivity()` (`packages/node/src/approval-server.ts` ~l.2962), which opens `/settings/activity`; `openFirstRun()` while no owner exists. In `apps/local-ui/src/router.tsx` `/` is Approvals and Home is `/settings/home`. It serves 30 minutes while the terminal stays open | Lands on Activity, not Home |
| Agent choice | `apps/cli/src/commands/agent-choice.ts`: `selectAgent` picks `default`, else the only agent, else `pickAgent` asks for a number; `init` uses the picker when its D5 name rule gives no answer (`init.ts` ~l.730) | The terminal question that confused the owner |
| Agent storage | `~/.agentlink/agents/<name>/` with `config.json` (`{v, name, agentId, keyStore}`) and `store.sqlite`; listing and checks in `apps/cli/src/runtime/agent-dir.ts` (`listAgentNames`, `readAgentConfig`). Keychain items per agent: `seed`, `store-key`, `policy-version`, `receipts-kept`, `storage-mark`, and `s3:<id>` per storage credential; a file-KeyStore agent is `<agentId>.alks` | No label; the node server cannot list agents; nothing deletes one. **The `KeyStore` interface (`packages/crypto/src/keystore-api.ts`) has no erase** |
| Owner | One owner per computer for all agents; one `localhost` passkey; a further agent's card through `owner add-agent` (04 §2.8, `packages/node/src/owner-add-agent.ts`) | Not reachable from the app |
| AI app configs | `apps/cli/src/harness/harnesses.ts`: fixed table (Claude Code `~/.claude.json`, Claude Desktop, Codex, Gemini CLI, OpenCode, Antigravity, Cursor, Windsurf). One `agentlink` entry per file, so each AI app serves one agent (`--agent <name>` for a non-default one). Atomic write with a backup (`files.ts`), realpath and no-link checks, a diff first; a different existing entry is a conflict. Claude Desktop is never written while it runs (D-130 (7)) | Terminal only; no "which agent does Claude Code use?"; no move |
| Server model | One approval server per process, bound to one agent; `agentlink mcp` processes start their own for approvals | The app cannot reach another agent |
| Local routes (08 §1) | GETs `presence: false`; every mutating route `presence: true` (D-118), with four named exceptions: `setup`, `pay-confirm`, `reveal`, `invite` (`packages/node/src/local-ui/routes.ts`). A presence route that signed nothing answers 409 `refused` (approval-server.ts ~l.84, ~l.1654; D-68) | No agent or AI app routes |
| Start here | `apps/local-ui/src/pages/home/start-here.ts` (UX2-g, b11 §27): Protect, Invite, Check safety code, Send first message, Save recovery kit | No name, connect or reply step |
| Removing an agent | `agent.revoke` (`retired`) defined (04 §2.5.1), verified on receipt (`packages/core/src/revocation.ts`, `revoked_agents`), on the owner allowlist; nothing sends one | All missing |
| Pulse | `GET /api/ui/messages/pulse` (UX2-f1) polled every 60 s by `pages/pulse/use-pulse.ts`; UX2-pulse-shared is a backlog card (merged in #662), not built. No streaming route anywhere | Nothing fresher than 60 s |
| Designs (D-116) | D2 `desktop-macos/first-run--welcome`, `desktop-macos/first-run--ai-app-setup`, `onboarding/connect-your-ai--waiting`, `console/agents--needs-credits` | Not yet in b11 |

## 3. Patterns from leading apps (adapted, not copied)

- **Checklist that ticks from real state** (Stripe "Get started", Linear and Notion onboarding): few steps, progress, one highlighted action. We have it (UX2-g); we extend it to the whole path and open the app on it.
- **Short wizard for the first minute** (Linear workspace setup, Raycast first launch): one screen per decision, minimal fields. For us: one screen that names the agent and protects it with Touch ID.
- **Profile switchers** (Slack workspaces, Chrome profiles, Arc spaces): the current one named in a corner, a menu of the others with a status mark, "Add" and "Manage"; removing a Chrome profile names what is deleted and cannot be undone. For us: the top-bar switcher, an Agents page, a remove sheet with the name typed.
- **Integrations as cards with a state** (Linear integrations, Raycast extensions, VS Code and Cursor "Install MCP server"): detected apps first, one button each, a state word, a manual fallback; Cursor shows the entry before adding it. For us: AI apps with the exact change and Touch ID, then "Restart Claude Code to finish", ticking when the app runs AgentLink.
- **Live topology, calm by default** (Tailscale machines and map, Figma multiplayer presence, Vercel and Linear live status, Grafana service maps): the list stays primary, motion only on change, clustering at scale (§4.1).

## 4. The target flow, screen by screen

Styled per D-116 from the D2 screens in §2; new screens built from new b11 sections (§5) with the owner's screenshot review in each PR (decision 7).

| # | Moment | Screen | What happens |
|---|---|---|---|
| 0 | Install | Terminal, once | `npx -y @4thtech-io/agentlink` (bare, owner's own terminal) or `agentlink ui` opens the app, asking nothing. An AI-run `init` (D-39) keeps working and ends with "Open AgentLink to finish: …" |
| 1 | Welcome | **Welcome** (b11 §28.1) | While no owner exists: one sentence, one button, Get started |
| 2 | Protect and name | **Set up your agent** (first run v3, §28.2) | "Name your agent" (prefilled "My agent", any text up to 40 characters) and **Use Touch ID**: one gesture creates the agent, the owner, the passkey, the first card and policy, as today (D-130 (2)) |
| 3 | Start here | **Home** with Start here v2 (§27 amended) | The app opens here every time. Protect ✓, Name ✓, Connect your AI app, Invite your first contact, Check the safety code (recommended, uncounted), Say hello, See the reply arrive, Save your recovery kit |
| 4 | Connect | **AI apps** (§30) | Detected apps as cards with a state: Not connected, Connected to {agent}, Connected to another agent, Needs restart, Running. **Review change** shows the exact `agentlink` entry being added or changed; **Apply with Touch ID**; then "Restart Claude Code to finish". Claude Desktop open: "Quit Claude Desktop first", re-checked, never closed by us. Moving an app from one agent to another shows both entries ("Claude Code will use Work instead of Personal"); an entry we did not write stays a conflict with manual steps |
| 5 | Invite | **Add contact** (b11 §21, exists) | Unchanged. **No one to invite yet?** "Try it with a second agent of your own": add an agent, connect a second AI app to it (for example Claude Desktop beside Claude Code), and the app accepts the invite for that agent, so a solo user can see a reply end to end (U3-k verifies two agents of one owner can pair) |
| 6 | Say hello | Start here | Copyable "Say hello to {name} on AgentLink." (exists) |
| 7 | See it arrive | Start here, Messages | Ticks on the first stored inbound message; opens that conversation |
| — | Switch | **Top-bar switcher** (§29.1) | Current agent's label and live dot; menu of agents with the AI apps each serves, then Add agent, Manage agents. A switch reloads every page for that agent |
| — | Manage | **Agents** page (§29.2) | Rows: label, AI apps, contacts, last activity; Rename, Connect an AI app, Remove; a List and Map control (§4.1) |
| — | Add | Sheet (§29.3) | Name, Touch ID (owner signs the card), then "Connect an AI app to it?" |
| — | Remove | Sheet (§29.4) | Names what goes (keys, history, AI app entries), says contacts will be told it is retired and that it cannot be undone, offers "Export history first" (I-10), asks for the label typed, **Remove with Touch ID** |

At 360 the switcher is the agent's initial with a dot; the menu is a bottom sheet.

### 4.1 Live connections view (owner input, 28 Oct evening)

**Ask.** In Agents, each agent as a box, with live lines to its contacts while messages or files flow, so someone running many agent sessions sees who is talking at a glance; refined, and reused where it fits.

**What it shows.** Your agents as boxes on the left (label, live dot, AI apps), contacts as smaller boxes on the right, and a line when they exchanged anything in the last 24 hours. Line weight follows the pulse counts (b11 §24); a **stream** (a short travelling dash in the flow's direction) runs only while a message or file is moving or arrived in the last minute, then settles. A file in progress shows the determinate fill of Files. **Clicking a box or line opens that conversation in Messages.**

**Glanceable, private by default.** The owner can always read their own agents' messages: the app already decrypts them locally and shows them in Messages (D-133). The map itself shows names, activity and direction only, **no content on boxes or lines by default** (calm, safe while screen sharing). Contact names are the owner-confirmed ones; others show "Unnamed contact" (a name the other side chose appears only in the untrusted container, I-5). A one-line preview on hover is part of decision 8; if chosen it comes from the existing Messages read, as plain text in the untrusted container. **Zero access is unchanged:** nothing leaves the device for this view, 4thTech never sees content, and it works offline.

**Where.** First on the Agents page (List and Map). Then where it fits: Home's Last activity tile as a mini map (top 5), Contacts as a Map view, a stream mark on the moving row in Messages and Files, a one-line strip in the compact view (b11 §25.1). Decision 8 sets what 0.4.4 carries.

**Data.** The pulse read through one shared pulse module (card UX2-pulse-shared, to be built first or with U3-map), plus one new read, `GET /api/ui/flow?since=<cursor>` (`presence: false`), polled every 3 s while visible and stopped when hidden: `{contactId, direction, kind: message|file, state, bytesDone?, bytesTotal?, at}`, at most 200 per answer, for the open agent; other agents' lines come from their pulse. Metadata only, from columns the store keeps in clear (07 §3): never text, subject, file name, link or envelope; logs carry counts (I-7). SSE was not chosen: polling fits the existing gate and the health poller. Whether upload bytes are recorded is unverified (UX2-c found none); without them the fill is indeterminate.

**Scale and calm.** Top 12 contacts per agent, the rest in a "+N more" cluster; up to 8 agents drawn; quiet contacts hidden ("Show quiet"); at most 6 streams at once; fixed two-column layout sorted by activity, no physics. **Reduced motion:** no travelling dash, a static arrowhead and "now". **Reduced transparency:** solid surfaces (b11 §13.2). **Accessibility:** the map is decoration over the List, which is its text alternative; a polite live region announces at most one line per 10 s; keyboard order follows the list; colour is never the only signal. **Budget:** one SVG layer, no dependency, under 8 KB gzipped, lazy-loaded; flow answer under 20 KB; animation on `transform` and `stroke-dashoffset` only, paused when hidden; `perf-guards.test.ts` extended.

## 5. New and amended b11 brief sections (card U3-brief, S0)

- **§27 amended, Start here v2:** the steps of §4 ("x of 7": Protect, Name, Connect, Invite, Say hello, See the reply, Recovery kit; safety code shown, uncounted); Connect ticks on an entry for this agent and shows Running when the app has run AgentLink; See the reply ticks on the first inbound message; the "second agent of your own" path; not dismissible (UX-WAVE-2 decision 7.1).
- **§28 Welcome and first run v3.**
- **§29 Agents:** switcher (one, several, needs setup, loading, more than 8 with search), Agents page, Add, Rename, Remove (typed label, export offer, "contacts can't be told" step, progress, "Removal not finished").
- **§30 AI apps:** cards and states, the entry-only change panel, move, Claude Desktop blocked, manual steps. Navigation default: "AI apps" in the sidebar after Contacts until an app is connected, then under Settings; agents in the top bar.
- **§31 Copy:** every new string against 11 §5 ("AI app", never "harness"; "keys" only in the remove sheet).
- **§32 Live connections:** §4.1 at 1280 and 360, light, dark, reduced motion, increased contrast.

## 6. How the app holds several agents

**Recommended (decision 2.1): one app, one agent open at a time.** The `ui` process becomes the app host: it lists agents, opens the current one through today's `openAgent` path, and on a switch closes it and opens the other in the same process, port and session. The node server gets agent folders through an **`AgentDirectory` seam** that the CLI passes in (list, read config, write label, mark removing, remove folder), implemented over `apps/cli/src/runtime/agent-dir.ts`, so the folder rules stay in one place.

- **Generation.** Each switch bumps a generation number. Every read answer carries it and the agent's label; **every mutating request carries it and is refused on mismatch** (`agent_changed`), and every owner statement names the agent's label, so a Touch ID prompt never approves something for an agent you are not looking at.
- **Last used** agent in `~/.agentlink/app.json` (`{v:1, current}`, 0600, not signed: it only picks which agent opens first, as `config.json`, 07 §9.1).
- **Approval pages opened by an MCP process** stay bound to that agent; their switcher says "Open the AgentLink app to switch".
- **One publisher per agent** is unchanged (06 §6): the host never takes the lease; it reads the lease row to show Running.
- **Residual:** switching opens another agent's keychain items without a gesture; macOS may show a keychain prompt the first time. U3-c records what each platform does.
- **Not chosen:** a tab per agent on its own port (tabs multiply, each with its own link); all agents open at once (every key unlocked, more relay work; b11 §25.3 reserves a combined view for later).

## 7. Spec and security impact

### 7.1 Local routes and owner actions (08 §1; all behind the session, CSRF, `Host`, `Origin`, fetch-metadata and octet-stream gate)

Every presence route below **signs an owner action**, so the D-68 rule "a presence route that signed nothing is refused" holds. New ops are **local owner actions** (U3-spec-04, 04 §2.5.1): `agent.label {agent, label}`, `app.connect {app, agent, changeId}`, `app.disconnect {app, agent, changeId}`. They are stored and nonce-checked in the agent's store like `contact.check`, short-lived (600 s), never sent in an envelope, and verified by the server before it acts.

| Route | Gate | What |
|---|---|---|
| `GET /api/ui/agents` | read | Agents: name, label, current, generation, AI apps (from the entry only), contacts count, Running, `removing` |
| `POST /api/ui/agents/switch` `{name, generation}` | new kind `switch`, no presence | Close and open; signs nothing; writes only `app.json`; name checked (06 §6) |
| `POST /api/ui/agents` `{label}` | presence | Keychain agent, owner signs its card (§2.8) and first policy (06 §3 defaults); folder name a slug of the label |
| `POST /api/ui/agents/label` | presence, signs `agent.label` | Label only; folder, entries, identity unchanged |
| `POST /api/ui/agents/remove` `{name, typedLabel, generation}` | presence, signs `agent.revoke` | §7.2 |
| first run `begin`/`finish` | `setup` (unchanged) | `begin` also takes `{label}`; with no agent yet, `finish` creates it first, all or nothing |
| `GET /api/ui/apps` | read | Detected apps, the agent each serves, Claude Desktop running |
| `GET /api/ui/apps/preview?app=&agent=` | read | The entry change and `changeId` = hash(app, resolved path, old entry, new entry, agent) |
| `POST /api/ui/apps/apply` `{changeId, generation}` | presence, signs `app.connect` | Recompute; refuse `changed` on mismatch; write (§7.3) |
| `POST /api/ui/apps/disconnect` | presence, signs `app.disconnect` | Remove this agent's entry |
| `GET /api/ui/flow?since=` | read | §4.1 |

Errors are fixed codes. No route takes a path from the page (`--config <path>` stays a terminal option). No MCP tool is added or changed (I-4).

### 7.2 Removing an agent (S2, Fable)

1. **Refuse while in use:** if any process holds this agent's publisher lease, answer `in_use`: "Quit the AI app that uses {label} first."
2. **Sign `agent.revoke` `{reason: "retired"}` always.** Record it in the owner's revoked list (`~/.agentlink/revoked/<agentId>.json`, 0600), and `backup restore` refuses to restore a revoked agent (04 §2.3.3, §2.5.1: it returns only as a new identity). If the agent has contacts, send the `revoke` envelope to each through the outbox with a bounded wait. **If it cannot be delivered** (offline, timeout), the sheet asks "Remove anyway? Your contacts can't be told now." It never proceeds silently.
3. **Mark:** write `removing: true` into `config.json` before deleting anything. An agent with the mark is listed as "Removal not finished" with Try again, never opened as usable.
4. **AI app entries** that run this agent are removed (entry-only change shown in the sheet, §7.3 rules).
5. **Erase keys** through a new `KeyStore` erase API (`packages/crypto`, implemented by the keychain and file backends in `packages/node`): every `keychainAccount(agentId, …)` item (`seed`, `store-key`, `policy-version`, `receipts-kept`, `storage-mark`, every `s3:<id>`), or the `<agentId>.alks` file for a file-KeyStore agent. **Never** `owner`, `owner-passkey`, `owner-next`, `owner.alko` or `owner.alkp`.
6. **Delete** `store.sqlite`, `-wal`, `-shm`, `config.json` and the folder after the `agent-dir.ts` realpath checks; then switch to another agent, or "Add an agent" when none is left. The owner stays.

Invariants: I-1/I-2 nothing leaves the computer and keys go through KeyStore; I-4 owner presence only, no tool; I-7 logs say "removed" only; I-10 export offered first. Residual (G-1): a same-user process can delete these files itself. Keychain deletion differs per backend: tests cover macOS Keychain, Windows Credential Manager, Linux Secret Service and the file KeyStore.

### 7.3 Writing AI app configs (S2, Fable)

- **Fixed content:** `npx -y @4thtech-io/agentlink mcp` plus `--agent <name>` (checked again); **no secret is ever written**.
- **These files hold other servers' secrets** (API keys in other MCP entries). The app list, preview and apply parse the file and show **only the `agentlink` entry**: never context lines, other entries or the whole file. Nothing from the file reaches a log or an error (I-7).
- Paths only from the fixed table; realpath, no-link, regular-file, atomic temp-and-rename and the backup of `files.ts` (06 §7) apply; the backup keeps the original file's mode. The harness code is reused through a seam the CLI passes in, so `packages/node` has no second writer.
- The change written is the change shown: `changeId` binds it, and the owner signs `app.connect` over it and the agent's label.
- **Threat note:** an entry starts a program, so this is a code-execution path; hence fixed content, fixed paths and the gesture. A shell-capable agent could edit these files anyway (06 §7: transparency, not a boundary).

### 7.4 CLI and migration

- `ui` and `init` never ask which agent. `ui` opens the last used (`app.json`), else the agent an AI app serves (`default` first), else the first by name. `init` without `--agent` keeps D5 and otherwise uses the current agent. `--agent` stays under Advanced in `--help`; `agent-choice.ts` goes. Bare `agentlink` in the owner's terminal opens the app; run by an AI it prints the M1-UX-OPEN-APP line. `ui` with no agent opens Welcome.
- **Existing agents** (decision 6): nothing deleted or renamed; labels default to the folder name; Home shows a one-time "Tidy up" note when agents serve no AI app and have no contacts, linking to Agents.

### 7.5 Spec text (all "proposed, owner confirms at merge")

- **U3-spec (S1):** 08 §1 app host, generation, Home as landing page, the routes of §7.1 (the preview as a GET, the `switch` kind), first run v3, Agents and AI apps pages; 06 §6 labels, §7 the app as a second path, move, disconnect, entry-only display, §8 bare command and no picker; 07 §9.1 `label`, `removing`, `app.json`, the revoked list; 11 §5 strings.
- **U3-spec-04 (S2):** 04 §2.5.1 the local owner ops and their lifetimes; §2.5 config writes and removal as signed local actions, generation binding, residuals; §2.3.3 restore refuses a revoked agent; §2.8 adding an agent from the app.

## 8. What it does not change

Pairing, invites, the policy engine, approvals, passkey enrolment, the publisher lease, MCP tools, `init`'s own diff-and-code path for an AI-run install.

## 9. Cards (proposed)

Classes per `audit-rules.md` §2 (`packages/node`, `packages/crypto`, `packages/core`, `docs/foundation/04` S2; `apps/local-ui`, `apps/cli`, other `docs/foundation`, `docs/process` S1; `docs/design` S0). **Fable** = Fable 5.1 audit.

| Card | What | Class | Depends on | Files | Acceptance | Fable |
|---|---|---|---|---|---|---|
| **U3-spec** | Spec text of §7.5 except 04 | S1 | decisions | `docs/foundation/06, 07, 08, 11` | Matches decisions; marked proposed | — |
| **U3-spec-04** | 04 amendments | S2 | decisions | `docs/foundation/04-security-and-crypto.md` | Ops, lifetimes, residuals | Yes |
| **U3-brief** | b11 §27 amended, §28 to §32 | S0 | decisions | `docs/design/b11-local-app.md` | Owner approves | — |
| **U3-a** | Open on Home: `openHome()` replaces `openActivity()`; `ui.ts` calls it; first run finishes on Home | S2 | — | `packages/node/src/approval-server.ts` (open function only), `apps/cli/src/commands/ui.ts` (one call), `apps/local-ui/src/pages/first-run/` (redirect) | `ui` and first run land on Home; tests | — |
| **U3-c** | App host: `AgentDirectory` seam, current agent, generation, switch, agents list, `app.json`; **registers every U3 route in `routes.ts` as a stub** (`not_available`) so later cards only add handlers | S2 | U3-a, U3-spec | `approval-server.ts`, `local-ui/routes.ts`, `local-ui/api/agents.ts` (new), `apps/cli/src/runtime/agent-dir.ts` (seam) | Stale generation refused on every mutating route; switch closes and opens; stubs refused; RED first | Yes |
| **U3-b** | CLI: no picker, bare command opens the app, `ui` with no agent opens Welcome | S1 | U3-c | `apps/cli/src/commands/{ui,init,agent-choice}.ts`, `apps/cli/src/dispatch.ts` | No prompt with 0, 1 or 4 agents; AI-run output unchanged | — |
| **U3-d** | Create agent, `agent.label` op, first run v3 with name | S2 | U3-c, U3-spec-04 | `local-ui/api/agents-manage.ts` (new), `owner-setup.ts`, `owner-add-agent.ts`, core owner-op schema for `agent.label` | All or nothing; label as text; op stored and nonce-checked; RED first | Yes |
| **U3-f** | AI apps: list, preview, apply, disconnect, move; `app.connect`/`app.disconnect` ops; harness seam | S2 | U3-c, U3-spec-04 | `local-ui/api/apps.ts` (new), core op schemas, `apps/cli/src/harness/` (replace, remove, entry-only view, mode-keeping backup), wiring in `ui.ts` after U3-b | Entry-only output (test with a file holding another server's secret); `changeId`; Claude Desktop rule; RED first | Yes |
| **U3-e** | Remove agent per §7.2; KeyStore erase API | S2 | U3-c, U3-f | `packages/crypto/src/keystore-api.ts` (erase), `packages/node/src/keychain-keystore.ts`, `keychain.ts`, `file-keystore.ts`, `file-keystore-fs.ts`, `local-ui/api/agents-remove.ts` (new), core revoke-send helper, restore check | Lease refusal; marker and crash test; item list exact; owner items untouched; undeliverable asks; four backends; RED first | Yes |
| **U3-flow** | `GET /api/ui/flow` | S2 | U3-c | `local-ui/api/flow.ts` (new), core store read | Metadata allowlist (hostile names test); caps; RED first | — |
| **U3-g** | Welcome and first run v3 screens | S1 | U3-brief, U3-d | `apps/local-ui/src/pages/first-run/`, `pages/welcome/` (new) | Screenshot review; a11y | — |
| **U3-h** | Switcher, Agents page, Add, Rename, Remove sheets | S1 | U3-brief, U3-c (then d, e) | `apps/local-ui/src/layout/top-bar.tsx`, `pages/agents/` (new) | Generation sent; labels as text | — |
| **U3-i** | AI apps page and Connect step | S1 | U3-brief, U3-f | `apps/local-ui/src/pages/apps/` (new) | Entry shown before Touch ID; states from reads | — |
| **U3-j** | Start here v2, incl. the second-agent path | S1 | U3-brief, U3-c | `apps/local-ui/src/pages/home/` | Ticks from reads only | — |
| **U3-map** | Live map on Agents, on the shared pulse module (builds UX2-pulse-shared if not yet built) | S1 | U3-brief §32, U3-flow, U3-h | `pages/agents/map/` (new), `pages/pulse/` | Click opens Messages; no content drawn; budget; reduced motion; screenshots | — |
| **U3-map-2** | Home mini map, Contacts Map, row stream marks, compact strip | S1 | U3-map, decision 8 | `pages/home/`, `contacts/`, `messages/`, `files/`, `compact/` | Same rules, one source | — |
| **U3-k** | End-to-end on a clean macOS user (two agents, two AI apps, a reply), README quick start, docs-site Getting started | S1 | all | `docs/runbooks/`, `README.md`, `docs-site/`, `changelog.d/` | Owner follows it without a terminal after step 0 | — |

## 10. Ordering (4 to 6 builders, disjoint files)

| Group | In parallel | Note |
|---|---|---|
| **0** | U3-spec, U3-spec-04, U3-brief, U3-a | U3-a owns the open function before U3-c touches `approval-server.ts` |
| **1** | U3-c, U3-j | U3-c's route stubs end the `routes.ts` overlap |
| **2** | U3-b, U3-d, U3-f, U3-flow, U3-h (list and switch) | Disjoint files; U3-f's `ui.ts` wiring merges after U3-b |
| **3** | U3-e, U3-g, U3-i, U3-h (sheets), U3-map | |
| **4** | U3-map-2 (per decision 8), U3-k, release | |

S2 cards: tests first (`RED (expected):` commit), Opus independent review, Fable where marked, Tali's "merge". UI cards: screenshots at 1280 and 360, light and dark.

## 11. Owner decisions

Recommended option first in each.

1. **Release target**
   1. **0.4.4** with every card; if Remove (U3-e) has not passed its security audit when the rest is ready, 0.4.4 ships without it and Remove follows in 0.4.5 (recommended: the start, switching and connecting fix "lost"; Remove is the riskiest piece).
   2. 0.4.4 only when every card, Remove included, is done.
   3. 0.5.0 (mixes it with the cloud agent; slower).
2. **Several agents in one app**
   1. One app, one agent open at a time, switched from the top bar with no Touch ID, because switching only changes what you look at (recommended).
   2. The same, but every switch asks for Touch ID.
   3. A separate browser tab for each agent.
3. **First screens**
   1. Name and Touch ID on one screen, one gesture (recommended: shortest, and today's first run is already one gesture).
   2. Touch ID first, then a name screen.
   3. No name at first ("My agent" until renamed).
4. **Removing an agent**
   1. Touch ID and the typed name; offer to export history first; the agent is always marked retired, and its contacts are told if it has any; its AI app entries, keys and history are deleted; it cannot be restored (recommended: clean for you and your contacts; your test agents have no contacts).
   2. Hide only ("Archive") in 0.4.4; real removal later.
5. **Connecting AI apps from the app**
   1. Show the exact AgentLink entry, then Touch ID, with a backup of the file; Claude Desktop must be closed; moving an app between agents is allowed with the same step (recommended).
   2. Show the entry and an Apply button, without Touch ID (anyone who can open your app page could then rewire your AI apps).
   3. No writes from the app: show a command to copy.
6. **Your existing agents and the terminal**
   1. Keep all four; open the last used (else the one an AI app uses); a one-time "Tidy up" note links to Agents; the terminal never asks which agent, and `npx -y @4thtech-io/agentlink` opens the app (recommended: nothing disappears without you).
   2. On first open, the app asks which agents to keep.
7. **How the new screens are designed**
   1. Straight from the new b11 sections, styled from the D2 screens, with your screenshot review in each PR, as for wave 2 (D-137) (recommended: fastest to something you can try).
   2. Claude Design screens first (D-116 as written; about a week more).
8. **Live connections view**
   1. Agents page map plus the moving-row mark in Messages and Files in 0.4.4; Home, Contacts and compact view in 0.4.5; no preview on hover (recommended: where you asked first, calm and safe to share).
   2. All of it in 0.4.4, no preview.
   3. As option 1, plus a one-line preview on hover, off by default, a switch in Appearance.
   4. All of it in 0.4.5.

## 12. Risks

- **Wrong agent:** generation on every change and the label in every statement; tests switch mid-request.
- **Config writes run code; config files hold other secrets:** fixed content and paths, entry-only display, signed op, Fable.
- **Irreversible removal or a crash halfway:** lease check, typed label, signed revoke, `removing` mark, explicit "contacts can't be told" step.
- **A busy map or content on screen while sharing:** calm defaults, no content drawn, metadata-only read.
- **The terminal must stay open** while `ui` serves (30 minutes); the desktop app removes this later; Welcome says so.
