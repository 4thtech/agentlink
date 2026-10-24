# Start here: the documentation map

Where everything lives in the AgentLink repository, what to read first for your role, and how to get productive in a set time. AgentLink is pre-alpha (M0 Foundations nearly complete; v0.1.0 of M1a released on 16 Oct 2026): the documents describe the design and the way we build; the M1a code (crypto, transport, core, node, the CLI and the MCP server) is released as the `@4thtech-io/agentlink` package. For the current state, see the Status box in the [root README](../README.md).

Four kinds of document, four jobs:

| Kind | Where | Answers | When two disagree |
|---|---|---|---|
| **Specs** | [`foundation/`](foundation/00-README.md) | *What* we build and the invariants it keeps | The spec wins over everything below |
| **Process** | [`process/`](process/development-process.md) | The *rules*: who may do what, gates, classes | The process document wins over a runbook |
| **Runbooks** | [`runbooks/`](runbooks/README.md) | *How*: numbered steps and exact commands for one repeatable procedure | Fix the runbook in the same PR |
| **Lessons** | [`lessons/`](lessons/README.md) | *Why* a rule exists: what went wrong before | A lesson never overrides a rule |

## 1. Pick your role

Read the documents in order. Each list is the minimum; open the rest by section when a task needs it.

### New human developer

1. [`../README.md`](../README.md) and [`../CONTRIBUTING.md`](../CONTRIBUTING.md): what this is, how work is organised.
2. [`foundation/00-README.md`](foundation/00-README.md): principles, glossary, decision log (skim the log).
3. [`foundation/04-security-and-crypto.md`](foundation/04-security-and-crypto.md) §1: the invariants I-1 to I-10.
4. [`process/delivery-process.md`](process/delivery-process.md): the 14-step lifecycle and the definition of done.
5. [`runbooks/README.md`](runbooks/README.md), then [RB-01 session start and end](runbooks/session-start-end.md) and [RB-02 claiming a task](runbooks/claim-task.md).
6. [`lessons/README.md`](lessons/README.md): ten minutes that save you a day.

### An agent in any harness (Claude Code, Codex, Gemini CLI, Cursor, others)

1. [`../AGENTS.md`](../AGENTS.md): the rules. Your harness loads it automatically if the table in §3 says so; otherwise read it first.
2. [RB-01 session start and end](runbooks/session-start-end.md): sync branch, board, optional Curator.
3. Your task card in [`process/backlog.md`](process/backlog.md) (`grep -n '^#### <TASK-ID>'`), and its security class in [`process/audit-rules.md`](process/audit-rules.md) §2.
4. The spec sections the card cites, by section, not whole files.
5. [RB-14 when a permission or safety check denies an action](runbooks/permission-denied.md).
6. [`process/repo-reference.md`](process/repo-reference.md) for commands.

### Orchestrator (the owner's main session)

1. [`../AGENTS.md`](../AGENTS.md) § Orchestration and context economy, then [`process/orchestrator-playbook.md`](process/orchestrator-playbook.md) (every session).
2. [`process/delivery-process.md`](process/delivery-process.md): roles, lifecycle, go-ahead model.
3. [`process/development-process.md`](process/development-process.md) §3 (routing), §4 (briefs), §5 (verification protocol).
4. Runbooks [RB-03 worker brief](runbooks/worker-brief.md), [RB-04 independent review](runbooks/independent-review.md), [RB-09 merge and release](runbooks/merge-and-release.md), [RB-15 save and hand off](runbooks/save-and-handoff.md). Dogfooding M1a: [RB-17 multi-harness dogfood](runbooks/dogfood-m1a.md). Releasing v0.1.0: [RB-18 owner checklist](runbooks/release-v0.1.0.md) and the [draft release note](releases/v0.1.0.md).
5. [`process/audit-rules.md`](process/audit-rules.md) §3 and §4.

### Builder (worker subagent or human implementer)

