# Backlog

PR-sized task cards for AgentLink (OCC v2), derived from `docs/foundation/10-build-plan.md` and the specs it references. This file is the **backlog source of truth**: every piece of work has a card here before it starts. GitHub Issues MAY later be generated from it; if they are, this file still wins.

- **Specs win.** A card restates the spec only to make acceptance testable. Where a card and a spec disagree, the spec wins and the mismatch is a spec gap (§8). Cards never resolve spec gaps by themselves; a gap is resolved through the spec-change process (`development-process.md` §8).
- **Public file.** This repository is public. Cards contain no secrets, no Safe signer details and no details of unfixed vulnerabilities. Legacy items are referenced only by `OPS-L<n>` and "see private 09 §4". Docs 01 and 09 are private (D-21, D-26); where a card cites them it says "(private)" and restates what the task needs.
- **Process.** Lifecycle, Definition of Ready/Done, routing and reviews: `development-process.md`. Security classes, reviews, threat notes, milestone audits: `audit-rules.md`. Deploys and releases: `release-and-deployment.md`. CI: `ci-cd.md`. Live coordination: `sync-protocol.md`.
- **No assignees here.** Who works on what, and live status, is on the `sync` branch board (`board.md`). This file never names an assignee.

Contents: §1 How to read a card · §2 M0 Foundations (incl. legacy OPS-L items and the D-25 continuous-delivery group) · §3 M1 Local beta on testnets (phases M1a and M1b; incl. owner design drops D1–D3) · §4 M2 Owner console, desktop apps, self-host, design · §5 M3 Mainnet beta · §6 M4/M5 epics · §7 Dependency overview · §8 Spec gaps and inconsistencies · §9 Owner actions

---

## 1. How to read a card

```
#### M1-5a · transport-nostr: gift wrap / unwrap
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2 · **Phase:** M1a
- **Repo/path:** agentlink · packages/transport-nostr
- **Depends on:** M1-1g, M1-2a
- **Spec:** 04 §3.5; 07 §4.2
- **Invariants:** I-1, I-2, I-5
- **Scope:** what is in (and, where useful, what is explicitly out)
- **Acceptance:** testable criteria; each maps to a test, vector, command output or demo in the PR
```

| Field | Meaning |
|---|---|
| **ID** | `M<milestone>-<build-plan task><letter>`. A build-plan task split into PR-sized parts gets letter suffixes (`M1-1a`, `M1-1b`, …). Tasks not in the build plan take the next free number in their milestone and are marked **(new)**. Legacy security items are `OPS-L1`…`OPS-L9` (private 09 §4 L-1…L-9). Milestone gates are `M1-GATE`, `M2-GATE`, `M3-GATE`. Owner design drops are `DESIGN-D1`…`DESIGN-D3` (D-30). M4 and M5 are single epic cards (`M4-EPIC`, `M5-EPIC`), decomposed when they start. |
| **Status** | See the legend below. |
| **Size** | **S** ≤ 2 days · **M** 3–5 days · **L** 6–8 days of focused agent + human work. Anything larger is split. The changed-lines limits in `development-process.md` §7.4 also apply. |
| **Tier** | Worker model routing (`development-process.md` §3): **Haiku** (mechanical, read-only, no design choices, never S1/S2) · **Sonnet** (clear-spec implementation, tests, CI, UI, docs, non-security review) · **Opus** (S2 work, architecture, protocol, contracts, signing, deploy scripts, audits). **Owner** marks a card that only the human owner can execute (accounts, settings, keys, legal, money); an agent may prepare material for it. |
| **Security** | **S0** none · **S1** sensitive · **S2** critical (`audit-rules.md` §2). The highest applicable class wins; only the owner may lower it. S1/S2 need an independent review session; S2 also needs @denisjazbec's review, tests-first evidence, a full threat note and an external-audit scope-register entry (`audit-rules.md` §3). |
| **Phase** | M1 cards only: `M1a` (walking skeleton: pair and talk) or `M1b` (files, proof, credits), D-33. Appended to the Status line; see §3. |
| **Repo/path** | `agentlink` = public `4thtech/agentlink`; `occ-v2-contracts` = private contracts repo (D-19); `agentlink-ops` = private ops/internal-docs repo (D-26). |
| **Depends on** | Cards that must be `done` (or stubbed behind an agreed interface, `development-process.md` §6.2) before this one is `ready`. |
| **Spec** | `04 §3.5` = `docs/foundation/04-security-and-crypto.md` section 3.5. `10 M1-5` = the build-plan row. `D-xx` = decision log in `00-README.md`. |
| **Invariants** | I-1…I-10 from 04 §1 that the task touches; the PR states how each holds. |

### Status legend

| Status | Meaning |
|---|---|
| `backlog` | Card exists; not yet ready |
| `ready` | Definition of Ready met (`development-process.md` §6.2) |
| `in-progress` | Claimed on `board.md` and as a draft PR; worktree and branch exist |
| `in-review` | PR open and ready for review; CI running |
| `audit` | S1/S2: independent review and human approvals in progress, or findings being closed |
| `done` | Definition of Done met; owner merged |
| `done (setup)` | Produced in the 12 Oct 2026 setup session; becomes `done` when the bootstrap commit is on `main` (M0-2b) |

In this file a card's Status changes in only two places: `backlog → ready` (orchestrator, planning PR or the task's own first commit) and `→ done` **in the PR that completes the task**. `in-progress`, `in-review` and `audit` are tracked live on the sync board, not here.

### Deploy acceptance (applies to every card that deploys an app)

Every deploy card (submitter, faucet, console, verify, invite, pay, onboarding/landing, marketing site, cloud-agent template) carries the block below, stated explicitly in its Acceptance:

- **Deploy (D-25: continuous delivery, `release-and-deployment.md` §1, §3–§5, §8):** merge to `main` → CI deploys automatically to staging (`workers.dev` preview, testnets, npm `next`); smoke test; production (npm `latest`, production Workers and sites) waits for one approval click by the owner (`talirezun`, required reviewer of the `production` and `npm-publish` environments); post-deploy health check; automatic rollback on a failed check; deploy record (§5.2); nothing runs while `DEPLOY_FREEZE` is set (M0-19).

Never automated: mainnet contract deploys, contract upgrades and configuration (hardware key, Safe, timelocks), production secrets, rulesets, CODEOWNERS and environments.

### Card count

| Section | Cards |
|---|---|
| M0 Foundations | 27 (incl. 5 in the D-25 group; 9 `done (setup)`) |
| Legacy OPS-L | 9 |
| Design drops (owner, D-30) | 3 |
| M1 Local beta | 80 (M1a 38, M1b 42; incl. 11 split-off and 7 new cards from D-31…D-41) |
| M2 Console, desktop apps, self-host, design | 35 (incl. 10 new cards from D-34…D-36, D-41) |
| M3 Mainnet beta | 20 (incl. 2 new cards from D-45…D-47) |
| M4, M5 | 2 epics |

---

## 2. M0 — Foundations

Goal (10 M0): accounts, repositories and CI hardened; docs in place; decisions D-11 and D-14 taken (D-12 decided: MIT); legacy immediate actions closed. Much of the CI and agent-instruction layer was drafted in the setup session (`done (setup)`); it lands with the bootstrap commit.

#### M0-1 · Legacy immediate actions (L-1, L-5, L-8): written confirmations
- **Status:** backlog · **Size:** S · **Tier:** Owner (Opus prepares) · **Security:** S1
- **Repo/path:** agentlink-ops · docs/internal (confirmations); legacy repos per OPS card
- **Depends on:** OPS-L1, OPS-L5, OPS-L8
- **Spec:** 10 M0-1; 09 §4 L-1, L-5, L-8 (private)
- **Invariants:** — (legacy OCC v1 / PollinationX; protects existing users)
- **Scope:**
  - Umbrella for the three "immediate" legacy items; no AgentLink code.
  - Collects one written confirmation per item and records it privately.
- **Acceptance:**
  - A dated, owner-signed confirmation for each of OPS-L1, OPS-L5, OPS-L8 exists in `agentlink-ops`.
  - The public repo and sync files reference the items by ID only.
  - M0 is not closed while any of the three is open.

#### M0-2a · GitHub organisation hardening
- **Status:** ready · **Size:** S · **Tier:** Owner · **Security:** S1
- **Repo/path:** GitHub org `4thtech` (settings)
- **Depends on:** —
- **Spec:** 10 M0-2; 04 §7 (supply chain); `ci-cd.md` §7; `release-and-deployment.md` §9
- **Invariants:** —
- **Scope:**
  - Require 2FA for all members; base repository permission **Read**; only owners may change visibility, delete or transfer repositories.
  - Disable forking of private repositories (protects `occ-v2-contracts` and `agentlink-ops`).
  - Write access to private repos limited to the owner and named engineers (compensating control for the Free plan, D-27).
- **Acceptance:**
  - `gh api orgs/4thtech` output (saved in the PR or sync file) shows `two_factor_requirement_enabled: true`, `default_repository_permission: read`, `members_can_fork_private_repositories: false`.
  - Collaborator lists of the private repos match the named people.

#### M0-2b · Bootstrap push, repository settings and rulesets
- **Status:** ready · **Size:** S · **Tier:** Owner · **Security:** S1
- **Repo/path:** agentlink · GitHub settings
- **Depends on:** M0-2a, M0-3
- **Spec:** 10 M0-2; `ci-cd.md` "Owner setup checklist" §0–§3, §6
- **Invariants:** —
- **Scope:**
  - Push the setup-session files as the initial commit; open the `CHORE: bootstrap CI` PR so `ci-gate`, `security-gate`, `pr-hygiene` and `review-gate` report once.
  - Repository settings: squash-only merging, private vulnerability reporting, Dependabot alerts, secret scanning + push protection, labels; no CodeQL default setup.
  - Rulesets: `main` (no bypass, block force-push/deletion, linear history, PR required, required checks `ci-gate`, `security-gate`, `pr-hygiene`, `review-gate`, approvals 0), tags (restrict update/delete), `sync` (block force-push/deletion).
  - Actions settings: allowlisted actions only, SHA pinning required, read-only `GITHUB_TOKEN`, approval for external fork workflows. Install the Renovate app.
  - Out: the auto-merge setting and Code Owners review (M0-17) and the GitHub Environments (M0-18).
- **Acceptance:**
  - A direct push to `main`, a force-push and a branch deletion are rejected (demonstrated).
  - The bootstrap PR merged through the ruleset with all four checks green.
  - Push protection blocks a provider-pattern dummy token on a scratch branch (demonstrated, then deleted).
  - Every `done (setup)` card in this file is switched to `done` in the bootstrap PR or the next one.

#### M0-2c · CI workflows, PR hygiene, Renovate, SECURITY.md, CODEOWNERS
- **Status:** done (setup) · **Size:** M · **Tier:** Sonnet · **Security:** S1
- **Repo/path:** agentlink · .github/, renovate.json, SECURITY.md
- **Depends on:** —
- **Spec:** 10 M0-2; 04 §7, §8.2; `ci-cd.md`
- **Invariants:** I-7 (gitleaks backstop)
- **Scope:**
  - `ci.yml` (`ci-gate`), `security.yml` (`security-gate`: dependency review, gitleaks via `secret-scan.yml`, CodeQL, zizmor), `pr-hygiene.yml`, `release.yml` (inactive until the skeleton exists), shared setup action, SHA-pinned actions.
  - `renovate.json` with cooldowns and the `security-sensitive` crypto group; `SECURITY.md`; `CODEOWNERS` routing S1/S2 paths to @talirezun and @denisjazbec.
- **Acceptance:**
  - First runs after M0-2b are green, or every zizmor/CodeQL finding is triaged in a follow-up `CHORE` PR.
  - The items under "Not verified when this was written" in `ci-cd.md` are each checked off or turned into a follow-up card.

