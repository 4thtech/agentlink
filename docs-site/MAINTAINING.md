# Maintaining the public docs

How the public documentation in `docs-site/` is organised, published and kept true. Internal documents (specifications, process, runbooks) stay in [`docs/`](../docs/README.md); this folder holds only what the public reads on [GitBook](https://wiki.4thtech.io).

## 1. Layout

| Folder | Section on the site | Audience | Vocabulary |
|---|---|---|---|
| [`guide/`](guide/README.md) | User guide | People who use AgentLink through their AI app, including non-developers | Strictly the product vocabulary of [11 §5](../docs/foundation/11-claude-design-brief.md): no "wallet", "gas", "seed phrase" or "transaction" (and the rest of the "Never say" list) outside a section titled "Advanced" |
| [`technical/`](technical/README.md) | Technical docs | Agent builders, integrators, reviewers, verifiers, contributors | Technical terms allowed; specs win on any conflict |

Each folder holds a `.gitbook.yaml` (root and structure; kept only if the sync script in the wiki repo uses it, otherwise removed), a `README.md` (the section's landing page) and a `SUMMARY.md` (the navigation). Every Markdown file in a space appears in its `SUMMARY.md` exactly once.

Both sections follow [Diátaxis](https://diataxis.fr), with plain navigation labels instead of the Diátaxis names:

| Diátaxis | User guide | Technical docs |
|---|---|---|
| Tutorials | Get started | Guides → Your first integration |
| How-to guides | Everyday use; Desktop app and cloud agent | Guides |
| Reference | Pricing; Help (troubleshooting, FAQ, glossary) | Reference |
| Explanation | What is AgentLink?; Privacy (What leaves your computer) | Concepts |

## 2. Publishing

This repo is the source of truth (D-57, amends D-29). GitBook is **one space**, the 4thTech Docs site at [wiki.4thtech.io](https://wiki.4thtech.io), Git-synced from the private repo `4thtech/wiki.4thtech.io` (decided by Tali, 2026-10-26; model in the [docs model](../docs/process/docs-model.md) §8). Nothing here syncs to GitBook directly.

- **Release-time copy.** Planned (the script is not built yet; today the AgentLink section of 4thTech Docs is a short summary): at each AgentLink release, a script in the wiki repo will copy `docs-site/guide` and `docs-site/technical` from the **release tag** into the wiki repo and opens a PR there (no secrets). Merging it will publish. Release tags only, never `main`. After two releases the script will move to a GitHub Action. A merge to `main` here does not change the published site until the next release.
- **Review class.** `docs-site/**` is S1 (`audit-rules.md` §2.2): every change gets an independent review and the orchestrator's audit, then auto-merges when the checks are green. Until `review-gate` derives this itself (owner follow-up), the PR declares S1.
- **Owner-only.** Any change to the publishing setup (the wiki repo, Git Sync, domain, site structure) is made by the owner.
- **Rollback.** Revert the PR on `main`; the next release copy, or a revert PR in the wiki repo, republishes the previous pages.

- **Never edit in GitBook.** Changes go through a pull request here like any other change; the wiki repo holds only copies. `main` accepts changes only through pull requests, so a GitBook-side edit could not sync back without bypassing review. Never add the GitBook app as a ruleset bypass actor.
- **Moving or renaming a page** needs a redirect on the site (a `redirects:` entry in `.gitbook.yaml` if the sync script keeps those files, otherwise in the wiki repo), so published links keep working.
- **Links.** Between guide and technical pages, use relative links (both folders are copied together). Links to the specs or to other repository files use absolute GitHub URLs (`https://github.com/4thtech/agentlink/blob/main/...`), because the copy contains only `docs-site/guide` and `docs-site/technical`.
- **Images** go in the folder's `.gitbook/assets/`. Screenshots are dark theme only; the intro GIF is pinned to the release tag.

### One-time setup (owner)

Only the owner does this, in the GitBook and GitHub interfaces. Agents never change GitBook settings.

1. Keep the single 4thTech Docs space Git-synced from `4thtech/wiki.4thtech.io` (domain `wiki.4thtech.io`). No AgentLink-specific space, no Git Sync from `4thtech/agentlink`, no GitBook app access to this repo.
2. Turn off live editing and do not merge change requests in GitBook (see "Never edit in GitBook").
3. Add the release-copy script to the wiki repo (not built yet); run it by hand for two releases, then replace it with a GitHub Action.
4. The AgentLink section uses the AgentLink by 4thTech branding in the docs model §8.

## 3. Page conventions

**How to write a page** (page types and outlines, callouts, diagrams, screenshots, the UI ↔ tech bridge, definition of done) is in the [docs model](../docs/process/docs-model.md). Start a new page from a template in [`_templates/`](_templates/README.md); that folder is outside `guide/` and `technical/`, so the release copy never publishes it.

### Status hints (honesty rule)

Nothing is documented as available until it is released. Every page starts, right after its title, with one status line in a blockquote:

| Hint | Use when |
|---|---|
| `> **Status: Design.** …` | The page explains the specified design (concepts, security model, protocol) and nothing is built yet |
| `> **Status: Planned for vX.Y.Z (Mx).** …` | The feature is not released; the page is an outline |
| `> **Status: Available since vX.Y.Z.**` | The feature is in a release promoted to npm `latest` (or deployed to production, for services) |
| `> **Status: Current.**` | The page describes the project itself (roadmap, versioning, contributing) and is true today |

A feature that is merged but only on `next` or staging is still **Planned**. Mixed pages name each part, for example "Planned for v0.1.0 (M1a); one-click install planned for v0.2.0 (M1)".

### Skeleton pages

A page for an unreleased feature contains only: the title, the status hint, a **Purpose** line, an optional short "What to expect" or design summary that the specs already make true, an **Outline**, and a **Filled in at** line naming the milestone, version and backlog card. No commands, screenshots or package names that could still change.

### Versions

Milestones map to versions per [versioning.md](../docs/process/versioning.md): M1a = 0.1.0, M1 gate = 0.2.0, the usable local app = 0.3.0, M2 = 0.4.0 first (the cloud agent, D-131), M3 = 1.0.0.

## 4. Who updates what, and when

**Who.** A docs worker (Sonnet; S1, because `docs-site/**` is S1) in the "Docs and knowledge" step of the delivery process, working from the milestone's DOCS card in [backlog.md](../docs/process/backlog.md). A feature PR that changes an interface also updates the matching technical reference page in the same PR (Definition of done).

**When.** A milestone or release (patches and M4/M5 included) is done only when the public docs, the README Status and Roadmap, the CHANGELOG, the explainers and the documentation map, runbooks and lessons, and the design status are updated (also an item in the release checklist, `release-and-deployment.md` §5.1) ([development-process.md](../docs/process/development-process.md) §6.3).

| Page | M1a (v0.1.0) | M1b, M1 gate (v0.2.0) | M2 (v0.3.0) | M3 (v1.0.0) |
|---|---|---|---|---|
| Guide: What is AgentLink? ("What works today") | Update | Update | Update | Update |
| Guide: How setup works; Claude Code; Codex; Gemini CLI | Fill in | Update | Desktop app path | Review |
| Guide: Claude Desktop | Fill in (config) | Extension | Desktop app path | Review |
| Guide: ChatGPT; Other AI apps | Generic part | — | Fill in (cloud agent, claude.ai) | Review |
| Guide: Pair with someone; Send your first message | Fill in | — | Accept in the browser | Review |
| Guide: Contacts; Messages; Approvals | Fill in | Passkey approvals | Console, desktop, Registered and Verified domain labels | Review |
| Guide: Files | — | Fill in | Storage connectors | Review |
| Guide: Agreements and proof | Negotiation | Proof, receipts, proof files | Web verify page | Paid proof |
| Guide: Credits | — | Free test credits | — | Real credits, adding, withdrawing |
| Guide: Desktop app; Always-on cloud agent | — | — | Fill in | Review |
| Guide: What leaves your computer | Check against the build | Files and proof | Desktop, console, cloud | Audit outcome |
| Guide: Pricing | — | Test credits | — | Live prices, status "Available" |
| Guide: Credits (who holds what, trust) | — | Free test credits | Top-up paths (exchange, own account) | Real credits, withdraw button, card path, status "Available" |
| Guide: Troubleshooting; FAQ; Glossary | Fill in | Extend | Extend | Extend |
| Technical: Architecture; Protocol pages; Security model; Threat model | Mark what shipped | Mark what shipped | Mark what shipped | Audit summary, frozen formats |
| Technical: MCP tools; Policies; CLI; Harness configuration | Fill in (Talk) | Fill in (files, proof) | Cloud and desktop | Review |
| Technical: SDK packages | Fill in (Talk packages) | Chain, storage | Connectors | Stable API notes |
| Technical: Crypto suites; Test vectors; Run the test vectors | Fill in | Proof-layer suites | — | Review |
| Technical: Proof pack format; Verify a proof; Your first integration | — | Fill in | Web verify page | Mainnet addresses |
| Technical: Contracts | — | Testnet addresses | Registry | Mainnet addresses, audit reports |
| Technical: Payments, credits and trust; Verify it yourself | — | Gasless top-up once enabled, event topics on a new contracts release | Top-up paths | Mainnet addresses, verified source, audit summary, licence |
| Technical: Self-host the cloud agent | — | — | Fill in | Review |
| Technical: Status and roadmap; Versioning | Update | Update | Update | Update |

### Generated status blocks

The Status and roadmap page (`technical/project/status-and-roadmap.md`) is generated from [`docs/status.yaml`](../docs/status.yaml): the blocks between `<!-- status-hint:start -->`, `<!-- status-summary:start -->` and `<!-- status-milestones:start -->` and their `:end` markers. Never edit them by hand. Change `docs/status.yaml`, run `node tools/docs-status/index.mjs` and commit both; `pnpm lint` fails when a block has drifted. The same source feeds the README Status and Roadmap and the knowledge base.

### Per-release docs pass

For every release (milestone or patch):

1. Change the status hints of everything in the release from **Planned** to **Available since vX.Y.Z**; leave everything else as it is.
2. Fill in the skeleton pages listed for the milestone; replace planned names (package, commands, tools) with the released ones.
3. Update "What works today" on the guide's landing page and Versioning (format table); Status and roadmap comes from `docs/status.yaml` (run `node tools/docs-status/index.mjs`).
4. Check every user-facing sentence against the released software, not against the plan.
5. Check the guide's vocabulary against 11 §5, that every page is in its `SUMMARY.md`, and that every relative link resolves (DOCS-LINT automates this).
6. Add redirects for moved pages.
7. Mention the docs changes in the release's CHANGELOG entry.

## 5. Versioned docs (plan)

Until 1.0.0 there is one version of the docs: `main`, describing the latest release and marking everything else planned. From 1.0.0, a frozen copy per supported version is planned, for example a GitBook variant per version synced from a release branch. The mechanism is decided in DOCS-M3, before the mainnet beta.