1. Your brief. It names your owned files, the files others own, and the stop conditions.
2. The spec sections and invariants the brief cites.
3. [RB-05 writing tests](runbooks/writing-tests.md).
4. [RB-07 adding a dependency](runbooks/add-dependency.md), only if the brief grants one.
5. [`process/development-process.md`](process/development-process.md) §3.3 (escalation) and §4.2 (forbidden actions).

### Reviewer (independent auditor worker or human reviewer)

1. [`process/audit-rules.md`](process/audit-rules.md) §4 (inputs, procedure, output format) and the §5 checklists for the areas touched.
2. [`foundation/04-security-and-crypto.md`](foundation/04-security-and-crypto.md) in full for S2, §1 for S1.
3. [RB-04 independent review](runbooks/independent-review.md).
4. The spec sections the change cites. Nothing else: no PR body, no builder report (audit-rules §4.1).

### Owner

1. [`process/delivery-process.md`](process/delivery-process.md) §4 (your go-ahead) and §6 (what you say, what happens).
2. [`process/development-process.md`](process/development-process.md) §1.1: the actions only you perform.
3. [`process/release-and-deployment.md`](process/release-and-deployment.md) §3 and §8: golden rules and rollback.
4. [RB-11 rollback and `DEPLOY_FREEZE`](runbooks/rollback-and-freeze.md) and [RB-14 permission denied](runbooks/permission-denied.md): where agents stop and hand the decision to you.
5. The private runbooks in `4thtech/agentlink-ops` (`runbooks/`) for incidents, secrets, Safe operations and mainnet.

Designers start with [`foundation/11-claude-design-brief.md`](foundation/11-claude-design-brief.md) and [`design/README.md`](design/README.md); product and partners with [`../README.md`](../README.md), [`foundation/02-product-spec.md`](foundation/02-product-spec.md) and [`foundation/10-build-plan.md`](foundation/10-build-plan.md).

## 2. Onboarding track for a new developer

A time-boxed path. Each stage ends with something you can show.

| When | Do | Done when |
|---|---|---|
| **First hour** | Read items 1 to 3 of "New human developer". Set up your machine ([`process/onboarding.md`](process/onboarding.md) A5: clone, git identity, the `sync` worktree). Run the read-only part of [RB-01](runbooks/session-start-end.md). | You can say which task is in flight, who holds it, and which invariant protects the owner's keys. |
| **Day 1** | Read [`process/delivery-process.md`](process/delivery-process.md) and every lesson in [`lessons/`](lessons/README.md). Pick one merged PR (for example the first `DOCS` PR) and trace it through the 14 steps: the card, the PR template sections, the review line `IR-…`, the CI checks (`gh pr checks <n>`). | You can explain why a green CI is not "done" (delivery-process §5) and what `review-gate` checks. |
| **Week 1** | Ship one small change end to end: claim it ([RB-02](runbooks/claim-task.md)), build it with tests ([RB-05](runbooks/writing-tests.md)), get it reviewed ([RB-04](runbooks/independent-review.md)), get CI green ([RB-08](runbooks/ci-red.md)), hand it to merge ([RB-09](runbooks/merge-and-release.md)), and save state ([RB-15](runbooks/save-and-handoff.md)). | Your PR is merged through the gates and your sync file says so. |

**Concrete first task:** card **M0-24** (docs-consistency check) in [`process/backlog.md`](process/backlog.md): a small script under `tools/` that checks that links resolve and that every runbook follows the template. It is S1, needs no secrets and exercises the whole flow. Its dependency, the monorepo skeleton (M0-2d), is on `main`. If someone already holds it, take any `DOCS` fix you find while reading (a broken link, a stale command) and ship it the same way.

## 3. Which file each harness reads

`AGENTS.md` is the single source of agent rules. The other files only point to it; never put rules in them.