#### M0-2d · Monorepo skeleton and CI strict mode
- **Status:** backlog · **Size:** M · **Tier:** Sonnet · **Security:** S1
- **Repo/path:** agentlink · / (root), packages/*, apps/*, test-vectors/, e2e/, skills/
- **Depends on:** M0-2b
- **Spec:** 03 §6; 07 §1; `AGENTS.md` (Stack, Repository layout, Commands); `ci-cd.md` "Contract with the monorepo skeleton"
- **Invariants:** —
- **Scope:**
  - pnpm workspace (`packageManager` pinned, pnpm `minimumReleaseAge`), Turborepo tasks `build`, `test`, `lint`, `typecheck`, `vectors:check`, `test:e2e`; strict ESM `tsconfig.base.json` with project references.
  - Stub package per directory in the `AGENTS.md` layout, each building to ESM + `.d.ts`; ESLint flat config + Prettier; Vitest workspace; Changesets initialised (`publishConfig.access`, `repository` fields).
  - Install scripts: none in our packages; dependency builds only via an explicit allowlist (`onlyBuiltDependencies`; CI keeps `--ignore-scripts`).
  - LICENSE: MIT (D-12); every `package.json` has `"license": "MIT"`, enforced by a check script. Commit `.github/ci-strict` in the same PR.
- **Acceptance:**
  - `pnpm install && pnpm build && pnpm lint && pnpm typecheck && pnpm test` pass on a clean clone and in CI with strict mode on.
  - A smoke test imports every shared package in Node.
  - A check script fails if any workspace `package.json` declares `preinstall`, `install` or `postinstall`.
  - Deleting the root `test` script makes CI fail (strict mode demonstrated).

#### M0-2e · npm organisations and trusted publishing
- **Status:** ready · **Size:** S · **Tier:** Owner (Sonnet prepares) · **Security:** S1
- **Repo/path:** npm orgs `agentlink`, `4thtech` · agentlink · .github/workflows/release.yml
- **Depends on:** M0-2a
- **Spec:** 04 §7 (npm provenance, 2FA); 06 header (`@4thtech/agentlink`); 07 §1; `ci-cd.md` §4–§5
- **Invariants:** —
- **Scope:**
  - npm org `agentlink`: 2FA required for all members. Check and, if free, claim the `@4thtech` scope for `@4thtech/agentlink`; if unavailable, raise it as a naming item under M0-4.
  - GitHub Environment `npm-publish` (D-25: required reviewer `talirezun`, "Prevent self-review" off; deployment branches `main` and Changesets tags only; no secrets); created with the other environments in M0-18.
  - Trusted publishing (OIDC) per package once it exists; packages set to "require 2FA and disallow tokens"; no `NPM_TOKEN` anywhere. Confirm whether a trusted publisher can be configured before the first publish; if not, bootstrap the first version manually with 2FA.
- **Acceptance:**
  - npm org settings show 2FA required; `@4thtech` scope status recorded (owned / not available).
  - `gh secret list` (repo and org) shows no npm token.

#### M0-2f · occ-v2-contracts private repository bootstrap
- **Status:** backlog · **Size:** S · **Tier:** Sonnet · **Security:** S1
- **Repo/path:** occ-v2-contracts · / (fresh `forge init`)
- **Depends on:** M0-2a
- **Spec:** 05 header (toolchain), §8; 03 §6; D-19, D-20, D-27; `development-process.md` §9; `audit-rules.md` §2.3, §6.1
- **Invariants:** —
- **Scope:**
  - Owner creates the private repo; a fresh `forge init` with no history from OCC v1 (D-20: v1 is reference only, never copied). Layout `src/`, `test/{unit,fuzz,invariant}`, `script/`, `audits/`; `PROVENANCE.md` stating the clean-room rule.
  - Exact `solc` 0.8.2x pin; `evm_version` per chain profile (values from M1-14); OpenZeppelin Contracts v5 (+ upgradeable) at pinned commits; Solady only where gas matters.
  - Import the prepared Foundry CI template: fmt, build with sizes, unit/fuzz/invariant tests with a CI fuzz profile, gas snapshot check, Slither, Aderyn, deployer-holds-no-role placeholder, `contracts-gate` aggregator, gitleaks; parity job against a pinned commit of the public `test-vectors/`.
  - **Free plan (D-27):** no rulesets, no environment protection, no GitHub secret scanning in this repo. Therefore: testnet deploy keys only, low balances; deploy workflow triggered manually by the owner; mainnet secrets never on GitHub; owner verifies `contracts-gate` before every merge.
  - LICENSE: all rights reserved during beta; BUSL-1.1 applied at M3-6 (D-11).
- **Acceptance:**
  - `contracts-gate` green on the skeleton, including Slither and Aderyn jobs.
  - `git log` contains no commit from OCC v1 history; `PROVENANCE.md` present.
  - Repo README lists the Free-plan compensating controls above.

#### M0-2g · Cloudflare setup for beta hostnames (new)
- **Status:** ready · **Size:** S · **Tier:** Owner (Sonnet prepares and verifies) · **Security:** S1
- **Repo/path:** Cloudflare (zone `4thtech.io`) · GitHub Environments of `agentlink`
- **Depends on:** M0-2b
- **Spec:** D-09, D-28; 08 §2.3 (separate origins), §6; `release-and-deployment.md` §1, §4.5–§4.6
- **Invariants:** I-3
- **Scope:**
  - CI API tokens scoped per environment and per Worker (least privilege), stored only as GitHub Environment secrets; Cloudflare account 2FA.
  - DNS / Workers Custom Domains for `agentlink.4thtech.io` (landing + invite at the apex) and `console.`, `verify.`, `invite.`, `pay.`, `submit.agentlink.4thtech.io`; staging on `workers.dev` previews.
  - Verify TLS certificate issuance for these second-level subdomains with Workers Custom Domains (Universal SSL covers only first-level names; confirm what Custom Domains issue, otherwise plan an advanced certificate).
  - Separate R2 bucket and bucket-scoped token used only by storage integration tests (M1-6a).
  - **DECISION NEEDED (owner):** move from the personal Cloudflare account to a 4thTech organisation account with @denisjazbec as a member, before any production deploy.
- **Acceptance:**
  - `curl -sI` against a hello-world Worker on each hostname returns a valid certificate chain and 200 (output in PR).
  - Token scopes listed (names and permissions only, never values); the R2 test token cannot list or write any other bucket (demonstrated).
  - Account decision recorded in the decision log.

#### M0-3 · Foundation and process docs in the repository
- **Status:** done (setup) · **Size:** S · **Tier:** Sonnet · **Security:** S1
- **Repo/path:** agentlink · docs/foundation, docs/process, AGENTS.md, CLAUDE.md
- **Depends on:** —
- **Spec:** 10 M0-3; 00 (reading order); D-21
- **Invariants:** —
- **Scope:**
  - Foundation pack (without 01 and 09), process docs, `AGENTS.md` and `CLAUDE.md` committed in the bootstrap commit; `.gitignore` guard keeps 01 and 09 out until M0-6 is done.
- **Acceptance:**
  - `git ls-files docs/foundation` lists no `01-*` or `09-*`; the bootstrap commit's history never contained them (`git log --all -- docs/foundation/01-* docs/foundation/09-*` empty).
  - Markdown link check over `docs/` passes, with links to 01/09 marked private.

#### M0-4 · Decide D-11 and D-14 (contract licence parameters, product name); record D-12
- **Status:** ready · **Size:** S · **Tier:** Owner (Sonnet prepares decision memos) · **Security:** S0
- **Repo/path:** agentlink · docs/foundation/00-README.md (decision log, owner PR)
- **Depends on:** M0-5 (input to D-11)
- **Spec:** 10 M0-4; 00 D-11, D-12, D-14, D-15; 05 §10
- **Invariants:** —
- **Scope:**
  - D-12 is decided by the owner: the open-source repositories use the **MIT** licence; contracts stay BUSL-1.1 at mainnet (D-11). Record it in the decision log if not yet there; LICENSE text for M0-2d.
  - D-11: BUSL-1.1 parameters (Licensor = the D-15 entity, Additional Use Grant, Change Date, Change License) put to counsel; stays "Proposed" until counsel confirms, but the beta plan (private repo) is unaffected.
  - D-14: name availability (trademark search, npm, the production domain). Production domain TBD (owner chooses and registers); the domain decision itself is M2-10.
- **Acceptance:**
  - Decision log rows D-11, D-12 (MIT), D-14 carry status and date in an owner-merged PR.
  - `LICENSE` in `agentlink` is MIT and every `package.json` has `"license": "MIT"` (checked by a CI script added in M0-2d).

#### M0-5 · Clean-room approach recorded; counsel brief for D-11/D-15 (new)
- **Status:** done (setup) · **Size:** S · **Tier:** Owner · **Security:** S0
- **Repo/path:** agentlink · docs/foundation/00-README.md (D-20)
- **Depends on:** —
- **Spec:** D-20, D-11, D-15; 05 header ("new codebase"); 09 §3 (private)
- **Invariants:** —
- **Scope:**
  - D-20 records that OCC v2 and the client packages are re-implemented from the specs; OCC v1 code (EUPL-1.2 + non-commercial rider) and the v1 SDK are reference only and never copied. Relicensing v1 is therefore not on any critical path.
  - Remaining: when counsel is engaged for D-11/D-15 (M3-7), include the clean-room record and the v1 licence facts in the brief.
- **Acceptance:**
  - D-20 present in the decision log (done).
  - Worker briefs for M1-1, M1-3, M1-4 and M1-6 state "no v1 code" (checked at those cards' review).

#### M0-6 · Move docs 01 and 09 into agentlink-ops and grant access (new)
- **Status:** ready · **Size:** S · **Tier:** Owner · **Security:** S1
- **Repo/path:** agentlink-ops · docs/internal/
- **Depends on:** —
- **Spec:** D-21, D-26; `development-process.md` §12
- **Invariants:** —
- **Scope:**
  - Place `01-commercial-brief.md` and `09-repositories-and-reuse.md` under `agentlink-ops/docs/internal/`; grant @denisjazbec access.
  - Keep the `.gitignore` guard in the public repo permanently.
  - 09 §4 may be published only after OPS-L1 and OPS-L5 are resolved (D-21); that publication is a separate owner PR.
- **Acceptance:**
  - Both files present in `agentlink-ops` (owner confirms); @denisjazbec can read them.
  - Public repo full-history scan finds neither file nor their distinctive section headings.

#### M0-7 · Public home for the repository map formerly in 09 §5 (new)
- **Status:** backlog · **Size:** S · **Tier:** Sonnet · **Security:** S1
- **Repo/path:** agentlink · docs/foundation/03-architecture.md (spec-change PR), AGENTS.md
- **Depends on:** M0-6
- **Spec:** 09 §5, §5.1, §5.2 (private); 03 §2; 07 §1; D-19, D-26; `development-process.md` §8
- **Invariants:** —
- **Scope:**
  - The public repo must not depend on 09 being public. The monorepo layout already lives in `AGENTS.md`. Add to 03 (spec-change PR) a short "Repositories" section: `agentlink` (public), `occ-v2-contracts` (private, layout `src/`, `test/`, `script/`, `audits/`), `agentlink-ops` (private), `agentlink-cloud-agent` (public template), and the `@agentlink/occ-v2-abi` + shared `test-vectors/` boundary.
  - Replace public references that send readers to 09 for something they need (00 reading order, 03, 07, 08) with "(private)" plus the restated fact.
- **Acceptance:**
  - `grep -rn "09-repositories\|09 §" docs/ AGENTS.md` shows only references marked private, none required to complete a public task.

#### M0-8 · Shared redacting logger and secret-canary CI test (new)
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S1
- **Repo/path:** agentlink · packages/log (proposed name, gap G-11)
- **Depends on:** M0-2d
- **Spec:** 04 §1 I-7, §8.4; 07 §7 (submitter logging); `audit-rules.md` §6
- **Invariants:** I-7
- **Scope:**
  - Zero-dependency structured logger for Node, browsers and Workers; debug level still redacts.
  - Redaction by key name (seed, secret, privateKey, fileKey, cek, salt, url, presigned, payload, plaintext, body, authorization, token, code) and by value pattern (64-hex scalars, bech32 `nsec`/`ncryptsec`, SigV4 `X-Amz-Signature`/`X-Amz-Credential`, `Authorization: AWS4-HMAC-SHA256`, local-UI `?t=` tokens, recovery-code shape, JWTs); URLs logged without query strings; `Error` messages and stacks scrubbed.
  - ESLint `no-console` repo-wide (documented exception: the CLI's user-output channel).
  - Canary test helper: injects known canary secrets through public APIs and fails if any captured log line (all levels) contains one. Every later package adds its canaries.
- **Acceptance:**
  - Unit test per redaction rule, including nested objects, arrays, errors and URLs.
  - A deliberately leaking fixture makes the canary job fail in CI (red run linked in PR).

#### M0-9 · Cross-runtime test-vector harness (new)
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2
- **Repo/path:** agentlink · test-vectors/, tools/vectors/
- **Depends on:** M0-2d
- **Spec:** 04 §8.2; 07 header (Node, browsers, Workers); 10 M1-1; `development-process.md` §9.1 (canonical vectors are public)
- **Invariants:** I-8
- **Scope:**
  - Vector file format: JSON with `{suite, version, generator: {tool, version}, cases[]}`, schema-validated; one directory per suite (hkdf-derive, hpke, jcs, aead-envelope, stream, bip340, nip44, eip712, pairing, safety-code, owner-wrap).
  - Runner executes the same suite modules in Node (Vitest), browsers (Playwright: Chromium, Firefox, WebKit) and Workers (Miniflare/workerd); `pnpm vectors:check` runs all three.
  - Rule enforced by CI: vectors are produced by an independent generator and committed; tests never regenerate them.
  - Placeholder suite (SHA-256 from published test values) proves the harness.
- **Acceptance:**
  - `pnpm vectors:check` green in all three runtimes; a mutated vector fails in all three.
  - Each runtime reports its identity, so a silent fallback to Node fails the run.

#### M0-10 · Architecture boundary guards (new)
- **Status:** backlog · **Size:** S · **Tier:** Sonnet · **Security:** S1
- **Repo/path:** agentlink · eslint config, tools/deps-check/
- **Depends on:** M0-2d
- **Spec:** 04 §8.1; 07 header; `AGENTS.md` Hard rules; `development-process.md` §11
- **Invariants:** I-8
- **Scope:**
  - Only `packages/crypto` imports `@noble/*`, `@hpke/core` or uses `crypto.subtle`; `nostr-tools` only in crypto and transport-nostr; `viem` only in crypto, chain and the `pay.` deposit page; `aws4fetch` only in storage.
  - No `node:*` / Node built-ins in types, crypto, chain, transport-nostr, storage, core, ui.
  - Per-package runtime-dependency allowlist; a new entry needs a justification line that reviewers see in the diff.
- **Acceptance:**
  - Each rule has a failing fixture test; the guard job is part of `ci-gate`.

#### M0-11 · Curator project context (new)
- **Status:** done (setup) · **Size:** S · **Tier:** Owner · **Security:** S0
- **Repo/path:** owner's Curator (project `agentlink`, domain `projects`); agentlink · .curator-project
- **Depends on:** —
- **Spec:** `AGENTS.md` (Session start and end); `development-process.md` §13
- **Invariants:** —
- **Scope:**
  - Curator project with standing brief; orchestrator-only writes; no secrets, no unfixed-vulnerability details, nothing from 01/09 in anything that is mirrored publicly.
- **Acceptance:**
  - A fresh orchestrator session retrieves the project context at start (owner confirms).

#### M0-12 · Sync layer: `sync` branch, ruleset, secret scan, collaborator onboarding (new)
- **Status:** ready · **Size:** S · **Tier:** Owner · **Security:** S1
- **Repo/path:** agentlink · `sync` branch (orphan)
- **Depends on:** M0-2b
- **Spec:** D-24; `sync-protocol.md`; `ci-cd.md` "The sync branch"; `onboarding.md`
- **Invariants:** I-7
- **Scope:**
  - Create the orphan `sync` branch with `board.md`, `talirezun.md`, `denisjazbec.md` from the `sync-protocol.md` templates.
  - Ruleset on `sync`: block force-push and deletion only.
  - Add the secret-scan stub workflow pinned to a full `main` SHA; confirm the weekly backstop scan in `security.yml` covers `sync`.
  - Onboard @denisjazbec and his agents: they read `AGENTS.md`, `onboarding.md` Part A/B and `sync-protocol.md`.
- **Acceptance:**
  - A throwaway push to `sync` triggers the gitleaks stub and it passes; a dummy secret on a scratch push is caught (then removed).
  - Force-push to `sync` rejected.
  - Denis's agent completes a session start (pull, read board and files) and pushes its own file.

#### M0-13 · AGENTS.md as canonical, harness-agnostic entry file (new)
- **Status:** done (setup) · **Size:** S · **Tier:** Sonnet · **Security:** S1
- **Repo/path:** agentlink · AGENTS.md, CLAUDE.md, .claude/settings.json
- **Depends on:** —
- **Spec:** D-22, D-24; `development-process.md` §2
- **Invariants:** I-1, I-4, I-5, I-7 (restated as agent rules)
- **Scope:**
  - All shared agent instructions in `AGENTS.md`; `CLAUDE.md` imports it and holds Claude-Code-only notes.
- **Acceptance:**
  - Claude Code, Codex and Gemini CLI each load the rules (owner spot check per harness).

#### M0-14 · Name human reviewers; CODEOWNERS routing (new)
- **Status:** done (setup) · **Size:** S · **Tier:** Owner · **Security:** S1
- **Repo/path:** agentlink · .github/CODEOWNERS
- **Depends on:** —
- **Spec:** D-23, D-24; `audit-rules.md` §3
- **Invariants:** —
- **Scope:**
  - @denisjazbec named as reviewer (required on S2); CODEOWNERS requests him on S1/S2 paths. More reviewers are added later if needed (owner PR).
  - Open: the waiver path when he is unavailable (`audit-rules.md` §3, DECISION NEEDED, see §9).
- **Acceptance:**
  - A PR touching `packages/crypto/` auto-requests @denisjazbec (verified on the first such PR).

#### M0-15 · PR-hygiene ID patterns for OPS and gate tasks (new)
- **Status:** done (setup) · **Size:** S · **Tier:** Sonnet · **Security:** S1
- **Repo/path:** agentlink · .github/workflows/pr-hygiene.yml
- **Depends on:** M0-2b
- **Spec:** `development-process.md` §7; this file §1 (ID scheme)
- **Invariants:** —
- **Scope:**
  - The title pattern accepts `M<n>-<n>[a-z]`, `OPS-<n>`, `DOCS`, `CHORE`, `DEPS` today; extend it to `OPS-L<n>`, `M<n>-GATE` and `DESIGN-D<n>` (gap G-37).
  - Align the branch-name example in `AGENTS.md` (lowercase) with `development-process.md` §7.1.
- **Acceptance:**
  - Unit test of the title regex: `OPS-L2 …`, `M1-GATE …`, `DESIGN-D1 …`, `M1-5a …` pass; `M1 …`, `OPS-X …` fail.

#### M0-21 · Public README: overview, status and roadmap (new)
- **Status:** done (setup) · **Size:** S · **Tier:** Sonnet · **Security:** S1
- **Repo/path:** agentlink · README.md
- **Depends on:** —
- **Spec:** 00 (summary, principles); 01 positioning rules (private; restated: lead with what works, never claim unimplemented features); D-29
- **Invariants:** —
- **Scope:**
  - We build in public: `README.md` is the public overview and always reflects the latest state (Status and roadmap sections).
  - Kept current by the gate cards (M1-GATE, M2-GATE, M3-GATE) and release cards (M1-16, M3-6, M3-10, M3-11), each of which carries "update the README Status and roadmap; never claim unimplemented features".
- **Acceptance:**
  - README present at the bootstrap commit; every feature it lists as available has a merged card.

### Continuous delivery (D-25, adopted)

D-25 is decided (decision log, 12 Oct 2026): agents merge only through GitHub auto-merge once `ci-gate`, `security-gate`, `pr-hygiene` and `review-gate` are green (plus a non-author code-owner approval where CODEOWNERS applies); a merge to `main` deploys automatically to staging; production (npm `latest`, production Workers and sites) waits for one approval click by the owner (`talirezun`, required reviewer on the `production` and `npm-publish` environments). Mainnet contract deploys, contract upgrades, Safe operations and production secrets stay manual and owner-only. Normative: `release-and-deployment.md` §1, §3; implementation and owner checklist: `ci-cd.md`. The `review-gate` workflow exists (`done (setup)`); the cards in which the owner applies the ruleset, the environments and the `DEPLOY_FREEZE` variable stay `backlog` (owner actions). M0-20 is a separate, still open decision. See gap G-38.

#### M0-16 · `review-gate` check (new)
- **Status:** done (setup) — the workflow exists; making it a required check is M0-17 · **Size:** S · **Tier:** Sonnet · **Security:** S1
- **Repo/path:** agentlink · .github/workflows/review-gate.yml
- **Depends on:** M0-2b
- **Spec:** D-25; `audit-rules.md` §2–§4; `ci-cd.md` §2 (Review gate)
- **Invariants:** I-4 (process analogue: no self-approval)
- **Scope:**
  - Derives the security class from changed paths (mirrors `audit-rules.md` §2.2; highest wins) and requires the PR body to declare at least that class.
  - S1/S2: an independent-review report ID (`IR-…`) without a FAIL verdict. S2: an approval on the head commit by @talirezun or @denisjazbec who is not the author, plus threat-note and tests-first sections.
  - Fails while `DEPLOY_FREEZE` is `true`; narrow bot exemptions (Renovate, Changesets version PR); reads PR text only through the API, no secrets, no checkout.
- **Acceptance:**
  - Fixture PRs on the first real runs: S2 without non-author approval → red; with it → green; declared class lower than derived → red; S0 docs PR with its box ticked → green.
  - The path table in the workflow matches `audit-rules.md` §2.2 (diff checked at each milestone gate).

#### M0-17 · `main` ruleset with auto-merge (new)
- **Status:** backlog · **Size:** S · **Tier:** Owner · **Security:** S1
- **Repo/path:** agentlink · GitHub ruleset `main`, repository settings
- **Depends on:** M0-16
- **Spec:** D-25; `ci-cd.md` §1–§2 (owner setup checklist), §0 step 4; `release-and-deployment.md` §3 rule 3
- **Invariants:** —
- **Scope:**
  - "Allow auto-merge" on (agents enable it per PR with `gh pr merge --auto --squash`; they never approve and never bypass).
  - `main` ruleset: required checks `ci-gate`, `security-gate`, `pr-hygiene`, `review-gate`; required approvals 0 with "Require review from Code Owners" on (S2, CI and agent-rule paths need a non-author code-owner approval); dismiss stale approvals; empty bypass list.
- **Acceptance:**
  - An S2 fixture PR cannot auto-merge without a non-author code-owner approval; an S0 PR auto-merges once checks are green.

#### M0-18 · GitHub Environments: `production` and `npm-publish` gated by the owner, staging open (new)
- **Status:** backlog · **Size:** S · **Tier:** Owner · **Security:** S1
- **Repo/path:** agentlink · GitHub Environments
- **Depends on:** M0-17
- **Spec:** D-25; `release-and-deployment.md` §1, §3 rule 1; `ci-cd.md` §4
- **Invariants:** I-3
- **Scope:**
  - `production` and `npm-publish`: required reviewer `talirezun`; "Prevent self-review" **off** (merges, and so the runs waiting for approval, happen under the owner's account); deployment branches limited to `main` and release tags (`npm-publish`: Changesets tags `*@*`); `npm-publish` holds no secrets, `production` holds the production Cloudflare token only.
  - `staging` and `npm-next` (npm `next` prereleases): no reviewer, deployment branch `main` only; `staging` holds the staging Cloudflare token only. `deploy-freeze`: no reviewer, `main` only, secret `DEPLOY_FREEZE_TOKEN` (M0-19).
  - Secrets scoped per environment; testnet and production keys never shared.
- **Acceptance:**
  - A workflow run from a non-`main` ref cannot access any of these environments (demonstrated).
  - A `production` or `npm-publish` job waits for `talirezun`'s approval click; a `staging` or `npm-next` job runs without waiting.

#### M0-19 · `DEPLOY_FREEZE` repository variable (new)
- **Status:** backlog · **Size:** S · **Tier:** Owner (Sonnet prepares the workflow checks) · **Security:** S1
- **Repo/path:** agentlink · repository variable; .github/workflows (all deploy and publish jobs)
- **Depends on:** M0-2b
- **Spec:** D-25; `release-and-deployment.md` §3 rule 6, §3.1; `ci-cd.md` §8
- **Invariants:** —
- **Scope:**
  - Repository variable `DEPLOY_FREEZE` (repository level only, never an environment variable) created by the owner; every deploy/publish job checks `vars.DEPLOY_FREEZE != 'true'` first and again after any approval wait; rollback jobs still run.
  - Agents may set it (stop-the-line) and then disable auto-merge on open PRs; CI sets it after a failed production health check through the `freeze` job (credential `DEPLOY_FREEZE_TOKEN` in environment `deploy-freeze`, created by the owner); only the owner clears it (documented; enforced by process).
- **Acceptance:**
  - With the variable set, release and deploy workflows exit before any build or credential use (fixture run); `review-gate` is red.

#### M0-20 · Machine-run independent AI review in CI (new, DECISION NEEDED)
- **Status:** backlog · **Size:** M · **Tier:** Owner decides; Opus designs · **Security:** S1
- **Repo/path:** agentlink · .github/workflows/ai-review.yml (if adopted)
- **Depends on:** owner decision
- **Spec:** `audit-rules.md` §4 (independent review inputs and output); D-23
- **Invariants:** I-7 (no secrets to the reviewer), I-5 (PR content is untrusted input to the reviewer)
- **Scope:**
  - Decide whether the independent review session runs as a CI job using an `ANTHROPIC_API_KEY` secret. Constraints if adopted: never on fork PRs; key in an environment limited to `main`-based PRs from the owner's account; reviewer receives only the `audit-rules.md` §4.1 inputs; output is advisory and posted as a PR comment; prompt-injection exposure from PR content documented.
- **Acceptance:**
  - Decision recorded (D-xx). If adopted: a fork PR cannot reach the secret (demonstrated); review output format matches `audit-rules.md` §4.3.

### Legacy security (OPS-L)

Legacy OCC v1 / PollinationX items from private 09 §4. Details of unresolved items stay private (D-21, `development-process.md` §12); cards describe actions only. Evidence goes to `agentlink-ops`, never to this repo or the sync branch.

#### OPS-L1 · Encryptor extension: resolve L-1
- **Status:** ready · **Size:** S · **Tier:** Owner (Opus prepares) · **Security:** S2
- **Repo/path:** legacy `encryptor-extension`; Chrome Web Store listing
- **Depends on:** —
- **Spec:** see private 09 §4 L-1 (priority: immediate)
- **Invariants:** — (legacy)
- **Scope:**
  - Owner chooses: unpublish the extension and notify users (default, consistent with its "retire" verdict), or ship the remediation described privately and then retire.
  - User notice drafted privately; public wording only after users are protected.
- **Acceptance:**
  - Written confirmation of the store listing state and, if patched, the private verification result (M0-1).
  - Unblocks publication of 09 §4 together with OPS-L5 (D-21).

#### OPS-L2 · OCC v1 ownership to Safes on all chains
- **Status:** backlog · **Size:** M · **Tier:** Opus (script) + Owner (signing) · **Security:** S2
- **Repo/path:** agentlink-ops · scripts (calls deployed v1 contracts; no v1 code copied)
- **Depends on:** OPS-L3
- **Spec:** see private 09 §4 L-2; D-20
- **Invariants:** —
- **Scope:**
  - Inventory owner-controlled v1 proxies: 4 per chain on Polygon, Gnosis, Sonic, Fantom, Oasis Sapphire (20 mainnet calls); decide whether the 7 testnet deployments are included.
  - Sequence: (1) withdraw accrued owner fees from the Mails and Chat proxies (OPS-L3); (2) verify a working Safe (≥ 2-of-3) exists on each chain, including Sapphire, Fantom and Sonic support; (3) `transferOwnership` to the Safe. Never renounce ownership or upgrades.
  - Ownership transfer is single-step: verify the Safe address on-chain per chain before sending.
  - Fork dry-run for every call before mainnet execution.
- **Acceptance:**
  - Fork dry-run log for all 20 calls asserting `owner()` == Safe afterwards.
  - Post-execution read of `owner()` on every proxy equals the chain's Safe; tx references recorded privately.
  - No proxy renounced.

#### OPS-L3 · v1 fee withdrawal constraint
- **Status:** ready · **Size:** S · **Tier:** Sonnet (runbook) + Owner (withdrawals) · **Security:** S1
- **Repo/path:** agentlink-ops · runbooks; GitBook `wiki.4thtech.io` (v1 docs)
- **Depends on:** —
- **Spec:** see private 09 §4 L-3; 05 §2.6 (v2 design)
- **Invariants:** —
- **Scope:**
  - Withdraw v1 owner fees only to EOAs, before OPS-L2 moves ownership to Safes.
  - No code change to v1 fee transfers (the reason is recorded privately); v2 handles this by design (05 §2.6).
  - Public v1 docs note the recipient constraint without further detail.
- **Acceptance:**
  - Per-chain withdrawal records exist privately before any OPS-L2 transfer.
  - Runbook reviewed by @denisjazbec (v1 author).

#### OPS-L4 · Document v1 group-chat key behaviour
- **Status:** ready · **Size:** S · **Tier:** Haiku · **Security:** S0
- **Repo/path:** GitBook `wiki.4thtech.io` (v1 docs)
- **Depends on:** —
- **Spec:** see private 09 §4 L-4 (low; document, no fix)
- **Invariants:** —
- **Scope:**
  - Document the known limitation of v1 group-chat membership changes as described privately; no fix planned.
- **Acceptance:**
  - v1 docs page updated via the GitBook change-request flow; owner approved.

#### OPS-L5 · PollinationX auth service: resolve L-5
- **Status:** ready · **Size:** S · **Tier:** Owner (Sonnet prepares a checklist) · **Security:** S1
- **Repo/path:** PollinationX hosting accounts and DNS
- **Depends on:** —
- **Spec:** see private 09 §4 L-5 (priority: immediate, verify)
- **Invariants:** — (legacy)
- **Scope:**
  - Confirm whether the legacy PX `auth` service is deployed anywhere; if it is, shut it down and rotate the associated server key.
  - Checks limited to infrastructure 4thTech owns.
- **Acceptance:**
  - Written confirmation (where checked, date, result; shutdown and rotation records if it was live) for M0-1.

#### OPS-L6 · PollinationX login: resolve L-6 (conditional)
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S1
- **Repo/path:** legacy `px-dapp`, `dapp`, PX backend
- **Depends on:** owner decision whether PollinationX stays live
- **Spec:** see private 09 §4 L-6 (high, if PX stays live)
- **Invariants:** —
- **Scope:**
  - If PX stays live: server-issued, expiring login nonces (SIWE / EIP-4361). If not: shut the login down.
- **Acceptance:**
  - Decision recorded; if implemented, a test shows a previously valid login signature is rejected and nonces expire.

#### OPS-L7 · PX Drive key handling: resolve L-7 (conditional)
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2
- **Repo/path:** legacy `px-dapp`
- **Depends on:** OPS-L6 decision (PX live or retired)
- **Spec:** see private 09 §4 L-7 (medium)
- **Invariants:** —
- **Scope:**
  - If PX stays live: implement the remediation described privately (user-secret or passkey-derived key), migrate existing users, notify them. If retired: notify users and retire.
- **Acceptance:**
  - Decision recorded; if fixed, migration tested on a copy of real-shaped data and the private verification check passes.

#### OPS-L8 · Secret scan of all 4thTech and PollinationX repositories
- **Status:** ready · **Size:** M · **Tier:** Sonnet (scan, triage) + Owner (rotation) · **Security:** S1
- **Repo/path:** all legacy repos (local clones) · report in agentlink-ops
- **Depends on:** —
- **Spec:** see private 09 §4 L-8; `audit-rules.md` §10.3 (secret-leak response)
- **Invariants:** I-7 (by analogy: never paste found values anywhere)
- **Scope:**
  - `gitleaks` over the full history of every repo in both organisations (including archived ones); triage true and false positives.
  - Owner rotates or revokes every live credential found. The report records fingerprints and locations only, never values.
- **Acceptance:**
  - Per-repo table (repo, commits scanned, findings, triage) stored privately.
  - Every true positive has a rotation or revocation record; a re-scan after rotation confirms nothing live remains.

#### OPS-L9 · Mark Fantom deployments deprecated
- **Status:** ready · **Size:** S · **Tier:** Haiku · **Security:** S0
- **Repo/path:** GitBook `wiki.4thtech.io`, 4thtech.io
- **Depends on:** —
- **Spec:** see private 09 §4 L-9 (low)
- **Invariants:** —
- **Scope:**
  - v1 docs mark Fantom deployments as deprecated and superseded by Sonic.
- **Acceptance:**
  - Docs updated via the GitBook change-request flow.

---

## 3. M1 — Local beta on testnets

Goal (10 M1): two people on different harnesses exchange messages and files and notarize on testnets, with no wallet and no payment for free features. Gate: `M1-GATE`.

**Phases (D-33, walking skeleton first).** Every M1 card carries `**Phase:** M1a` or `M1b` on its Status line.

- **M1a "Walking skeleton: pair and talk"**: the crypto Talk needs, types, transport, core identity/pairing/contacts/envelopes, a minimal policy engine with approvals (incl. the D-31 `commitments` policy), keychain and SQLite, owner presence via the CLI passphrase prompt, the Talk and approval MCP tools, agent-assisted install (D-39), and e2e pair-and-message plus J8 over Talk. **M1a gate** (recorded by M1-23): Tali's and Denis's agents pair and sync project status through AgentLink (J9 dogfood), and complete a J8 negotiation over Talk without on-chain proof. There is no milestone audit at M1a; per-card S1/S2 reviews apply.
- **M1b "Files, proof, credits"**: storage, contracts, chain (incl. zero-config chain selection, D-40), submitter and faucet, file and proof tools, passkey owner presence and the full local approval UI (D1 styling), and the remaining e2e. `M1-GATE` needs both phases.
- **Phase** names the gate that needs the card. M1b cards with long lead times (contracts, proof-layer vectors, chain configuration, audit RFP, owner actions) SHOULD start during M1a when a lane has capacity. Design-dependent cards (DESIGN-D1, M1-9g) never block the M1a gate (D-30). DESIGN-D3 is an M3 deliverable and carries no phase.
- A card that spanned both phases was split: the original ID keeps the M1a part and the M1b part has a new letter, marked "(new, split from …)". Schemas and interface definitions that M1b will use stay in their M1a card.

### Design deliveries (owner, D-30)

The owner designs in Claude Design and delivers in three drops (10 "Design deliveries"; intake and live status in `docs/design/README.md`). Until a surface's drop has landed, every UI card builds it **functional and unstyled, strings externalized, no invented visual design**. A late D2 slips M2: the M2 critical path starts from DESIGN-D2.

#### DESIGN-D1 · Design drop D1: foundations and M1 surfaces
- **Status:** backlog · **Size:** — · **Tier:** Owner · **Security:** S0 · **Phase:** M1a
- **Repo/path:** Claude Design links or `docs/design/d1/` (+ `MANIFEST.md`); private material to `agentlink-ops`
- **Depends on:** — · **Due:** week 3 of M1
- **Spec:** 11 §6.1, §6.2, §8, §9, §11, §13; 10 "Design deliveries"; D-30
- **Invariants:** —
- **Scope:**
  - In-chat copy sheet (11 §6.1, highest priority: it feeds the M1a tool summaries through M1-9g); design tokens (§11.7) and core components (§8); local settings and approvals app (§6.2) with its states (§9); simple "how to install" invite placeholder page.
- **Acceptance:**
  - Drop recorded in `docs/design/README.md` (date, links/files, delivered or partial); intake cards M1-9g, M1-11b and the M1-19 restyle become `ready`.

#### DESIGN-D2 · Design drop D2: full system and M2 surfaces
- **Status:** backlog · **Size:** — · **Tier:** Owner · **Security:** S0 · **Phase:** M1b
- **Repo/path:** Claude Design links or `docs/design/d2/`
- **Depends on:** DESIGN-D1 · **Due:** before M1-GATE
- **Spec:** 11 §6.3–§6.8, §8, §13; 08 §7 (browser counterparty, D-35), §8 (desktop dashboard, D-41); 02 F-15; D-30
- **Invariants:** —
- **Scope:**
  - Complete component library; owner console (§6.3, desktop and mobile); verify page (§6.4); invite landing (§6.5); browser counterparty view-and-accept (D-35); onboarding (§6.6); pay page (§6.7) and pricing (§6.8); clickable prototypes J1, J2, J4, J5, J8; rationale notes (§13). The console screens are also the desktop dashboard (D-41).
- **Acceptance:**
  - Drop recorded in `docs/design/README.md`; M2-1a becomes `ready`. Arriving after M1-GATE delays the start of M2 by the same amount.

#### DESIGN-D3 · Design drop D3: launch brand
- **Status:** backlog · **Size:** — · **Tier:** Owner · **Security:** S0
- **Repo/path:** Claude Design links or `docs/design/d3/`
- **Depends on:** M2-10 (production domain) · **Due:** before M3 public launch
- **Spec:** 11 §2 (brand), §13 (D3 deliverables), §15 (marketing site out of scope for beta); D-28, D-30
- **Invariants:** —
- **Scope:**
  - Production-domain brand and marketing site.
- **Acceptance:**
  - Drop recorded in `docs/design/README.md`; M3-13 becomes `ready`.

### Crypto (`@agentlink/crypto`)

#### M1-1h · Independent test vectors for all protocol suites
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2 · **Phase:** M1a
- **Repo/path:** agentlink · test-vectors/, tools/vectors/generators/
- **Depends on:** M0-9
- **Spec:** 04 §2.1, §2.3, §3.1, §3.3, §3.6, §4, §5, §8.2; 05 §3.1, §4, §8; `development-process.md` §9.1
- **Invariants:** I-6, I-8
- **Scope:**
  - Written by a session that does not implement the TypeScript code. Generators use independent implementations (e.g. Python `cryptography`, a reference BIP-340, RFC 9180 reference vectors, an RFC 8785 reference, `eth-account`/`eth-abi` or `cast` for EIP-712).
  - Suites (M1a, what Talk needs): HKDF derivation per 04 §2.1 (labels × epochs 0–2), BIP-340 tagged-hash envelope signatures, HPKE CEK wrap (fixed ephemeral keys), payload AEAD + AAD, envelope hash via JCS, pairing HMAC, safety code, owner-seed wrap (Argon2id passphrase path), EIP-712 domain separator / struct hash / digest for `AgentCard` (chain-agnostic domain).
  - Proof-layer suites (STREAM, PRF wrap, `Record`, `Receipt`, `Registration`) are M1-1i (M1b).
  - These are the **canonical** vectors; the contracts repo checks parity against a pinned commit (D-19).
  - Vectors that depend on open gap G-28 are added only after it is resolved.
- **Acceptance:**
  - Every case records generator, version and inputs; regeneration from the generator scripts reproduces the files byte for byte.
  - Narrow gitleaks allowlist (fingerprints, owner-reviewed) for deliberate test keys; no directory-wide allowlist.

#### M1-1i · Independent test vectors for the proof-layer suites (new, split from M1-1h)
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2 · **Phase:** M1b
- **Repo/path:** agentlink · test-vectors/, tools/vectors/generators/
- **Depends on:** M1-1h
- **Spec:** 04 §2.3, §4, §5; 05 §3.1, §4, §8; `development-process.md` §9.1
- **Invariants:** I-6, I-8
- **Scope:**
  - Same rules and generators as M1-1h (written by a session that does not implement the TypeScript code).
  - Suites: STREAM (empty, 1 B, exactly 1 chunk, chunk + 1, multi-chunk), owner-seed wrap (passkey PRF path), EIP-712 domain separators / struct hashes / digests for `Record`, `Receipt` (OCC v2 chain domain) and `Registration`; revoke after G-20.
  - Vectors that depend on open gaps (G-20, G-26) are added only after those are resolved. May start during M1a.
- **Acceptance:**
  - Every case records generator, version and inputs; regeneration reproduces the files byte for byte; the contracts repo's parity job runs against the pinned commit.

#### M1-1a · crypto: encodings, hashing, JCS, randomness, wiping
- **Status:** backlog · **Size:** S · **Tier:** Opus · **Security:** S2 · **Phase:** M1a
- **Repo/path:** agentlink · packages/crypto
- **Depends on:** M0-9, M0-10
- **Spec:** 04 §3.1 (base64url without padding, JCS, tagged hash), §8.1–§8.3; 07 §1
- **Invariants:** I-8
- **Scope:**
  - base64url (strict: rejects padding and non-canonical input), hex, UTF-8; SHA-256 and keccak-256 via `@noble/hashes`; BIP-340 tagged hash; constant-time compare.
  - JCS (RFC 8785) canonicalisation; library choice per gap G-12 (dependency justification in PR).
  - `randomBytes` from `globalThis.crypto.getRandomValues`; `wipe()` (`fill(0)`) helpers.
- **Acceptance:**
  - RFC 8785 examples and number-serialisation edge cases pass in Node, browsers and Workers (M0-9).
  - Tagged-hash vectors for `agentlink/envelope/v1` from M1-1h pass.
  - Strict base64url tests (padded, `+`/`/`, trailing bits) rejected.

#### M1-1b · crypto: key derivation and public identities
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2 · **Phase:** M1a
- **Repo/path:** agentlink · packages/crypto
- **Depends on:** M1-1a, M1-1h
- **Spec:** 04 §2.1, §2.4, §2.6, §3.1 (`kid`)
- **Invariants:** I-1, I-8
- **Scope:**
  - `deriveKey(masterSeed, label, epoch, counter)` exactly per 04 §2.1 (HKDF-SHA256, salt `agentlink-v1`, info = label ‖ 0x00 ‖ u32be(epoch) ‖ u8(counter), L = 32).
  - secp256k1 rejection loop (okm = 0 or ≥ n → counter + 1); `agentlink/v1/evm` always epoch 0; Nostr and enc keys per `keyEpoch`; X25519 from okm (library clamping).
  - Public bundle: checksummed EVM address, Nostr x-only key, X25519 key, `kid` = first 16 bytes of SHA-256(encPub). BIP-340 sign/verify helpers for KeyStore implementations only.
  - Intermediate secrets wiped.
- **Acceptance:**
  - M1-1h derivation vectors pass in all runtimes.
  - Rejection loop covered by a unit test that injects an out-of-range okm (a natural vector is infeasible).
  - Requesting the EVM key with epoch ≠ 0 is rejected by the API (test).

#### M1-1c · crypto: HPKE CEK wrapping, payload AEAD, envelope hash and signature helpers
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2 · **Phase:** M1a
- **Repo/path:** agentlink · packages/crypto
- **Depends on:** M1-1b
- **Spec:** 04 §3.1, §3.3; 03 §4.1
- **Invariants:** I-2, I-8, I-9
- **Scope:**
  - HPKE (RFC 9180) mode Base, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM via `@hpke/core`; `info = "agentlink/v1/cek" ‖ id(16 raw bytes)`; empty AAD; one seal per recipient.
  - Payload AEAD AES-256-GCM, 12-byte random IV, AAD = SHA-256(JCS({v, id, thread, from, createdAt, recipients})).
  - `envelopeHash = SHA-256(JCS(envelope without sig))`; signature input = taggedHash("agentlink/envelope/v1", envelopeHash).
  - Deterministic test seam for randomness (never exported in production builds).
- **Acceptance:**
  - RFC 9180 vectors for suite (KEM 0x0020, KDF 0x0001, AEAD 0x0002, mode 0) and M1-1h envelope vectors pass in all runtimes.
  - Changing any covered field (incl. recipient order or `createdAt`) changes the hash and fails verification; wrong-recipient open and tampered `ct`/AAD fail.

#### M1-1d · crypto: STREAM file encryption (ALF1)
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2 · **Phase:** M1b
- **Repo/path:** agentlink · packages/crypto
- **Depends on:** M1-1a, M1-1i; gap G-26 resolved
- **Spec:** 04 §4 (object layout, nonce, AAD, chunk size); 07 §5.2 (streaming); 03 §4.2
- **Invariants:** I-2
- **Scope:**
  - Web-Streams encrypt/decrypt with bounded memory: header `"ALF1" ‖ u8 version ‖ u32be chunkSize ‖ noncePrefix(8)`; chunk nonce = noncePrefix ‖ u32be(index); AAD = u8(isFinal) (plus header binding if G-26 decides so); default chunk 1 MiB.
  - Incremental SHA-256 of ciphertext and plaintext while streaming; chunk-size bounds and maximum chunk count enforced.
- **Acceptance:**
  - M1-1i STREAM vectors pass in all runtimes.
  - Dropped final chunk, reordered, duplicated or appended chunks, bit flips and header tampering all fail (tests).
  - 1 GiB encrypt + decrypt in Node with RSS growth < 64 MiB (slow-tagged benchmark test).

#### M1-1e · crypto: EIP-712 typed-data hashing and AgentCard
- **Status:** backlog · **Size:** S · **Tier:** Opus · **Security:** S2 · **Phase:** M1a
- **Repo/path:** agentlink · packages/crypto
- **Depends on:** M1-1a, M1-1h, M1-2a
- **Spec:** 04 §2.4, §5; 05 §4, §8
- **Invariants:** I-6
- **Scope:**
  - EIP-712 typed-data hashing via viem; `AgentCard` definition (domain `{name: "OCC AgentCard", version: "1"}`, no chainId/verifyingContract), which pairing and contacts need in M1a.
  - `Record`, `Receipt`, `Registration`, commitments and EIP-3009 are M1-1j (M1b).
- **Acceptance:**
  - `AgentCard` EIP-712 vectors from M1-1h pass in all runtimes.

#### M1-1j · crypto: EIP-712 proof types and commitment helpers (new, split from M1-1e)
- **Status:** backlog · **Size:** S · **Tier:** Opus · **Security:** S2 · **Phase:** M1b
- **Repo/path:** agentlink · packages/crypto
- **Depends on:** M1-1e, M1-1i
- **Spec:** 04 §5; 05 §3.1, §4, §8
- **Invariants:** I-6
- **Scope:**
  - Typed-data definitions for `Record`, `Receipt` (domain `{name: "OCC", version: "2", chainId, verifyingContract}`), `Registration`; revoke struct after G-20.
  - `recordStructHash`; recipient commitment `keccak256(abi.encode(recipientAgentEvm, salt))`.
  - EIP-3009 `ReceiveWithAuthorization` typed data (used in M3-4b); the token's domain is read from chain, never hard-coded.
- **Acceptance:**
  - EIP-712 vectors from M1-1i pass in all runtimes; the contracts repo's parity job passes against the same commit (M1-3d).

#### M1-1f · crypto: owner passphrase wrapping, pairing proof, safety code
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2 · **Phase:** M1a
- **Repo/path:** agentlink · packages/crypto
- **Depends on:** M1-1b, M1-1h; gap G-28 resolved
- **Spec:** 04 §2.3, §2.5, §3.6
- **Invariants:** I-1, I-4
- **Scope:**
  - Owner passphrase wrapping of the owner seed for local storage only: Argon2id (m = 64 MiB, t = 3, p = 1), AES-256-GCM (the M1a owner-presence minimum, D-33).
  - Pairing proof HMAC-SHA256(secret, "agentlink-handshake" ‖ inviteId ‖ SHA-256(JCS(B card))); safety code per 04 §3.6 with the encoding fixed by G-28.
  - Versioned wrapped-blob format (alg, params, salt, nonce), shared with M1-1k.
- **Acceptance:**
  - M1-1h vectors for Argon2id (plus RFC 9106 vectors), HMAC proof and safety code pass in all runtimes.
  - Property test: both sides compute the same safety code regardless of argument order.
  - The API refuses passphrase wrapping for blobs flagged for relay publication (test).
  - Argon2id timing measured in browser and Workers (Workers memory limit noted in PR).

#### M1-1k · crypto: passkey PRF seed wrapping and recovery code (new, split from M1-1f)
- **Status:** backlog · **Size:** S · **Tier:** Opus · **Security:** S2 · **Phase:** M1b
- **Repo/path:** agentlink · packages/crypto
- **Depends on:** M1-1f, M1-1i
- **Spec:** 04 §2.3; 08 §2.1
- **Invariants:** I-1, I-4, I-10
- **Scope:**
  - PRF path: PRF salt = SHA-256("agentlink-owner-v1"); wrapKey = HKDF-SHA256(ikm = PRF output, salt = "", info = "owner-seed-wrap", L = 32); AES-256-GCM seal/open of the seed.
  - Recovery code: 120 random bits as 24 base32 characters in groups; Argon2id (m = 64 MiB, t = 3, p = 1) wrapping in the M1-1f blob format.
- **Acceptance:**
  - M1-1i wrapKey vectors pass in all runtimes; recovery-code round trip and format tests (grouping, alphabet); a mistyped code fails cleanly without partial output.

#### M1-1g · crypto: KeyStore / OwnerKeyStore interfaces, MemoryKeyStore, NIP-44 helpers
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2 · **Phase:** M1a
- **Repo/path:** agentlink · packages/crypto (interfaces location per gap G-2)
- **Depends on:** M1-1b, M1-1c; gap G-2 resolved
- **Spec:** 03 §3; 04 §2.5, §2.6, §8.1; 07 §4.1
- **Invariants:** I-1, I-4, I-8
- **Scope:**
  - `KeyStore`: `getPublicBundle`, `sign712`, `signNostr`, envelope-hash signing, `nip44Encrypt`/`nip44Decrypt`, `hpkeOpen`, all epoch-aware (G-2). `OwnerKeyStore`: `unlock(presence)` → short-lived handle; owner signatures (OwnerAction, AgentCard, Registration); wipe on lock.
  - `MemoryKeyStore` from a seed (tests, base for the Worker implementation).
  - NIP-44 v2 and gift-wrap ephemeral key generation wrapped from `nostr-tools`; ephemeral secrets never leave the module.
- **Acceptance:**
  - Official NIP-44 v2 vectors pass in all runtimes.
  - Type-level test: no interface method returns private key or seed bytes.
  - Owner operations fail when locked; handles expire (fake-timer test).

### Types (`@agentlink/types`)

#### M1-2a · types: constants and envelope, payload, card, invite schemas
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2 · **Phase:** M1a
- **Repo/path:** agentlink · packages/types
- **Depends on:** M0-2d; gap G-29 resolved for owner-operation bodies
- **Spec:** 04 §2.4, §3.1, §3.4, §3.6; 05 §2.1, §3.1; 07 §1
- **Invariants:** I-5
- **Scope:**
  - Constants: 17 payload types, record kinds, receipt types, fee types, MCP status values, size limits (24 KB envelope, 12 KB inline), policy defaults reference.
  - Strict zod schemas (unknown keys rejected) for Envelope v1, Payload with per-type bodies (handshake, handshake-ack, proof, approval-request, approval, policy, card-update, revoke, `request` with `kind: "refresh-link"`, file entries), AgentCard, Invite.
  - Field validation: base64url without padding, byte lengths (id/thread/kid 16 B, keys 32 B), hex formats.
  - Security S2 because envelope/payload schema changes are S2 (`audit-rules.md` §2.2).
- **Acceptance:**
  - Round-trip tests for every schema; property-based fuzzing never throws anything but a validation error.
  - Wrong lengths, padded base64, oversized fields rejected (tests); schemas run in all three runtimes.

#### M1-2b · types: policy, approvals, owner actions, proof pack, tool results
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2 · **Phase:** M1a
- **Repo/path:** agentlink · packages/types
- **Depends on:** M1-2a; gaps G-7, G-32 resolved
- **Spec:** 06 §1 rule 3, §2 (`ProofStatus`), §3; 04 §2.5; 07 §8; 03 §3
- **Invariants:** I-4, I-5
- **Scope:**
  - Policy schema with the exact 06 §3 defaults (plus per-contact overrides if G-32 adds them); signed-policy document wrapper.
  - `OwnerAction{agentId, action, params, nonce, issuedAt}`, `ApprovalRequest`/`Approval` bound to an action digest, `ProofPack` v1, `ProofStatus`, the common tool-result shape `{status, summary, nextStep?, url?, approvalId?}`.
- **Acceptance:**
  - Defaults deep-equal 06 §3 (snapshot test citing the spec); the 07 §8 example pack parses.
  - Round-trip and strictness tests for each schema.

### Contracts (`occ-v2-contracts`, private)

All contract cards: private repo on the Free plan (D-27), so no rulesets or environment protection; `contracts-gate` is verified by the owner before merge; testnet deploy keys only, low balances; no OCC v1 code (D-20). Landing order for cross-repo changes: `development-process.md` §9.3.

#### M1-3a · contracts: interfaces, storage layout, AccessManager role map
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2 · **Phase:** M1b
- **Repo/path:** occ-v2-contracts · src/interfaces, src/libraries, docs/roles.md
- **Depends on:** M0-2f; gap G-3 resolved
- **Spec:** 05 §1, §5, §6, §7; 03 §6
- **Invariants:** I-6, I-10
- **Scope:**
  - `IOCCFeeVault`, `IOCCNotary` with the events (05 §6) and custom errors (05 §7) verbatim; ERC-7201 namespaced storage structs; UUPS base whose `_authorizeUpgrade` is gated by `AccessManager`.
  - AccessManager design: execution delays attach to a (role, account) grant, not to a function, so 05 §5 "per-function delays" becomes **one role per (power, delay) tier** plus a role → function-selector map, e.g. ADMIN (48 h), FEE_ADMIN (0), CAP_RAISER (7 d), TREASURY_ADMIN (7 d), PAUSER (0), UPGRADER_NOTARY (48 h), UPGRADER_VAULT (7 d), FREEZER (7 d); grant delays, guardian (cancel) roles and `minSetback` specified (G-3).
  - Direction-dependent changes split into separate functions (e.g. lower vs raise `maxProtocolFee`) so each maps to one role (G-3).
- **Acceptance:**
  - `docs/roles.md` table (role, holder, selectors, execution delay, grant delay, guardian) reviewed by the owner and @denisjazbec.
  - A table-driven Foundry test enumerates every restricted selector and asserts its role and delay match `docs/roles.md`.

#### M1-3b · contracts: OCCFeeVault (credits, fees, apps, treasury)
- **Status:** backlog · **Size:** L · **Tier:** Opus · **Security:** S2 · **Phase:** M1b
- **Repo/path:** occ-v2-contracts · src/OCCFeeVault.sol, test/unit
- **Depends on:** M1-3a; gap G-39 resolved
- **Spec:** 05 §2.1–§2.6, §5, §6, §7
- **Invariants:** I-10
- **Scope:**
  - Credits: `deposit`, `depositFor` (native + allowlisted ERC-20 via SafeERC20, measured balance delta), `withdraw` (works while paused), `creditsOf`, `minDeposit`.
  - Fees: `protocolFee ≤ maxProtocolFee`; caps lowered immediately, raised only via the 7-day role; `integratorFeeCapMultiple` default 4, ≤ `MAX_MULTIPLE` = 10; `quote`; `charge` (modules only; integrator cap applied at charge time; `maxTotal`; `InsufficientCredits`); `depositFromModule` (modules only; `transferFrom` payer).
  - Apps: `registerApp` (appId = keccak256(abi.encode(integrator, keccak256(bytes(name))))), `setIntegratorFee`, `setIntegrator` (appId unchanged), `setAppActive`; appId 0 = no integrator.
  - Treasury: permissionless `sweep` via `call`; `withdrawIntegrator`; treasury change with 7-day delay; pause blocks charges and deposits only (pause behaviour of `sweep`/`withdrawIntegrator` per G-39); CEI + `nonReentrant` on every value transfer.
  - Out: `depositWithAuthorization` (M1-3c).
- **Acceptance:**
  - Tests first (failing-test commit precedes implementation); a unit test for every function and every applicable revert in 05 §7.
  - No restricted selector can reduce `credits[payer][token]` (test enumerates all selectors).
  - Withdraw succeeds while paused; fee-on-transfer and reentrant token/receiver mocks cannot over-credit or re-enter.
  - Withdraw of credits in a token that was removed from the allowlist succeeds (05 §2.2, 12 §3.2).

#### M1-3c · contracts: vault EIP-3009 `depositWithAuthorization`
- **Status:** backlog · **Size:** S · **Tier:** Opus · **Security:** S2 · **Phase:** M1b
- **Repo/path:** occ-v2-contracts · src/OCCFeeVault.sol
- **Depends on:** M1-3b, M1-14; gap G-17 resolved
- **Spec:** 05 §2.5; 03 §4.4; 07 §7
- **Invariants:** I-6, I-10
- **Scope:**
  - Calls the token's `receiveWithAuthorization` with payee = vault (never `transferWithAuthorization`); credits `from` by measured delta; requires `value ≥ minDeposit[token]` and an allowed token; EIP-3009 capability handling per G-17.
- **Acceptance:**
  - Mock EIP-3009 token tests plus a fork test against Base Sepolia Circle USDC.
  - A front-run of the same authorization cannot redirect funds; a replayed nonce reverts; below minimum reverts `BelowMinDeposit()`.

#### M1-3d · contracts: OCCNotary (records, receipts, freeze)
- **Status:** backlog · **Size:** L · **Tier:** Opus · **Security:** S2 · **Phase:** M1b
- **Repo/path:** occ-v2-contracts · src/OCCNotary.sol, test/unit
- **Depends on:** M1-3a (uses `IOCCFeeVault` with a mock until M1-3b lands), M1-1i; gap G-4 resolved
- **Spec:** 05 §3.1–§3.4, §5 (freeze), §6, §7; 04 §5
- **Invariants:** I-6
- **Scope:**
  - EIP-712 `Record`/`Receipt`; `notarize`, `notarizeBatch` (semantics per G-4), `notarizeDirect` (payable; `msg.sender == r.signer`; `depositFromModule` then `charge`), `acknowledge`, `acknowledgeBatch`, `getRecord`, `computeRecordId`.
  - recordId = keccak256(abi.encode(block.chainid, address(this), signer, nonce)) (also the single-use nonce); `RecordState` packed into 5 slots incl. `recordStructHash`; receipt flags; ACCEPTED/REJECTED exclusive; commitment check `keccak256(abi.encode(rc.signer, rc.salt)) == recipientCommitment`.
  - `SignatureChecker.isValidSignatureNow` (EOA + ERC-1271); deadlines; pause; one-way `freezeUpgrades()`.
  - CI parity job: EIP-712 hashes equal the canonical public vectors at the pinned commit.
- **Acceptance:**
  - Tests first; unit test for every function and revert (`Expired`, `InvalidSignature`, `RecordExists`, `RecordNotFound`, `ReceiptExists`, `ConflictingReceipt`, `NotRecipient`, `NotSigner`, `FeeAboveMax`, `Paused`, `UpgradesAreFrozen`).
  - Gas snapshots meet 05 §3.4: `notarize` (credits, EOA) ≤ 160k, `acknowledge` ≤ 75k, `notarizeBatch` per item (n = 20) ≤ 120k; CI fails on regression.
  - A test recomputes `recordStructHash` from a full `Record` and matches `getRecord` (verification without logs).
  - Cross-chain, cross-contract and high-s signature replays rejected.

#### M1-3e · contracts: fuzz, invariant, ERC-1271 suites; static analysis clean
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2 · **Phase:** M1b
- **Repo/path:** occ-v2-contracts · test/fuzz, test/invariant, audits/static-analysis.md
- **Depends on:** M1-3b, M1-3c, M1-3d
- **Spec:** 05 §8
- **Invariants:** I-6, I-10
- **Scope:**
  - Invariants: Σ credits + Σ protocolAccrued + Σ integratorAccrued ≤ vault balance per token (with force-sent funds); record fields immutable; receipt flags and timestamps set once; no role reduces credits; no upgrade succeeds after freeze.
  - Fuzz: signatures, fee/cap/multiple arithmetic, credits.
  - ERC-1271 signers: Safe-style (threshold owners) and passkey-style (P-256/WebAuthn) smart-account mocks, including invalid and reverting `isValidSignature`.
  - Slither and Aderyn: clean, or each finding justified in `audits/static-analysis.md`.
- **Acceptance:**
  - Invariant suite runs in `contracts-gate` with the CI fuzz profile and nightly with a deep profile (runs/depth recorded).
  - ERC-1271 record and receipt paths pass; every static-analysis finding has a disposition.

#### M1-3f · contracts: ABI release artifacts and `@agentlink/occ-v2-abi`
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S1 · **Phase:** M1b
- **Repo/path:** occ-v2-contracts · release workflow; agentlink · packages/occ-v2-abi
- **Depends on:** M1-3d, M0-2e; DECISION NEEDED on the publish location (gap G-10)
- **Spec:** 05 §9; D-19; `development-process.md` §9.1–§9.3; `release-and-deployment.md` §2
- **Invariants:** I-6
- **Scope:**
  - Tagged contracts release emits ABI JSON, per-chain addresses (empty until M1-3g) and a SHA-256 manifest; no Solidity source leaves the private repo.
  - Proposed (G-10): a PR imports the artifacts into public `packages/occ-v2-abi`; CI verifies the manifest; `release.yml` publishes with provenance (ABIs only, MIT licence).
  - `@agentlink/chain` pins an exact version; Renovate never automerges it.
- **Acceptance:**
  - A `next` prerelease of `@agentlink/occ-v2-abi` published with provenance visible on npm.
  - CI fails if imported files differ from the release manifest; no `.sol` file is present in the public package (check).

#### M1-3g · contracts: CREATE3 deploy script and testnet deployment
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2 · **Phase:** M1b
- **Repo/path:** occ-v2-contracts · script/Deploy.s.sol, script/config/*.json, .github/workflows/deploy-testnet.yml
- **Depends on:** M1-3e, M1-14; gap G-8 resolved
- **Spec:** 05 §5, §9; 03 §6–§7; `release-and-deployment.md` §4.2
- **Invariants:** I-6
- **Scope:**
  - Foundry script: implementations and UUPS proxies via CreateX CREATE3 with deploy-and-initialise in one call; salt scheme per G-8; per-chain config (fee tokens with EIP-3009 flags, fees, caps, min deposits, treasury Safe, role holders, delays).
  - In the same script: all roles granted to the testnet Safe (mirroring the planned mainnet layout), Notary registered as vault module, every deployer role revoked.
  - Post-deploy check script (in CI): deployer holds no role; delays equal `docs/roles.md`; addresses identical on both chains.
  - Deploy runs from CI in the private repo, triggered manually by the owner (Free plan: no environment protection); testnet-only key, low balance. Agents never broadcast from a workstation.
  - Resolved (D-11, D-19): no explorer or Sourcify source verification on testnets; the source stays private until mainnet verification (M3-6). Testnet deploys publish ABIs and addresses only (`release-and-deployment.md` §4.2).
- **Acceptance:**
  - Identical proxy addresses on Base Sepolia and Gnosis Chiado (script output in PR).
  - `deployer-holds-no-role` passes on both chains; fork dry-run in CI before broadcast.
  - Addresses published in the next `@agentlink/occ-v2-abi` prerelease (M1-3f).

#### M1-14 · Testnet chain and fee configuration verification, stablecoin allowlist (D-45, D-46) (new)
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2 · **Phase:** M1b
- **Repo/path:** occ-v2-contracts · script/config, script/verify-chain; agentlink · packages/chain/src/config
- **Depends on:** M0-2f
- **Spec:** 05 §2.2, §9; 03 §7; 07 §6.1; 12 §2–§4; D-45, D-46
- **Invariants:** I-3, I-10
- **Scope:**
  - Base Sepolia (84532) and Gnosis Chiado (10200): CreateX deployed (code hash at the canonical address); supported EVM version → pinned `evm_version` per profile; testnet USDC/USDT addresses against issuer documentation; EIP-3009 support per token proven on a fork (USDT generally lacks it; bridged USDC variants may lack it); decimals; several public RPC URLs; explorer; confirmations.
  - Every entry cites its source and verification date.
  - Fee configuration (D-45, D-46): one per-chain schema used by the deploy script (M1-3g) and the client's shipped `ChainConfig` (07 §6.1). Fee tokens limited to the stablecoin allowlist (USDC, USDT where available, native xDAI on Gnosis/Chiado); no fee-on-transfer token; fees and caps derived from the USD schedule in 12 §2 (USD × 10^decimals: `NOTARIZE` $0.10, cap $0.50; `REGISTER` $5, cap $25); `minDeposit` (proposed $5); integrator multiple 4.
  - Out: mainnet values (M3-2a, M3-3).
- **Acceptance:**
  - A re-runnable script checks CreateX code hash, `decimals()`, `symbol()` and the EIP-3009 selector per token per chain; its output is attached to the PR.
  - The config check rejects a fee token outside the stablecoin allowlist (including a volatile native coin), a token without an issuer source, a fee-on-transfer token (mock), and any fee or cap whose USD value differs between chains or tokens; it passes on the committed testnet config.

### Chain client (`@agentlink/chain`)

#### M1-4a · chain: config, clients, typed-data builders, parity
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2 · **Phase:** M1b
- **Repo/path:** agentlink · packages/chain
- **Depends on:** M1-1j, M1-1g, M1-3f, M1-14
- **Spec:** 07 §6.1, §6.2; 03 §7; 05 §8
- **Invariants:** I-6
- **Scope:**
  - `ChainConfig` (07 §6.1) and the registry for Base Sepolia and Chiado; user RPC overrides; no API keys in the client; viem fallback transport.
  - ABIs and addresses from the pinned `@agentlink/occ-v2-abi`; builders for `Record`, `Receipt`, `AgentCard`; signing only through `KeyStore.sign712`.
  - Random 256-bit nonces, 32-byte salts, recipient commitments, recordId computation.
- **Acceptance:**
  - EIP-712 vector parity in all runtimes; config schema rejects unknown chains and duplicate tokens.

#### M1-4b · chain: quotes, USD display, credits
- **Status:** backlog · **Size:** M · **Tier:** Sonnet · **Security:** S1 · **Phase:** M1b
- **Repo/path:** agentlink · packages/chain
- **Depends on:** M1-4a (G-30 resolved by D-46)
- **Spec:** 07 §6.2; 06 §2.4 (`fee_quote`, `get_credits`); 02 F-45, F-47; 03 §4.4; 12 §4–§5; D-46
- **Invariants:** —
- **Scope:**
  - `OCCFeeVault.quote`; USD at 1:1 for every launch fee token (all USD stablecoins, D-46), no price endpoint; protocol and integrator parts shown separately (12 §5); never used on-chain.
  - `creditsOf` across the supported chains and tokens; `deposit` helper (direct mode). Which chain pays (auto-detection and auto-selection, D-40) is M1-26.
- **Acceptance:**
  - Quotes equal the contract's `quote` including the integrator cap, with the protocol and integrator parts in USD; `creditsOf` read on every supported chain (fork or mocked RPC); a fee token outside the configured stablecoin allowlist is never priced or offered.

#### M1-4c · chain: submission, direct mode, inclusion tracking
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2 · **Phase:** M1b
- **Repo/path:** agentlink · packages/chain
- **Depends on:** M1-4a, M1-3g (testnet addresses); M1-10a for integration (mock before)
- **Spec:** 07 §6.2, §7; 03 §4.3; 05 §3.2; 04 §7 (malicious submitter)
- **Invariants:** I-3, I-6
- **Scope:**
  - Submitter client (`/v1/notarize`, `/v1/receipt`, `/v1/status`) with failover across a list; direct mode (`notarizeDirect`, direct `acknowledge`) when the agent has native gas, simulated before sending; confirmations per chain config.
  - Idempotent retry: the same signed record is resubmitted, never re-signed with a new nonce unless the deadline passed; `RecordExists` with matching on-chain state counts as success.
  - Results are trusted only after reading chain state, never from submitter responses alone.
- **Acceptance:**
  - Testnet integration: notarize via submitter and via direct mode; receipts both ways.
  - Fake-submitter tests (wrong tx hash, silent drop, modified record) are detected via chain reads and fail over.

#### M1-4d · chain: proof-pack verification
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2 · **Phase:** M1b
- **Repo/path:** agentlink · packages/chain
- **Depends on:** M1-4a, M1-2b
- **Spec:** 07 §6.2, §8; 05 §3.3; 02 J5, F-44; 06 §2.4
- **Invariants:** I-3, I-6
- **Scope:**
  - Static `verifyProofPack(pack, {chains})`: `getRecord`, recompute `recordStructHash` from `pack.record`, envelope hash, commitment with disclosed salt, signer signature (EOA, or ERC-1271 via `eth_call`), receipts from `RecordState`; optional decryption with a disclosed content key and hash comparison.
  - Structured result with a specific reason per failure, ready for plain-language rendering. No log queries (some RPCs prune logs) and no 4thTech service.
- **Acceptance:**
  - Vector packs: valid; each single-field tamper → its specific reason; ERC-1271 signer; disclosed-key content check.
  - Runs in browser and Workers (M0-9 harness).

#### M1-26 · chain: zero-config chain auto-detection and auto-selection (D-40) (new)
- **Status:** backlog · **Size:** M · **Tier:** Sonnet · **Security:** S1 · **Phase:** M1b
- **Repo/path:** agentlink · packages/chain
- **Depends on:** M1-4a, M1-4b, M1-14
- **Spec:** D-39, D-40; 02 F-51; 07 §6.1, §6.2, §6.3 (auto-detection and selection); 06 §2.4 (`fee_quote` and `notarize`: chain chosen automatically; `needs_credits`; `get_credits`: `topUpUrl`); 11 §5 (Vocabulary and microcopy)
- **Invariants:** —
- **Scope:**
  - The client ships the supported-chain list (07 §6.1); detects where the agent has credits or stablecoin balance; picks the chain automatically: the default chain if funded, otherwise the cheapest funded one; nothing funded → `needs_credits`. Top-ups route to the cheapest supported chain.
  - Replaces the earlier M1-4b payment-choice order. A user RPC override or chain choice exists only under Advanced (local UI M1-11c, CLI flag); the default UX never asks for a chain.
  - Proof packs carry their chain, so `verifyProofPack` resolves the chain from the shipped list without setup.
- **Acceptance:**
  - Table-driven tests (fork or mocked RPC) for the selection order: default funded; default empty and two others funded (cheaper wins); credits vs stablecoin balance only; nothing funded → `needs_credits` with a top-up link to the cheapest chain; an RPC failure on one chain neither blocks nor picks it.
  - Snapshot tests of CLI and MCP default outputs contain no chain prompt and no chain name outside Advanced; a proof pack verifies with no chain configured.

#### M1-5a · transport-nostr: gift wrap / unwrap
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2 · **Phase:** M1a
- **Repo/path:** agentlink · packages/transport-nostr
- **Depends on:** M1-1g, M1-2a
- **Spec:** 04 §3.5; 07 §4.1, §4.2 (wrapping, size)
- **Invariants:** I-1, I-2, I-5
- **Scope:**
  - Rumor kind 14 with tag `["agentlink","1"]` and `content` = envelope JSON; seal kind 13 signed via `KeyStore.signNostr`; gift wrap kind 1059 per recipient Nostr key with an ephemeral key created inside `@agentlink/crypto`; NIP-44 v2; `created_at` randomised up to 2 days back.
  - Unwrap rejects unless: wrap and seal signatures verify, rumor pubkey == seal pubkey, seal pubkey == `envelope.from`, the `agentlink` tag is present, the envelope parses.
  - Envelope ≤ 24 KB before wrapping; final gift-wrap size computed per recipient for M1-5b.
- **Acceptance:**
  - Interop both directions with the `nostr-tools` NIP-59 reference (ours → reference unwrap and reference → ours).
  - Impersonation tests (seal ≠ `from`, rumor ≠ seal) rejected; a 24 KB envelope yields a wrap < 64 KB, 24 KB + 1 B is refused before wrapping.
  - Timestamp distribution test within [now − 2 d, now].

#### M1-5b · transport-nostr: relay pool, publish, NIP-11, NIP-42, outbox
- **Status:** backlog · **Size:** M · **Tier:** Sonnet · **Security:** S1 · **Phase:** M1a
- **Repo/path:** agentlink · packages/transport-nostr
- **Depends on:** M1-5a; gaps G-9, G-24 resolved
- **Spec:** 07 §4.2 (relays, reliability, size, NIP-42); 04 §3.5; 06 §6
- **Invariants:** I-3, I-7
- **Scope:**
  - WebSocket relay pool for Node, browsers and Workers; publish to the recipient's relays and the sender's own relays (owner copies per G-24); "sent" when ≥ 2 relays return `OK`.
  - Outbox retry with backoff for up to 24 h through an injected persistence interface (implemented by core/node).
  - NIP-11 fetch and cache; skip relays whose `max_message_length` is below the wrap size. NIP-42 AUTH signed via `KeyStore.signNostr`.
  - Event contents never logged; per-relay health and timeouts.
- **Acceptance:**
  - Tests against 2–3 local relays in Docker (one requiring AUTH, one with a small `max_message_length`): success only with ≥ 2 `OK`; the small relay is skipped.
  - Outbox survives a restart (persistence fake) and gives up after 24 h (fake clock); canary test shows no content in logs.

#### M1-5c · transport-nostr: subscribe and sync with cursors and dedup
- **Status:** backlog · **Size:** M · **Tier:** Sonnet · **Security:** S1 · **Phase:** M1a
- **Repo/path:** agentlink · packages/transport-nostr
- **Depends on:** M1-5b
- **Spec:** 07 §4.2 (sync); 04 §3.5; 06 §6 (48 h look-back, 3 s budget)
- **Invariants:** I-5
- **Scope:**
  - `REQ {kinds: [1059], "#p": [own pubkeys]}` with `since = lastSync − 48 h`, per-relay cursors; live subscriptions.
  - Dedup by gift-wrap event ID, then by envelope ID, with a seen-set kept ≥ 7 days (injected persistence, G-9).
  - Time-budgeted sync (3 s for `check_inbox`) returning partial results flagged as partial; malformed events dropped without logging content.
- **Acceptance:**
  - An event with `created_at` 47 h in the past is found after a restart; the same envelope from 3 relays is delivered once.
  - Seen-set retention ≥ 7 days (fake clock); the time budget is respected under a slow relay.

### Storage (`@agentlink/storage`)

#### M1-6a · storage: adapter interface, inline adapter, S3 adapter
- **Status:** backlog · **Size:** M · **Tier:** Sonnet · **Security:** S1 · **Phase:** M1b
- **Repo/path:** agentlink · packages/storage
- **Depends on:** M1-1a, M0-8, M0-2g (R2 test token); gap G-23 resolved
- **Spec:** 07 §5.1–§5.3; 04 §4 (delivery, expiry); 02 F-30–F-32; D-18
- **Invariants:** I-2, I-7
- **Scope:**
  - `StorageAdapter` per 07 §5.1; inline adapter (≤ 12 KB, base64url); S3 adapter over `aws4fetch`: PUT, `presignGet` (clamped to ≤ 7 days and to credential expiry), DELETE.
  - Object key `agentlink/<id>/<random 128-bit>` per G-23; no file names, contact data or user metadata on objects.
  - Credentials only through an injected provider; never logged; presigned URLs never logged.
- **Acceptance:**
  - Integration tests against MinIO (Docker, every PR) and Cloudflare R2 (scheduled job using the bucket-scoped test token): upload, presign, download, delete.
  - Presign beyond 7 days is clamped (test); canary test shows no URL query strings or keys in logs.

#### M1-6b · storage: streaming encryption and multipart upload
- **Status:** backlog · **Size:** M · **Tier:** Sonnet · **Security:** S1 · **Phase:** M1b
- **Repo/path:** agentlink · packages/storage
- **Depends on:** M1-6a, M1-1d
- **Spec:** 07 §5.2 (multipart > 64 MB, streaming, lifecycle); 10 M1-6; 04 §4
- **Invariants:** I-2
- **Scope:**
  - File stream → STREAM encryption → multipart upload with adaptive part size and incremental ciphertext SHA-256; multipart aborted on any error.
  - Streaming download + decrypt helper with a byte cap.
  - Lifecycle-rule helper (delete `agentlink/` objects after 30 days) used by `storage connect`.
- **Acceptance:**
  - 1 GB round trip against MinIO with RSS growth < 128 MiB (measured in the test).
  - An aborted upload leaves no open multipart uploads; lifecycle rule applied and read back on MinIO and R2.

### Core (`@agentlink/core`)

#### M1-7a · core: client skeleton, Store and ApprovalChannel interfaces, identity, contacts
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2 · **Phase:** M1a
- **Repo/path:** agentlink · packages/core
- **Depends on:** M1-1g, M1-1e, M1-2b; gaps G-9, G-23 resolved
- **Spec:** 03 §3; 07 §2, §3; 04 §2.4, §2.6; 02 F-02, F-03, F-05, F-06, F-13, F-14
- **Invariants:** I-1, I-4, I-9
- **Scope:**
  - `AgentLinkClient.create(...)` wiring; `Store` interface covering 07 §3 plus the tables from G-9 (outbox, seen-set, owner-action nonces, fee-budget ledger, rate counters, idempotency results); `ApprovalChannel`; in-memory Store for tests.
  - Identity: agent card build (04 §2.4) signed via `OwnerKeyStore`; key rotation to `keyEpoch + 1` with a new card; `agentId` per G-23.
  - Contacts: add from a verified card, list, block/remove (F-14: later envelopes dropped); display names marked self-declared.
- **Acceptance:**
  - Card with a signature not from `ownerEvm` rejected; rotation yields epoch + 1 and old-epoch keys still open old envelopes.
  - Envelopes from a blocked contact are dropped (test).

#### M1-7b · core: envelope build/open and threads
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2 · **Phase:** M1a
- **Repo/path:** agentlink · packages/core
- **Depends on:** M1-7a, M1-1c
- **Spec:** 04 §3.1–§3.4; 03 §4.1; 02 F-20, F-22, F-60
- **Invariants:** I-2, I-5, I-9
- **Scope:**
  - Build: random 16-byte `id`, stable `thread`, CEK, payload AEAD, HPKE wraps to the 04 §3.2 recipient set (recipient agent, recipient owner, sender owner, sender agent), signature; ≤ 24 KB check.
  - Open: verify signature against the contact's card (epoch-aware), pick the wrap by `kid`, decrypt, validate payload with zod. Unknown senders → requests queue, except `handshake` (M1-7c).
  - Store the ciphertext envelope; decrypted payload only in encrypted columns.
- **Acceptance:**
  - Each of the four recipients decrypts (test per role; I-9 for both owners).
  - Unknown sender lands in requests (F-13); unknown type or invalid body rejected; M1-1h envelope fixture opens.

#### M1-7c · core: pairing protocol (invite, accept, handshake)
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2 · **Phase:** M1a
- **Repo/path:** agentlink · packages/core
- **Depends on:** M1-7b, M1-1f, M1-5a; gap G-12 (invite encoding) resolved
- **Spec:** 04 §3.6; 06 §2.1 (`create_invite`, `accept_invite`); 02 F-10–F-12; D-17
- **Invariants:** I-1, I-4, I-5
- **Scope:**
  - Invite `{v, inviteId, secret, card, cardSig, name, relays, expiresAt}` → base64url(deflate) → `https://<invite-host>/i#<payload>`; accept from the full URL or the bare payload; default expiry 7 days.
  - A stores `{inviteId, sha256(secret), expiresAt, used}`. B verifies `cardSig` and expiry, applies `contacts.acceptInvites` (default `approval` → `pending_approval`), then sends `handshake` with the HMAC proof.
  - A accepts a `handshake` from an unknown sender only for an unused, unexpired invite; marks it used, adds B, replies `handshake-ack`. Both sides compute the safety code once the handshake is done; `createInvite` returns `{inviteUrl, ownerFingerprint, expiresAt}` and no safety code (it needs both sides' keys, 04 §3.6).
- **Acceptance:**
  - In-process two-client test over a local relay: pairing completes and both safety codes match.
  - Replayed handshake, expired invite, wrong proof and tampered card each rejected.
  - Default policy yields `pending_approval`; the invite secret never appears in logs or in any relay-visible field (canary).

#### M1-7d · core: policy engine and owner-signed policies
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2 · **Phase:** M1a
- **Repo/path:** agentlink · packages/core
- **Depends on:** M1-7a, M1-2b; gaps G-6, G-7 resolved
- **Spec:** 07 §2 (pure `evaluate`); 06 §3; 04 §2.5; 02 F-61–F-63
- **Invariants:** I-4
- **Scope:**
  - Pure `evaluate(policy, action, context) → allow | approval | deny`, minimal for M1a (D-33): the 06 §3 rules for contacts and envelopes (hourly per-contact rate counts passed in as context), plus the `commitments` rule from M1-20. Files, proofs and receipts rules are M1-7i (M1b).
  - Signed policy documents verified against the owner key in the agent card on every load; behaviour on missing or invalid signatures per G-6.
  - `OwnerAction` verification: owner signature, `agentId` binding, single-use nonce, freshness window (G-7).
- **Acceptance:**
  - Tests first; a table-driven test per rule and boundary (e.g. the per-contact hourly rate limit at N and N + 1).
  - A policy row edited directly in the store is ignored (I-4); a replayed or stale `OwnerAction` is rejected.
  - Property test: `evaluate` is deterministic and has no side effects.

#### M1-7i · core: policy rules for files, proofs and receipts (new, split from M1-7d)
- **Status:** backlog · **Size:** S · **Tier:** Opus · **Security:** S2 · **Phase:** M1b
- **Repo/path:** agentlink · packages/core
- **Depends on:** M1-7d, M1-20; gap G-7 resolved
- **Spec:** 06 §3; 07 §2; 02 F-61–F-63
- **Invariants:** I-4
- **Scope:**
  - The remaining 06 §3 rules in the same pure `evaluate`: files, proofs incl. `dailyBudgetUSD` and `perActionMaxUSD` (budget ledger passed in as context), receipts. `ACCEPTED`/`REJECTED` receipt signing stays under `commitments` (M1-20).
- **Acceptance:**
  - Tests first; a table-driven test per rule and boundary (e.g. $1.00 vs $1.01 for `perActionMaxUSD`; budget day boundary as fixed by G-7).
  - Property test: `evaluate` stays deterministic and side-effect free.

#### M1-7e · core: approvals, requests queue, idempotency
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2 · **Phase:** M1a
- **Repo/path:** agentlink · packages/core
- **Depends on:** M1-7d
- **Spec:** 06 §1 rule 6, §2.5; 03 §3, §4.5; 02 F-62, F-65, J4
- **Invariants:** I-4
- **Scope:**
  - Approval requests bound to an action digest (SHA-256 of the JCS action); an approved ID lets the identical action proceed once; expiry per G-7; statuses `pending | approved | denied | expired`.
  - Approval accepted only as an owner-signed object (local UI, CLI or console envelope).
  - Requests queue for unknown senders with owner accept/ignore; `clientRequestId` idempotency (repeats return the original result).
- **Acceptance:**
  - An approved ID is refused for a different action and on second use; an unsigned or wrongly signed approval is rejected.
  - Idempotent repeats return identical results; expired approvals report `expired`.

#### M1-7f · core: files (send, fetch, refresh link, crypto-shredding)
- **Status:** backlog · **Size:** L · **Tier:** Opus · **Security:** S2 · **Phase:** M1b
- **Repo/path:** agentlink · packages/core
- **Depends on:** M1-7b, M1-6b, M1-15; gap G-27 resolved
- **Spec:** 04 §4; 03 §4.2; 06 §2.3; 02 F-30–F-34; D-18
- **Invariants:** I-2, I-5, I-7
- **Scope:**
  - `sendFile`: allowed-folder check (M1-15), size policy, inline vs storage chosen so the final envelope stays ≤ 24 KB (G-27), STREAM encryption, both hashes, presign with expiry ≤ 7 days, payload `files[]`.
  - `fetchFile`: SSRF-safe download (M1-15) capped at declared size + overhead; check `ciphertextSha256` before and `plaintextSha256` after decryption; write only to the inbox folder with a sanitised name; never execute.
  - `refresh-link` request and answer; retention (`files.deleteAfter` = expiry | receipt): delete the object and discard the file key on both sides; file keys encrypted at rest.
- **Acceptance:**
  - 5 MB round trip via MinIO; tampered ciphertext → integrity error and nothing written.
  - Oversized download aborted; hostile names (`../../.ssh/x`, control characters, hidden names) sanitised.
  - Expired link → refresh-link flow returns a working URL; after the retention trigger the object returns 404 and file-key rows are gone on both sides.

#### M1-7g · core: proofs and receipts
- **Status:** backlog · **Size:** L · **Tier:** Opus · **Security:** S2 · **Phase:** M1b
- **Repo/path:** agentlink · packages/core
- **Depends on:** M1-7b, M1-7e, M1-7i, M1-20, M1-21, M1-4b, M1-4c, M1-4d, M1-26; gap G-13 resolved
- **Spec:** 03 §4.3; 04 §3.4 (`proof`; `terms` and proof of agreement), §5; 05 §3.1, §3.3; 06 §2.4, §3 (`commitments`); 07 §6.2, §6.3, §8; 02 F-40, F-42, F-43, F-47, F-51, J2, J3, J8; D-31, D-32
- **Invariants:** I-2, I-4, I-6
- **Scope:**
  - `notarize(envelopeId)`: kind mapping (G-13), salt + commitment, `Record`, policy `proofs.*` and budgets (→ approval), automatic chain selection (M1-26; nothing funded → `needs_credits` with agent address and top-up link), submit, then a follow-up `proof` envelope `{envelopeId, chainId, recordId, salt}`.
  - Recipient: on a `proof` envelope, check on-chain that recordId matches the envelope hash and `commitment(self, salt)` before any receipt.
  - Receipts: DELIVERED automatic per `receipts.autoDelivered`; OPENED only on explicit request; ACCEPTED/REJECTED exclusive and only after the `commitments` policy allows it or the owner approves (D-31, M1-20). `getProof`; `exportProofPack` (content key only with `proofs.allowKeyDisclosure` approval).
  - Proof of agreement (D-32): notarizing the envelope that carries the final `terms`, plus the counterparty's ACCEPTED receipt, yields a pack that states mutual assent, not just a timestamp.
- **Acceptance:**
  - Testnet integration: notarize → automatic DELIVERED → explicit OPENED → export → `verifyProofPack` valid.
  - No receipt is signed when the on-chain record does not match (tampered proof-envelope test); no ACCEPTED/REJECTED receipt is signed under the default policy without an owner-signed approval.
  - Zero credits → `needs_credits`; key disclosure without approval → `pending_approval`.

#### M1-7h · core: inbox sync, card updates, revocation, delivery acks
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2 · **Phase:** M1a
- **Repo/path:** agentlink · packages/core
- **Depends on:** M1-7c, M1-5c
- **Spec:** 07 §2 (`syncInbox`), §4.2; 04 §2.6, §3.4, §7 (spam); 06 §2.2, §6; 02 F-21, F-23, F-65
- **Invariants:** I-4, I-5
- **Scope:**
  - `syncInbox`: transport sync → unwrap → open → classify (contact, request, handshake) → store; idempotent across restarts.
  - Per-contact rate limit (`contacts.rateLimitPerContactPerHour`); `card-update` accepted only for a higher epoch signed by the same owner; `revoke` envelopes; F-23 signed off-chain "received" ack (P1, behind a flag).
  - Metadata for the untrusted-content wrapper (contact verified, owner fingerprint).
- **Acceptance:**
  - `card-update` with the same epoch or a different owner rejected; a revoked contact's later envelopes dropped.
  - 500 envelopes from one contact are rate-limited without delaying another contact's envelopes.

### Node runtime (`@agentlink/node`)

#### M1-8a · node: OS keychain KeyStore
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2 · **Phase:** M1a
- **Repo/path:** agentlink · packages/node
- **Depends on:** M1-1g; gaps G-23, G-31 resolved
- **Spec:** 04 §2.2 (service `agentlink`, account `<agentId>`); 03 §6 (`@napi-rs/keyring`); 10 M1-8
- **Invariants:** I-1, I-7
- **Scope:**
  - `KeyStore` backed by macOS Keychain, Windows Credential Manager and libsecret via `@napi-rs/keyring` (dependency justification; prebuilt binaries, no install script); seed held in memory only as long as needed, then wiped.
  - Store key for encrypted SQLite columns also in the keychain; several agents per machine (`--agent <name>`).
  - Headless Linux / no Secret Service: behaviour per G-31 (default: `needs_setup` with explanation).
- **Acceptance:**
  - CI matrix on macOS, Windows and Ubuntu (gnome-keyring in a D-Bus session) runs the keychain tests.
  - A filesystem diff during `init` shows the seed in no file; missing keychain → `needs_setup`.

#### M1-8b · node: SQLite Store with encrypted sensitive columns
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2 · **Phase:** M1a
- **Repo/path:** agentlink · packages/node
- **Depends on:** M1-7a, M1-8a
- **Spec:** 07 §3 (schema, at-rest encryption); 06 §6 (WAL + file lock, shared agent)
- **Invariants:** I-2, I-7
- **Scope:**
  - `better-sqlite3` Store implementing the full `Store` interface (07 §3 + G-9 tables) with forward migrations; schema reusable by the Durable Object (M2-3a). Native build allowlisted explicitly in CI (`ci-cd.md`).
  - Sensitive columns (decrypted payloads, contact names, file names, URLs, file keys, salts, policy parameters) encrypted with the store key via `@agentlink/crypto` (AES-GCM, AAD bound to table/column/row ID); IDs, timestamps and statuses in clear.
  - WAL + inter-process lock so several harnesses share one agent.
- **Acceptance:**
  - Scanning the raw DB file finds none of the canary plaintexts; without the store key only IDs, timestamps and statuses are readable.
  - Two processes writing concurrently cause no corruption; migrations run from empty and from the previous schema version.

#### M1-8c · node: OwnerKeyStore with the owner passphrase (CLI prompt)
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2 · **Phase:** M1a
- **Repo/path:** agentlink · packages/node
- **Depends on:** M1-1f, M1-8a; gap G-1 resolved (at least documented and accepted by the owner)
- **Spec:** 04 §2.2, §2.5; 08 §1; 06 §8 (†); D-16, D-33
- **Invariants:** I-1, I-4
- **Scope:**
  - Owner seed stored only wrapped with the Argon2id owner passphrase (the M1a owner-presence minimum, D-33); unwrapped only inside one owner operation, then wiped. The localhost passkey (PRF) path is M1-8e (M1b).
  - CLI passphrase prompt reads from a TTY only; no reusable bearer token on disk.
  - Produces `OwnerAction` signatures and EIP-712 card/registration signatures.
  - Full threat note covering G-1 (shared `localhost` RP ID; same-user installation tampering).
- **Acceptance:**
  - Build-plan test (10 M1-8): a script running as the same OS user, with read access to `~/.agentlink`, the agent's keychain items and the DB, cannot produce a valid approval or policy change without the passphrase. The test's stated scope excludes modifying the installed package (G-1).
  - No owner-seed bytes on disk (scan after setup and after an operation); the unlock handle's buffers are zeroed after use (test).

#### M1-8d · node: local approval server
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2 · **Phase:** M1b
- **Repo/path:** agentlink · packages/node
- **Depends on:** M1-8c, M1-7e
- **Spec:** 08 §1; 03 §4.5; 04 §2.5; 06 §2.5
- **Invariants:** I-4, I-7
- **Scope:**
  - HTTP server on `127.0.0.1:<random port>`; random session token in memory only, passed in the opened URL (`/?t=…`), never on disk.
  - Rejects missing/wrong token, wrong `Host` header and foreign `Origin` (DNS rebinding); no state change through simple cross-site requests.
  - The token grants viewing only; owner operations require WebAuthn (rpId `localhost`, PRF; wired in M1-8e) or the passphrase and produce owner-signed actions verified by core. OS notification on new approval requests; `/approve/<id>` route.
- **Acceptance:**
  - Tests: wrong token → 401; `Host: evil.example` rejected; cross-origin POST rejected; token absent from files and logs.
  - Approving without presence fails; the M1-8c same-user script test also passes against the running server.

#### M1-8e · node: OwnerKeyStore localhost passkey (PRF) path (new, split from M1-8c)
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2 · **Phase:** M1b
- **Repo/path:** agentlink · packages/node
- **Depends on:** M1-8c, M1-8d, M1-1k; gap G-1 resolved (at least documented and accepted by the owner)
- **Spec:** 04 §2.2, §2.3, §2.5; 08 §1; D-16
- **Invariants:** I-1, I-4
- **Scope:**
  - Owner seed wrapped with the PRF-derived key from a passkey registered for `localhost` (ceremony through the M1-8d server); unwrapped only inside one owner operation, then wiped. Passphrase stays as the fallback.
  - Threat note extended for the shared `localhost` RP ID (G-1); D-36 desktop biometrics are the intended long-term mitigation (G-42).
- **Acceptance:**
  - The M1-8c same-user script test passes with the passkey path enabled (virtual authenticator with PRF); a PRF-less authenticator falls back to the passphrase.
  - No owner-seed bytes on disk after passkey setup and after an operation (scan).

### CLI and MCP server (`@4thtech/agentlink`, `apps/cli`)

#### M1-9a · CLI: init, harness setup, everyday commands
- **Status:** backlog · **Size:** M · **Tier:** Sonnet · **Security:** S1 · **Phase:** M1a
- **Repo/path:** agentlink · apps/cli
- **Depends on:** M1-8a, M1-8b, M1-8c, M1-7c; gap G-5 resolved
- **Spec:** 06 §7, §8; 02 F-01, J1; 04 §2.2; D-39
- **Invariants:** I-1, I-4
- **Scope:**
  - `agentlink init [--agent <name>]`: agent identity in the keychain; owner identity via the owner passphrase (04 §2.2, not plaintext in the keychain; G-5); display name. The passkey option and the recovery-kit offer are M1-9h (M1b).
  - Harness detection and config writes for Claude Code, Claude Desktop, Codex, Gemini CLI, each after confirmation showing the exact file change (D-39); printed snippets for Antigravity, Cursor, VS Code, Windsurf, Cline (config locations verified at build time).
  - `invite`, `accept <url>`, `contacts [--verify <id>]`, `doctor` (relays, keychain). `ui`, `credits`, `verify` and the RPC and storage checks of `doctor` are M1-9h.
  - All key creation delegated to `@agentlink/node`; no new crypto here.
- **Acceptance:**
  - Snapshot tests per harness on fixture home directories: no config, config with other servers (preserved), malformed config (abort, no write).
  - `doctor` reports each subsystem; `init` on clean macOS, Windows and Linux VMs completes (recorded).

#### M1-9b · CLI: owner commands for approvals and policy (†)
- **Status:** backlog · **Size:** S · **Tier:** Opus · **Security:** S2 · **Phase:** M1a
- **Repo/path:** agentlink · apps/cli
- **Depends on:** M1-9a, M1-8c, M1-7e, M1-20
- **Spec:** 06 §3 (`commitments`), §8 (†); 04 §2.5 (Commitments); D-31, D-33
- **Invariants:** I-4
- **Scope:**
  - `policy show | set` (incl. `commitments` limits, M1-20), `approve | deny <id>`: the M1a approval channel, since the local UI arrives in M1b.
  - Each † command requires owner presence (passphrase at a TTY) and emits an owner-signed action; non-TTY invocation of a presence prompt is refused.
  - `storage connect` and `backup` are M1-9i (M1b).
- **Acceptance:**
  - Each † command fails with piped stdin and no passphrase (tests).
  - An approval made with `approve <id>` lets exactly the pending action proceed once (end-to-end with M1-7e).

#### M1-9i · CLI: owner commands for storage and backup (†) (new, split from M1-9b)
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2 · **Phase:** M1b
- **Repo/path:** agentlink · apps/cli
- **Depends on:** M1-9b, M1-6b, M1-1k
- **Spec:** 06 §8 (†); 04 §2.3, §2.5; 07 §5.2 (guided setup, lifecycle)
- **Invariants:** I-4, I-7, I-10
- **Scope:**
  - `storage connect` (provider picker, test upload/download/delete, lifecycle-rule offer, credentials → keychain), `backup export | restore` (recovery kit).
  - Each † command requires owner presence and emits an owner-signed action; non-TTY invocation of a presence prompt is refused.
- **Acceptance:**
  - Each † command fails with piped stdin and no passkey or passphrase (tests).
  - Recovery kit export → restore on a clean machine restores identity, contacts and history (I-10).
  - Storage credentials never printed or logged (canary).

#### M1-9c · MCP server: identity, Talk and approval tools
- **Status:** backlog · **Size:** L · **Tier:** Opus · **Security:** S1 · **Phase:** M1a
- **Repo/path:** agentlink · apps/cli (tool handlers in a runtime-agnostic module, gap G-15)
- **Depends on:** M1-7c, M1-7e, M1-7h, M1-9b, M1-20, M1-21
- **Spec:** 06 §1, §2.1, §2.2, §2.5, §3 (`commitments`), §4, §5, §6; 04 §3.4 (`terms`); 02 F-22; 11 §5; D-31, D-32
- **Invariants:** I-4, I-5, I-7
- **Scope:**
  - stdio server on the official MCP TypeScript SDK; every tool declares `inputSchema` and `outputSchema` and returns `structuredContent` plus a one-sentence summary; status values with `nextStep`/`url`; contact resolution with `AMBIGUOUS_CONTACT`.
  - Tools: `agentlink_status`, `create_invite`, `accept_invite`, `list_contacts`, `send_message` (incl. typed `offer`/`accept`/`reject` with a `terms` body, M1-21; a binding `accept` goes through the `commitments` policy, M1-20), `check_inbox` (3 s sync budget; automatic DELIVERED once proofs land, M1-9d), `get_thread`, `get_approval`.
  - Until the local approval server lands (M1-8d, M1b), `pending_approval` results name the owner's CLI command (`agentlink approve <id>`, run in a terminal the agent does not control) as `nextStep`; M1-11a adds the local UI `url`.
  - Untrusted-content wrapper exactly per 06 §4 (escape `</untrusted_content>` and control characters, in text and `structuredContent`); server instructions verbatim from 06 §5.
  - Relay subscriptions while running; optional `agentlink://inbox` resource notifications (tools work without them).
- **Acceptance:**
  - Schema test + behaviour test for each `status` value of each tool.
  - A canary sent through the inbound path never appears in tool descriptions, server instructions or error messages (test scans all three).
  - Summaries pass the vocabulary lint (11 §5).

#### M1-9d · MCP server: file and proof tools
- **Status:** backlog · **Size:** L · **Tier:** Opus · **Security:** S1 · **Phase:** M1b
- **Repo/path:** agentlink · apps/cli
- **Depends on:** M1-9c, M1-7f, M1-7g, M1-15; gaps G-25 and G-43 resolved
- **Spec:** 06 §2.3, §2.4, §9; 04 §4; 02 J2, J3
- **Invariants:** I-4, I-5, I-6
- **Scope:**
  - `send_file` (realpath allowed-folder check; outside or none → `needs_setup` with the local UI link, file never opened), `fetch_file`, `fee_quote` (USD split `protocolUsd` / `integratorUsd`, G-43), `notarize`, `acknowledge` (`opened` only when the user asked), `get_proof`, `export_proof_pack` (to `proofs.exportFolder`; key disclosure needs approval), `verify_proof_pack` (file-path argument restricted per G-25), `get_credits`.
  - No tool asks for or requires a chain in its default inputs; the chain is picked automatically (M1-26, D-40).
- **Acceptance:**
  - `send_file` outside allowed folders → `needs_setup`, and a filesystem spy shows the file was never opened; a symlink escaping an allowed folder is refused.
  - `notarize` with zero credits → `needs_credits` with agent address and `topUpUrl`.
  - Schema + behaviour test per `status` value of each tool.

#### M1-9e · MCP conformance and tool-surface guard
- **Status:** backlog · **Size:** S · **Tier:** Sonnet · **Security:** S1 · **Phase:** M1a
- **Repo/path:** agentlink · apps/cli/test, .github/workflows/ci.yml
- **Depends on:** M1-9c (extended when M1-9d lands)
- **Spec:** 06 §1 rule 4, §9; 04 I-4; 11 §5
- **Invariants:** I-4
- **Scope:**
  - MCP Inspector (CLI mode) schema validation of all tools in CI.
  - Committed tool-surface snapshot (names, input and output schemas); changes need code-owner review.
  - Deny assertions: no tool name, description or argument that changes policy, exports keys, adds storage credentials, decides approvals or reads arbitrary files. Vocabulary lint over summaries and server instructions.
- **Acceptance:**
  - Adding a fixture tool `set_policy` or an argument `privateKey` fails CI (red run linked); Inspector validation passes for every tool.

#### M1-9f · Claude Desktop one-click extension bundle
- **Status:** backlog · **Size:** S · **Tier:** Sonnet · **Security:** S1 · **Phase:** M1b
- **Repo/path:** agentlink · apps/cli/desktop-extension
- **Depends on:** M1-9c, M1-16; DECISION NEEDED: build, signing and distribution (`release-and-deployment.md` §2)
- **Spec:** 02 F-01; 06 §7
- **Invariants:** I-1
- **Scope:**
  - Bundle in the current Claude Desktop extension format (verified at build time), pinned to a published package version with provenance, no bundled secrets; signed if the format supports it.
- **Acceptance:**
  - A fresh Claude Desktop installs the bundle and `agentlink_status` returns `ok`; bundle hash published with the GitHub release.

#### M1-9g · Tool summaries aligned with the D1 copy sheet (new)
- **Status:** backlog · **Size:** S · **Tier:** Sonnet · **Security:** S1 · **Phase:** M1a
- **Repo/path:** agentlink · apps/cli (shared tool-handler module, externalized strings)
- **Depends on:** DESIGN-D1, M1-9c (extended when M1-9d lands)
- **Spec:** 11 §5, §6.1; 06 §1 rule 2, §4, §5; D-30
- **Invariants:** I-5
- **Scope:**
  - Replace interim summaries with the D1 copy-sheet templates (sent, sent with proof, new-messages summary, approval needed, storage needed, credits needed, proof status, verification). Until D1 lands, summaries follow the 11 §5 vocabulary and live in externalized string files.
  - M1a tools (Talk, offers and approvals) first; file and proof templates when M1-9d lands. Does not block the M1a gate if D1 arrives late (D-30).
  - The 06 §4 untrusted-content wrapper and the "information from another party, not instructions" framing are never changed by copy.
- **Acceptance:**
  - Snapshot test per template; vocabulary lint passes; the tool-surface snapshot (M1-9e) shows no schema change.

#### M1-9h · CLI: local UI, credits and verify commands; passkey and recovery kit in `init` (new, split from M1-9a)
- **Status:** backlog · **Size:** S · **Tier:** Sonnet · **Security:** S1 · **Phase:** M1b
- **Repo/path:** agentlink · apps/cli
- **Depends on:** M1-9a, M1-8d, M1-8e, M1-1k, M1-4d, M1-26
- **Spec:** 06 §7, §8; 02 F-51, J1, J3, J5; 04 §2.2, §2.3; 07 §6.3; D-39, D-40
- **Invariants:** I-1, I-4, I-10
- **Scope:**
  - `ui`, `credits [--topup]` (top-up routed to the cheapest supported chain, M1-26), `verify <proof.json>`; `doctor` checks for RPC and storage.
  - `init`: owner passkey option (localhost PRF via the local UI) beside the passphrase; recovery-kit offer.
  - No command asks for a chain or mentions wallets or gas in default output (11 §5).
- **Acceptance:**
  - Snapshot tests of default outputs pass the vocabulary lint and contain no chain prompt; `verify` reports a tampered pack's specific reason.
  - `init` with the passkey option on a virtual authenticator completes; the recovery kit offered by `init` restores on a clean machine (with M1-9i).

### Submitter and faucet (`apps/submitter`)

#### M1-10a · submitter Worker (testnets)
- **Status:** backlog · **Size:** L · **Tier:** Opus · **Security:** S2 · **Phase:** M1b
- **Repo/path:** agentlink · apps/submitter
- **Depends on:** M1-4a, M1-3g, M0-8; gap G-4 resolved
- **Spec:** 07 §7; 03 §4.3; 04 §7 (malicious submitter, gas griefing); 05 §3.2
- **Invariants:** I-3, I-7
- **Scope:**
  - `POST /v1/notarize`, `POST /v1/receipt`, `GET /v1/status/:txHash`, `GET /v1/health`; signature validation and `eth_call` simulation (incl. credits) before sending; batching per G-4.
  - Per-signer and per-IP rate limits and per-chain transaction-nonce serialisation in Durable Objects; gas keys only from Worker secrets.
  - No request logging beyond aggregate metrics; never signatures together with IPs. `/v1/deposit-authorization` present but disabled until M3-4b.
- **Acceptance:**
  - Miniflare tests per endpoint: invalid signature, insufficient credits (rejected before sending), rate limit, concurrent nonce handling.
  - Testnet integration with M1-4c; captured logs contain no IPs or signatures; `/v1/health` reports gas balances and queue depth.

#### M1-10b · testnet credits faucet
- **Status:** backlog · **Size:** S · **Tier:** Opus · **Security:** S2 · **Phase:** M1b
- **Repo/path:** agentlink · apps/submitter (faucet route)
- **Depends on:** M1-10a
- **Spec:** 05 §9 (faucet); 03 §4.4; 10 M1-10; `release-and-deployment.md` §4.5
- **Invariants:** I-3
- **Scope:**
  - Endpoint calling `depositFor(agent, token, amount)` on Base Sepolia and Chiado only (hard-coded testnet chain-ID allowlist); its own key.
  - Rate limits per agent address and per IP plus a global daily cap (new identities are free, so per-agent limits alone are not enough).
- **Acceptance:**
  - A mainnet chain ID is rejected (test); a repeat inside the window is rejected; the global cap holds.

#### M1-10c · submitter and faucet deploy pipeline (new sub-task)
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2 · **Phase:** M1b
- **Repo/path:** agentlink · .github/workflows/deploy-submitter.yml, apps/submitter/wrangler config
- **Depends on:** M1-10a, M1-10b, M0-2g; gap G-40 resolved
- **Spec:** `release-and-deployment.md` §1, §4.5, §5, §8; D-28
- **Invariants:** I-3, I-7
- **Scope:**
  - CI-only `wrangler deploy`; staging on `workers.dev` previews; beta hostname `submit.agentlink.4thtech.io` (testnets) per the environment mapping fixed in G-40.
  - Gas and faucet keys set by the owner with `wrangler secret put`; never in GitHub, logs or sync files.
- **Acceptance:**
  - **Deploy (D-25):** staging deploy on merge; smoke test (health + simulated notarize per chain); production after the owner's approval click (`production` environment); health check after deploy with automatic `wrangler rollback` on failure (rehearsed); deploy record written; nothing runs while `DEPLOY_FREEZE` is set.

### Local approval UI (`apps/cli` local UI)

#### M1-11a · local UI: owner setup and approvals
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2 · **Phase:** M1b
- **Repo/path:** agentlink · apps/cli (local UI bundle)
- **Depends on:** M1-8d, M1-8e; gap G-32 resolved
- **Spec:** 08 §1; 11 §6.2 (first run, approval); 02 J4; 04 §2.5
- **Invariants:** I-4, I-5
- **Scope:**
  - First run: create the owner passkey (PRF) on `localhost`, or set the owner passphrase.
  - Approval page: who, what, cost and the policy rule in plain words; approve/deny with presence → owner-signed approval; "Remember for this contact" (new-contact and proof-limit approvals only, 11 §8) creates an owner-signed policy change (G-32).
  - Untrusted strings (contact names, file names) rendered as text only.
  - Before DESIGN-D1 lands: functional and unstyled, strings externalized, no invented visual design (`docs/design/README.md`). Styling is M1-11b.
- **Acceptance:**
  - Playwright with a virtual authenticator (PRF) completes J4; approval without presence is impossible.
  - XSS payloads in contact and file names render inert; a PRF-less authenticator falls back to the passphrase.

#### M1-11c · local UI: settings pages
- **Status:** backlog · **Size:** M · **Tier:** Sonnet · **Security:** S1 · **Phase:** M1b
- **Repo/path:** agentlink · apps/cli (local UI bundle)
- **Depends on:** M1-11a, M1-9b, M1-9i, M1-26
- **Spec:** 08 §1 (pages); 11 §6.2; 10 M1-11
- **Invariants:** I-4, I-10
- **Scope:**
  - Activity; Contacts (safety-code compare, block); Files (allowed folders with resolved paths, inbox folder, expiry); Storage (connect, test); Proofs & credits (balances, agent address QR, faucet button on testnets); Policies (plain-language rules → owner-signed, incl. `commitments` limits); Backup (recovery kit export/restore); Advanced (fingerprints, relays, RPCs, chains; the only place a chain can be chosen, D-40).
  - All owner operations call M1-8c / M1-8e / M1-9b / M1-9i APIs; no new crypto or signing code in the UI.
  - Before DESIGN-D1 lands: functional and unstyled, strings externalized, no invented visual design. Styling is M1-11b.
- **Acceptance:**
  - Playwright flow per page; every mutating action requires presence; default views pass the vocabulary lint.

#### M1-11b · local UI: apply design drop D1 (new)
- **Status:** backlog · **Size:** M · **Tier:** Sonnet (Opus for the passkey, approval and policy screens) · **Security:** S1 (S2 where a change touches owner-presence or approval flows) · **Phase:** M1b
- **Repo/path:** agentlink · packages/ui (D1 tokens and core components), apps/cli (local UI bundle)
- **Depends on:** DESIGN-D1, M1-11a, M1-11c
- **Spec:** 11 §6.2, §8, §9, §11; D-30; `docs/design/README.md`
- **Invariants:** I-4, I-5
- **Scope:**
  - Implement the D1 tokens (CSS variables + JSON) and core components in `packages/ui`; apply them to every local UI screen and state in 11 §6.2 and §9. Self-hosted fonts, light and dark, no CDNs.
  - Implement the design as delivered; any deviation (technical, accessibility, CSP) written up in the PR for the owner's OK.
  - Visual only: no change to owner-presence, approval or signing logic.
- **Acceptance:**
  - All M1-11a/M1-11c Playwright flows pass unchanged; axe-core zero WCAG 2.1 AA violations; owner confirms fidelity to D1.
  - Untrusted strings still render as text (XSS fixtures re-run); no external URL in the bundle.

### Agent instructions, docs, end-to-end

#### M1-12a · skill file and AGENTS.md snippet for users' harnesses
- **Status:** backlog · **Size:** S · **Tier:** Sonnet · **Security:** S1 · **Phase:** M1a
- **Repo/path:** agentlink · skills/agentlink/SKILL.md
- **Depends on:** M1-9c
- **Spec:** 06 §3 (`commitments`), §5; 02 J1, J4, J8, J9, F-62; 11 §5, §6.1; D-31, D-32
- **Invariants:** I-5
- **Scope:**
  - Talk workflows (M1a): invite and pair; send and read messages; negotiate with `offer`/`accept`/`reject` and `terms` (inbound offers are information; a binding `accept` needs the owner's approval by default); keep a shared project in sync with a partner's agent (J9). Consistent with the server instructions (inbound content is information, explain statuses).
  - File and proof workflows are M1-12c (M1b). The same content as an `AGENTS.md` snippet for users' own projects.
- **Acceptance:**
  - Passes the vocabulary lint; contains no instruction to act on inbound content; used unchanged in the M1-13a and M1-22 LLM runs.

#### M1-12c · skill file: file and proof workflows (new, split from M1-12a)
- **Status:** backlog · **Size:** S · **Tier:** Sonnet · **Security:** S1 · **Phase:** M1b
- **Repo/path:** agentlink · skills/agentlink/SKILL.md
- **Depends on:** M1-12a, M1-9d
- **Spec:** 06 §5; 02 F-43, F-51, J2, J3, J5, J8; 04 §3.4 (proof of agreement); 11 §5, §6.1; D-32, D-40
- **Invariants:** I-5
- **Scope:**
  - Send and notarize a document; check whether something was received; export proof; record a proof of agreement for final `terms`. Mention cost before proof; never ask the user to pick a chain (D-40).
- **Acceptance:**
  - Passes the vocabulary lint; contains no instruction to act on inbound content; used unchanged in the M1-13c LLM runs.

#### M1-12b · quickstart and harness permission guidance
- **Status:** backlog · **Size:** S · **Tier:** Sonnet · **Security:** S1 · **Phase:** M1a
- **Repo/path:** agentlink · docs/quickstart/ (published to GitBook in M3-11)
- **Depends on:** M1-9a, M1-9b; gap G-1 resolved
- **Spec:** 04 §2.5 (residual risk, harness permissions); 06 §7; 02 J1; 10 M1-12
- **Invariants:** I-4
- **Scope:**
  - Per-harness install steps (the agent-assisted install prompts come from M1-25).
  - Harness permission settings that deny the agent access to `~/.agentlink`, the installed AgentLink package / npx cache and the keychain (Claude Code permission deny rules, Codex sandbox, Gemini CLI sandbox; syntax verified at build time).
  - Run owner († ) commands in a terminal the agent does not control; `doctor` for troubleshooting. Local UI, storage and credits sections are M1-12d (M1b).
- **Acceptance:**
  - Tali and Denis install from the docs alone for the J9 dogfood (M1-23), times recorded.
  - Each permission snippet is shown to block an agent's attempt to read `~/.agentlink` (transcript in PR).

#### M1-12d · quickstart: local UI, storage, credits and proof (new, split from M1-12b)
- **Status:** backlog · **Size:** S · **Tier:** Sonnet · **Security:** S1 · **Phase:** M1b
- **Repo/path:** agentlink · docs/quickstart/
- **Depends on:** M1-12b, M1-11a, M1-9h, M1-9i
- **Spec:** 04 §2.5; 06 §7; 02 F-51, J1–J5; 10 M1-12; D-39, D-40
- **Invariants:** I-4
- **Scope:**
  - Local UI and passkey setup, storage connect, credits (keep them small; faucet on testnets), proofs and verification. No wallet, extension, gas or chain choice in any default step.
- **Acceptance:**
  - Two people new to AgentLink complete J1 from the docs alone (observed, times recorded; install → first message under 5 minutes).

#### M1-13a · e2e: two agents on two harnesses
- **Status:** backlog · **Size:** M · **Tier:** Sonnet · **Security:** S1 · **Phase:** M1a
- **Repo/path:** agentlink · e2e/, .github/workflows/e2e.yml
- **Depends on:** M1-9c, M1-12a; DECISION NEEDED: where e2e runs and how its credentials are held (`development-process.md` §10)
- **Spec:** 10 M1-13; 06 §9; 02 J1, J9
- **Invariants:** I-1, I-2, I-5
- **Scope:**
  - Scripted scenario, agent A (Claude Code headless) ↔ agent B (Codex), isolated environments: pair and message (M1a). File and proof steps are M1-13c (M1b).
  - Deterministic SDK-driven variant of the same scenario (local relays) for every PR; LLM-driven variant on a schedule; credentials never exposed to PR workflows.
- **Acceptance:**
  - Deterministic variant green on PRs within 15 minutes; LLM variant pass rate reported per run.
  - Canary scan of all e2e logs and artifacts finds no plaintext or keys.

#### M1-13c · e2e: files, proof and proof of agreement (new, split from M1-13a)
- **Status:** backlog · **Size:** L · **Tier:** Sonnet · **Security:** S1 · **Phase:** M1b
- **Repo/path:** agentlink · e2e/, .github/workflows/e2e.yml
- **Depends on:** M1-13a, M1-22, M1-9d, M1-10c, M1-11a, M1-12c
- **Spec:** 10 M1-13; 06 §3, §9; 02 F-43, F-51, J2–J5, J8; 04 §3.4 (proof of agreement); 07 §6.3; D-31, D-32, D-40
- **Invariants:** I-1, I-2, I-5, I-6
- **Scope:**
  - Extends the M1-13a scenario: 5 MB file, notarize, DELIVERED and OPENED, export and verify the proof pack.
  - J8 with proof of agreement: extends M1-22; the final `terms` are notarized, the counterparty's ACCEPTED receipt is signed after owner approval, and the exported pack verifies as a proof of agreement.
  - Deterministic variant on local relays, MinIO and testnets or anvil forks; LLM variant on a schedule.
- **Acceptance:**
  - Deterministic variant green on PRs within 15 minutes; LLM variant pass rate reported per run; no chain is chosen by hand anywhere in the scenario (D-40).
  - Canary scan of all e2e logs and artifacts finds no plaintext, keys or presigned URLs.

#### M1-13b · prompt-injection suite
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S1 · **Phase:** M1a
- **Repo/path:** agentlink · e2e/prompt-injection/
- **Depends on:** M1-9c, M1-21
- **Spec:** 06 §4, §9; 04 I-5, §7
- **Invariants:** I-5
- **Scope:**
  - Corpus over the Talk and approval tools: tool-like instructions, `</untrusted_content>` variants (case, whitespace, Unicode look-alikes), fake `[AgentLink]` headers, invite links, control and bidi characters, oversized bodies, instruction strings in JSON bodies and in `terms` fields.
  - Deterministic assertions on our code; an LLM-in-the-loop run as an observational report. File and proof tools are M1-13d (M1b).
- **Acceptance:**
  - For every corpus item: wrapped and escaped in text and `structuredContent`; no tool call issued by our code; no inbound bytes in descriptions, instructions or errors.
  - The LLM report is reviewed before the M1a dogfood starts (M1-23).

#### M1-13d · prompt-injection suite: file and proof tools (new, split from M1-13b)
- **Status:** backlog · **Size:** S · **Tier:** Opus · **Security:** S1 · **Phase:** M1b
- **Repo/path:** agentlink · e2e/prompt-injection/
- **Depends on:** M1-13b, M1-9d
- **Spec:** 06 §4, §9; 04 I-5, §4, §7
- **Invariants:** I-5
- **Scope:**
  - The M1-13b corpus plus file paths, hostile file names and hostile proof packs, run against the file and proof tools.
- **Acceptance:**
  - For every corpus item: wrapped and escaped in text and `structuredContent`; no tool call issued by our code; no inbound bytes in descriptions, instructions or errors.
  - The LLM report is reviewed at M1-GATE.

### Cross-cutting M1 (new)

#### M1-15 · Security utilities: SSRF-safe fetch, path guard, filename sanitiser (new)
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S1 · **Phase:** M1b
- **Repo/path:** agentlink · packages/node (DNS-pinned fetch), packages/core (pure checks)
- **Depends on:** M0-2d
- **Spec:** 04 §4 (SSRF, allowed folders, downloads), §7; 06 §2.3
- **Invariants:** I-2, I-5
- **Scope:**
  - Fetch: `https` only; resolve DNS and reject loopback, private, link-local (incl. `169.254.169.254`), unique-local, CGNAT, multicast, unspecified and IPv4-mapped IPv6; connect to the checked IP (no re-resolution); ≤ 2 redirects, each re-checked; byte cap; timeouts. Workers semantics per G-14.
  - Paths: `realpath` on both sides, must stay inside an allowed folder; hidden files and anything under `~/.ssh`, `~/.agentlink` and keychain directories always refused.
  - File names: strip directories and control characters, no leading dots, Windows reserved names.
- **Acceptance:**
  - Table tests: `http://`, `https://127.0.0.1`, decimal/octal/hex IP forms, `[::ffff:127.0.0.1]`, a hostname resolving to 10.x, DNS that changes between resolution and connect, a redirect chain to the metadata IP, a third redirect.
  - A symlink inside an allowed folder pointing to `~/.ssh` is refused; Windows path tests run in CI.

#### M1-16 · npm release pipeline activation (new)
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S1 · **Phase:** M1a
- **Repo/path:** agentlink · .github/workflows/release.yml, .changeset/
- **Depends on:** M0-2d, M0-2e
- **Spec:** 04 §7 (supply chain); `release-and-deployment.md` §4.1; `ci-cd.md` §4–§5
- **Invariants:** —
- **Scope:**
  - Activate the prepared `release.yml`: Changesets versioning; trusted publishing (OIDC) with provenance; prereleases to `next` automatically on merge (`publish-next`, environment `npm-next`); stable releases to `latest` only after the owner's approval click (`publish-latest`, environment `npm-publish`).
  - Tarball allowlist (`files`) and size check; SBOM attached to the GitHub release; dry-run on a throwaway package first.
- **Acceptance:**
  - A `next` prerelease of `@agentlink/types` with provenance visible on npm.
  - A workflow run from a fork or a non-`main` ref cannot publish (demonstrated).
  - Release checklist includes "update the README Status and roadmap; never claim unimplemented features".
  - **Deploy (D-25):** `publish-latest` waits for the owner's approval click; the post-publish health check moves `latest` back automatically on failure; nothing publishes while `DEPLOY_FREEZE` is set.

#### M1-17 · External audit procurement (new)
- **Status:** backlog · **Size:** S · **Tier:** Owner (Sonnet drafts the RFP) · **Security:** S0 · **Phase:** M1b
- **Repo/path:** agentlink-ops · audits/procurement/
- **Depends on:** M1-3a (interfaces stable enough to size the scope)
- **Spec:** 05 §8; 04 §8.5; 10 M3-1; `audit-rules.md` §8
- **Invariants:** —
- **Scope:**
  - RFP: contracts (`OCCFeeVault`, `OCCNotary`, `OCCRegistry`, deploy scripts) for an external firm; independent review of `@agentlink/crypto` and `@agentlink/core`, and whether to include `packages/node` owner paths and console identity (owner decision).
  - Estimated nSLOC, code-freeze date, deliverables (report, fix review), budget. Book early: firms schedule weeks to months ahead.
- **Acceptance:**
  - RFP sent to ≥ 3 firms; ≥ 2 quotes received; signed engagement with dates before M3 starts; code-freeze date fed into M2 planning.

#### M1-18 · Default relay set and optional 4thTech relay (new)
- **Status:** backlog · **Size:** M · **Tier:** Sonnet · **Security:** S1 · **Phase:** M1a
- **Repo/path:** agentlink · packages/transport-nostr (defaults); agentlink-ops · relay/ (optional relay)
- **Depends on:** M1-5b; DECISION NEEDED: `agentlink-ops` pipeline (`release-and-deployment.md` §4.7)
- **Spec:** 07 §4.2 (relays, retention); 03 §2; 08 §6
- **Invariants:** I-3
- **Scope:**
  - Evaluate public relays: kind 1059 accepted, NIP-42 AUTH for kind 1059 reads, NIP-11 `max_message_length` ≥ 64 KB, retention, uptime. Choose a default set of 3–5.
  - Optional (not on the M1 critical path): 4thTech strfry relay, 30-day retention for kind 1059, AUTH-gated reads, no content logging.
- **Acceptance:**
  - Evaluation table committed with test dates; the default set passes the M1-5b/M1-5c suites.
  - If deployed, the 4thTech relay passes the same suites and its logs contain no event contents.

#### M1-19 · Invite host: static how-to-install page (new)
- **Status:** backlog · **Size:** S · **Tier:** Sonnet · **Security:** S1 · **Phase:** M1a
- **Repo/path:** agentlink · apps/invite (static placeholder)
- **Depends on:** M0-2g
- **Spec:** 04 §3.6 (static page until M2); 08 §4; D-28
- **Invariants:** I-2
- **Scope:**
  - Until M2-5b, the invite host serves a static how-to-install page at `agentlink.4thtech.io` (invite links `https://agentlink.4thtech.io/i#<payload>`). No script reads or transmits the fragment; no analytics; `Referrer-Policy: no-referrer`; CSP per 08 §2.3.
  - Functional and unstyled, strings externalized, no invented visual design until DESIGN-D1 (which includes the invite placeholder) lands; then restyled in a follow-up PR under this card.
- **Acceptance:**
  - Playwright asserts no request carries the fragment; headers verified on staging.
  - **Deploy (D-25):** staging deploy on merge; smoke test; production after the owner's approval click; health check with automatic rollback to the previous artifacts; deploy record; halted by `DEPLOY_FREEZE`.

### Walking skeleton, negotiation and UX (D-31…D-41) (new)

#### M1-20 · Commitments policy: owner approval for binding accepts and receipts (D-31) (new)
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2 · **Phase:** M1a
- **Repo/path:** agentlink · packages/types (policy schema), packages/core (policy engine)
- **Depends on:** M1-7d, M1-21
- **Spec:** D-31, D-32; 06 §3 (`commitments` policy and its "Commitments (D-31)" paragraph; open there: whether a notarized `offer` is also a commitment), §2.2, §2.4 (`send_message` type `accept`, `acknowledge`); 04 §2.5 (Commitments), §3.4 (`terms` checks); 02 F-61, F-62, J8
- **Invariants:** I-4, I-5
- **Scope:**
  - New `commitments` policy, default `approval`, covering: sending a binding `accept` (one that answers an `offer` with `terms`), and signing an on-chain `ACCEPTED` or `REJECTED` receipt (the receipt side is applied by M1-7g in M1b).
  - Owner-signed relaxations only: auto-accept within limits (contact allowlist, maximum value taken from the `terms` price). Anything the limits cannot evaluate (no price, a different currency, unparsable terms) → `approval` (fail closed).
  - Schema, defaults and the pure rule in the engine; the approval request shows the counterparty (self-declared or safety-checked), a `terms` summary and the `termsHash`.
- **Acceptance:**
  - Tests first; table-driven tests: default → `pending_approval`; allowlisted contact under the limit → allow; over the limit, contact not allowlisted, or unevaluable terms → `approval`.
  - Inbound content can never produce a binding `accept` or a receipt without the owner: it cannot change policy or limits (I-4, I-5); a policy row edited in the store is ignored.
  - Defaults snapshot test cites the 06 §3 `commitments` defaults.

#### M1-21 · `terms` schema and `termsHash` vectors (D-32) (new)
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2 · **Phase:** M1a
- **Repo/path:** agentlink · packages/types (schema), packages/crypto (hash helper), test-vectors/, tools/vectors/generators/
- **Depends on:** M1-2a, M1-1a, M0-9
- **Spec:** D-32; 02 F-22, J8; 04 §3.1 (JCS), §3.4 (`terms` and `termsHash`; `offer`, `accept`, `reject`; proof of agreement); 06 §2.2 (`send_message` validation)
- **Invariants:** I-5, I-8
- **Scope:**
  - Strict zod schema for `terms` (parties, deliverables, price, deadlines, validity) as the body of `offer`, `accept` and `reject` payloads; an `accept` or `reject` binds to the exact terms it answers through `termsHash` (04 §3.4).
  - `termsHash` helper exactly per 04 §3.4; inbound `terms` are untrusted data (sizes, string lengths and list lengths bounded).
  - Vectors (canonical inputs, hashes, rejected inputs) generated by a session that does not implement the schema, under the M1-1h rules.
- **Acceptance:**
  - Round-trip and strictness tests; property fuzzing raises only validation errors; vectors pass in Node, browsers and Workers.
  - The hash is canonical (key order and whitespace do not change it; any covered field does); an `accept` whose `termsHash` does not match the offer it answers is rejected.

#### M1-22 · e2e: J8 negotiate and agree over Talk (new)
- **Status:** backlog · **Size:** M · **Tier:** Sonnet · **Security:** S1 · **Phase:** M1a
- **Repo/path:** agentlink · e2e/
- **Depends on:** M1-13a, M1-9b, M1-9c, M1-12a, M1-20, M1-21
- **Spec:** D-31, D-32; 02 F-22, F-61, F-62, J8; 06 §2.2, §3 (`commitments`), §4; 04 §2.5, §3.4
- **Invariants:** I-4, I-5
- **Scope:**
  - Deterministic scenario on the M1-13a harness: A sends an `offer` with `terms`; B counters with a new `offer`; A's binding `accept` → `pending_approval` under the default `commitments` policy → owner approves via the CLI (passphrase through a test TTY) → `accept` delivered; both sides hold the same `termsHash`. A `reject` path.
  - The same with an owner-signed auto-accept limit: inside the limit no approval; outside → approval.
  - LLM-driven variant (Claude Code ↔ Codex) on a schedule, observational. No on-chain proof here; proof of agreement is M1-13c (M1b).
- **Acceptance:**
  - Deterministic variant green on PRs; no binding `accept` leaves A without an owner-signed approval or a matching owner-signed limit (asserted on relay traffic).
  - Inbound `terms` reach the harness wrapped as untrusted content (06 §4); canary scan of logs finds no plaintext.

#### M1-23 · J9 dogfood: Tali's and Denis's agents sync through AgentLink (M1a gate) (new)
- **Status:** backlog · **Size:** S · **Tier:** Sonnet (setup notes) + Owner (with @denisjazbec) · **Security:** S1 · **Phase:** M1a
- **Repo/path:** owner's sync file (dogfood log); issues as backlog cards. No synced project content is committed.
- **Depends on:** all M1a cards except DESIGN-D1 and M1-9g (D-30); in particular M1-13b, M1-16, M1-22, M1-25
- **Spec:** D-33; 02 J8, J9; 06 §7.1 (install prompts); 10 "Gate M1a"
- **Invariants:** I-1, I-4, I-5
- **Scope:**
  - Install the `next` prerelease on both machines (Claude Code and Codex) with the agent-assisted install (M1-25); harness permission rules from M1-12b applied; owner passphrases set in terminals the agents do not control.
  - Pair the two agents (safety codes compared); a project-status sync workflow from the skill file (M1-12a) used in daily work; a J8 negotiation over Talk with owner approval of the binding `accept`.
  - No milestone audit at M1a; the per-card S1/S2 reviews are the control.
- **Acceptance:**
  - M1a gate: both agents paired and syncing project status through AgentLink; a J8 negotiation completed over Talk without on-chain proof.
  - No wallet, extension, gas or chain choice appeared in either setup (D-39); dogfood log (dates, harnesses, versions, issues filed) and owner sign-off recorded.

#### M1-24 · Product name and trademark check before the production domain (D-38) (new)
- **Status:** backlog · **Size:** S · **Tier:** Owner (Sonnet prepares search material) · **Security:** S0 · **Phase:** M1b
- **Repo/path:** agentlink-ops · legal/ (search results); decision log update in agentlink · docs/foundation/00-README.md (owner PR)
- **Depends on:** M0-4
- **Spec:** D-14, D-28, D-38
- **Invariants:** —
- **Scope:**
  - Check the product name (D-14) for trademark conflicts in the target markets and for domain availability, with counsel where needed, before M2-10 chooses the production domain: owner passkeys bind to that domain, so a later rename forces a passkey migration.
  - Start as early as possible (it may run during M1a); searches and counsel take weeks.
- **Acceptance:**
  - Search results and the go/no-go recorded privately; the name confirmed or changed in the decision log before M2-10 is decided.

#### M1-25 · Agent-assisted install: install prompts per harness (D-39) (new)
- **Status:** backlog · **Size:** M · **Tier:** Sonnet · **Security:** S1 · **Phase:** M1a
- **Repo/path:** agentlink · docs/quickstart/, skills/agentlink/SKILL.md, apps/cli (`init`)
- **Depends on:** M1-9a, M1-12a, M1-12b, M1-16
- **Spec:** D-39; 06 §7, §7.1 (install prompts); 02 F-01, F-09, J1; 04 §2.5; 11 §5
- **Invariants:** I-1, I-4
- **Scope:**
  - A copy-paste install prompt per harness (Claude Code, Codex, Gemini CLI; printed snippets for the others) in the docs and in `SKILL.md`: the user's own agent runs `npx @4thtech/agentlink init`, which detects the harness, shows the exact config diff and asks for confirmation; the agent relays the diff to the user and confirms only what the user approved.
  - Owner setup stays presence-gated: the user enters the owner passphrase in a terminal the agent does not control (TTY only, M1-8c); the prompt tells the agent to hand the user that one step and never to ask for the passphrase (04 §2.5).
  - Adding the MCP is the only setup step (D-39): no account, wallet, extension, gas or chain choice.
- **Acceptance:**
  - On fresh machines, a user's agent installs AgentLink from the prompt alone, in under 5 minutes, on Claude Code, Codex and Gemini CLI (transcripts or recordings with times in the PR).
  - `init` writes no harness config without an explicit confirmation, and owner setup refuses non-TTY input (tests); prompts pass the vocabulary lint.

#### M1-GATE · Milestone 1 gate: internal audit and user testing
- **Status:** backlog · **Size:** M · **Tier:** Opus (audit session) + Owner (sign-off) · **Security:** S2 · **Phase:** M1b
- **Repo/path:** private audit store (`audit-rules.md` §4.5); summary in the owner's sync file
- **Depends on:** all M1 cards (M1a and M1b)
- **Spec:** 10 Gate M1; 02 J8, F-43, F-51; D-32, D-33, D-39, D-40; 04 §1, §3.4 (proof of agreement), §7; `audit-rules.md` §7
- **Invariants:** I-1 … I-10
- **Scope:**
  - Internal milestone audit by a fresh Opus session: invariant walkthrough I-1…I-10 with evidence; every 04 §7 threat row; dependency and licence audit; findings register; public-repo boundary sweep (incl. `sync`); process check (strict mode, gate bypasses, S1/S2 review evidence). M1 additions: same-OS-user test, prompt-injection suite, testnet contracts and faucet.
  - User testing: 10 internal testers on ≥ 3 harness combinations complete J1, J2, J4 and J5 on testnets, and J3 with faucet credits, plus J8 with on-chain proof of agreement; measured per G-21.
- **Acceptance:**
  - Audit report with a verdict per invariant and zero open Critical/High findings.
  - Testing log: testers × journeys × harness combinations, with issues filed as cards; J8 completed with on-chain proof of agreement (D-32).
  - UX (D-39, D-40): no wallet, browser extension, gas or chain choice appears anywhere in the J1–J9 default flows; install → first message stays under 5 minutes (median, per G-21).
  - README Status and roadmap updated to the state at this point; README never claims unimplemented features.
  - Owner sign-off recorded.

---

## 4. M2 — Owner console, desktop apps, self-host, design

Goal (10 M2): owner console, signed desktop apps for macOS, Windows and Linux (D-36, D-41), self-host template, verified registration with domain verification (D-34), public verify and invite pages with browser view-and-accept for counterparties (D-35), all on testnets, styled from the Claude Design deliverables. Gate: `M2-GATE` (external early adopters). Beta hostnames under `agentlink.4thtech.io` (D-28); production domain TBD (owner chooses and registers, M2-10).

### Design system (`packages/ui`)

#### M2-1a · ui: design tokens, theming, i18n foundation
- **Status:** backlog · **Size:** M · **Tier:** Sonnet · **Security:** S1
- **Repo/path:** agentlink · packages/ui
- **Depends on:** DESIGN-D2, M1-11b (D1 tokens already in `packages/ui`)
- **Spec:** 11 §11, §13; 03 §6; D-30
- **Invariants:** —
- **Scope:**
  - Complete the token set from D2 (colour, type, spacing, radius, elevation) as CSS variables and JSON, extending the D1 tokens; light and dark themes; self-hosted fonts.
  - String externalisation (English first; localised dates and currency); static component catalogue.
- **Acceptance:**
  - Token diff test against the design export; no external URL in built CSS/JS (CI grep); light/dark snapshot tests.

#### M2-1b · ui: component library
- **Status:** backlog · **Size:** L · **Tier:** Sonnet · **Security:** S1
- **Repo/path:** agentlink · packages/ui
- **Depends on:** M2-1a, DESIGN-D2
- **Spec:** 11 §8, §9, §11; 10 M2-1; D-30
- **Invariants:** I-5
- **Scope:**
  - Proof badge (all states), receipt timeline, contact card (self-declared / safety-checked / registered), safety-code compare, approval card, cost chip, file card, agent chip, empty states, network status; every state in 11 §9.
  - Untrusted strings rendered as text only (no raw HTML injection); Trusted Types compatible.
- **Acceptance:**
  - Owner confirms visual match to the design; axe-core reports zero WCAG 2.1 AA violations; keyboard-navigation tests; no colour-only status (icon + label test).
  - XSS fixture strings render inert in every component.

### Owner console (`apps/console`)

#### M2-2a · console: app shell, CSP, origins
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2
- **Repo/path:** agentlink · apps/console
- **Depends on:** M2-1b, M0-2g
- **Spec:** 08 §2, §2.3; 03 §5; 04 §7 (malicious console JS); D-28
- **Invariants:** I-1, I-2, I-3
- **Scope:**
  - Vite + React static PWA; CSP per 08 §2.3 (`default-src 'self'`; `script-src 'self'` with SRI; `connect-src 'self' https: wss:`; Trusted Types; no third-party scripts or analytics).
  - Separate origins `console.`, `verify.`, `invite.`, `pay.agentlink.4thtech.io`; service-worker update policy documented; security headers set by the Worker.
- **Acceptance:**
  - Automated header test on the staging preview; the bundle contains no external URLs; a Trusted Types violation is blocked (test).
  - A page on the `pay.` origin cannot read console storage (origin-isolation test).

#### M2-2b · console: owner identity (passkey PRF), relay backup, restore, recovery kit
- **Status:** backlog · **Size:** L · **Tier:** Opus · **Security:** S2
- **Repo/path:** agentlink · apps/console
- **Depends on:** M2-2a, M1-1f, M1-5b; gap G-36 resolved
- **Spec:** 04 §2.3; 08 §2.1; 02 F-03, F-04; 11 §6.3
- **Invariants:** I-1, I-4, I-10
- **Scope:**
  - Owner seed generated in the browser; passkey with PRF, `user.id` = owner Nostr pubkey; wrapKey per 04 §2.3; wrapped seed in IndexedDB.
  - Backup as a parameterised-replaceable event (`d` = `agentlink-owner-backup`, kind per G-36) signed by the owner key; new-device restore via passkey sign-in → `user.id` → fetch → PRF unwrap.
  - PRF unavailable: generated recovery code (Argon2id) path; recovery-kit download; raw seed export only under Advanced.
  - RP ID chosen explicitly and recorded; see M2-10 before external testers create passkeys.
- **Acceptance:**
  - Playwright with a virtual authenticator: create → backup → clear storage → restore on a "new device".
  - PRF-less path uses the recovery code; the published blob decrypts only with PRF or the recovery code (test); a user-chosen passphrase is never used for a relay-published blob.

#### M2-2c · console: owner link from the CLI
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2
- **Repo/path:** agentlink · apps/console, apps/cli (`agentlink owner link`)
- **Depends on:** M2-2b, M1-9b; gap G-16 resolved
- **Spec:** 08 §2.1; 04 §2.2, §2.5
- **Invariants:** I-1, I-4
- **Scope:**
  - Protocol written up first (G-16): the console page generates an ephemeral X25519 key; key exchange via QR plus a 6-digit code shown on both sides; the CLI (owner presence required) encrypts the owner seed to the console key; the console wraps it with a new passkey.
- **Acceptance:**
  - A substituted ephemeral key is detected by the code comparison (MITM test); the transfer blob is single-use and expires.
  - Network capture shows the seed (or its transfer ciphertext) reaches no 4thTech service.

#### M2-2d · console: activity, threads, files, proofs, credits view
- **Status:** backlog · **Size:** L · **Tier:** Opus · **Security:** S2
- **Repo/path:** agentlink · apps/console
- **Depends on:** M2-2b, M1-7h, M1-4d; gap G-24 resolved
- **Spec:** 08 §2.2 (Activity, Threads, Proofs, Credits); 07 §4.2 (owner copies); 11 §6.3
- **Invariants:** I-2, I-5, I-9
- **Scope:**
  - Core in the browser with an IndexedDB Store; subscribe with the owner Nostr key on the relays fixed by G-24; decrypt all envelope copies; unified timeline; threads with typed cards.
  - Files downloaded and decrypted in the browser with both hash checks; proof list and detail, export, link to the verify page; credit balances per agent and chain.
  - Untrusted content shown as text with its label.
- **Acceptance:**
  - Two agents' sent and received envelopes appear for their owner (e2e with local relays).
  - File decryption verifies both hashes; captured network traffic contains no decrypted content.

#### M2-2e · console: approvals, policies, agent management
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2
- **Repo/path:** agentlink · apps/console
- **Depends on:** M2-2d, M1-7e; gap G-29 resolved
- **Spec:** 08 §2.2 (Agents, Approvals, Policies); 03 §4.5; 04 §2.5; 02 F-05, F-62, F-63
- **Invariants:** I-4
- **Scope:**
  - `approval-request` envelopes → approval card → owner-signed `approval` envelope back over Talk; policy editor → owner-signed `policy` envelope.
  - Agents list from cards; add agent (owner signs the agent card); revoke (revoke envelope; on-chain revoke when registered, M2-4b).
- **Acceptance:**
  - An agent applies a console-signed policy and rejects one signed by another key (e2e).
  - A console approval unblocks the pending action exactly once; contacts stop accepting a revoked agent's envelopes.

#### M2-2f · deposit page on the `pay.` origin
- **Status:** backlog · **Size:** M · **Tier:** Sonnet · **Security:** S1
- **Repo/path:** agentlink · apps/pay (separate origin)
- **Depends on:** M2-2a, M1-4b
- **Spec:** 08 §2.2 (Credits), §2.3 (separate origin); 03 §4.4; 02 J3; 11 §6.7, §6.8
- **Invariants:** I-1
- **Scope:**
  - Receives only the agent address; browser wallet or WalletConnect `depositFor` in an allowlisted stablecoin (USDC, USDT where available, xDAI on Gnosis; D-46); amounts in USD. The only origin allowed to load a wallet connector.
  - Testnets in M2; mainnet enablement in M3-4a.
- **Acceptance:**
  - Origin test: no access to console storage or owner keys; a testnet deposit credits the agent.
  - **Deploy (D-25)** block as in M2-5a.

#### M2-2g · console: Web Push for approval requests
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2
- **Repo/path:** agentlink · apps/console, apps/cloud-agent
- **Depends on:** M2-2e, M2-3a; gap G-35 resolved
- **Spec:** 08 §2.2 (Push)
- **Invariants:** I-2, I-3
- **Scope:**
  - Owner-generated VAPID keys; the push subscription is delivered only in owner-signed, encrypted config to the owner's own agents (G-35); cloud agents send Web Push directly; no 4thTech push server; local agents fall back to OS notifications.
- **Acceptance:**
  - A cloud agent's approval request produces a push; the payload says only that an approval is waiting (test); no 4thTech endpoint is involved (network capture).

#### M2-2h · console: reproducible build, published hashes, SRI, deploy pipeline
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2
- **Repo/path:** agentlink · apps/console, .github/workflows/deploy-sites.yml
- **Depends on:** M2-2a, M1-16, M0-2g
- **Spec:** 08 §2.3; 04 §7; 03 §5; `release-and-deployment.md` §4.6, §5, §8
- **Invariants:** I-3
- **Scope:**
  - Deterministic build (pinned toolchain and lockfile, fixed timestamps); SRI on all scripts; CI builds twice and compares; hashes published in the GitHub release; build hash shown in Settings. Same pipeline reused by verify, invite, pay and the local UI bundle.
  - Beta at `console.agentlink.4thtech.io`; staging on `workers.dev`.
- **Acceptance:**
  - Two independent CI builds are byte-identical; a script compares deployed asset hashes with the release.
  - **Deploy (D-25):** staging deploy on merge; smoke test (load, CSP headers, hash check); production after the owner's approval click; health check with automatic rollback to the previous hash-identical artifacts; deploy record; halted by `DEPLOY_FREEZE`.

### Cloud agent template (`apps/cloud-agent`)

#### M2-3a · cloud agent: AgentDO, store, relay sync, Worker KeyStore
- **Status:** backlog · **Size:** L · **Tier:** Opus · **Security:** S2
- **Repo/path:** agentlink · apps/cloud-agent
- **Depends on:** M1-7h, M1-8b (schema), M1-5c
- **Spec:** 08 §3.1, §3.2, §3.4; 03 §3; 06 §6
- **Invariants:** I-1, I-2, I-3
- **Scope:**
  - SQLite-backed Durable Object with the local schema; alarm sync every 60 s (configurable) plus WebSocket subscriptions while active.
  - `KeyStore` from the `AGENT_SEED` secret, or from DO storage wrapped with `SEED_WRAP_KEY`; R2 binding as storage; autonomous actions off by default.
- **Acceptance:**
  - Miniflare tests: alarm sync picks up a message; restart is idempotent; the seed never appears in logs or unwrapped in DO storage.

#### M2-3b · cloud agent: remote MCP over streamable HTTP
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2
- **Repo/path:** agentlink · apps/cloud-agent
- **Depends on:** M2-3a, M1-9d; gaps G-14, G-15 resolved
- **Spec:** 06 §1 rule 1; 08 §3.1; 04 §4
- **Invariants:** I-4, I-5
- **Scope:**
  - Cloudflare Agents SDK `McpAgent` (API verified at build time) wrapping the shared tool handlers; identical names and schemas; `fetch_file` semantics and SSRF handling in Workers per G-14.
- **Acceptance:**
  - Tool-surface snapshot identical to the local server (CI); MCP Inspector over HTTP passes; status-value tests re-run against the Worker.

#### M2-3c · cloud agent: OAuth with owner proof
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2
- **Repo/path:** agentlink · apps/cloud-agent, apps/cli (`agentlink cloud login`)
- **Depends on:** M2-3b, M2-2e; gap G-16 resolved
- **Spec:** 08 §3.3; 02 F-71
- **Invariants:** I-4
- **Scope:**
  - `workers-oauth-provider` with PKCE; the authorise page requires owner proof: a console-signed challenge, or a one-time access code from `agentlink cloud login`; tokens scoped to this agent and revocable from the console.
- **Acceptance:**
  - Authorisation without owner proof fails; a replayed challenge fails; the access code is single-use and short-lived; a revoked token is rejected.

#### M2-3d · cloud agent: deploy paths and template repository
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2
- **Repo/path:** agentlink · apps/cloud-agent, apps/cli (`agentlink cloud deploy`); template repo `4thtech/agentlink-cloud-agent`
- **Depends on:** M2-3a, M2-3c; DECISION NEEDED: template sync mechanism (`release-and-deployment.md` §4.8)
- **Spec:** 08 §3.2; 02 J6; `release-and-deployment.md` §4.8
- **Invariants:** I-1, I-3
- **Scope:**
  - `agentlink cloud deploy`: seed generated locally, `wrangler secret put AGENT_SEED` into the user's account, deploy.
  - Deploy-to-Cloudflare button: `/setup` protected by a one-time setup code; seed generated in the Worker and stored in DO wrapped with `SEED_WRAP_KEY`.
  - Owner pairs the agent (owner-signed card). One-way template sync at a release tag; template pins provenance-carrying npm versions and holds no secrets.
- **Acceptance:**
  - Both paths deploy into a test Cloudflare account and complete J6; `/setup` is unusable after first use; captured traffic from the CLI path sends the seed to no 4thTech system.
  - **Deploy (D-25):** template publication only from a release tag, after the owner's approval click; a staging test deployment of the tagged template passes a smoke test (status, send, check inbox) first; a failed check restores the previous template tag; deploy record; halted by `DEPLOY_FREEZE`. 4thTech never deploys into users' accounts.

#### M2-3e · harness connector validation (ChatGPT developer mode, claude.ai)
- **Status:** backlog · **Size:** S · **Tier:** Sonnet · **Security:** S1
- **Repo/path:** agentlink · docs/quickstart/cloud
- **Depends on:** M2-3c
- **Spec:** 10 M2-3; 06 §7; 02 J6
- **Invariants:** —
- **Scope:**
  - Connect a ChatGPT developer-mode connector and a claude.ai custom connector to a deployed Worker; document steps and plan requirements.
- **Acceptance:**
  - Both connectors complete `agentlink_status` → `send_message` → `check_inbox` (transcripts in PR); docs updated.

### Registry and verified badge

#### M2-4a · contracts: OCCRegistry
- **Status:** backlog · **Size:** L · **Tier:** Opus · **Security:** S2
- **Repo/path:** occ-v2-contracts · src/OCCRegistry.sol
- **Depends on:** M1-3e, M1-1h (AgentCard vectors), M1-1i (Registration vectors); gap G-20 resolved
- **Spec:** 05 §4, §5, §6, §7; 04 §2.4, §7 (public-card abuse)
- **Invariants:** I-6
- **Scope:**
  - `register(card, cardOwnerSig, cardAgentSig, reg, regOwnerSig)`: both card signatures over the chain-agnostic AgentCard domain; `regOwnerSig` over `Registration` in the OCC v2 chain domain authorises fees; `REGISTER` fee charged to `card.ownerEvm` through the vault.
  - Higher `keyEpoch` from the same owner replaces the entry; `revoke` with an owner signature (struct per G-20); `getAgent`; events.
  - Registered as a vault module; CREATE3 deployment to both testnets via the M1-3g script (private repo, Free-plan controls apply).
- **Acceptance:**
  - Registering a public card with an attacker-chosen `appId` and no `regOwnerSig` fails; replayed registration and revoke rejected; ERC-1271 owner works.
  - Invariant suite extended (entries change only through owner-signed operations); identical address on both testnets; vector parity green.

#### M2-4b · registration flow and verified badge
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2
- **Repo/path:** agentlink · packages/chain, packages/core, apps/console, apps/cli
- **Depends on:** M2-4a, M2-2e; gap G-19 resolved
- **Spec:** 02 F-12, F-41; 05 §4; 04 §2.4; 11 §8 (contact card)
- **Invariants:** I-4, I-6
- **Scope:**
  - Build and sign `Registration` with owner presence; owner credits per G-19; revoke; contacts read the registry and show the registered badge; otherwise names are labelled self-declared. Console and CLI.
- **Acceptance:**
  - Register and revoke on testnets from the console.
  - The badge shows only when the registry entry matches the contact's current card hash and epoch (test with a stale entry).

### Public pages

#### M2-5a · verify page
- **Status:** backlog · **Size:** M · **Tier:** Sonnet · **Security:** S1
- **Repo/path:** agentlink · apps/verify
- **Depends on:** M1-4d, M2-1b, M2-2h (pipeline)
- **Spec:** 08 §4; 11 §6.4; 02 F-44, J5
- **Invariants:** I-3
- **Scope:**
  - Drop zone, or a pack compressed in the URL fragment; verification in the browser via public RPC; plain-language result with self-declared labels; disclosed-key content check; what it proves and does not prove; print-friendly; Advanced data.
  - Beta at `verify.agentlink.4thtech.io`.
- **Acceptance:**
  - Playwright asserts the fragment is never sent in any request; a testnet pack verifies in ≤ 2 s; a tampered pack shows its specific reason; print snapshot.
  - **Deploy (D-25):** staging deploy on merge; smoke test (verify a known pack, fragment test against staging); production after the owner's approval click; health check with automatic rollback to the previous artifacts; deploy record; halted by `DEPLOY_FREEZE`.

#### M2-5b · invite landing page
- **Status:** backlog · **Size:** M · **Tier:** Sonnet · **Security:** S1
- **Repo/path:** agentlink · apps/invite
- **Depends on:** M1-19, M2-1b, M1-7c (decoder), M2-2h (pipeline)
- **Spec:** 08 §4; 11 §6.5; 02 J7; 04 §3.6; D-28
- **Invariants:** I-2
- **Scope:**
  - Decode the invite locally; show inviter name (self-declared) and fingerprint; harness picker with tailored steps; accept hand-off (copy command, or open the console). No analytics.
  - Replaces the M1-19 page at `agentlink.4thtech.io/i` and `invite.agentlink.4thtech.io`; old links keep working.
- **Acceptance:**
  - The fragment is never transmitted (test); malformed and expired invites handled; inviter name rendered as text.
  - **Deploy (D-25)** block as in M2-5a.

#### M2-6 · Move the local approval UI to the full D2 component library
- **Status:** backlog · **Size:** M · **Tier:** Sonnet · **Security:** S1
- **Repo/path:** agentlink · apps/cli (local UI bundle)
- **Depends on:** M2-1b, M1-11b, M1-11c
- **Spec:** 10 M2-6; 08 §1; 11 §6.2; D-30
- **Invariants:** I-4
- **Scope:**
  - Visual restyle only; no change to owner-operation flows or signing calls.
- **Acceptance:**
  - All M1-11a/M1-11c Playwright flows pass unchanged; axe AA clean; bundle hash published via the M2-2h pipeline.

### Cross-cutting M2 (new)

#### M2-7 · Vulnerability disclosure and incident-response runbooks (new)
- **Status:** backlog · **Size:** S · **Tier:** Sonnet · **Security:** S1
- **Repo/path:** agentlink · SECURITY.md; agentlink-ops · runbooks/
- **Depends on:** M0-2c
- **Spec:** 04 §7; `release-and-deployment.md` §7; `audit-rules.md` §10, §12
- **Invariants:** I-7
- **Scope:**
  - Runbooks (private): leaked secret, compromised npm release, malicious static-site deploy, submitter gas-key compromise, relay outage, testnet contract pause; user communication templates; on-call contacts (DECISION NEEDED, `release-and-deployment.md` §7.2).
- **Acceptance:**
  - Runbooks reviewed by the owner and @denisjazbec; one tabletop exercise (compromised npm release) run and documented before M2-GATE.

#### M2-8 · Onboarding and landing pages ("Connect your AI") (new)
- **Status:** backlog · **Size:** M · **Tier:** Sonnet · **Security:** S1
- **Repo/path:** agentlink · apps/invite (apex landing at `agentlink.4thtech.io`)
- **Depends on:** M2-1b, M1-12b, M1-25, M2-2h (pipeline), DESIGN-D2 (onboarding, 11 §6.6)
- **Spec:** 11 §6.6; 06 §7; 02 J1, J7; D-28, D-29
- **Invariants:** —
- **Scope:**
  - Harness picker; per-harness single command with copy button; success screen. The optional "waiting for your agent" check only if it needs no 4thTech backend; otherwise omitted. Links to GitBook docs once published (M3-11).
- **Acceptance:**
  - Each harness path verified by a tester; no third-party scripts; vocabulary lint passes.
  - **Deploy (D-25)** block as in M2-5a.

#### M2-9 · Owner archive of files (P1) (new)
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2
- **Repo/path:** agentlink · packages/core
- **Depends on:** M1-7f, M2-2d; gap G-22 resolved
- **Spec:** 04 §4 (owner archive); 02 F-33; 06 §3 (`files.ownerArchive`); D-18
- **Invariants:** I-2, I-9
- **Scope:**
  - With `files.ownerArchive: true`, the sender's core re-uploads the ciphertext to the owner's own storage, with the file key available only to the owner key, before the agent copy is deleted (mechanics per G-22).
- **Acceptance:**
  - After expiry the owner can still decrypt the archived file; agent-side copies and keys are shredded as before.

#### M2-10 · Production console domain decision (new, DECISION NEEDED)
- **Status:** ready · **Size:** S · **Tier:** Owner · **Security:** S1
- **Repo/path:** agentlink · docs/foundation/00-README.md (D-14/D-28 update, owner PR)
- **Depends on:** M0-4 (product name), M1-24 (trademark check, D-38)
- **Spec:** D-14, D-28, D-38; 04 §2.3 (passkey `user.id`, PRF); 08 §2.3
- **Invariants:** I-10
- **Scope:**
  - Production domain TBD (owner chooses and registers). Deadline: **before M2-2 reaches external testers**, because owner passkeys are bound to the WebAuthn RP ID of the origin where they are created.
  - If the production console moves to a different domain later: Related Origin Requests plan plus a recovery-kit re-wrap for existing owners. Keep `agentlink.4thtech.io` redirects alive so old invite links work.
- **Acceptance:**
  - Decision recorded; the console's RP ID set accordingly before external testers onboard; if a later move is planned, the migration plan is written and tested on staging.

### Desktop apps, owner identity, counterparty (D-34…D-36, D-41) (new)

Desktop apps (D-36, D-41) are full local dashboards on the same core: tray app hosting the MCP server, native approval window with OS biometrics, harness auto-setup, and every console area via `packages/ui`. M1 ships the `npx` package only.

#### M2-11a · desktop: framework and architecture decision (D-36) (new)
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2
- **Repo/path:** agentlink · decision record plus spec PR (03, 08) for the desktop architecture
- **Depends on:** M1-8d, M1-8e, M1-9c, M1-11a
- **Spec:** D-36, D-39, D-41; 03 §3, §6; 04 §2.2 (desktop row), §2.5 (desktop app owner presence), §7; 08 §1, §8 (desktop apps; framework decision and read-unlock duration open); 06 §7
- **Invariants:** I-1, I-4, I-7
- **Scope:**
  - Compare candidates (e.g. Tauri with a Node sidecar vs Electron) on: isolation between the UI and the key-holding core; how the tray app hosts the MCP server for harnesses; OS keychain access gated by biometrics (Touch ID, Windows Hello; Linux fallback); code signing and notarization; signed auto-update; supply chain (dependency count, native modules, no install scripts); CSP and no remote content; bundle size.
  - Threat model against a same-user agent with shell access (G-1, G-42): how the native approval window and keychain access bound to the signed app stop a tampered install or another process from unlocking the owner key, and what remains on Linux.
  - Output before any shell code: decision record, spec PR, and a scope and estimate check for M2.
- **Acceptance:**
  - Independent security review session, @denisjazbec review and owner approval of the decision; spec PR merged.
  - A spike shows biometric-gated unlock of a keychain item on macOS and Windows that an unsigned or re-signed build cannot use.

#### M2-11b · desktop: shared shell and macOS app (new)
- **Status:** backlog · **Size:** L · **Tier:** Opus · **Security:** S2
- **Repo/path:** agentlink · apps/desktop (layout per M2-11a)
- **Depends on:** M2-11a
- **Spec:** D-36, D-39, D-41; 08 §1, §8 (tray app, harness connection, native approval window, owner key, harness auto-setup); 11 §6.2; 04 §2.2 (desktop row), §2.5; 06 §7
- **Invariants:** I-1, I-4, I-7
- **Scope:**
  - Tray app hosting the MCP server on the same core and node packages (no second implementation); harness auto-setup reusing `init` detection, with each config change shown and confirmed (D-39).
  - Native approval window: owner operations unlock the owner key from the OS keychain only through Touch ID (passphrase fallback) and produce the same owner-signed actions that core verifies. No login (D-39).
  - Keychain access bound to the app's signing identity and to biometry; no remote content, strict CSP, renderer without direct key access.
- **Acceptance:**
  - The M1-8c same-user script test passes against the running app; a modified (unsigned or re-signed) build cannot unlock the owner key (test on macOS).
  - Harness auto-setup configures Claude Code, Claude Desktop, Codex and Gemini CLI after confirmation; J4 completed with Touch ID; install → first message under 5 minutes on a clean macOS VM.

#### M2-11c · desktop: Windows app with Windows Hello (new)
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2
- **Repo/path:** agentlink · apps/desktop
- **Depends on:** M2-11b
- **Spec:** D-36, D-39; 08 §8 (owner key: Windows Hello); 04 §2.2 (desktop row), §2.5
- **Invariants:** I-1, I-4, I-7
- **Scope:**
  - Windows integration of the shared shell: tray, installer, Windows Hello gating the owner key (mechanism per M2-11a), Credential Manager for agent keys, harness auto-setup.
- **Acceptance:**
  - The same-user script test passes; J4 completed with Windows Hello; install → first message under 5 minutes on a clean Windows VM.

#### M2-11d · desktop: Linux app (new)
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2
- **Repo/path:** agentlink · apps/desktop
- **Depends on:** M2-11b
- **Spec:** D-36; 08 §8 (owner key: Linux, weaker); 04 §2.2 (desktop row), §2.5; G-31
- **Invariants:** I-1, I-4, I-7
- **Scope:**
  - Linux integration: tray where the desktop supports it, libsecret keychain (G-31 behaviour without Secret Service), owner presence via the passphrase or a platform authenticator where M2-11a found one; packaging formats per M2-11a.
- **Acceptance:**
  - The same-user script test passes; the weaker Linux residual risk (no OS biometric binding) is stated in the threat note and the quickstart.

#### M2-11e · desktop: code signing and notarization pipeline (new)
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S1
- **Repo/path:** agentlink · .github/workflows (desktop release workflow), apps/desktop build config
- **Depends on:** M2-11b, M2-14, M1-16
- **Spec:** D-36; 08 §8 (code signing and notarization); `release-and-deployment.md` §2, §4.1; `ci-cd.md` §4–§5
- **Invariants:** I-7
- **Scope:**
  - CI builds per OS from tagged releases: macOS Developer ID signing, notarization and stapling; Windows code signing; Linux packages with signatures and checksums; SBOM and provenance attached to the GitHub release.
  - Signing credentials only in the owner-gated release environment, never reachable from PR workflows, forks or non-`main` refs.
- **Acceptance:**
  - Signed builds install without OS security warnings on clean macOS and Windows VMs; published hashes match the artifacts.
  - A fork or non-`main` ref cannot reach signing credentials (demonstrated).
  - **Deploy (D-25):** release waits for the owner's approval click; nothing publishes while `DEPLOY_FREEZE` is set.

#### M2-11f · desktop: auto-update with signature verification (new)
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2
- **Repo/path:** agentlink · apps/desktop (updater), release workflow
- **Depends on:** M2-11e
- **Spec:** D-36; 08 §8 (signed auto-update); 04 §7 (supply chain); `release-and-deployment.md` §2
- **Invariants:** I-1, I-7
- **Scope:**
  - The app verifies each update's signature against a pinned update key before applying it (independent of TLS); no downgrades; a failed update rolls back; staged rollout.
  - Update-key custody offline with the owner; updates published only through the owner-approved release (M2-11e).
- **Acceptance:**
  - Tampered, unsigned, wrongly signed and downgrade updates are refused (tests); rollback after a failed update; the update-key rotation procedure is documented and rehearsed on staging.

#### M2-11g · desktop: full local dashboard (D-41) (new)
- **Status:** backlog · **Size:** L · **Tier:** Sonnet (Opus for the approval, policy and owner-key screens) · **Security:** S1 (S2 where a change touches owner presence, approvals or policy)
- **Repo/path:** agentlink · apps/desktop, packages/ui
- **Depends on:** M2-11b, M2-1b, M2-2d, M2-2e, DESIGN-D2
- **Spec:** D-41, D-36, D-40; 08 §1, §8 (full local dashboard); 07 §6.3; 11 §6.2, §6.3, §9
- **Invariants:** I-4, I-5
- **Scope:**
  - Activity, threads, contacts, approvals, proofs, credits, policies, storage and settings, from `packages/ui` and the console screens (M2-1, M2-2), fed by the local core; replaces the local approval UI inside the app.
  - Untrusted strings rendered as text; no remote content; chain only under Advanced (D-40); owner operations through the native approval window.
- **Acceptance:**
  - A flow test per area; axe-core zero WCAG 2.1 AA violations; XSS fixtures inert; every mutating action requires presence; owner confirms the match to D2.

#### M2-12 · Domain verification for owners (D-34) (new)
- **Status:** backlog · **Size:** L · **Tier:** Opus · **Security:** S2
- **Repo/path:** agentlink · packages/core, packages/chain, apps/console, apps/cli; occ-v2-contracts if the Registry records the claim hash (04 §2.7)
- **Depends on:** M2-4a, M2-4b, M1-15
- **Spec:** D-34; 02 F-07, F-41; 04 §2.7 (domain verification), §2.4, §4 (SSRF); 05 §4; 11 §8 (contact card)
- **Invariants:** I-3, I-4, I-6
- **Scope:**
  - The owner proves control of a domain with a DNS TXT record or a `/.well-known` file bound to the owner key by an owner signature (presence required); ships with OCCRegistry. Record format, publication and checks follow 04 §2.7 (`DomainClaim`; the exact struct is fixed in the M2 Registry task, 05).
  - Clients check claims themselves: `/.well-known` through the SSRF-safe fetch (M1-15); the DNS lookup method and its privacy cost documented; no 4thTech service in the path.
  - Contacts show "domain verified" only after a successful check that matches the current card; otherwise names stay self-declared.
- **Acceptance:**
  - A valid claim shows the badge; a claim for another owner key, a stale card epoch, a removed TXT record and a redirect to a private IP are each rejected (tests); the badge is never shown from data the counterparty merely asserts.

#### M2-13 · Browser counterparty: view and accept from the invite link (D-35) (new)
- **Status:** backlog · **Size:** L · **Tier:** Opus · **Security:** S2
- **Repo/path:** agentlink · web client per 08 §7 (served from the console origin), reusing the console identity code (M2-2b)
- **Depends on:** M2-5b, M2-2b, M2-1b, DESIGN-D2, M1-20, M1-21
- **Spec:** D-35, D-32, D-39; 08 §7 (browser counterparty), §2, §4; 04 §2.3, §3.4 (`terms`), §3.6; 02 F-15, J7, J8
- **Invariants:** I-1, I-2, I-4, I-5
- **Scope:**
  - P1. A counterparty without an agent opens the invite link, sees the inviter (self-declared name, fingerprint) and the offer's `terms`, and accepts or rejects in the browser. Zero install: keys generated in the browser with the console identity model (passkey PRF, recovery code); the binding `accept` needs the person's presence.
  - The fragment is never sent; console origin rules apply (CSP, no third-party scripts, no analytics); inbound `terms` rendered as text.
- **Acceptance:**
  - Playwright: open invite → view terms → accept → the inviting agent receives a valid `accept` with the matching `termsHash`; the fragment is never transmitted; XSS fixtures in `terms` are inert; restore on a second browser from the recovery code.
  - **Deploy (D-25)** block as in M2-5a.

#### M2-14 · Code-signing certificates: Apple Developer ID and Windows (D-36) (new)
- **Status:** backlog · **Size:** S · **Tier:** Owner · **Security:** S1
- **Repo/path:** agentlink-ops · release/ (custody notes); credentials only in the owner-gated release environment
- **Depends on:** — · **Due:** start during M1b (enrolment and validation take weeks); needed by M2-11e
- **Spec:** D-36; 08 §8 (code signing and notarization); `release-and-deployment.md` §2
- **Invariants:** I-7
- **Scope:**
  - Apple Developer Program enrolment as an organisation, a Developer ID Application certificate and notarization credentials; a Windows code-signing certificate (type per M2-11a).
  - Custody on a hardware token or a cloud signing service, never on a workstation disk.
- **Acceptance:**
  - Certificates issued; custody recorded privately; a test signature from the CI release environment verifies (with M2-11e).

#### M2-GATE · Milestone 2 gate: internal audit and external testing
- **Status:** backlog · **Size:** M · **Tier:** Opus (audit session) + Owner (sign-off) · **Security:** S2
- **Repo/path:** private audit store; summary in the owner's sync file
- **Depends on:** all M2 cards; M2-10 before external testers start
- **Spec:** 10 Gate M2; 02 §7; `audit-rules.md` §7
- **Invariants:** I-1 … I-10
- **Scope:**
  - Internal milestone audit (parts A–F of `audit-rules.md` §7) plus the M2 additions: web checklist on console, verify, invite and pay; cloud agent; Registry.
  - External testing: 20–50 early adopters on testnets; UX metric "install → first message < 5 minutes" (median) measured per G-21.
- **Acceptance:**
  - Zero open Critical/High findings; per-invariant verdicts.
  - README Status and roadmap updated to the state at this point; README never claims unimplemented features.
  - UX (D-39…D-41): no wallet, browser extension, gas or chain choice appears anywhere in the J1–J9 default flows (CLI, desktop apps, console, browser counterparty); install → first message stays under 5 minutes (median).
  - Adopter count and the measured median recorded; issues filed as cards; owner sign-off.

---

## 5. M3 — Mainnet beta

Goal (10 M3): audited contracts on Base and Gnosis, governance in Safes with timelocks, paid notarization with credits and gasless USDC. Gate: `M3-GATE` (first paid notarizations, zero security incidents). Mainnet contract deploys, upgrades, configuration and production secrets are manual and owner-only in every model (`release-and-deployment.md` §3).

#### M3-12 · Revisit the GitHub plan before mainnet (D-27) (new, M3 prerequisite)
- **Status:** backlog · **Size:** S · **Tier:** Owner · **Security:** S1
- **Repo/path:** GitHub org `4thtech` (billing, settings)
- **Depends on:** M2-GATE
- **Spec:** D-27; `audit-rules.md` §6.1; `release-and-deployment.md` §9
- **Invariants:** —
- **Scope:**
  - Decide whether to move to GitHub Team (rulesets, environment protection and security products for the private contracts repo) before any mainnet-bound contract release; if staying on Free, reaffirm the compensating controls in writing.
- **Acceptance:**
  - Decision recorded (D-xx); if upgraded, the contracts repo has a `main` ruleset with `contracts-gate` required and a protected deploy environment.

#### M3-1a · External audit of the contracts
- **Status:** backlog · **Size:** L · **Tier:** Opus (support, fixes) + Owner (engagement) · **Security:** S2
- **Repo/path:** occ-v2-contracts · audits/
- **Depends on:** M1-17, M1-3g, M2-4a
- **Spec:** 05 §8; 10 M3-1; 04 §8.5; `audit-rules.md` §8
- **Invariants:** I-6, I-10
- **Scope:**
  - Audit commit tagged `audit-<firm>-<yyyymmdd>` with readiness pack (specs, threat model, NatSpec, coverage, static-analysis output, known issues, scope register).
  - Each finding fixed in its own PR with a regression test; fixes verified by the auditor.
- **Acceptance:**
  - All High and Medium findings fixed and auditor-verified; Low/Info dispositioned; final report stored in `audits/` (published at mainnet).

#### M3-1b · Independent review of crypto, core and owner paths
- **Status:** backlog · **Size:** L · **Tier:** Opus (support, fixes) + Owner (engagement) · **Security:** S2
- **Repo/path:** agentlink · packages/crypto, packages/core (+ packages/node owner paths, console identity if in scope)
- **Depends on:** M1-17, M2-2b, M2-GATE
- **Spec:** 04 §8.5; 10 M3-1; `audit-rules.md` §8
- **Invariants:** I-1 … I-10
- **Scope:**
  - Review at a tagged commit built from the public scope register; fixes as separate PRs with regression tests and vectors where relevant.
- **Acceptance:**
  - All High and Medium findings fixed and verified by the reviewer; report stored privately until mainnet, then published.

#### M3-2a · Mainnet chain configuration verification (Base, Gnosis)
- **Status:** backlog · **Size:** S · **Tier:** Sonnet · **Security:** S1
- **Repo/path:** occ-v2-contracts · script/config; agentlink · packages/chain/src/config
- **Depends on:** M1-14
- **Spec:** 05 §2.2, §9; 03 §7; 07 §6.1; 12 §3.2; D-04 (amended by D-46), D-10, D-46
- **Invariants:** —
- **Scope:**
  - Base (8453) and Gnosis (100), stablecoin-only allowlist with the M1-14 config check (D-46; xDAI native on Gnosis, no volatile native coin): CreateX presence (code hash), `evm_version`, USDC/USDT addresses checked against the issuers' official lists (Base native USDC; on Gnosis determine which USDC/USDT variants, if any, meet 12 §3.2), decimals, no fee-on-transfer behaviour, EIP-3009 support proven on a fork per token (USDT generally lacks it), RPC set, explorers, confirmations.
- **Acceptance:**
  - Re-runnable verification script output attached; each token entry cites its issuer source and date; EIP-3009 flags proven by fork calls.

#### M3-2b · Treasury Safes, signer keys and role holders
- **Status:** backlog · **Size:** M · **Tier:** Owner (Opus prepares the role plan) · **Security:** S2
- **Repo/path:** agentlink-ops · safes/ (addresses and configuration only; signer details private)
- **Depends on:** M3-2a, M1-3a (`docs/roles.md`)
- **Spec:** 05 §2.6, §5; 10 M3-2; `release-and-deployment.md` §6
- **Invariants:** I-10
- **Scope:**
  - ≥ 2-of-3 Safes per chain with hardware signers; PAUSER ops hardware key (plus Safe); fresh hardware-backed mainnet deployer key retained per G-8 for later chains; role-assignment plan mapping every role in `docs/roles.md` to its holder.
- **Acceptance:**
  - A script reads each Safe's owners and threshold on-chain and matches the plan; no seed or signer secret in any repository.

#### M3-2c · Mainnet deployment: Base and Gnosis
- **Status:** backlog · **Size:** M · **Tier:** Owner (executes) + Opus (scripts, checks) · **Security:** S2
- **Repo/path:** occ-v2-contracts · script/
- **Depends on:** M3-1a, M3-2b, M3-12
- **Spec:** 05 §5, §9; 10 M3-2; `release-and-deployment.md` §3 rule 2, §4.3
- **Invariants:** I-6, I-10
- **Scope:**
  - Only the audited commit (bytecode rebuilt and compared); fork dry-run; the owner runs the deploy locally with the hardware deployer key while @denisjazbec witnesses and independently verifies; identical addresses on both chains; all roles to the Safes; deployer roles revoked in the same script.
  - New `@agentlink/occ-v2-abi` version with mainnet addresses.
- **Acceptance:**
  - Scripted check "deployer holds no role" passes on both chains; delays equal `docs/roles.md`; addresses identical; deployed bytecode matches the audited build; witness record stored.

#### M3-3 · Fee configuration and beta pricing
- **Status:** backlog · **Size:** S · **Tier:** Owner (decides, signs) + Opus (prepares Safe batch) · **Security:** S2
- **Repo/path:** occ-v2-contracts · script/config; agentlink-ops (Safe transaction records)
- **Depends on:** M3-2c, M1-14, M3-7 (tax/VAT assessment, D-47)
- **Spec:** 05 §2.2; 02 §4; 12 §2–§4, §6; 06 §2.4 (`fee_quote` in USD); 10 M3-3; D-04 (amended by D-46), D-45, D-46, D-47
- **Invariants:** I-10
- **Scope:**
  - Owner confirms the D-45 beta prices and `minDeposit` (proposed $5); per-chain, per-token fees for the stablecoin allowlist only (USDC, USDT where available, xDAI on Gnosis; D-46): `NOTARIZE` $0.10 (cap $0.50), `REGISTER` $5 (cap $25), integrator multiple 4, the same USD amounts on every chain; Safe batch simulated before signing.
- **Acceptance:**
  - On-chain configuration equals the approved table and 12 §2 (script); `fee_quote` returns the same USD amount for every token on both chains.

#### M3-4a · Credits deposit on mainnet
- **Status:** backlog · **Size:** S · **Tier:** Sonnet · **Security:** S1
- **Repo/path:** agentlink · apps/pay
- **Depends on:** M2-2f, M3-2c
- **Spec:** 03 §4.4; 02 J3; 10 M3-4
- **Invariants:** I-1
- **Scope:**
  - Enable mainnet chains on the `pay.` origin; amounts in USD; token details under Advanced.
- **Acceptance:**
  - Deposits in every allowlisted stablecoin (USDC, USDT where allowlisted, xDAI on Gnosis) credit an agent on both chains (small real amounts, recorded).
  - **Deploy (D-25):** staging deploy on merge; smoke test; production after the owner's approval click; health check with automatic rollback to the previous artifacts; deploy record; halted by `DEPLOY_FREEZE`.

#### M3-4b · Gasless USDC top-up (EIP-3009)
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2
- **Repo/path:** agentlink · packages/core, packages/chain, apps/submitter
- **Depends on:** M1-3c, M1-10a, M3-2a
- **Spec:** 03 §4.4; 05 §2.5; 07 §7 (`/v1/deposit-authorization`); 02 F-46, J3
- **Invariants:** I-1, I-6
- **Scope:**
  - Core detects USDC at the agent address and signs `ReceiveWithAuthorization` (payee = vault) with the agent key; the submitter checks `value ≥ minDeposit` and the token's EIP-3009 flag, then submits `depositWithAuthorization`; status reported in `get_credits`.
- **Acceptance:**
  - J3 completed without gas on Base (and on Gnosis if a supported token exists).
  - A replayed authorization fails; a below-minimum authorization is rejected by the submitter before submission.

#### M3-5 · Submitter on mainnet: operations, monitoring, alerts
- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2
- **Repo/path:** agentlink · apps/submitter; agentlink-ops · monitoring
- **Depends on:** M3-2c, M1-10c
- **Spec:** 07 §7; 04 §7 (gas griefing); 10 M3-5; `release-and-deployment.md` §4.5, §7
- **Invariants:** I-3, I-7
- **Scope:**
  - Mainnet gas keys (set by the owner, low balances), refill procedure, alerts (balance, error rate, queue depth, failed-simulation spikes), tuned per-signer limits, key-rotation runbook.
- **Acceptance:**
  - A low-balance alert fires in a test; a key-rotation drill is done; logs contain no IP-plus-signature pairs.
  - **Deploy (D-25):** staging deploy on merge; smoke test; production after the owner's approval click; health check (`/v1/health` + simulated notarize per chain) with automatic rollback (rehearsed); deploy record; halted by `DEPLOY_FREEZE`.

#### M3-6 · Publish verified contract source (BUSL-1.1) and addresses
- **Status:** backlog · **Size:** S · **Tier:** Owner + Sonnet · **Security:** S1
- **Repo/path:** occ-v2-contracts (public release or mirror); agentlink · packages/occ-v2-abi, README.md
- **Depends on:** M3-2c, M3-7 (D-11 parameters confirmed)
- **Spec:** 05 §9, §10; D-11; 10 M3-6
- **Invariants:** —
- **Scope:**
  - BUSL-1.1 headers and LICENSE with counsel-approved parameters; verification on Sourcify and the explorers; published source (repo made public or a public mirror at the audited tag); addresses in `@agentlink/occ-v2-abi` and docs.
  - Update the README Status and roadmap; never claim unimplemented features.
- **Acceptance:**
  - Explorers show verified source on both chains; Sourcify full match; LICENSE text matches counsel's approval.

#### M3-7 · Legal review: terms, privacy notice, positioning, entity, tax and VAT
- **Status:** backlog · **Size:** M · **Tier:** Owner · **Security:** S0
- **Repo/path:** agentlink-ops · legal/ (private); public terms and privacy pages
- **Depends on:** M0-5
- **Spec:** 10 M3-7; 12 §9; D-11, D-15, D-47; 01 positioning rules (private)
- **Invariants:** —
- **Scope:**
  - Counsel reviews terms of use, privacy notice (zero-access claims), positioning and the operating entity (D-15); includes the clean-room record (D-20) and BUSL parameters (D-11).
  - Tax and VAT assessment before paid mainnet (D-47): EU VAT exposure for fees paid by EU consumers (including non-Union OSS for a non-EU seller), treatment of fees paid in stablecoins, and any record-keeping or invoicing duties.
- **Acceptance:**
  - Written counsel sign-off before public launch; D-11 and D-15 updated; terms and privacy notice published.
  - Written tax and VAT assessment received before the fee-configuration Safe batch (M3-3) is signed; 12 §9 updated to match.

#### M3-8 · Bug bounty preparation (new)
- **Status:** backlog · **Size:** S · **Tier:** Owner (Sonnet drafts) · **Security:** S1
- **Repo/path:** agentlink · SECURITY.md; bounty platform
- **Depends on:** M3-1a
- **Spec:** 05 §8 (bug bounty after mainnet); `audit-rules.md` §8, §12
- **Invariants:** —
- **Scope:**
  - Scope (contracts at mainnet addresses, client packages, submitter), severity and reward table, platform and budget (DECISION NEEDED), safe-harbour text; launch shortly after mainnet.
- **Acceptance:**
  - Programme live within the agreed window after mainnet; `SECURITY.md` links it.

#### M3-9 · Mainnet incident runbook and pause drill (new)
- **Status:** backlog · **Size:** S · **Tier:** Sonnet + Owner · **Security:** S1
- **Repo/path:** agentlink-ops · runbooks/
- **Depends on:** M2-7, M3-2b
- **Spec:** 05 §5 (PAUSER); 04 §7; `release-and-deployment.md` §7–§8
- **Invariants:** I-10
- **Scope:**
  - Mainnet additions to the M2-7 runbooks: pause via the PAUSER hardware key and via the Safe, unpause, upgrade under the 48 h / 7-day delays, cancellation of a scheduled operation (guardian), user communication.
- **Acceptance:**
  - Pause/unpause drill on a mainnet fork with the real role layout; withdrawals keep working while paused (verified in the drill).

#### M3-10 · Client mainnet enablement and release (new)
- **Status:** backlog · **Size:** M · **Tier:** Sonnet · **Security:** S1
- **Repo/path:** agentlink · packages/chain, apps/cli, apps/console, README.md
- **Depends on:** M3-2c, M3-3
- **Spec:** 07 §6.1; 06 §3 (`proofs.defaultChain: base`); 03 §7; `release-and-deployment.md` §4.1, §4.6, §5
- **Invariants:** I-3, I-6
- **Scope:**
  - Mainnet chain configs; default chain Base; faucet unreachable from mainnet configs; `@4thtech/agentlink` released to `latest` after the owner's approval click; console production deploy with published hashes.
  - Update the README Status and roadmap; never claim unimplemented features.
- **Acceptance:**
  - J2 completed on mainnet with real credits; deployed console hashes equal the release hashes.
  - **Deploy (D-25):** staging deploy on merge; smoke test; production after the owner's approval click; health check with automatic rollback to the previous artifacts; deploy record; halted by `DEPLOY_FREEZE`.

#### M3-11 · Publish AgentLink / OCC v2 docs on GitBook (new)
- **Status:** backlog · **Size:** M · **Tier:** Sonnet · **Security:** S0
- **Repo/path:** GitBook `wiki.4thtech.io` (via the owner-provided GitBook MCP); sources in agentlink · docs/quickstart/
- **Depends on:** M3-10, M1-12b, M1-12d
- **Spec:** D-29; 02 (features); 06 §7; 01 positioning rules (private: never claim unimplemented features)
- **Invariants:** —
- **Scope:**
  - Add AgentLink and OCC v2 product and developer docs at mainnet beta using the GitBook change-request flow (no direct edits to published content); mark OCC v1 docs as legacy.
  - Only features that are merged and deployed are documented as available; everything else is labelled planned.
  - Update the README Status and roadmap; never claim unimplemented features.
- **Acceptance:**
  - Change request merged by the owner; each documented feature maps to a `done` card; v1 pages carry a legacy notice.

#### M3-13 · Launch brand and marketing site from D3 (new)
- **Status:** backlog · **Size:** M · **Tier:** Sonnet · **Security:** S1
- **Repo/path:** agentlink · apps/site (or the apex landing in apps/invite), packages/ui (brand tokens)
- **Depends on:** DESIGN-D3, M2-10, M2-2h (pipeline)
- **Spec:** 11 §2, §13 (D3); D-28, D-29, D-30; 01 positioning rules (private: never claim unimplemented features)
- **Invariants:** —
- **Scope:**
  - Implement the D3 brand and marketing site on the production domain (TBD, chosen in M2-10); keep `agentlink.4thtech.io` redirects for old invite links; same CSP, no third-party scripts or analytics.
  - Update the README Status and roadmap; never claim unimplemented features.
- **Acceptance:**
  - Every feature the site presents as available maps to a `done` card; owner confirms fidelity to D3; old invite links resolve.
  - **Deploy (D-25):** staging deploy on merge; smoke test; production after the owner's approval click; health check with automatic rollback to the previous artifacts; deploy record; halted by `DEPLOY_FREEZE`.

#### M3-14 · Publish the fee schedule and per-chain fee configuration at mainnet (D-45) (new)
- **Status:** backlog · **Size:** S · **Tier:** Sonnet + Owner · **Security:** S1
- **Repo/path:** agentlink · docs/foundation/12-economics-and-fees.md, README.md, CHANGELOG.md; GitHub Releases; agentlink-ops · runbooks/ (price-change procedure)
- **Depends on:** M3-2c, M3-3
- **Spec:** 12 §2, §6, §7; 05 §2.2, §2.6, §9; D-45, D-46
- **Invariants:** —
- **Scope:**
  - Publish per chain: contract addresses, treasury Safe, allowlisted fee tokens with issuer source, fees, caps, `minDeposit` and integrator multiple; mark the beta prices as live in 12 and the README.
  - A re-runnable script reads the on-chain configuration (`quote`, caps, allowlist, treasury) and diffs it against the published tables.
  - Price-change runbook: an increase is announced ≥ 7 days ahead in the CHANGELOG, a GitHub Release and the docs before its Safe batch executes; a decrease may be immediate and is announced the same way; a cap raise is announced when it is scheduled (7-day delay).
- **Acceptance:**
  - Published tables equal the on-chain reads on both chains (script output in the PR); the runbook exists and 12 §6 links to it; the README states a price as live only once it is.

#### M3-15 · Welcome credits decision (optional promotion) (new)
- **Status:** backlog · **Size:** S · **Tier:** Owner · **Security:** S1
- **Repo/path:** agentlink-ops · decisions (budget, private); agentlink · docs/foundation/12-economics-and-fees.md §10 (public, if adopted)
- **Depends on:** M3-3
- **Spec:** 12 §10; 05 §2.5 (`depositFor`); D-45
- **Invariants:** —
- **Scope:**
  - **DECISION NEEDED (owner, optional):** whether to fund welcome credits from the treasury through `depositFor`; if yes: amount per grant, eligibility (e.g. after verified registration, invite or partner codes), per-owner limit, total budget, end date.
  - Sybil analysis: agents are free to create and credits are withdrawable, so a grant is equivalent to cash. A non-withdrawable promotional balance would need a contract change with design and security review (out of scope).
- **Acceptance:**
  - Decision recorded (D-xx) with its parameters, or "no"; if adopted, 12 §10 updated and grants issued by a script whose total cannot exceed the approved budget.

#### M3-GATE · Milestone 3 gate: mainnet readiness audit and first paid use
- **Status:** backlog · **Size:** M · **Tier:** Opus (audit session) + Owner (sign-off) · **Security:** S2
- **Repo/path:** private audit store; summary in the owner's sync file
- **Depends on:** all M3 cards
- **Spec:** 10 Gate M3; 02 §7; `audit-rules.md` §7–§8; `release-and-deployment.md` §4.3
- **Invariants:** I-1 … I-10
- **Scope:**
  - Milestone audit (parts A–F) plus M3 additions: M3-1 closed, mainnet release prerequisites met, zero open Medium.
  - First paid notarizations on mainnet; zero security incidents.
- **Acceptance:**
  - Zero open Critical, High or Medium findings; first paid notarizations recorded; incident log empty for the period.
  - README Status and roadmap updated to the state at this point; README never claims unimplemented features.
  - Owner sign-off recorded.

---

## 6. M4 and M5 — epics

Epics are decomposed into cards (same format, same rules) when the milestone starts. Each sub-card goes through the normal Definition of Ready.

#### M4-EPIC · Expansion (rolling)
- **Status:** backlog · **Size:** — · **Tier:** Opus (decomposition) · **Security:** S2 (contains S2 work)
- **Repo/path:** agentlink, occ-v2-contracts
- **Depends on:** M3-GATE
- **Spec:** 10 M4; 03 §7; 04 §2.7 (what domain verification proves); 05 §1 (OCCAnchor), §2.2 (`PRICE_UPDATER`), §5 (freeze); 07 §4.1, §5.4, §6.2; 08 §5; 12 §3.4; 02 F-08, F-24, F-35, F-48, F-72, F-73; D-34, D-37, D-46
- **Invariants:** I-1 … I-10
- **Scope:**
  - Deployments to Arbitrum One, Optimism, Polygon PoS (+ testnets) with identical addresses (deployer-key lifecycle, G-8); chain verification per M3-2a.
  - Batched receipts tier: `OCCAnchor` contract + client (F-48), external audit delta.
  - ERC-8004 bridge for registered agents.
  - Hosted remote MCP in approval mode (F-73, P2) — only after a design review against I-1–I-3 (08 §5); self-hosting in the user's own Cloudflare account stays the default cloud path (D-37).
  - IPFS pinning storage adapter (F-35); XMTP transport adapter (same `Transport` interface).
  - ElizaOS plugin rewrite on `@agentlink/core`; group threads (F-24); webhooks for self-hosted agents (F-72).
  - Notary `freezeUpgrades()` at GA once GA criteria are defined (G-18).
  - Native-coin fees (D-46): **DECISION NEEDED (owner)** whether to offer volatile native coins at all; if yes, a bounded `PRICE_UPDATER` role (narrow band around the USD target, rate-limited, never above the cap) with contract design, security review and an external audit delta before any such token is allowlisted, plus a USD price source for display (formerly G-30).
  - Research: EU qualified electronic signature (eIDAS) integration so owners can give a proof of agreement legal weight (D-34); output is a research note and a go/no-go, decomposed into cards only if adopted.
- **Acceptance:**
  - Each item decomposed into cards before work starts; each new contract externally audited before mainnet; README Status and roadmap updated per release.

#### M5-EPIC · Agent commerce
- **Status:** backlog · **Size:** — · **Tier:** Opus (decomposition) · **Security:** S2
- **Repo/path:** agentlink, occ-v2-contracts
- **Depends on:** M4-EPIC (as needed)
- **Spec:** 10 M5; 05 §1 (OCCDeals); 02 F-49, F-50; 04 §3.2 (arbitrator recipient), §5
- **Invariants:** I-1 … I-10
- **Scope:**
  - `OCCDeals` state machine (offer → counter → accept → deliver → confirm) and `DEAL` fees.
  - x402 settlement linkage; arbitrator disclosure (F-50, `DISCLOSE` fee, arbitrator as optional recipient).
  - Per-relationship agent keys to reduce on-chain linkability.
- **Acceptance:**
  - Decomposed into cards with a spec PR first (05/04 changes); external audit of new contracts before mainnet; README Status and roadmap updated per release.

---

## 7. Dependency overview

### 7.1 M1 critical paths (M1a, then M1b; D-33)

**M1a, walking skeleton:** **M0-2b → M0-2d → M0-9 → M1-1h → M1-1a → M1-1b → M1-1c → M1-1g → M1-7a → M1-7b → M1-7c → M1-7h → M1-9c → M1-13a → M1-22 → M1-23 (M1a gate)**

Converging M1a chains that must arrive in time:

- **Policy and commitments:** M1-2a → {M1-2b, M1-21}; M1-7a + M1-2b → M1-7d → {M1-7e, M1-20 (+ M1-21)} → M1-9b → (M1-9c).
- **Pairing and card crypto:** M1-1f (after G-28) → (M1-7c); M1-1e → (M1-7a).
- **Transport:** M1-5a → M1-5b → M1-5c → (M1-7h); M1-18 before the dogfood.
- **Owner presence (passphrase):** M1-8a → {M1-8b, M1-8c} → M1-9a → M1-9b.
- **Install and dogfood:** M1-16 + M1-9a + M1-12a + M1-12b → M1-25 → (M1-23); M1-13b → (M1-23); M1-19 for invite links.

**M1b, to M1-GATE:** **M0-2f → M1-3a → M1-3b → M1-3c → M1-3e → M1-3g → M1-4c → M1-7g → M1-9d → M1-13c → M1-GATE**. This chain starts in M1a week 1 (contracts lane); if it waits for the M1a gate, M1 slips by the length of M1a.

Converging M1b chains:

- **Proof-layer crypto and chain:** M1-1h → M1-1i → {M1-1d, M1-1j, M1-1k}; M1-1j + M1-1g + M1-3f + M1-14 → M1-4a → {M1-4b → M1-26, M1-4d} → (M1-7g). M1-3d runs beside M1-3b against a vault mock.
- **Owner presence (passkey and local UI):** M1-8c + M1-7e → M1-8d → M1-8e (+ M1-1k) → M1-11a → M1-11c → M1-11b (after DESIGN-D1) → (M1-13c).
- **Files:** M1-6a → M1-6b (+ M1-1d) → M1-7f (+ M1-15) → (M1-9d).
- **Submitter:** M1-4a + M1-3g → M1-10a → M1-10b → M1-10c → (M1-13c).
- **Policy:** M1-7d + M1-20 → M1-7i → (M1-7g).

Sizes are effort, not calendar time. The M1a path has thirteen sequential M1 cards, most of them S2; together with the M1b chain it fits the build plan's 5–7 weeks only if S2 reviews (independent session plus @denisjazbec) turn around in 1–2 days. Review capacity, not implementation, is the expected bottleneck; schedule S2 reviews as soon as a card enters `in-review`.

### 7.2 Parallel lanes (separate worktrees)

| Stage | Lanes that can run concurrently |
|---|---|
| **A — M0 (week 1)** | Owner: M0-2a, M0-2b, M0-2e, M0-2g, M0-4, M0-6, M0-12 · Skeleton: M0-2d → {M0-8, M0-9, M0-10, M0-15} · Contracts repo: M0-2f · Legacy: OPS-L1, OPS-L5, OPS-L8 (→ M0-1), OPS-L3 → OPS-L2, OPS-L4, OPS-L9 |
| **B — M1a weeks 1–2** | Vectors: M1-1h · Crypto: M1-1a → M1-1b → {M1-1c, M1-1f} → M1-1g; M1-1e · Types: M1-2a → {M1-2b, M1-21} · Relays: M1-18 · Release: M1-16 · Invite page: M1-19 · Started early for M1b: M1-1i; Contracts M1-3a → {M1-3b, M1-3d}; Chain config M1-14; Utilities M1-15; Audit RFP M1-17; Trademark M1-24 |
| **C — M1a weeks 2–4** | Core: M1-7a → M1-7b → M1-7c → M1-7h; M1-7d → {M1-7e, M1-20} · Transport: M1-5a → M1-5b → M1-5c · Node: M1-8a → {M1-8b, M1-8c} · CLI: M1-9a → M1-9b · MCP: M1-9c → {M1-9e, M1-9g (after DESIGN-D1), M1-12a, M1-13b} · Install: M1-12b → M1-25 · E2E: M1-13a → M1-22 → **M1-23 (M1a gate)** · M1b in parallel: M1-1d, M1-1j, M1-1k, M1-3c, M1-3e, M1-3f, M1-6a |
| **D — M1b weeks 4–6** | Chain: M1-4a → {M1-4b → M1-26, M1-4d}, M1-3g → M1-4c · Storage: M1-6b · Core: M1-7f, M1-7i, M1-7g · Owner presence: M1-8d → M1-8e → M1-11a → M1-11c → M1-11b (after DESIGN-D1) · Submitter: M1-10a → M1-10b → M1-10c · CLI: M1-9h, M1-9i · Owner: M2-14 enrolment starts |
| **E — M1b weeks 6–7** | M1-9d, M1-9f, M1-12c, M1-12d, M1-13c, M1-13d → M1-GATE |
| **M2** | Design: DESIGN-D2 → M2-1a → M2-1b → M2-6 · Console: M2-2a → M2-2b → {M2-2c, M2-2d → M2-2e}, M2-2f, M2-2h · Cloud: M2-3a → M2-3b → M2-3c → {M2-3d, M2-3e}, M2-2g · Registry: M2-4a → M2-4b → M2-12 · Public pages: M2-5a, M2-5b → M2-13, M2-8 · Desktop: M2-11a → M2-11b → {M2-11c, M2-11d, M2-11e (+ M2-14) → M2-11f}, M2-11g (after M2-2e, DESIGN-D2) · M2-7, M2-9 · M2-10 (after M1-24) before external testers → M2-GATE |
| **M3** | M3-12 and M3-2a first · Audits: M3-1a, M3-1b · Governance: M3-2b → M3-2c → {M3-3, M3-4a, M3-5, M3-6} · M3-4b · M3-7, M3-8, M3-9 · M3-14, M3-15 (after M3-3) · M3-10 → M3-11 → M3-GATE |

### 7.3 M2 critical path

**DESIGN-D2 → M2-1a → M2-1b → M2-2a → M2-2b → M2-2d → M2-2e → M2-3c → M2-3d → M2-GATE**, with M2-10 (console domain) before external testers. The M2 critical path starts from DESIGN-D2: if D2 arrives late, M2 slips by the same amount. Non-UI work (M2-3a, M2-4a, M2-7, M2-9, M2-11a) can start before D2.

Desktop chain (D-36, D-41): M2-11a → M2-11b → M2-11g (after M2-2e) → M2-GATE, with the M2-14 certificates needed before M2-11e. The desktop apps add substantial scope to the build plan's 4–6 weeks for M2; M2-11a re-checks the estimate.

Concurrency guideline: no more than five or six S1/S2 cards `in-review`/`audit` at once, so human review keeps up. Cross-repo changes follow the landing order in `development-process.md` §9.3.

---

## 8. Spec gaps and inconsistencies

Found while decomposing. None is resolved here; each needs a spec-change PR (or an owner decision) before the blocked cards become `ready`. Priority: **H** blocks security-critical design, **M** blocks a card's acceptance, **L** cosmetic or late.

1. **G-1 (H) Local owner presence vs a same-user agent.** 04 §1 I-4, §2.5; 08 §1; 10 M1-8. The WebAuthn RP ID `localhost` is shared by every local origin, and 04 §2.5 already accepts that a shell-capable agent can tamper with the installation. Either way the next owner passkey or passphrase use on that machine can be captured and the wrapped owner seed on disk unwrapped: local presence proves presence, not intent. The residual-risk text lists only tampering and credit spending, and I-4's "no agent process can produce one" holds only while the installation is intact. *Proposed:* state this in 04 §2.5; scope the M1-8 test to an unmodified installation; recommend owner operations from the console on a separate device when the harness has unrestricted shell; harness deny rules for the installed package and npx cache; consider not storing the owner seed on agent machines by default. *Blocks:* M1-8c, M1-8d, M1-8e, M1-11a, M1-12b. *Status:* stays open until the D-36 desktop app ships (G-42).
2. **G-2 (H) `KeyStore` location and methods.** 03 §3; 07 §1, §4.1; 04 §2.6, §3.1. The interface lives "in core", but `transport-nostr` depends only on `crypto` (dependency cycle). Missing: envelope-hash signing (`signNostr` signs events, the envelope signature is BIP-340 over a tagged hash) and epoch selection for decrypting with old keys. *Proposed:* define `KeyStore`/`OwnerKeyStore` in `@agentlink/crypto`; add `signEnvelopeHash` and epoch parameters. *Blocks:* M1-1g, M1-5a, M1-7b.
3. **G-3 (H) AccessManager role mapping.** 05 §2.2, §5. Execution delays attach to (role, account) grants, so: cap lowering (immediate) and raising (7 days) need separate functions and roles; UPGRADER has two delays (48 h Notary/Registry, 7 days vault); `freezeUpgrades` is ADMIN with a 7-day delay while ADMIN is 48 h; guardian (cancel) roles, grant delays and `minSetback` are unspecified. *Proposed:* role-per-tier table with a role → selector map in 05 §5 (drafted in M1-3a). *Blocks:* M1-3a, M1-3b, M1-3g.
4. **G-4 (H) Batch failure semantics.** 05 §3.2; 07 §7. Whether one failing item reverts `notarizeBatch`/`acknowledgeBatch` is unspecified; the submitter batches across signers, so one item (e.g. credits spent between simulation and inclusion) can grief the rest. *Proposed:* specify all-or-nothing with per-item pre-simulation and retry without the failing item, or skip-and-emit with per-item status; keep 05 §3.4 gas targets. *Blocks:* M1-3d, M1-10a.
5. **G-5 (M) J1 key storage wording.** RESOLVED by 02 §5 J1 steps 2–3: `init` puts only the agent keys in the OS keychain (step 2); the owner key is created and wrapped in the setup step (step 3, 04 §2.2). *Was:* J1 step 2 stored "owner and agent keys" in the OS keychain, against 04 §2.2. *Blocked:* M1-9a, M1-12b.
6. **G-6 (H) Policy fail-open.** 06 §3 (last paragraph); 04 §2.5. Unsigned or tampered policies fall back to defaults, which can be looser than the owner's policy (e.g. `proofs.notarize: deny` → `allow`); deleting the signed row downgrades policy. *Proposed:* once an owner-signed policy exists, fail closed (`approval` for owner-gated actions) and keep a policy version in an owner-signed object. *Blocks:* M1-7d.
7. **G-7 (M) Lifetimes.** 04 §2.5 (`OwnerAction{nonce, issuedAt}`); 06 §2.5; 06 §3 (`dailyBudgetUSD`). No freshness window, nonce retention, approval TTL or budget day boundary. *Proposed:* e.g. OwnerAction valid 10 minutes, nonces kept 30 days, approvals expire after 24 h, budget day in UTC. *Blocks:* M1-2b, M1-7d, M1-7e.
8. **G-8 (H) CREATE3 salts and deployer lifecycle.** 05 §9; `release-and-deployment.md` §4.2. CreateX guarded salts bind addresses to the deployer; identical addresses for the Registry (M2) and M4 chains need the same deployer and salt scheme; proxies must be deployed and initialised atomically; testnet and mainnet deployers differ, so testnet and mainnet addresses differ. *Proposed:* specify salt layout (deployer-guarded, no cross-chain redeploy protection), deploy-and-init, and cold-storage retention of the mainnet deployer key until all planned chains are deployed. *Blocks:* M1-3g, M3-2b, M3-2c, M4-EPIC.
9. **G-9 (M) Store schema gaps.** 07 §3 lacks the outbox (07 §4.2, 24 h retry), the ≥ 7-day seen-set (07 §4.2), idempotency results (06 §1 rule 6), budget ledger and rate counters (06 §3) and OwnerAction nonces (04 §2.5). *Proposed:* extend 07 §3. *Blocks:* M1-5b, M1-5c, M1-7a, M1-8b.
10. **G-10 (M) Where `@agentlink/occ-v2-abi` is published.** 05 §9; D-19. npm provenance is not generated for private source repos (verify). *Proposed* (`development-process.md` §9.2): import release artifacts into public `packages/occ-v2-abi` and publish from there. *Blocks:* M1-3f.
11. **G-11 (L) Logger package missing from the package map.** 04 §8.4 vs 07 §1. *Proposed:* add `@agentlink/log` (zero dependencies). *Blocks:* M0-8.
12. **G-12 (M) JCS and invite compression.** 04 §3.1, §3.6; `AGENTS.md` dependency allowlist. No JCS implementation is allowlisted although `envelopeHash` depends on it; "deflate" does not say raw DEFLATE or zlib. *Proposed:* approve a vetted RFC 8785 implementation (or in-repo code with RFC vectors); specify `deflate-raw` via `CompressionStream`. *Blocks:* M1-1a, M1-7c.
13. **G-13 (L) Record kind ↔ payload type.** 05 §3.1 kinds vs 04 §3.4 payload types; no mapping. *Blocks:* M1-7g.
14. **G-14 (M) `fetch_file` and SSRF in Workers.** 06 §2.3 (`savedTo`, inbox folder) vs 08 §3 (no filesystem); 04 §4 DNS checks are not possible in Workers. *Proposed:* cloud `fetch_file` stores the decrypted file in the user's R2 and returns a short-lived link; Workers SSRF = https + IP-literal and hostname checks, documented reliance on Workers egress. *Blocks:* M1-15, M2-3b.
15. **G-15 (L) Shared tool handlers.** 06 §1 rule 1; no shared package between `apps/cli` and `apps/cloud-agent` in the layout. *Proposed:* `packages/mcp-tools`. *Blocks:* M1-9c (structure), M2-3b.
16. **G-16 (M) Owner link and cloud commands.** 08 §2.1 (QR direction, code derivation and channel unspecified); `agentlink owner link`, `cloud deploy`, `cloud login` (08 §2.1, §3.2, §3.3) are missing from the 06 §8 command list. *Proposed:* specify the owner-link protocol (short code from a transcript hash) and add the commands with † where owner presence applies. *Blocks:* M2-2c, M2-3c, M2-3d.
17. **G-17 (L) EIP-3009 flag location.** 05 §2.2 has no on-chain flag; 05 §2.5 says "flagged in the chain config". *Proposed:* off-chain flag (client + submitter), contract relies on the token call reverting. *Blocks:* M1-3c.
18. **G-18 (L) GA undefined.** 05 §5 freezes the Notary "at GA"; 10 has no GA milestone. *Blocks:* M4-EPIC.
19. **G-19 (M) Who pays `REGISTER`.** 05 §4 charges `card.ownerEvm`; there is no owner top-up flow (J3 is for agents) and local owner keys are presence-gated. *Proposed:* allow the agent to pay under the owner's `regOwnerSig`, or add owner credits to the console. *Blocks:* M2-4b.
20. **G-20 (M) Revocation typed data.** 05 §4 `revoke(agentEvm, nonce, deadline, ownerSig)` has no EIP-712 struct; nonce rules for `Registration` and revoke unspecified. *Blocks:* M1-1i (vectors), M2-4a.
21. **G-21 (M) Measuring beta metrics without analytics.** 02 §7 and 10 gates vs 08 §2.3 and zero access. *Proposed:* moderated sessions plus opt-in, local-only timing exported by testers. *Blocks:* M1-GATE, M2-GATE.
22. **G-22 (M) Owner archive mechanics.** 04 §4; 02 F-33; 06 §3: whose storage credentials, how the file key reaches the owner, who deletes. *Blocks:* M2-9.
23. **G-23 (M) `agentId` undefined.** Used in 04 §2.2 (keychain account), 04 §2.5, 06 §6, 07 §3, 07 §5.2 (object key). The object-key path also gives every recipient of a presigned URL a stable per-agent identifier. *Proposed:* define `agentId`; use a random per-agent prefix in object keys. *Blocks:* M1-6a, M1-7a, M1-8a.
24. **G-24 (M) Relays for owner copies.** 04 §3.5; 07 §4.2; 08 §2.2. AgentCard carries only the agent's `relaysHash`; owners have no relay list. *Proposed:* each owner copy goes to the relays of the agent it concerns; the console subscribes to all its agents' relays. *Blocks:* M1-5b, M2-2d.
25. **G-25 (M) `verify_proof_pack {path}`.** 06 §2.4 lets a tool read a caller-chosen file, against 06 §1 rule 4. *Proposed:* `json` only, or `path` restricted to `proofs.exportFolder`/inbox with realpath checks. *Blocks:* M1-9d.
26. **G-26 (L) STREAM header not authenticated.** 04 §4: AAD is `u8(isFinal)` only; header fields rely on `ciphertextSha256`. *Proposed:* AAD = header ‖ isFinal, decided before vectors freeze. *Blocks:* M1-1d, M1-1i.
27. **G-27 (L) Inline file vs envelope size.** 04 §3.5; 02 F-30; 06 §2.3. A 12 KB file, base64-encoded inside an encrypted, base64-encoded payload with four recipient wraps, is already near 24 KB before any text. *Proposed:* "inline only if the final envelope ≤ 24 KB". *Blocks:* M1-7f.
28. **G-28 (L) Safety-code encoding.** 04 §3.6: the first 40 bits (2^40 ≈ 1.1 × 10^12) do not fit 12 decimal digits, the format 11 §1 and §8 specify. *Blocks:* M1-1f, M1-1h.
29. **G-29 (M) Owner-operation payload bodies.** 04 §3.4 lists `approval-request`, `approval`, `policy`, `card-update`, `revoke`, `handshake-ack` without body schemas. *Blocks:* M1-2a, M2-2e.
30. **G-30 (M) Native-coin price source.** RESOLVED for launch by D-46: fees are stablecoin-only, every fee token is valued 1:1, and 07 §6.2 needs no price endpoint. A USD price source for native coins returns with the `PRICE_UPDATER` work in M4-EPIC (12 §3.4). *Was:* 07 §6.2 "public price endpoint" unspecified (third-party egress, integrity). *Blocked:* M1-4b, M3-3.
31. **G-31 (L) Linux without Secret Service.** 04 §2.2; 03 §6 (headless servers, containers, WSL). *Proposed:* `needs_setup` by default; a documented, weaker passphrase-wrapped file store as opt-in. *Blocks:* M1-8a.
32. **G-32 (M) Per-contact policy overrides.** 11 §8 (approval card, "Remember for this contact") has no counterpart in 06 §3. *Blocks:* M1-2b, M1-11a.
33. **G-33 (M) DELIVERED timing for notarized messages.** 06 §2.2 records DELIVERED when `check_inbox` returns a message, but the `proof` envelope (04 §3.4) arrives later. *Proposed:* sign DELIVERED when the proof envelope is processed if the message was already returned. *Blocks:* M1-7g, M1-9c.
34. **G-34 (L) Default receipt linkability.** 05 §3.3 (a receipt links the recipient's agent address to the record) vs 06 §3 `receipts.autoDelivered: true`. *Proposed:* keep the default but state it at pairing and in settings, or default to off. *Blocks:* M1-7g, M1-11c.
35. **G-35 (L) Web Push keys.** 08 §2.2: the owner-generated VAPID private key must reach cloud agents securely; local agents cannot push. *Blocks:* M2-2g.
36. **G-36 (L) Owner-backup event kind.** 04 §2.3 names the `d` tag but not the parameterised-replaceable kind. *Blocks:* M2-2b.
37. **G-37 (L, process) PR title pattern.** `pr-hygiene.yml` accepts `OPS-<n>` and `M<n>-<n>[a-z]`, but `development-process.md` §12.2 and `audit-rules.md` §7 use `OPS-L<n>` and `M<n>-GATE`. *Blocks:* PRs for OPS-L, gate and design-drop cards (fixed by M0-15; design drops may also use the `DOCS` prefix).
38. **G-38 (M, decision) D-25 scope.** RESOLVED: D-25 is decided (decision log, 12 Oct 2026): continuous delivery with auto-merge behind `review-gate`, automatic staging deploys, automatic rollback, and one owner approval click for production (`talirezun` required reviewer on `production` and `npm-publish`, "Prevent self-review" off). `release-and-deployment.md` and `ci-cd.md` are aligned. Remaining work is owner setup: M0-17 (ruleset with auto-merge), M0-18 (environments), M0-19 (`DEPLOY_FREEZE`).
39. **G-39 (M) Pause scope.** 05 §2.5 says pause never blocks payer withdrawals but is silent on `sweep` and `withdrawIntegrator` (also DECISION NEEDED in `audit-rules.md` §5). *Blocks:* M1-3b.
40. **G-40 (M, process) Beta hostnames vs environments.** D-28 puts beta services on `*.agentlink.4thtech.io` and staging on `workers.dev`; `release-and-deployment.md` §1 maps testnets to staging and production to mainnets. Which environment (and approval) serves the testnet submitter, faucet and console used by M1/M2 testers is undefined. *Proposed:* a "beta" environment (testnets, beta hostnames, owner-approved promotion). *Blocks:* M1-10c, M2-2h.
41. **G-41 (L) D-12 propagation.** The decision log now records MIT (D-12); the private internal docs predate it. *Proposed:* align them privately; every public `package.json` and the cloud-agent template carry MIT. *Blocks:* M0-2d (check script), M2-3d (template licence).
42. **G-42 (H, note) Desktop owner presence as the G-1 mitigation.** D-36; 04 §2.5; 08 §1. D-36's desktop model (a signed app, a native approval window, the owner key in the OS keychain gated by OS biometrics such as Touch ID or Windows Hello) is the intended mitigation for G-1: the OS, not a `localhost` web origin, shows the presence prompt, and keychain access bound to the app's signing identity is meant to stop a tampered installation or another same-user process from unlocking the owner key. It is not yet specified or proven: Linux has no equivalent OS binding, and `npx` installs keep G-1's residual risk. *Proposed:* M2-11a's threat model states exactly which G-1 paths the desktop app closes, per OS; 04 §2.5 is updated when the desktop app ships, and only then is G-1 closed for desktop installs. G-1 stays open until then. *Blocks:* M2-11a, M2-11b, M2-11c, M2-11d.
43. **G-43 (M) `fee_quote` split.** RESOLVED by 06 §2.4: `fee_quote` returns `{chain, token, amount, usd, protocolUsd, integratorUsd, payFrom}`, and `ProofStatus.fee` carries the same split, as D-45 and 12 §4.3, §5 require. *Was:* `fee_quote` returned only `{chain, token, amount, usd, payFrom}`. *Blocked:* M1-9d.

---

## 9. Owner actions

Only the owner (@talirezun) can do these. Agents may prepare material, never execute. Every merge is an owner action (`development-process.md` §1.1) and is not repeated per card.

| Card | Owner action |
|---|---|
| M0-2a | Org settings: 2FA required, base permission Read, restrict visibility change/deletion/transfer, disable private forks, limit private-repo write access |
| M0-2b | Push the bootstrap commit; repository settings; `main`, tag and `sync` rulesets; Actions settings; install Renovate |
| M0-2e | npm 2FA enforcement; check/claim `@4thtech`; `npm-publish` environment; trusted publishers; first manual publish with 2FA if needed |
| M0-2f | Create `occ-v2-contracts` (private); grant write access to named engineers only |
| M0-2g | Cloudflare API tokens, custom domains for `agentlink.4thtech.io` hostnames, R2 test bucket and token; **DECISION NEEDED:** move to a 4thTech Cloudflare org account with @denisjazbec |
| M0-4 | D-11 to counsel; D-14 name; record D-12 = MIT |
| M0-6 | Move docs 01 and 09 into `agentlink-ops/docs/internal/`; grant @denisjazbec access |
| M0-12 | Create the `sync` branch, its ruleset and secret-scan stub; onboard @denisjazbec |
| M0-14 | Add further reviewers when needed; decide the S2 review waiver path (`audit-rules.md` §3) |
| M0-17, M0-18 | (D-25) Apply the `main` ruleset with auto-merge and the four required checks; create the environments `npm-next`, `npm-publish`, `staging`, `production`, `deploy-freeze`, with `talirezun` as required reviewer on `production` and `npm-publish`, "Prevent self-review" off, deployment branches `main`/tags only |
| M0-19 | Create the repository variable `DEPLOY_FREEZE` and the freeze credential `DEPLOY_FREEZE_TOKEN` (environment `deploy-freeze`); clearing `DEPLOY_FREEZE` is owner-only |
| M0-20 | **DECISION NEEDED:** machine-run AI review in CI with an `ANTHROPIC_API_KEY` secret |
| M0-1, OPS-L1, OPS-L5 | Unpublish or patch the Encryptor; confirm the PX auth service is offline; sign the confirmations |
| OPS-L2, OPS-L3 | Withdraw v1 fees to EOAs; create/verify Safes; sign 20 `transferOwnership` calls |
| OPS-L6, OPS-L7 | Decide whether PollinationX stays live |
| OPS-L8 | Rotate every live credential found |
| M1-3g | Testnet deployer key and testnet Safe; fund with low balances; trigger the private-repo deploy workflow (no testnet explorer verification: D-11, D-19) |
| M1-3f | **DECISION NEEDED:** where `@agentlink/occ-v2-abi` is built and published (G-10) |
| M1-9f | **DECISION NEEDED:** Claude Desktop bundle build, signing and distribution |
| M1-10c | Set submitter and faucet keys with `wrangler secret put`; fund them; approve promotions; **DECISION NEEDED:** Cloudflare staging account vs environments, environment names, beta environment (G-40) |
| M1-13a | **DECISION NEEDED:** where e2e runs; provide harness API keys and testnet funds outside PR workflows |
| M1-17 | Choose audit firms, approve budget, sign engagements, decide scope (`packages/node`, console identity) |
| M1-18 | **DECISION NEEDED:** `agentlink-ops` pipeline; host the optional relay |
| M1-23 | Run the J9 dogfood with @denisjazbec (install, pair, daily project sync, a J8 negotiation); sign off the M1a gate |
| M1-24 | Trademark and name check (D-38) with counsel before the production domain (M2-10); start early |
| M1-GATE, M2-GATE, M3-GATE | Recruit testers; sign off the gate; accept or reject residual risks |
| DESIGN-D1 | Deliver D1 (copy sheet, tokens + core components, local approval UI, invite placeholder) by week 3 of M1; record it in `docs/design/README.md` |
| DESIGN-D2 | Deliver D2 (full component library, console, verify, invite landing, onboarding, pay page and pricing, prototypes, rationale) before M1-GATE; late delivery slips M2 |
| DESIGN-D3 | Deliver D3 (launch brand, marketing site for the production domain) before M3 public launch |
| M2-3d | Create `4thtech/agentlink-cloud-agent`; **DECISION NEEDED:** template sync mechanism |
| M2-3e | Provide paid ChatGPT and claude.ai plans for connector tests |
| M2-10 | **DECISION NEEDED:** production console domain (TBD; choose and register) before external testers |
| M2-11a | Approve the desktop framework decision after its security review |
| M2-14, M2-11e, M2-11f | Buy and enrol: Apple Developer ID (organisation) and a Windows code-signing certificate, starting in M1b; hold signing credentials and the offline update key; approve each desktop release |
| M3-12 | **DECISION NEEDED:** GitHub Team before mainnet (D-27) |
| M3-1a, M3-1b | Run the audit engagements; accept final reports |
| M3-2b | Create mainnet Safes with hardware signers; PAUSER key; mainnet deployer hardware key and its custody |
| M3-2c | Run the mainnet deploy with the hardware key, @denisjazbec witnessing |
| M3-3 | Confirm the D-45 beta prices and `minDeposit`; sign the fee-configuration Safe batch |
| M3-5 | Set and fund mainnet gas keys |
| M3-6 | Publish BUSL-1.1 source; explorer verification accounts |
| M3-7 | Engage counsel; decide the entity (D-15); obtain the tax and VAT assessment before paid launch (D-47) |
| M3-8 | **DECISION NEEDED:** bounty platform and budget |
| M3-14 | Approve the published fee schedule; announce every later price increase ≥ 7 days ahead (D-45) |
| M3-15 | **DECISION NEEDED (optional):** welcome credits, eligibility and budget |
| M3-11 | Provide the GitBook MCP; merge the GitBook change request |
| Releases | Approve every production promotion (npm `latest`, production Workers and sites) with one click on the waiting deployment (D-25) |
