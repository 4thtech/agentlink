# Documentation map

Where everything lives in the AgentLink repository, and which documents to read first for your role. AgentLink is pre-alpha (M0 Foundations): the documents describe the design and the way we build; product code does not exist yet. For the current state, see the Status box in the [root README](../README.md).

## What lives where

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
| [`audit-rules.md`](process/audit-rules.md) | Security classes S0/S1/S2, review requirements, independent reviews and external audits |
| [`release-and-deployment.md`](process/release-and-deployment.md) | Environments, releases, owner-approved production step, rollback and secrets handling |
| [`ci-cd.md`](process/ci-cd.md) | GitHub Actions workflows, required checks and repository settings |
| [`versioning.md`](process/versioning.md) | SemVer, milestone-to-version mapping, changesets and compatibility |
| [`sync-protocol.md`](process/sync-protocol.md) | How collaborators and their agents coordinate on the shared `sync` branch |
| [`onboarding.md`](process/onboarding.md) | Onboarding for collaborators and the agents working for them |
| [`backlog.md`](process/backlog.md) | Task cards (the IDs you see in branches and PR titles) |
| [`repo-reference.md`](process/repo-reference.md) | Stack, repository layout, commands and testing |

### Elsewhere

- [`design/`](design/README.md): design intake and status (the three design drops, and the rules for building UI before a design lands).
- **Decision log:** the table in [`foundation/00-README.md`](foundation/00-README.md). Every decision has an ID (D-xx); changes to it go through a PR.
- **Release history:** [`../CHANGELOG.md`](../CHANGELOG.md).
- **Root files:** [`../README.md`](../README.md) (status and roadmap), [`../CONTRIBUTING.md`](../CONTRIBUTING.md), [`../CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md), [`../SECURITY.md`](../SECURITY.md), [`../AGENTS.md`](../AGENTS.md).

## Reading paths by role

**New contributor**
1. [`README.md`](../README.md) and [`CONTRIBUTING.md`](../CONTRIBUTING.md)
2. [`foundation/00-README.md`](foundation/00-README.md): principles, glossary, decisions
3. [`foundation/04-security-and-crypto.md`](foundation/04-security-and-crypto.md): the invariants
4. [`process/development-process.md`](process/development-process.md), then the spec for the area you want to work on

**AI agent (any harness)**
1. [`AGENTS.md`](../AGENTS.md) first: it holds the rules and points to everything else
2. [`foundation/00-README.md`](foundation/00-README.md) and [`foundation/04-security-and-crypto.md`](foundation/04-security-and-crypto.md)
3. The spec for your component, then your task card in [`process/backlog.md`](process/backlog.md)
4. [`process/audit-rules.md`](process/audit-rules.md) for your task's security class, and [`process/repo-reference.md`](process/repo-reference.md) for commands

**Reviewer or auditor**
1. [`foundation/04-security-and-crypto.md`](foundation/04-security-and-crypto.md): threat model and invariants
2. [`process/audit-rules.md`](process/audit-rules.md): classes, checklists and finding handling
3. [`process/ci-cd.md`](process/ci-cd.md) and [`process/release-and-deployment.md`](process/release-and-deployment.md): what the pipeline enforces
4. The spec of the area under review, and [`SECURITY.md`](../SECURITY.md) for scope and reporting

**Designer**
1. [`foundation/11-claude-design-brief.md`](foundation/11-claude-design-brief.md): principles, screens, flows and copy rules
2. [`design/README.md`](design/README.md): drop schedule and status
3. [`foundation/02-product-spec.md`](foundation/02-product-spec.md) for the user journeys

**Product or partner**
1. [`README.md`](../README.md): what it is, what is planned, and what exists today
2. [`foundation/00-README.md`](foundation/00-README.md): summary, principles and decisions
3. [`foundation/02-product-spec.md`](foundation/02-product-spec.md): features and journeys
4. [`foundation/10-build-plan.md`](foundation/10-build-plan.md): milestones and gates

## How the docs change

- **Specs, process documents and the decision log change only through a pull request.** A spec change that alters an interface lands in the same PR as the code, or before it. Implementation never runs ahead of the spec.
- **Decisions are recorded.** A change to a principle, an invariant, a policy default or the build plan adds a decision-log entry (D-xx) in [`foundation/00-README.md`](foundation/00-README.md), and a revision-history line when the spec pack changes.
- **Every user-visible, spec or process change adds a line under `[Unreleased]` in [`CHANGELOG.md`](../CHANGELOG.md).** See [`process/versioning.md`](process/versioning.md).
- **Review depends on the security class.** Changes to `04-security-and-crypto.md` are S2; other specs and process documents are S1; see [`process/audit-rules.md`](process/audit-rules.md) and the spec-change table in [`process/development-process.md`](process/development-process.md).
- **Keep the README honest.** Update its Status and Roadmap whenever a milestone, release or user-visible capability changes, and never describe unbuilt features as available.
- **This repository is public.** Do not add the private documents (01, 09), contract source, secrets or details of unfixed vulnerabilities.