| Harness | Reads | Action needed |
|---|---|---|
| Claude Code | `CLAUDE.md`, which imports `AGENTS.md` with `@AGENTS.md`; project `.claude/settings.json` | None |
| OpenAI Codex | `AGENTS.md` | None |
| Cursor | `AGENTS.md` in the project root (Cursor rules docs); `.cursor/rules/*.mdc` are not used here | None |
| Gemini CLI | `GEMINI.md` by default, which imports `AGENTS.md` with `@AGENTS.md` | None (or set `context.fileName` to `AGENTS.md` in `.gemini/settings.json`) |
| GitHub Copilot coding agent | `AGENTS.md` (GitHub changelog, 2025) | None. Copilot Chat in the IDE reads `.github/copilot-instructions.md`, which does not exist yet (card M0-25) |
| Any other harness | Unknown | Start each session with the bootstrap prompt in [`process/onboarding.md`](process/onboarding.md) and confirm the rules are loaded |

## 4. What lives where

### `foundation/`: the specifications (source of truth)

When code, process or any other document disagrees with a spec, the spec wins. Start with [`00-README.md`](foundation/00-README.md).

| Doc | Purpose |
|---|---|
| [`00-README.md`](foundation/00-README.md) | Index, core principles, glossary and the **decision log** (D-01 and later), plus the revision history |
| 01 Commercial brief | *Private.* Positioning, market and business model; kept outside this repository |
| [`02-product-spec.md`](foundation/02-product-spec.md) | Features, user journeys, free vs paid, non-goals |
| [`03-architecture.md`](foundation/03-architecture.md) | Components, data flows, packagings and trust boundaries |
| [`04-security-and-crypto.md`](foundation/04-security-and-crypto.md) | Key management, encryption scheme, threat model and the non-negotiable invariants I-1 to I-10 |
| [`05-contracts-occ-v2.md`](foundation/05-contracts-occ-v2.md) | Specification of the OCC v2 smart contracts (the Solidity source lives in a separate private repository during beta) |
| [`06-mcp-server.md`](foundation/06-mcp-server.md) | MCP tools, transports, approval flow and harness setup |
| [`07-sdk-transport-storage.md`](foundation/07-sdk-transport-storage.md) | Core TypeScript packages, the Nostr transport and the storage adapter |
| [`08-clients-console-cloud.md`](foundation/08-clients-console-cloud.md) | Local approval UI, owner console, cloud agent, public pages and desktop apps |
| 09 Repositories and reuse | *Private.* Audit of existing repositories and what to reuse; kept outside this repository |
| [`10-build-plan.md`](foundation/10-build-plan.md) | Milestones, tasks and acceptance criteria |
| [`11-claude-design-brief.md`](foundation/11-claude-design-brief.md) | UX principles, screens, flows and the copy vocabulary |
| [`12-economics-and-fees.md`](foundation/12-economics-and-fees.md) | Public fee schedule in USD, fee tokens, caps and price-change policy, treasury and transparency |

### `process/`: how we build

| Doc | Purpose |
|---|---|
| [`development-process.md`](process/development-process.md) | Roles, orchestration of AI agents, task flow, verification and the spec-change process |
| [`orchestrator-playbook.md`](process/orchestrator-playbook.md) | What the orchestrator does every session: delegate everything, keep 8–15 workers busy, four-model routing, merge-queue procedures, recording reviews, builder rules |
| [`delivery-process.md`](process/delivery-process.md) | The end-to-end delivery process: roles, 14-step lifecycle, safety nets, owner go-ahead model and definition of done |
| [`audit-rules.md`](process/audit-rules.md) | Security classes S0/S1/S2, review requirements, independent reviews and external audits |
| [`release-and-deployment.md`](process/release-and-deployment.md) | Environments, releases, automatic service deploys, owner-approved npm `latest`, rollback and secrets handling |
| [`ci-cd.md`](process/ci-cd.md) | GitHub Actions workflows, required checks and repository settings |
| [`versioning.md`](process/versioning.md) | SemVer, milestone-to-version mapping, changesets and compatibility |
| [`sync-protocol.md`](process/sync-protocol.md) | How collaborators and their agents coordinate on the shared `sync` branch |
| [`onboarding.md`](process/onboarding.md) | Onboarding for collaborators and the agents working for them |
| [`backlog.md`](process/backlog.md) | Task cards (the IDs you see in branches and PR titles) |
| [`repo-reference.md`](process/repo-reference.md) | Stack, repository layout, commands and testing |
| [`test-reports/`](process/test-reports/README.md) | Reports of end-to-end and acceptance test runs (setup, how to rerun, measured results) |

