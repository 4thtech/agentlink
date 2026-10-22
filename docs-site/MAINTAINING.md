# Maintaining the public docs

How the public documentation in `docs-site/` is organised, published and kept true. Internal documents (specifications, process, runbooks) stay in [`docs/`](../docs/README.md); this folder holds only what the public reads on GitBook.

## 1. Layout

| Folder | GitBook space | Audience | Vocabulary |
|---|---|---|---|
| [`guide/`](guide/README.md) | User guide | People who use AgentLink through their AI app, including non-developers | Strictly the product vocabulary of [11 §5](../docs/foundation/11-claude-design-brief.md): no "wallet", "gas", "seed phrase" or "transaction" (and the rest of the "Never say" list) outside a section titled "Advanced" |
| [`technical/`](technical/README.md) | Technical docs | Agent builders, integrators, reviewers, verifiers, contributors | Technical terms allowed; specs win on any conflict |

Each space folder holds a `.gitbook.yaml` (root and structure), a `README.md` (the space's landing page) and a `SUMMARY.md` (the navigation). Every Markdown file in a space appears in its `SUMMARY.md` exactly once.

Both spaces follow [Diátaxis](https://diataxis.fr), with plain navigation labels instead of the Diátaxis names:

| Diátaxis | User guide | Technical docs |
|---|---|---|
| Tutorials | Get started | Guides → Your first integration |
| How-to guides | Everyday use; Desktop app and cloud agent | Guides |
| Reference | Pricing; Help (troubleshooting, FAQ, glossary) | Reference |
| Explanation | What is AgentLink?; Privacy (What leaves your computer) | Concepts |

## 2. Publishing

The repository is the source of truth (D-57, amends D-29). Each space is connected to `main` with GitBook **Git Sync**, one space per folder, GitHub → GitBook only. A merge to `main` that changes `docs-site/` updates the published docs.

- **Review class.** `docs-site/**` is S1 (`audit-rules.md` §2.2): every change gets an independent review and the orchestrator's audit, then auto-merges when the checks are green. Until `review-gate` derives this itself (owner follow-up), the PR declares S1.
- **Owner-only.** Any change to the publishing setup (Git Sync, domain, site structure, spaces) is made by the owner.
- **Rollback.** Revert the PR on `main`; Git Sync republishes the previous pages.

- **Never edit in GitBook.** Changes go through a pull request like any other change. `main` accepts changes only through pull requests, so a GitBook-side edit could not sync back without bypassing review. Never add the GitBook app as a ruleset bypass actor.
- **Moving or renaming a page** needs a `redirects:` entry in that space's `.gitbook.yaml`, so published links keep working.
- **Links.** Inside a space, use relative links. Links to the other space, to the specs or to other repository files use absolute GitHub URLs (`https://github.com/4thtech/agentlink/blob/main/...`), because GitBook resolves only files inside the space. Once the docs site has its final address, cross-space links switch to site URLs (DOCS-M1a).
- **Images** go in the space's `.gitbook/assets/` folder.

### One-time GitBook setup (owner)

Only the owner does this, in the GitBook and GitHub interfaces. Agents never change GitBook settings.

1. Decide where the docs live (`DECISION NEEDED (owner)`, D-57): a new GitBook site for AgentLink (recommended: own brand, D-42; custom domain after D-38), or new sections in the existing `wiki.4thtech.io` site. Either way, create two spaces: **User guide** and **Technical docs**.
2. Install the GitBook GitHub app on the `4thtech` organisation with access to `4thtech/agentlink` only.
3. In each space: **Git Sync → GitHub**, repository `4thtech/agentlink`, branch `main`, project directory `docs-site/guide` (or `docs-site/technical`), initial sync direction **GitHub → GitBook**. Use space-level Git Sync: site-wide content mapping makes GitBook commit a mapping file to the repository.
4. In each space's settings, turn off live editing, and do not merge change requests in GitBook (see "Never edit in GitBook").
5. Add both spaces to the site (sections "User guide" and "Technical"), check the rendered pages, then publish.
6. Later: connect the custom domain once the production domain is chosen, and record the final URLs on the sync board for the docs worker.

## 3. Page conventions

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

Milestones map to versions per [versioning.md](../docs/process/versioning.md): M1a = 0.1.0, M1 gate = 0.2.0, M2 = 0.3.0, M3 = 1.0.0.

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
| Guide: Credits and payments | — | Free test credits, automatic claim | Top-up paths (exchange, own account) | Real credits, withdraw button, card path, status "Available" |
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
