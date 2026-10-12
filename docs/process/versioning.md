# Versioning

| | |
|---|---|
| **Purpose** | How AgentLink versions software, wire formats, specs and apps, and how versions become changesets, changelog entries, tags and releases. |
| **Applies to** | `4thtech/agentlink` and, for §2, §6, §7, `4thtech/occ-v2-contracts`; the owner, `@denisjazbec`, all agents. |
| **Status** | Normative · v0.3 · 12 Oct 2026 (D-43) |
| **Companions** | `release-and-deployment.md` (§4.1, §5.1, §8) · `ci-cd.md` · `development-process.md` (§6.3, §8, §9.2) · [`CHANGELOG.md`](../../CHANGELOG.md) |
| **Source of truth** | D-43 in [`00-README.md`](../foundation/00-README.md). Formats: the specs named in §2. |

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used as in RFC 2119 / RFC 8174.

---

## 1. SemVer rules

Released software follows [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html): `MAJOR.MINOR.PATCH`, prereleases `-next.N`, build metadata after `+`.

- **PATCH:** compatible fix (security fixes included), internal change, documentation.
- **MINOR:** compatible addition.
- **MAJOR:** incompatible change.
- **Before 1.0.0 (beta):** SemVer allows anything in `0.x`; we narrow it. A MINOR may break, a PATCH never does, and every break is listed in `CHANGELOG.md` as **BREAKING:**. From 1.0.0 a break needs a MAJOR.

| Surface | Breaking | Compatible |
|---|---|---|
| **MCP tools** (06 §2) | Removing or renaming a tool, input or output field; changing a type; a new required input (or an optional one made required); removing a `status` value or changing its meaning; weakening a documented guarantee (untrusted-content wrapping, approvals) | New tool; new optional input; new output field; new `status` value (under Added) |
| **Wire formats** (§2) | Anything an older reader would misparse, reject or mis-verify: a changed, removed, retyped or newly required field; changed canonicalization, hash or signature input; changed labels, EIP-712 types or key-derivation strings | A new optional field that readers must ignore |
| **CLI** (06 §8) | Removing or renaming a command, flag or environment variable; changed exit codes or `--json` shape; a changed default that alters existing setups; on-disk state without an automatic migration | New commands and flags; new `--json` fields; clearer text |
| **Libraries** | Removing, renaming or retyping an export; narrower input | New exports; wider input |

A security fix that rejects previously accepted input is a PATCH listed under `### Security`; invariants I-1…I-10 outrank compatibility.

---

## 2. Version layers

Each layer has its own number; the product version never stands in for a format's.

| Layer | Version | Defined in | Moves when |
|---|---|---|---|
| **Product** | `0.0.x` now | D-43; `CHANGELOG.md` | Every release. One Changesets **fixed group** moves together during beta: the CLI `@4thtech/agentlink`, the `@agentlink/*` libraries (not the ABI package) and, from M2, the desktop apps (private workspace packages). Set in `.changeset/config.json` |
| **OCC v2 EIP-712 domain** | `version: "2"` | 05 §3.1; 04 §5 | Only for a new contract generation (OCC v3) |
| **Agent card** | domain `version: "1"` | 04 §2.4 | The card struct or its domain changes |
| **Envelope** | `v: 1`; labels `agentlink/envelope/v1`, `agentlink/v1/*` | 04 §2.1, §3 | An incompatible change to fields, signing input or labels |
| **Payload and terms** | v1, carried by envelope `v` (`terms.version` is the negotiation counter) | 04 §3.4 | Ignorable optional fields: no bump. Anything else: new envelope `v` |
| **Proof pack** | `version: 1` | 07 §8 | An incompatible change |
| **Invite** | `v: 1` | 04 §3.6 | An incompatible change |
| **Spec pack** | `0.3` | `00-README.md` revision history | §8 |
| **Contracts** | `occ-v2-contracts` tags `v*`; `@agentlink/occ-v2-abi` has its own SemVer line | 05; `development-process.md` §9 | A contract release. ABI package: MAJOR = ABI-breaking, MINOR = additive (function, event, chain entry), PATCH = metadata. `@agentlink/chain` pins it exactly |
| **Desktop builds** (M2) | Product version; build identity `<version>+<short commit>` per OS | 08 §8 | With the product. Update channels mirror npm `latest` and `next` (M2-11) |