### `explainers/`: plain-language guides

Short, non-normative explanations for anyone. They describe the planned design and link to the specs for detail; when they disagree with a spec, the spec wins.

| Doc | Purpose |
|---|---|
| [`messaging.md`](explainers/messaging.md) | How messages travel: relays, the double envelope, the inbox and why Nostr |
| [`files.md`](explainers/files.md) | How files move: inline, the encrypted drop or your own storage, and how they are cleaned up |
| [`payments.md`](explainers/payments.md) | What costs money and where it goes: credits, fees, price changes and invoices |

### `runbooks/`: how to do it

One file per repeatable procedure, in a fixed template (purpose, when, who, preconditions, steps, verify, on failure, related). Index: [`runbooks/README.md`](runbooks/README.md). Runbooks link to the process documents for the rules and never set rules of their own.

### `lessons/`: what we learned the hard way

One short file per lesson (problem, symptom, cause, rule). Index: [`lessons/README.md`](lessons/README.md).

### Elsewhere

- [`../docs-site/`](../docs-site/README.md): source of the **public documentation** on GitBook (user guide and technical docs), kept separate from these internal documents; upkeep rules in [`MAINTAINING.md`](../docs-site/MAINTAINING.md).
- [`design/`](design/README.md): design intake and status (the three design drops, and the rules for building UI before a design lands).
- **Decision log:** the table in [`foundation/00-README.md`](foundation/00-README.md). Every decision has an ID (D-xx); changes to it go through a PR.
- **Release history:** [`../CHANGELOG.md`](../CHANGELOG.md).
- **Root files:** [`../README.md`](../README.md) (status and roadmap), [`../CONTRIBUTING.md`](../CONTRIBUTING.md), [`../CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md), [`../SECURITY.md`](../SECURITY.md), [`../AGENTS.md`](../AGENTS.md) (with the harness pointers [`../CLAUDE.md`](../CLAUDE.md) and [`../GEMINI.md`](../GEMINI.md)).

## 5. How the docs change

- **Specs, process documents and the decision log change only through a pull request.** A spec change that alters an interface lands in the same PR as the code, or before it. Implementation never runs ahead of the spec.
- **Decisions are recorded.** A change to a principle, an invariant, a policy default or the build plan adds a decision-log entry (D-xx) in [`foundation/00-README.md`](foundation/00-README.md), and a revision-history line when the spec pack changes.
- **Every user-visible, spec or process change adds a line under `[Unreleased]` in [`CHANGELOG.md`](../CHANGELOG.md).** See [`process/versioning.md`](process/versioning.md).
- **Review depends on the security class.** Changes to `04-security-and-crypto.md` are S2; other specs and process documents are S1; see [`process/audit-rules.md`](process/audit-rules.md) and the spec-change table in [`process/development-process.md`](process/development-process.md).
- **Keep the README honest.** Update its Status and Roadmap whenever a milestone, release or user-visible capability changes, and never describe unbuilt features as available.
- **Runbooks follow the process.** A runbook that would change what is allowed is a process change: change the process document first (owner approval, `process/development-process.md` §8), then the runbook.
- **This repository is public.** Do not add the private documents (01, 09), contract source, secrets or details of unfixed vulnerabilities.
