# USABILITY-WAVE-3 proposal: a start you can follow, agents and AI apps managed in the app

| | |
|---|---|
| **Status** | Proposal. Nothing here is decided. The owner (Tali) picks the options in §11; the cards in §9 go into `backlog.md` only after that, in a separate cards PR. Spec amendments in §7 are described here and land through card U3-spec, marked "proposed, owner confirms at merge". |
| **Source** | The owner's own try of 0.4.3 on 28 Oct 2026 (evening): "I'm totally lost", "truly not usable yet". Owner decision 28 (28 Oct): usability comes first, before business agents. |
| **Specs that win on conflict** | 04 (I-1…I-10, §2.3.3 recovery kit, §2.5 owner presence and "What the AI may cause", §2.5.1 `agent.revoke`, §2.5.3 confirmation statements, §2.8 adding an agent, §4 SSRF and realpath), 06 §6 (local agent names, one publisher per agent), §7 (harness installation and its write rules), §8 (commands), 08 §1 (local UI hosting, route kinds), 11 §5 (vocabulary), D-39, D-40, D-78, D-116, D-118, D-130, D-135, D-137 |
| **Release** | **0.4.4** recommended (§10, decision 1). 0.5.0 stays reserved for the cloud agent and business agents |
| **Date** | 28 Oct 2026 |

## 1. The problem, in plain words

The owner installed 0.4.3 and could not tell how to begin. Four things went wrong:

1. **No start.** `agentlink ui` opened Activity, a log of events, not a place to begin. Start here (UX2-g) lives on Home, which the app did not open.
2. **Agents are a terminal question.** `npx … ui` printed "Agents on this computer:" with four names left over from harness tests (`ag-test`, `cc-gate`, `cc-test`, `oc-test`) and asked for a number. Nothing in the app lists, names, switches or removes agents, or says which AI app uses which.
3. **Connecting an AI app is a terminal job.** Only `init` writes Claude Code, Claude Desktop, Codex and the other configs. The app can't do it, and can't say what is connected.
4. **The path is in pieces.** Install, protect, name, connect, invite, say hello and see a reply each live somewhere else (terminal, AI chat, app), with no thread through them.

**Goal.** Someone who has never seen AgentLink goes from install to a first reply **inside the app**, always seeing one next action, and manages their agents and AI apps there. The terminal is needed once, to start the app.

**Not in scope:** the pairing protocol, the invite format, the policy engine, the cloud agent (0.5.0), the desktop app (M2-11; the browser app here is what the desktop app later wraps), writing messages from the app (b11 §18 decision 6 stays).

## 2. What exists today (checked 28 Oct, main at d56698d9)

| Area | Today | Gap |
|---|---|---|
| Opening the app | `agentlink ui` (`apps/cli/src/commands/ui.ts`) opens one agent, starts the approval server and opens `/settings/activity` (`openActivity`, `packages/node/src/approval-server.ts`), or `/first-run` while no owner exists. It serves for 30 minutes while the terminal stays open | Lands on Activity, not Home |
| Agent choice | `apps/cli/src/commands/agent-choice.ts` (M1-UX-MULTI-AGENT): `selectAgent` picks `default`, else the only agent, else `pickAgent` asks for a number. `init` uses the same picker when its D5 name rule gives no answer (`init.ts` ~line 730) | A terminal question; the cause of the owner's confusion |
| Agent storage | One folder per agent, `~/.agentlink/agents/<name>/` with `config.json` (`{v, name, agentId, keyStore}`) and `store.sqlite` (`apps/cli/src/runtime/agent-dir.ts`); the agent seed and KeyStore items in the OS keychain per agent (`open-agent.ts`). Names match `[a-z][a-z0-9-]{0,31}` (06 §6) | No display label; nothing deletes an agent |
| Owner | **One owner per computer** for all agents; one `localhost` passkey; a further agent gets its card through `owner add-agent` (04 §2.8, `packages/node/src/owner-add-agent.ts`) | Not reachable from the app |
| AI app configs | `apps/cli/src/harness/harnesses.ts`: fixed table for Claude Code (`~/.claude.json`), Claude Desktop, Codex (`~/.codex/config.toml`), Gemini CLI, OpenCode, Antigravity, Cursor, Windsurf. Each holds **one** `agentlink` entry, so each AI app serves one agent; a non-default agent adds `--agent <name>`. Writes are atomic with a backup first (`files.ts`), realpath and no-link checks, a diff before writing, and a different existing entry is a **conflict** (refused). Claude Desktop is never written while it runs (D-130 (7)) | Terminal only; no "which agent does Claude Code use?" read; no way to move an AI app to another agent |
| Server model | One approval server per process, bound to one opened agent. Every `agentlink mcp` process can start its own for its agent (approval pages); `ui` starts one for the chosen agent | The app cannot show or reach another agent |
| Local routes (08 §1) | GET routes `presence: false`; every mutating route `presence: true` (D-118), with five named exceptions: `setup` (first run), `pay-confirm`, `reveal` (Show in Finder), `invite` (create and check). Registered in `packages/node/src/local-ui/routes.ts`, which refuses anything else | No agent or AI app routes |
| Start here | `apps/local-ui/src/pages/home/start-here.ts` (UX2-g, b11 §27): Protect, Invite, Check safety code, Send first message, Save recovery kit; ticks from reads only; not dismissible | No "name your agent", no "connect your AI app", no "see the reply" |
| Removing an agent | `agent.revoke` (reason `retired`) is defined (04 §2.5.1), verified by core on receipt (`packages/core/src/revocation.ts`) and on the owner allowlist; **no command sends one**, and nothing deletes an agent's keychain items or folder | All missing |
| Designs to style from (D-116) | D2 `desktop-macos/first-run--welcome`, `desktop-macos/first-run--ai-app-setup` ("Connect your AI apps", per-app diff, Apply and Skip, "Restart Claude Desktop afterwards"), `onboarding/connect-your-ai--waiting` (app tiles, steps header), `console/agents--needs-credits` (agents list) | Not yet in b11 for the local app |