A format version changes only with a spec change, a decision-log entry, new test vectors (`test-vectors/`) and a §7 row.

---

## 3. Milestone to version

| Milestone | Version | Meaning |
|---|---|---|
| M0 Foundations | `0.0.x` | Specs, process and CI; no packages |
| M1a Walking skeleton | `0.1.0` | First npm release: pair and talk. Packages start at `0.0.0`; the first minor changeset makes `0.1.0` |
| M1 gate (M1a and M1b) | `0.2.0` | Local beta on testnets |
| M2 | `0.3.0` | Console, desktop apps, self-host |
| M3 mainnet beta | `1.0.0` | First strict SemVer promise |

Patch releases (`0.1.1`, …) fix defects in between. Work toward a milestone ships as `0.x.0-next.N` on `next`; only the milestone version and later patches reach `latest`. Hotfix branches wait until first needed.

---

## 4. Prereleases and promotion to `latest`

1. **Prereleases.** In pre mode with tag `next` (`pnpm changeset pre enter next`), merging the Version packages PR publishes `x.y.z-next.N` to npm `next` automatically (job `publish-next`, environment `npm-next`, no reviewer), then the smoke test runs. A prerelease never moves `latest`.
2. **Promotion.** `latest` is production; only the owner's approval moves it (D-25). Promotion is a new stable publish, not a dist-tag move (`release-and-deployment.md` §4.1 says why):
   1. A PR runs `pnpm changeset pre exit`; between the last prerelease and it only fixes SHOULD merge.
   2. The next Version packages PR carries the stable versions and the rolled `CHANGELOG.md` (§5).
   3. Merging it starts `publish-latest` in environment `npm-publish`, which waits for the owner's approval click.
   4. After the click: publish with provenance, health check, GitHub Release `v<version>` (§6), smoke test. A failure rolls back and sets `DEPLOY_FREEZE`.
3. Agents never run `npm publish`, `npm dist-tag` or `npm unpublish`, or approve the deployment.

---

## 5. Workflow for agents

Agents MUST NOT bump a version by hand: not in `package.json`, a changelog heading or a tag.

- **Changeset.** A PR that changes a published package adds one with `pnpm changeset`, naming the packages and the bump from §1 (in `0.x`: PATCH for fixes, MINOR for additions and for breaks). The summary is one sentence in user vocabulary (`11-claude-design-brief.md` §5), with nothing from the private repositories (`development-process.md` §12). Docs-only PRs need none.
- **Changelog.** A PR that changes user-visible behaviour, a spec or the process adds one line under `## [Unreleased]` in `CHANGELOG.md`, in the matching subsection (Added, Changed, Deprecated, Removed, Fixed, Security), with the task ID. Breaks start with **BREAKING:**. Refactors, tests and CI tweaks need none.
- **Release PR.** CI opens the "Version packages" PR and its branch is push-restricted (`ci-cd.md` checklist §2), so the root script `version-packages` rolls the changelog inside the version job. After `changeset version`, and only for a stable version, it renames `[Unreleased]` to `## [<version>] - <date>`, adds an empty `[Unreleased]`, updates the compare links, and writes "Maintenance release; no user-visible changes." if nothing was listed. Prereleases leave `CHANGELOG.md` alone.
- **Release notes gate.** `publish-latest` fails before publishing if the product version has no non-empty `CHANGELOG.md` section.

---

## 6. Tags and GitHub Releases

- **Product tag** `v<version>` (stable versions only), created at the released commit together with the GitHub Release. The release body is that version's `CHANGELOG.md` section, nothing generated. SBOMs and, from M2, the desktop installers, update manifests and SHA-256 hashes attach to it; the desktop pipeline adds assets and never creates a release.
- **Per-package tags** (`<package>@<version>`) MAY exist; Changesets pushes them. A GitHub Release exists **only** for `v*` product tags: `release.yml` sets `create-github-releases: false` on the Changesets publish steps, and `publish-latest` creates the product release after the health check, in the owner-approved environment. Prereleases get per-package tags, no GitHub Release.
- If a release is rolled back, the owner edits or deletes its GitHub Release. In M0 (pipeline off) the owner creates `v0.0.x` by hand.
- **Contracts repo:** its own SemVer line and `v*` tags, unrelated to product numbers; each tag maps to deployment records and the `@agentlink/occ-v2-abi` version published from it.

---

## 7. Compatibility and deprecation

| Format | Version | First shipped in | Readers MUST accept | Writers emit |
|---|---|---|---|---|
| Envelope | v1 | 0.1.0 | v1 | v1 |
| Payload and terms | v1 | 0.1.0 | v1 | v1 |
| Agent card | v1 | 0.1.0 | v1 | v1 |
| Invite | v1 | 0.1.0 | v1 | v1 |
| Proof pack | v1 | 0.2.0 | v1, and every earlier pack version, always | v1 |
| OCC v2 records and receipts | domain `"2"` | 0.2.0 (testnets) | `"2"` | `"2"` |

Update this table in the PR that adds a format version.

- **Beta.** Formats may break between minors (§1); each break bumps the format version and is marked BREAKING. A reader of N keeps reading N-1 for at least one minor. Proof packs and receipts are long-lived evidence, so `verifyProofPack` reads every pack version ever issued.
- **Unknown versions** are refused visibly ("update AgentLink to read this"), never dropped or guessed at. Until a spec says how a sender learns what a recipient reads, writers emit the older version.
- **From 1.0.0** old format versions stay readable until the next MAJOR.
- **Deprecation.** Deprecate one MINOR ahead: an interface deprecated in `0.n.0` is removed no earlier than `0.(n+1).0`. List it under `### Deprecated`, warn on stderr (CLI) or document it (tools, libraries) and name the replacement. Removal is BREAKING.
- **Mistakes.** Never unpublish. Publish a fixed PATCH, `npm deprecate` the bad version (owner action) and move `latest` back if needed (`release-and-deployment.md` §8).

---

## 8. Spec versioning

The spec pack version is the top row of the revision history in `00-README.md` (`MAJOR.MINOR[.PATCH]`), independent of the product version.

- **MINOR** (`0.3` → `0.4`): decisions (D-xx) added or changed, or an interface change (`development-process.md` §8).
- **PATCH** (`0.3` → `0.3.1`): clarifications that change no behaviour.
- **MAJOR:** owner decision only, expected at the M3 freeze.

The PR that changes a spec adds its revision row, naming the decisions or sections covered.

---

## 9. Release checklist

Linked from `release-and-deployment.md` §5.1. Agents prepare everything except the owner's click.

- [ ] Every PR that changed a published package has its changeset; the Version packages PR lists the expected packages at one version.
- [ ] The bump matches §1; breaks are marked **BREAKING:**; deprecations were announced one minor earlier (§7).
- [ ] Format versions and the §7 table are current; new versions have test vectors.
- [ ] `CHANGELOG.md` rolled into `## [<version>] - <date>`, compare links correct, public/private boundary respected.
- [ ] Spec revision row added if specs changed (§8); `README.md` Status updated (D-44).
- [ ] Stable release: prerelease soaked on `next`, `pnpm changeset pre exit` merged, tag `v<version>` not yet used.
- [ ] After the click: provenance and smoke test green; GitHub Release `v<version>` carries the changelog section, tag at the released commit; from M2 desktop artifacts attached.
- [ ] If rolled back: `DEPLOY_FREEZE` set, GitHub Release edited or deleted, bad version deprecated.

---

## Change control

Changing this document requires the owner's approval and a decision log entry (D-xx) in `docs/foundation/00-README.md`. Agents may propose changes but MUST NOT enable auto-merge on them: the owner merges, or enables auto-merge, himself.