## 3. Patterns from leading apps (adapted, not copied)

- **Onboarding as a checklist that ticks from real state** (Stripe dashboard "Get started", Linear's first-run, Notion's "Getting started"): a few steps, progress, one highlighted action, each step done by doing it. We already have this (UX2-g); we extend it to cover the whole path and open the app on it.
- **Short wizard for the irreducible first minute** (Linear workspace setup, Raycast's first launch): one screen per decision, the minimum of fields, everything else later. For us: one screen that names the agent and protects it with Touch ID in one gesture.
- **Profile and workspace switchers** (Slack workspaces, Chrome profiles, Arc spaces): the current one named in the top corner; a menu lists the others with a status mark, then "Add" and "Manage". Each profile has its own data; switching never mixes them. Removing a Chrome profile asks once, names what is deleted, and cannot be undone. For us: the top-bar agent switcher, an Agents page, and a remove sheet with the agent's name typed.
- **Integration setup shown as a card per app with a clear state** (Linear integrations, Raycast extensions, VS Code and Cursor "Install MCP server" buttons): detected apps first, one button per app, a state word (Connected, Not connected, Needs restart), a manual fallback. Cursor and VS Code show the exact entry before adding it. For us: an AI apps page with the exact diff and Touch ID, then "Restart Claude Code to finish", and the state ticks when the AI app actually runs AgentLink.

## 4. The target flow, screen by screen

Styled per D-116 from the D2 screens in §2 and existing b11 components; new screens are built from new b11 sections (§5) with the owner's screenshot review in each build PR, as D-137 did for wave 2 (decision 11).

| # | Moment | Screen | What happens |
|---|---|---|---|
| 0 | Install | Terminal, once | `npx -y @4thtech-io/agentlink` (bare, in the owner's own terminal) opens the app. `agentlink ui` does the same. No question is asked. An AI-run `init` (D-39) keeps working and ends with "Open AgentLink to finish: …" |
| 1 | Welcome | **Welcome** (new, b11 §28.1; from `first-run--welcome`) | Shown while no owner exists. One sentence on what AgentLink is, one button: Get started |
| 2 | Protect and name | **Set up your agent** (first run v3, b11 §28.2) | Field "Name your agent" (prefilled "My agent"; a label, any characters, up to 40) and **Use Touch ID**. One gesture creates the agent, the owner, the passkey, the first card and the first policy, as today's first run (D-130 (2)). Backup code saved as today |
| 3 | Start here | **Home** with **Start here v2** (b11 §27 amended) | The app opens here from now on, every time. Steps: Protect ✓, Name ✓, **Connect your AI app**, Invite your first contact, Check the safety code (recommended, uncounted), Say hello, **See the reply arrive**, Save your recovery kit |
| 4 | Connect your AI app | **AI apps** (new, b11 §30; from `first-run--ai-app-setup` and `connect-your-ai--waiting`) | Detected apps as cards: Claude Code, Claude Desktop, Codex, Cursor, Gemini CLI, OpenCode, Antigravity, Windsurf; "My app isn't listed" opens manual steps. Each card shows its state: Not connected, Connected to {agent}, Connected to another agent. **Review change** shows the exact diff; **Apply with Touch ID** writes it. Then "Restart Claude Code to finish." The card says **Running** once that app has started AgentLink for this agent. Claude Desktop open: "Quit Claude Desktop first", re-checked, never closed by us |
| 5 | Invite | **Add contact** sheet (b11 §21, exists) | Unchanged |
| 6 | Say hello | Start here step | Copyable "Say hello to {name} on AgentLink." for the AI app just connected (exists) |
| 7 | See it arrive | Start here step, Messages | Ticks when the first inbound message from a contact is stored; links to that conversation |
| — | Switch agent | **Top-bar agent switcher** (b11 §29.1; Slack and Chrome pattern) | Current agent's label and live dot top left of the top bar. Menu: each agent with its live word and the AI apps it serves ("Claude Code, Codex"), then **Add agent**, **Manage agents**. Switching reloads every page for that agent |
| — | Manage agents | **Agents** page (Settings, b11 §29.2; from `console/agents`) | Rows: label, AI apps it serves, contacts count, last activity. Row actions: Rename, Connect an AI app, Remove |
| — | Add agent | Sheet (b11 §29.3) | Name, then Touch ID (owner signs the new agent's card); then "Connect an AI app to it?" |
| — | Remove agent | Sheet (b11 §29.4; Chrome profile pattern) | Names what goes: keys, history, AI app entries; contacts are told it is retired; type the agent's label; **Remove with Touch ID**. Offers "Export history first" (I-10) |

At 360 the switcher sits in the top bar as the agent's initial with a dot; the menu is a bottom sheet.

### 4.1 Live connections view (owner input, 28 Oct evening)

**Ask.** In Agents, each agent as a box, with live lines between your agents and their contacts while messages or files flow, so someone running many agent sessions sees who is talking at a glance. Refined, and reused where it fits.

**Patterns.** Tailscale's machines list and network map (nodes with a calm online dot, the map secondary to the list); Figma multiplayer presence (small live marks that appear only while something happens, never a constant blink); Vercel and Linear live status (one quiet dot plus a word, motion only on change); Grafana and Datadog service maps (nodes sized by traffic, edges thickened by rate, clustered when large). Adapted: the list stays the main view; the map is an alternate view of the same rows.

**What it shows.** Your agents as boxes on the left (label, live dot, AI apps it serves), contacts as smaller boxes on the right (owner-confirmed name only, as Start here, I-5), and a line between an agent and a contact when they exchanged anything in the last 24 hours. Line weight follows the existing pulse counts (UX2-f1, b11 §24); a **stream** (a short travelling dash, inbound and outbound in their own direction) runs only while a message or file is moving or arrived in the last minute, then settles to a still line. A file transfer in progress shows the same determinate fill as Files (UX2-c). Clicking a box or line opens that contact in Messages.

**Where.** Agents page: a List and Map control (b11 §22 segmented control). Then, where it fits: Home "Last activity" tile as a mini map (top 5 contacts); Contacts as a Map view; Messages and Files as a stream mark on the row that is moving now (no map); the compact view as a one-line strip of active contacts (b11 §25.1). Decision 13 sets how far 0.4.4 goes.

**Data.** Reuses the pulse read (`GET /api/ui/messages/pulse`, counts per two hours, `activity` word) through the shared pulse module (card UX2-pulse-shared, PR #662), so the map, list rows and compact view read one source. "Live" needs fresher signals than the pulse's 60 s poll: one new read, `GET /api/ui/flow?since=<cursor>` (`presence: false`), polled every 3 s while the page is visible and stopped when hidden. It answers events from the local store only: `{contactId, direction: in|out, kind: message|file, state: queued|sent|delivered|received|progress, bytesDone?, bytesTotal?, at}`, at most 200 per answer, for the current agent (with decision 2.1: other agents' lines come from their pulse, read on demand, and show Live only for the open agent; an all-agents live map waits for the all-agents host). SSE was considered and not chosen: polling fits the existing gate and the health poller pattern, with no long-lived socket per tab.

**Glanceable, and private by default.** The owner can always read their own agents' messages: the app already decrypts them locally and shows them in Messages (D-133). The map itself stays glanceable: names, activity and direction, with **no content drawn on the boxes or lines by default** (calm, and safe while screen sharing). Clicking a box or line opens that conversation in Messages, where the content is. So the flow read carries metadata only: who, direction, kind, state, time and sizes the store already keeps in clear (07 §3); never message text, subject, file name, link or envelope. A contact the owner has not named shows as "Unnamed contact" (I-5: a name the other side chose is shown only inside the untrusted container, as in Messages). An optional one-line preview on hover is decision 14; if chosen, it is fetched from the existing Messages read on hover and rendered in the untrusted-content container as plain text (I-5), never part of the flow read. **Zero access is unchanged:** nothing leaves the device for this view, 4thTech never sees content, and it works offline. Logs carry counts only (I-7).

**Scale and calm defaults.** Top 12 contacts by recent activity per agent, the rest folded into "+N more" (a cluster box that expands); up to 8 agents drawn, then the list. Quiet contacts are hidden by default ("Show quiet"). Lines are still unless something moves; at most 6 streams animate at once, the rest show a still highlighted line. No layout physics: a fixed two-column layout sorted by activity, so boxes never jump.

**Reduced motion and transparency.** Under `prefers-reduced-motion` no stream travels: an active line gets a static arrowhead and a "now" label. Under reduced transparency the boxes use solid level-2 surfaces (b11 §13.2). Increased contrast thickens lines and borders.

**Accessibility.** The map is `aria-hidden` decoration over a real list: the text alternative is the List view, and a visually hidden live region announces at most one line per 10 s ("Message from Marko to Work, now."). Every box is reachable by keyboard in list order. Colour is never the only signal (direction arrows, words).

**Performance budget.** One SVG layer, no new dependency, no canvas library; under 8 KB gzipped for the map part, lazy-loaded with the Agents page; flow poll answer under 20 KB; animation on `transform` and `stroke-dashoffset` only, paused when the tab is hidden; 60 fps at 8 agents and 12 contacts each on a 2020 MacBook Air; the perf guard test (`perf-guards.test.ts`) extended.

**Design.** A new brief section **b11 §32 Live connections** (layout, box and line styles, stream motion with tokens from §14, the cluster box, reduced-motion and contrast variants, the mini-map and compact strip, 1280 and 360), approved with screenshots per D-116 and D-137 (decision 11); nothing is drawn ad hoc.

## 5. New and amended b11 brief sections (card U3-brief, S0)

- **§27 amended, Start here v2:** the steps above; counted steps Protect, Name, Connect, Invite, Say hello, See the reply, Recovery kit ("3 of 7"); "Connect" ticks on a harness entry for this agent, its line shows Running when the AI app has run AgentLink; "See the reply" ticks on the first inbound message. Still not dismissible (UX-WAVE-2 decision 7.1), still one primary button.
- **§28 Welcome and first run v3:** Welcome; "Set up your agent" with the name field and the platform button; errors and states as today's first run; 1280 and 360.
- **§29 Agents:** §29.1 top-bar switcher (states: one agent, several, an agent needing setup, loading; overflow after 8 rows with search); §29.2 Agents page; §29.3 Add agent sheet; §29.4 Remove agent sheet (copy, the typed label, the export offer, progress, partial-failure state); §29.5 Rename.
- **§30 AI apps:** app cards and states (Not found, Not connected, Connected, Connected to {other agent}, Needs restart, Running, Blocked: quit Claude Desktop first, Can't edit this file); the diff panel (from `first-run--ai-app-setup`); the move case ("Claude Code will use Work instead of Personal"); manual steps; 1280 and 360.
- **§32 Live connections:** as §4.1 (the map, streams, cluster, mini map on Home, compact strip, row stream mark, reduced motion, contrast, the text alternative).
- **§31 Copy:** every new string, checked against 11 §5 (no wallet, gas, seed phrase, transaction, chain; "keys" only in the remove sheet, where it is the honest word; "AI app", not "harness").

## 6. How the app holds several agents

**Recommended (decision 2.1): one app, one agent open at a time.** The `ui` process becomes the app host: it lists the agents in `~/.agentlink/agents`, opens the current one (the same `openAgent` path as today), and on a switch closes it and opens the other in the same process and on the same port and session. Every `/api/ui/` read and owner route acts on the current agent; the response carries the agent's label so a page never shows one agent's data under another's name (a switch bumps a generation number, and a reply from the old generation is dropped). The owner is per computer, so the same passkey works for every agent: switching asks for nothing.

- **The last-used agent** is remembered in `~/.agentlink/app.json` (`{v:1, current:"<name>"}`, 0600, not owner-signed: changing it only changes which agent opens first, as for `config.json`, 07 §9.1).
- **Approval pages opened by an MCP process** (06 §2.5) stay bound to that process's agent. They show its label in the top bar; the switcher there says "Open the AgentLink app to switch" with no menu, so two servers never act for the same choice.
- **One publisher per agent** is unchanged (06 §6): the app host never takes the publisher lease, as CLI commands do not today. The app reads the lease row to show **Running** ("an AI app is running AgentLink for this agent").
- **Not chosen:** a page per agent on its own port (option 2.2: tabs multiply, each with its own session link; confusing) and all agents open at once (option 2.3: every keychain item unlocked at once, more memory and relay work, for a combined view nobody asked for yet; b11 §25.3 reserves it for later).

## 7. Spec and security impact

### 7.1 New local routes (08 §1; all behind the session, CSRF, `Host`, `Origin`, fetch-metadata and octet-stream gate)

| Route | Kind | What |
|---|---|---|
| `GET /api/ui/agents` | `presence: false` | Agents here: name, label, current, AI apps that serve it (read from the harness files, read-only), contacts count, Running. Never an ID beyond the short form under Under the hood, never a path |
| `POST /api/ui/agents/switch` `{name}` | **new kind `switch`** (decision 2) | Closes the current agent, opens the named one. Signs nothing, writes only `app.json`. Name checked against 06 §6 and must exist |
| `POST /api/ui/agents` `{label}` | `presence: true` | Creates a keychain agent (`createOsKeychainAgent`), the owner signs its card (`owner add-agent` path, 04 §2.8) and its first policy (06 §3 defaults). Folder name derived from the label (slug, de-duplicated) |
| `POST /api/ui/agents/label` `{name,label}` | `presence: true` (decision 4) | Changes the label only; the folder name, MCP entries and identity stay |
| `POST /api/ui/agents/remove` `{name, typedLabel}` | `presence: true` | §7.2 |
| first run `begin`/`finish` | `setup` (unchanged kind) | `begin` also takes `{label}`; with no agent yet, `finish` creates the agent first, all or nothing |
| `GET /api/ui/apps` | `presence: false` | Detected AI apps, the agent each serves, Claude Desktop running |
| `POST /api/ui/apps/preview` `{app, agent}` | `presence: false`, a POST only to carry a body; new kind `preview` or a GET with query (decision 6) | The exact diff and a `changeId` = hash of (app, resolved path, old bytes, new bytes, agent) |
| `POST /api/ui/apps/apply` `{changeId}` | `presence: true` | Recomputes the change, refuses `changed` if it differs, then writes under the 06 §7 rules |
| `POST /api/ui/apps/disconnect` `{app}` | `presence: true` | Removes this agent's `agentlink` entry, same diff and rules |
| `GET /api/ui/flow?since=` | `presence: false` | §4.1: local flow events, metadata only, capped, cursor of at most 256 characters |

All errors are fixed codes; logs carry counts and app ids only (I-7). No route takes a path from the page: AI app files come only from the fixed table (`--config <path>` stays a terminal option under Advanced). No MCP tool is added or changed (I-4).

### 7.2 Removing an agent (S2, Fable audit)

Steps, all or nothing where possible, in this order, after Touch ID and the typed label:

1. If the agent has contacts: the owner signs `agent.revoke` `{reason: "retired"}` (04 §2.5.1) and a `revoke` envelope goes to each contact through the outbox, with a bounded wait (decision 5). This is permanent: a recovery kit can no longer bring the agent back as itself (04 §2.5.1 "returns only as a new identity"), and the sheet says so.
2. AI app entries that run this agent are removed (diff shown in the sheet, same write rules).
3. The agent's keychain items are deleted (the `KeyStore` delete path, never our own code), then `store.sqlite` (and `-wal`, `-shm`), `config.json` and the folder, after the realpath check of `agent-dir.ts`.
4. The app switches to another agent, or to Welcome-style "Add an agent" when none is left. The owner stays.

**Invariants.** I-1/I-2: no key or content leaves the computer; deletion uses KeyStore. I-4: only through owner presence; no MCP tool can remove an agent. I-7: nothing about the agent is logged beyond "removed". **I-10:** the sheet offers "Export history first" (the existing backup export) before the gesture. **Partial failure** (keychain refused, file busy) answers a fixed code and leaves the agent listed as "Removal not finished" with Try again; never a half-deleted agent that looks fine. **Residual (G-1):** a same-user process can delete these files itself; the presence gate stops a page session holder, not the agent.

### 7.3 Writing AI app configs from the app (S2, Fable audit)

- The content is fixed: `npx -y @4thtech-io/agentlink mcp` plus `--agent <name>` for a non-default agent (name checked again); **no secret is ever written** (no token, no key, no session link).
- Paths only from the fixed table; realpath, no-link, regular-file, atomic temp-and-rename and the backup before write from `apps/cli/src/harness/files.ts` (06 §7) apply unchanged. The code is reused through a seam the CLI passes to the server (as `ui.ts` already passes its deps), so `packages/node` does not grow a second harness writer.
- **The diff the owner saw is the diff written:** `changeId` binds it; Touch ID is bound to a statement naming the app and agent (04 §2.5.3 pattern; no owner-signed op is stored, since nothing outside this computer verifies it; proposed in 04 §2.5).
- **Moving** an AI app from agent A to B replaces the entry (today a conflict); the diff shows the old and new lines (decision 7). An entry we did not write (other command or arguments) stays a conflict with manual steps.
- Claude Desktop: never written while it runs (D-130 (7)).
- **Threat note:** a config entry starts a program, so this route is a code-execution path; that is why the content is fixed, the path is fixed and the owner's gesture is required. A shell-capable agent could already edit these files (06 §7: transparency, not a boundary).

### 7.4 CLI and migration

- `ui` and `init` never ask which agent. `ui` opens the last-used agent (`app.json`), else the agent an AI app serves (`default` first), else the first by name; the app's switcher does the rest. `init` without `--agent` keeps D5 (named after the app) and, when that gives no answer, uses the current agent; it never prompts. `--agent` stays, under Advanced in `--help`. `agent-choice.ts` and its texts go.
- Bare `agentlink` (and `npx -y @4thtech-io/agentlink`) in the owner's own terminal opens the app; run by an AI it prints the one fixed line of M1-UX-OPEN-APP. `ui` with no agent at all opens Welcome instead of "run init first".
- **Existing installs with several agents** (decision 8): nothing is deleted or renamed. Labels default to the folder name. Home shows a one-time "Tidy up" note when some agents serve no AI app and have no contacts, linking to Agents.

### 7.5 Spec text to amend (card U3-spec, all "proposed, owner confirms at merge")

- **08 §1:** the app host and current agent (§6); `agentlink ui` opens Home; the routes of §7.1 (with the flow read and its metadata-only allowlist), the `switch` kind (and `preview` if chosen); first run v3; pages list adds Agents and AI apps.
- **06 §6:** agent labels (owner text, shown as text, never in a prompt to the AI), the app manages agents; **§7:** the app as a second path with the same rules, move and disconnect, the UI's fixed-path limit; **§8:** bare command, `ui` and `init` without a picker.
- **04 §2.5:** config writes and agent removal as presence-gated local actions with statement binding; the removal order and residuals; **§2.8:** adding an agent from the app.
- **07 §9.1:** `config.json` gains optional `label`; `app.json`.
- **11 §5:** the new strings.

## 8. What it does not change

Pairing, invites, the policy engine, approvals, owner keys and passkey enrolment, the publisher lease, MCP tools, `init`'s own diff-and-code path for an AI-run install.

## 9. Cards (proposed)

Class per `audit-rules.md` §2 (`packages/node` S2; `apps/local-ui`, `apps/cli` S1, owner operations S2; `docs/foundation`, `docs/process` S1; `docs/design` S0). Sizes: S up to a day, M two to three days, L a week. **Fable** = Fable 5.1 security audit (keys, owner presence, code execution).

| Card | What | Class | Depends on | Files (owner) | Acceptance | Fable |
|---|---|---|---|---|---|---|
| **U3-spec** | Spec amendments of §7.5 | S1 | decisions | `docs/foundation/04, 06, 07, 08, 11` | Text matches the decisions; marked proposed | — |
| **U3-brief** | b11 §27 amended, §28 to §31 | S0 | decisions | `docs/design/b11-local-app.md` | Owner approves the sections | — |
| **U3-a** | Open on Home: router default, first run lands on Home, Home is first in every entry | S1 | — | `apps/local-ui/src/router.tsx`, `nav.ts`, `pages/first-run/` (redirect only) | `ui` and first run land on Home; tests | — |
| **U3-b** | CLI: no agent picker; bare command opens the app; `ui` with no agent opens Welcome; `--agent` under Advanced | S1 | U3-c (host API) | `apps/cli/src/commands/{ui,init,agent-choice,dispatch}`, `apps/cli/src/dispatch.ts` | No prompt in any path (tests with 0, 1, 4 agents); AI-run behaviour unchanged | — |
| **U3-c** | App host: current agent, switch, `GET /api/ui/agents`, `openHome`, `app.json`, generation check | S2 | U3-spec | `packages/node/src/approval-server.ts`, `local-ui/routes.ts`, `local-ui/api/agents.ts` (new) | Switch closes and opens; stale replies dropped; route kind registered and refused elsewhere; RED first | — (Opus IR) |
| **U3-d** | Create agent and label: route, first run v3 with name (`setup` kind), owner signs card and policy | S2 | U3-c | `packages/node/src/local-ui/api/agents-manage.ts` (new), `owner-setup.ts`, `owner-add-agent.ts`, `apps/cli/src/runtime/agent-dir.ts` (label) | All or nothing; label rendered as text; no secret in any answer; RED first | **Yes** |
| **U3-e** | Remove agent: revoke send, entries, keychain and files, partial-failure state | S2 | U3-c, U3-f | `packages/node/src/local-ui/api/agents-remove.ts` (new), `packages/node` keychain delete path, `packages/core` revoke send helper | §7.2 order; typed label; I-10 offer; failure leaves "Removal not finished"; RED first | **Yes** |
| **U3-f** | AI apps: list, preview, apply, disconnect, move; seam from CLI harness code | S2 | U3-c | `packages/node/src/local-ui/api/apps.ts` (new), `apps/cli/src/harness/` (replace and remove an entry), `apps/cli/src/commands/ui.ts` wiring (after U3-b merges) | `changeId` binding; fixed paths only; Claude Desktop rule; backup; no secret written; RED first | **Yes** |
| **U3-g** | Welcome and first run v3 screens | S1 | U3-brief §28, U3-d | `apps/local-ui/src/pages/first-run/`, `pages/welcome/` (new) | Owner screenshot review; a11y tests | — |
| **U3-h** | Top-bar switcher and Agents page, Add, Rename and Remove sheets | S1 | U3-brief §29, U3-c (then d, e) | `apps/local-ui/src/layout/top-bar.tsx`, `pages/agents/` (new) | Switch reloads data; labels as text; remove sheet copy exact | — |
| **U3-i** | AI apps page and Connect step | S1 | U3-brief §30, U3-f | `apps/local-ui/src/pages/apps/` (new) | Diff shown before Touch ID; states from reads only | — |
| **U3-j** | Start here v2 | S1 | U3-brief §27, U3-c (Running read) | `apps/local-ui/src/pages/home/` | Ticks from reads only; "3 of 7"; still not dismissible | — |
| **U3-flow** | Local API: `GET /api/ui/flow` (metadata-only allowlist, caps, cursor) | S2 | U3-spec | `packages/node/src/local-ui/api/flow.ts` (new), core store read helper | No inbound text or file name in any answer (test with hostile names); caps; RED first | — (Opus IR) |
| **U3-map** | Live connections map on Agents (List/Map), on the shared pulse module | S1 | U3-brief §32, UX2-pulse-shared, U3-flow, U3-h | `apps/local-ui/src/pages/agents/map/` (new), `pages/pulse/` (shared module only) | Budget met; click opens the conversation in Messages; no content drawn; reduced-motion and contrast variants; List is the text alternative; screenshot review | — |
| **U3-map-2** | The idea elsewhere: Home mini map, Contacts Map view, row stream mark in Messages and Files, compact strip | S1 | U3-map, decision 13 | `pages/home/`, `pages/contacts/`, `pages/messages/`, `pages/files/`, `pages/compact/` | Same rules; one source (shared module) | — |
| **U3-k** | End-to-end check of the whole path on a clean macOS user (scripted, two agents, two AI apps), plus README quick start and docs-site "Getting started" | S1 | all above | `docs/runbooks/`, `README.md`, `docs-site/`, `changelog.d/` | Owner can follow it without a terminal after step 0 | — |

## 10. Ordering (4 to 6 builders, disjoint files)

| Group | Cards in parallel | Why |
|---|---|---|
| **0** | U3-spec, U3-brief, **U3-a** | Docs and the one change that needs nothing new: the app opens on Home (could ship at once as 0.4.3-patch if wanted) |
| **1** | U3-c, U3-j (with the Running read stubbed until c lands) | The host is the base of everything else |
| **2** | U3-b, U3-d, U3-f, U3-h (switch and list parts) | Disjoint: CLI commands; node agents-manage; node apps plus CLI harness; local-ui layout |
| **3** | U3-e, U3-g, U3-i, U3-h (add, rename, remove parts); U3-flow (from group 1 on, its own file) | Remove waits for the apps route (entries) |
| **3b** | U3-map, then U3-map-2 | After the brief §32, the shared pulse module and the Agents page |
| **4** | U3-k, then the release | The owner walks the path |

S2 cards follow tests first (`RED (expected):` commit), an independent review (Opus), the Fable audit where marked, and Tali's "merge". UI cards carry screenshots at 1280 and 360, light and dark, for the owner's review (D-137 pattern, decision 11).

## 11. Owner decisions

Recommended option first in each.

1. **Release target**
   1. **0.4.4** with all cards; if U3-e (remove) has not passed its Fable audit when the rest is ready, 0.4.4 ships without Remove and it follows in 0.4.5 (recommended: the start, switch and connect fix the "lost" problem; remove is the riskiest piece and should not hold it).
   2. 0.4.4 only when every card including Remove is done.
   3. Ship U3-a (open on Home) alone now as 0.4.4, the rest as 0.4.5.
2. **Several agents in one app**
   1. One app, one agent open at a time, top-bar switcher; switching is a new route kind `switch` without Touch ID (it signs and changes nothing beyond which agent you view) (recommended, §6).
   2. The same, but switching needs Touch ID (safer against a page-session holder, but a gesture just to look is friction, and viewing is already what the session grants).
   3. A browser tab per agent, each with its own server and link.
3. **First screens**
   1. Name and Touch ID on one screen, one gesture (recommended: the shortest path, and today's first run is already one all-or-nothing gesture).
   2. Touch ID first, then a separate "Name your agent" screen (your order, one more screen).
   3. No name at first; "My agent" until renamed.
4. **Renaming an agent**
   1. A label only (any text up to 40 characters), with Touch ID; folder name, AI app entries and identity unchanged (recommended: nothing breaks, and every change stays presence-gated, D-118).
   2. A label only, without Touch ID (another route kind).
   3. Rename the folder too (rewrites every AI app entry; more risk, no user gain).
5. **Removing an agent**
   1. Touch ID and the typed name; offer "Export history first"; tell its contacts it is retired (`agent.revoke`, only if it has contacts); remove its AI app entries; delete its keys and history (recommended: clean for you and your contacts; your test agents have no contacts, so for them it is a plain delete).
   2. The same without telling contacts, so a recovery kit could restore it; contacts keep writing to an agent that is gone.
   3. Hide only ("Archive"), delete later.
6. **Writing AI app configs from the app**
   1. Exact diff, then Touch ID bound to that diff, backup first, Claude Desktop must be closed; preview as a GET with query (no new kind) (recommended).
   2. Exact diff and an Apply click without Touch ID (the terminal path asks only y/N; a page-session holder could then rewire your AI apps).
   3. No writes from the app: show the command to copy.
7. **Moving an AI app to another agent**
   1. Allowed, with the replace diff ("Claude Code will use Work instead of Personal") (recommended).
   2. Not allowed: disconnect first, then connect.
8. **Your existing agents (ag-test, cc-gate, cc-test, oc-test)**
   1. Keep all, open the last used (else the one an AI app uses), show a one-time "Tidy up" note linking to Agents (recommended: nothing disappears without you).
   2. On first open, ask in the app which to keep.
9. **CLI**
   1. `ui` and `init` never ask; bare `npx -y @4thtech-io/agentlink` opens the app; `--agent` stays under Advanced in help (recommended: scripts and docs keep working).
   2. Also remove `--agent` from `ui` (the app is the only way to switch).
10. **Where agents and AI apps live in the navigation**
    1. Top-bar switcher for agents (with Manage agents); "AI apps" as a sidebar item after Contacts until every app is connected, then under Settings (recommended: visible while you need it, quiet after).
    2. Both under Settings only.
    3. Both as sidebar items always.
11. **How the new screens are designed**
    1. Built straight from the new b11 sections (§28 to §31), styled from the D2 screens named in §2, with your screenshot review in each PR, as D-137 did for wave 2 (recommended: fastest to something you can try).
    2. Claude Design screens first, then builds (D-116 as written; adds about a week).
12. **Start here v2 steps**
    1. Protect, Name, Connect your AI app, Invite, Check safety code (recommended, not counted), Say hello, See the reply, Save recovery kit; counted "x of 7"; not dismissible (recommended).
    2. The same without "See the reply" (ends at sending).
13. **Live connections view (§4.1)**
    1. Agents page Map view plus the row stream mark in Messages and Files in **0.4.4** (U3-flow, U3-map); Home mini map, Contacts Map and the compact strip in 0.4.5 (U3-map-2) (recommended: the place you asked for first, without holding the usability fixes).
    2. Everything in 0.4.4, including U3-map-2.
    3. Whole view in 0.4.5, after the usability path is out.
    4. Pulse-only, no live streams (no new read; lines update once a minute).
14. **A preview on hover in the map**
    1. No preview; click opens the conversation in Messages (recommended: the map stays calm and safe to show while screen sharing, and Messages is one click away).
    2. A one-line preview of the latest message on hover or focus, off by default, a switch in Appearance (fetched from the Messages read on hover, plain text in the untrusted container).
    3. The preview on by default.

## 12. Risks

- **Wrong agent in view:** a reply for the old agent after a switch. Mitigated by the generation check and the label in every response; tests switch mid-request.
- **Config writes as a code path:** fixed content and paths, presence, `changeId`, Fable audit.
- **Irreversible removal:** typed label, presence, export offer, plain copy that says it cannot be undone; partial-failure state.
- **The terminal still has to stay open** while `ui` serves (30 minutes). Out of scope here (the desktop app removes it); the Welcome copy says so plainly.
- **A busy, distracting map:** calm defaults (still lines, 6 streams at most, quiet hidden), the list stays first, reduced-motion variant.
- **Content on screen by surprise (screen sharing):** the map draws no content by default; the flow read is a metadata allowlist, and tests feed hostile file names and texts and check none appears in it.
- **Keychain prompts on delete** may differ per macOS version: U3-e checks on a real Mac before review.
