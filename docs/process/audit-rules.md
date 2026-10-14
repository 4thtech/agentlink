# Audit rules

| | |
|---|---|
| **Purpose** | The review and audit regime for AgentLink: security classes, review requirements, independent reviews, milestone and external audits, findings, stop-the-line. |
| **Applies to** | Every change to `4thtech/agentlink` (public) and `4thtech/occ-v2-contracts` (private), every release, and every reviewer, human or AI. |
| **Status** | Normative · v0.3 · 13 Oct 2026 (merge rules D-51, simplified; `apps/drop/**` S2, D-48; continuous delivery, D-25) |
| **Companions** | `development-process.md` · `release-and-deployment.md` · `backlog.md` · `sync-protocol.md` |
| **Source of truth** | Invariants I-1…I-10 and the threat model are in `docs/foundation/04-security-and-crypto.md`. This document never relaxes them. |

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are used as in RFC 2119 / RFC 8174.

---

## 1. Principles

1. **Nobody reviews their own work.** An author is every person and every AI session that wrote code in the diff, including the orchestrator that integrated it. The owner directs the agents, so S1/S2 changes need an independent reviewer who did not direct them (§3). Agents work under the owner's account; S2 and sensitive-path changes merge only after the owner's explicit "merge" in chat, recorded in the PR (D-51, simplified).
2. **Evidence over claims.** A requirement is met only by an artifact a third party can check: test name and output, CI run, command output, file and line at a commit. "Worker reported" is not evidence.
3. **Every finding is tracked to closure** (§9). A finding mentioned only in chat does not exist.
4. **Never weaken a test, invariant or policy default** to make something pass. Flag it instead.
5. **Fail closed.** A gate that cannot run is red. A required check that skipped is not evidence.
6. **Least context for reviewers.** Independent reviewers get what an attacker would have plus the specs, not the author's reasoning.
7. **Class only goes up** without the owner (§2.4).

---

## 2. Security classes

### 2.1 Definitions

| Class | Name | Definition |
|---|---|---|
| **S0** | None | No security-relevant behaviour: docs outside `docs/foundation/`, `docs/process/` and `docs-site/`, internal tooling with no secrets, UI styling with no data flow change. |
| **S1** | Sensitive | Handles inbound content; files, paths or URLs; storage credentials; the policy or approval UI; CI or release configuration; the chain client. |
| **S2** | Critical | Crypto; key derivation and storage; owner presence; the envelope or pairing protocol; the policy engine; contracts; anything that signs; the submitter; deploy scripts with roles. |

### 2.2 Path defaults: `4thtech/agentlink` (public)

| Path | Class | Reason |
|---|---|---|
| `packages/crypto/**` | S2 | Crypto (04 §8) |
| `packages/core/**` | S2 | Envelopes, pairing, policy engine, owner-action verification |
| `packages/node/**` | S2 | Keychain `KeyStore`, `OwnerKeyStore`, local approval server |
| `packages/chain/**` | S1 | Chain client (content rules raise EIP-712/signing code to S2) |
| `packages/transport-nostr/**` | S1 | Inbound content |
| `packages/storage/**` | S1 | Storage credentials, presigned URLs, OAuth tokens, SSRF (the drop adapter's request signing → S2) |
| `packages/types/**` | S1 | Inbound validation schemas (envelope, payload, policy schema changes → S2) |
| `packages/ui/**` | S1 | Approval and policy UI; runs inside the console origin |
| `apps/cli/**` | S1 | MCP tool surface, files, inbound content (owner operations → S2) |
| `apps/console/**` | S2 | Generates and holds the owner seed; signs approvals and policies |
| `apps/cloud-agent/**` | S2 | Generates and holds agent seeds; OAuth owner proof |
| `apps/submitter/**` | S2 | Submitter, gas keys, faucet |
| `apps/drop/**` | S2 | Encrypted drop (D-48): signed-upload verification, quotas, expiry, no logging of URLs, keys or signatures (04 §4) |
| `apps/verify/**`, `apps/invite/**` | S1 | Untrusted proof packs and invites; URL fragment |
| `test-vectors/**` | S2 | Canonical protocol vectors |
| `e2e/**`, `skills/**` | S1 | Prompt-injection suite; agent-facing instructions |
| `.github/**` (incl. `CODEOWNERS`), `renovate.json` | S1 | CI and release configuration |
| `package.json` (root), `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc` (any depth), `.pnpmfile.*` (any depth), `turbo.json`, `.changeset/config.json`, `.gitleaks.toml`, `.gitleaksignore` | S1 | Supply chain, release and secret-scan configuration. `.npmrc`, `.pnpmfile.*`, `pnpm-workspace.yaml` and the root `package.json` can run code or redirect installs and publishing in CI (`--ignore-scripts` does not stop a pnpmfile), including in jobs holding the npm OIDC token |
| `docs/foundation/04-security-and-crypto.md` | S2 | Invariants |
| other `docs/foundation/**`, `docs/process/**`, `AGENTS.md`, `CLAUDE.md`, `.claude/**`, `SECURITY.md` | S1 | Specs, agent instructions and harness settings |
| `docs-site/**` | S1 | Public docs, published on merge (D-57); they restate security and privacy commitments. Mirror in `review-gate.yml` pending (owner, M0-25); until then the PR declares S1 |
| anything else | S0 | — |

This table is mirrored in two places that MUST change with it in the same PR:

- **`.github/CODEOWNERS`** lists the S2 rows plus `/.github/`, `/AGENTS.md`, `/CLAUDE.md`, `/.claude/` and the code-executing supply-chain files (`/package.json`, `/pnpm-workspace.yaml`, `.npmrc` and `.pnpmfile.*` at any depth), owned by `@talirezun @denisjazbec` (D-25). Code-owner review is off (D-51, simplified); CODEOWNERS requests reviews and notifies, and the owner's "merge" go-ahead is the gate (§3). `@denisjazbec` is also a code owner, and his approval is optional but sufficient.
- **`.github/workflows/review-gate.yml`** derives the class from the changed files with the same rules (§3.3).

The root `package.json`, `pnpm-workspace.yaml`, `.npmrc` and `.pnpmfile.*` are code-owned because they can execute code or redirect installs and publishing (a pnpmfile, lifecycle-script settings, a registry). The setup action also refuses any pnpmfile and installs with `--ignore-pnpmfile` (`ci-cd.md`).

DECISION NEEDED (owner): whether the remaining supply-chain files (`pnpm-lock.yaml`, `turbo.json`, `renovate.json`, `.changeset/config.json`, `.gitleaks.toml`, `.gitleaksignore`) should also be code-owned. As S1 non-code-owned files they can auto-merge with an orchestrator-attested independent review and no human approval. They can shorten dependency cooldowns or silence the secret scan. Proposed: code-own `renovate.json`, `.gitleaks.toml` and `.gitleaksignore`.

### 2.3 Path defaults: `4thtech/occ-v2-contracts` (private)

| Path | Class |
|---|---|
| `src/**`, `script/**` (incl. per-chain config), `test/**`, `test-vectors/**` | S2 |
| `foundry.toml`, `remappings.txt`, `lib/**`, `.gitmodules` (compiler, `evm_version`, dependency pins) | S2 |
| `.github/**`, `audits/**` | S1 |
| anything else | S0 |

### 2.4 Content rules and authority

Regardless of path, a change is **S2** if it: calls `KeyStore`/`OwnerKeyStore` or any signing; builds or hashes EIP-712 typed data or domains; touches randomness, nonces or deadlines; changes owner presence, approvals, policy evaluation or a policy default; adds network egress from a key-holding context (console, local UI, cloud agent); changes a test vector; or changes a dependency of an S2 package. It is at least **S1** if it parses inbound content, file names, URLs or paths; touches logging or redaction; changes MCP tool names, schemas or server instructions; or touches workflow permissions, secrets or environments.

The **highest applicable class wins.** The orchestrator assigns the class on the task card and the PR. Any reviewer MAY raise it. Only the owner MAY lower it, with the rationale recorded in the PR. `review-gate` rejects a declared class below the path default (§3.3); it cannot see content rules, so a content-rule S2 is declared S2 by the orchestrator, and `review-gate` then requires the S2 evidence even on a non-owned path.

---

## 3. Review requirements

Merging is continuous (D-25, amended by D-51 and D-52): agents work under Tali's GitHub account. S0/S1 PRs outside the sensitive paths auto-merge when every GitHub-enforced gate below is green. **S2 PRs and sensitive-path PRs** (`.github/**`, `AGENTS.md`, `CLAUDE.md`, `.claude/**`, supply-chain files, §2.2) merge only after CI, the independent AI review and **Tali's explicit "merge" in chat**, recorded in the PR. This is a process control, not GitHub-enforced. Code-owner review is off; `@denisjazbec` stays a code owner for notifications, and his approval is not required. Agents never approve a PR or a deployment and never merge with admin bypass. The `main` ruleset has no bypass actors (`ci-cd.md`). The residual risk is owner-accepted and is revisited before M3 (`development-process.md` §1.3). Every task follows one pipeline (D-52): develop, independent audit (required for S1/S2), required checks green, auto-merge; where CI cannot catch a class of problem, CI is improved (a follow-up card), never skipped. The orchestrator enables auto-merge after the audit passes (S0/S1) or after the owner's "merge" (S2 and sensitive paths); no non-author GitHub approval is required.

| Requirement | S0 | S1 | S2 | Enforced by |
|---|---|---|---|---|
| CI gates (public) | `ci-gate`, `security-gate`, `pr-hygiene`, `review-gate` | same | same | Ruleset (required checks) |
| CI gates (contracts repo) | `contracts-gate` | same | same | Owner, before merging (Free plan, §6.1) |
| Owner's merge go-ahead | — | ✅ on sensitive paths only (§2.2) | ✅ Tali's explicit "merge" in chat on the PR, or a go-ahead recorded in chat that covers this specific piece of work (`delivery-process.md` §4), recorded in the PR body (D-51, D-52) | Process control (D-51, simplified). Code-owner review is off. The owner MAY review any PR and MAY disable its auto-merge. Services deploy to production automatically once staging smoke tests are green; npm `latest` needs the owner's approval click (D-52, `release-and-deployment.md` §3) |
| Independent AI review session (Opus 5.5, §4) | — (a Sonnet non-security review MAY be used) | ✅ checklists for the areas touched | ✅ all applicable checklists + invariant walkthrough | `review-gate` (c): report ID referenced in the PR, no FAIL verdict. Attested by the orchestrator: CI sees the reference, not the review. Automated PRs: a code-owner approval on the head commit instead (below) |
| Feedback from `@denisjazbec` | — | MAY | Usually relayed through the owner and logged with a disposition (`development-process.md` §14); review comments welcome; his GitHub approval is optional (D-51) | Process |
| Tests-first evidence | — | Regression test for every fix | ✅ failing-test commit precedes implementation; red run in PR | `review-gate` (d): section filled. Content: independent reviewer |
| Threat note (§3.1) | — | Short | Full | `review-gate` (d) for S2: section filled |
| External-audit scope register entry (§3.2) | — | — | ✅ | Process (orchestrator after merge) |
| Re-review after new commits | — | If the reviewed area changed | Always: delta review by a fresh session, and the owner's "merge" (or the covering go-ahead) still valid for the new head commit: a review-fix round within the same scope stays covered, new scope needs a new go-ahead | Process; `review-gate` (d) re-checks the Threat note and Tests-first evidence |

**S2 and sensitive-path merges (D-51, D-52).** The orchestrator marks the PR ready and reports it to Tali, who answers "merge" in chat, or a go-ahead recorded in chat already covers this specific piece of work (`delivery-process.md` §4; some changes are never covered, see there). Only then does the orchestrator enable auto-merge and record the go-ahead in the PR body; GitHub merges when every required check is green. No GitHub approval is required, and agents never approve a PR. Feedback from `@denisjazbec`, including a "Request changes" review, is logged with a disposition and weighed by the owner before he gives his "merge".

**Sensitive paths (resolved by D-51, simplified).** S1 changes on sensitive paths (`.github/**`, `AGENTS.md`, `CLAUDE.md`, `.claude/**`, supply-chain files, including `review-gate.yml`, the root `package.json`, `pnpm-workspace.yaml`, `.npmrc` and `.pnpmfile.*`) need a human gate: Tali's explicit "merge" in chat, the same as S2. It is a process control, not enforced by the ruleset or by `review-gate`.

**Automated PRs (Renovate, Changesets "Version packages").** A PR is automated only when its **author** (GitHub's `pull_request.user.login`) is `renovate[bot]` or `github-actions[bot]`. Commit author names, e-mail addresses and the `verified` flag are never used: anyone who can push to the branch can forge them. An automated PR has no report to cite, so for S1/S2 `review-gate` (c) is satisfied **only** by an APPROVED GitHub review from `@talirezun` or `@denisjazbec` on the current head commit; a new commit invalidates it. Nothing else is exempt: (b) needs no ticked class, and (d) applies unchanged for S2 (a human fills in the Threat note and Tests-first evidence sections), and the code-owner approval applies as for any S2 PR. The bot is the author, so the owner's own approval counts for (c). Crypto dependency updates remain S2 (`development-process.md` §11): the approver SHOULD have the orchestrator's review of the new version's changelog and diff first. Owner action (`ci-cd.md`, checklist section 6): a ruleset restricting who may push to `renovate/**` and `changeset-release/**` branches, so nobody else can add commits to a bot-authored PR.

**Releases:** any mainnet-bound contract release or crypto release (`@agentlink/crypto`, or any package whose crypto code changed since the last reviewed release) MUST have the owner's "merge" in chat (D-51, D-52) and an independent review recorded on the release PR. `@denisjazbec`'s review is recommended for contracts.

### 3.1 Threat note

Written by the author (orchestrator) in the PR body. **Short (S1):** untrusted inputs touched; checklist items relevant; tests covering them. **Full (S2):** assets; entry points and trust boundaries crossed (03 §5); invariants touched and how each holds; 04 §7 rows affected; abuse cases considered; residual risk. The independent reviewer does **not** receive the threat note (§4.1); the orchestrator compares it with the review afterwards and any mismatch becomes a finding.

### 3.2 External-audit scope register

One entry per merged S2 PR: task ID, PR, merge commit, files, invariants touched, review report ID. Kept at `docs/audits/scope-register.md` (public repo, off-chain components) and `audits/scope-register.md` (contracts repo). Entries contain no finding details. M3-1 scope is built from this register (§8).

### 3.3 `review-gate` (required check)

`.github/workflows/review-gate.yml` runs on every PR event and every review event. It:

| # | Rule |
|---|---|
| a | Derives the class from the changed files (old and new names of renames) with the §2.2 rules; the highest wins. If the file list is incomplete (over 3000 files), it assumes S2. |
| b | Requires the PR template's **Security class** section to tick exactly one class, at least the derived one (an automated PR may leave it unticked; the derived class then applies). |
| c | S1/S2: requires the **Independent review** section to reference a report ID `IR-<TASK-ID>-<n>` (§4.3) and fails on a FAIL verdict. The orchestrator attests that the referenced review happened per §4; CI cannot see the private report. For an automated PR (author `renovate[bot]` or `github-actions[bot]`, §3) it requires instead an APPROVED review by `@talirezun` or `@denisjazbec` on the current head commit. |
| d | S2: requires filled **Threat note** and **Tests-first evidence** sections. The S2 approval check was removed by the owner (D-51, simplified); the owner's go-ahead is a process control recorded in the PR. |
| e | Fails while `DEPLOY_FREEZE` is `true` (`release-and-deployment.md` §3.1). |

The class used for (c) and (d) is the higher of the derived and the declared class. Automated PRs have no exemption beyond (b) and (c) as described above (§3, `ci-cd.md`). A red `review-gate` is never bypassed by an agent; only the owner's break-glass (§6) applies.

---

## 4. Independent review session

### 4.1 Inputs (and nothing else)

| Given | Not given |
|---|---|
| Specs: `04` in full plus the sections cited by the task | Implementation transcript, worker briefs or reports |
| Invariants I-1…I-10 | Worker or orchestrator rationale, PR description, commit messages |
| The diff (`<base SHA>...<head SHA>`) | The threat note |
| Test and CI output for the head commit | Curator content, sync files |
| Read-only access to the repository at the head commit | Prior review reports for this PR (except for a delta review: the finding list only) |
| The area checklists of §5 | — |

The session is a **fresh Opus 5.5 subagent**, spawned by the orchestrator, in read-only mode. It MAY run tests in a scratch worktree. It MUST NOT push, comment or write outside its report.

### 4.2 Procedure

1. State the scope: commit range, files, class, areas touched.
2. Select every applicable checklist in §5.
3. Work through **each item** and record exactly one result: `finding <ID>`, `no finding`, or `n/a: <reason>`. Silence on an item makes the review incomplete; incomplete reviews are rejected.
4. For S2: walk through each touched invariant (I-x) and state how the diff preserves it, with file:line.
5. Judge test adequacy: missing tests for security behaviour are findings.
6. Give a verdict: `PASS` · `PASS WITH FINDINGS` (no Critical/High) · `FAIL`.

### 4.3 Output format

```text
REVIEW IR-<TASK-ID>-<n>
Date / model:      <ISO date> / Opus 5.5
Repo / range:      <repo> <base SHA>...<head SHA>
Class / areas:     <S1|S2> / <checklist IDs applied>
Inputs:            <list of spec sections, CI run IDs>
CHECKLIST:         <item ID> | finding <ID> | no finding | n/a: <reason>   (one line per item)
INVARIANTS (S2):   I-x | holds: <evidence file:line> | finding <ID>
FINDINGS:
  ID:              IR-<TASK-ID>-<n>-F<nn>
  Severity:        Critical | High | Medium | Low | Info   (§9.1)
  Invariant:       I-x | none
  Location:        <path>:<line> @ <SHA>
  Evidence:        <code excerpt, failing test, reproduction steps>
  Recommendation:  <specific fix and the test that would prove it>
  Confidence:      high | medium | low
VERDICT:           PASS | PASS WITH FINDINGS | FAIL
```

### 4.4 Handling

- The orchestrator forwards the report **verbatim** to the owner. It MUST NOT edit, merge or drop findings.
- Each finding is entered into the tracker (§9.2) before the PR leaves `audit`.
- A delta review (new commits after review) covers the new commits and verifies each prior finding's fix.

### 4.5 Storage

Full reports MAY contain unfixed vulnerability details, so they are stored privately, in `4thtech/agentlink-ops` (D-26) under `audits/reviews/` for both repositories. The PR (public) gets one line in its **Independent review** section: report ID, verdict, finding counts by severity, tracker IDs, and the link to the private report. A report MAY be published under `docs/audits/reviews/` once all its findings are closed.

---

## 5. Area checklists

Reviewers apply every checklist the diff touches. Item IDs are stable; new items are appended.

**Crypto (CR)**: 04 §2–§4, §8
- CR-1 No primitive calls outside `@agentlink/crypto`; only allowlisted libraries (`nostr-tools`, `viem`, `@noble/*`, `@hpke/core`, `aws4fetch`); no custom primitives (I-8).
- CR-2 HKDF derivation exactly per 04 §2.1 (salt `agentlink-v1`; info `label‖0x00‖u32be(epoch)‖u8(counter)`; L=32); secp256k1 rejection loop; EVM label always epoch 0.
- CR-3 X25519 clamping left to the library.
- CR-4 `envelopeHash = sha256(JCS(envelope without sig))` (RFC 8785); AEAD AD = `sha256(JCS({v,id,thread,from,createdAt,recipients}))`.
- CR-5 Envelope signature: BIP-340 over `taggedHash("agentlink/envelope/v1", envelopeHash)`; verified before any other processing.
- CR-6 HPKE Base mode, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM; `info = "agentlink/v1/cek"‖id`; empty AAD; `kid` = first 16 bytes of `sha256(encPub)`.
- CR-7 Recipient set always includes recipient agent, recipient owner, sender owner, sender agent (I-9, 04 §3.2).
- CR-8 CEK 32 random bytes per envelope; AES-GCM IVs 12 random bytes, never reused under a key; randomness only from `globalThis.crypto` via libraries.
- CR-9 STREAM file format per 04 §4: `ALF1` header, nonce `noncePrefix‖u32be(index)`, AAD `u8(isFinal)`; truncation and reordering detected.
- CR-10 Pairing: invite stores only `sha256(secret)`; single use; expiry; proof `HMAC-SHA256(secret, "agentlink-handshake"‖inviteId‖sha256(JCS(B card)))` compared in constant time; safety code per 04 §3.6.
- CR-11 Owner seed wrap per 04 §2.3 (PRF salt, HKDF info, AES-256-GCM); recovery code 120 bits with Argon2id m=64 MiB, t=3, p=1; no user-chosen passphrase for relay-published blobs.
- CR-12 Secrets zeroed with `fill(0)` where the platform allows; decrypt failures give uniform errors.
- CR-13 Vectors exist for every new use and pass in Node, Playwright and Miniflare; existing vectors unchanged unless the spec changed.

**Keys and owner presence (KY)**: 04 §2, 08 §1, §3.2
- KY-1 Agent seed only in the OS keychain (service `agentlink`, account `<agentId>`), or Worker secret / DO storage in the user's account.
- KY-2 Owner seed never stored unwrapped on the agent machine; unlock only by localhost passkey PRF or owner passphrase.
- KY-3 Every owner operation (04 §2.5 list) is an owner-signed object verified against the owner key in the agent card before it applies; nonce and `issuedAt` prevent replay.
- KY-4 Policies are signed documents re-verified on load; unsigned or tampered → defaults.
- KY-5 Local UI: bound to `127.0.0.1`; session token in memory only; token grants viewing only; `Host` and `Origin` checks; no reusable bearer token on disk.
- KY-6 The same-OS-user test (M1-8) exists, covers the change and passes.
- KY-7 No MCP tool code path reaches `OwnerKeyStore`.
- KY-8 Store key in the keychain; sensitive columns encrypted (07 §3).
- KY-9 Rotation: EVM key unchanged; old epoch keys re-derivable; `card-update` only from the same owner with a higher epoch.
- KY-10 Cloud agent: seed generated locally and set by `wrangler secret put`, or `/setup` gated by a one-time code with `SEED_WRAP_KEY`; 4thTech never sees either.

**Inbound content (IN)**: I-5, 06 §4, 04 §3.5–§3.6
- IN-1 All inbound text, payloads and file names are returned inside `<untrusted_content …>` in both the text result and `structuredContent`, with the trailer.
- IN-2 `</untrusted_content>` (case and whitespace variants) and control characters are stripped or escaped.
- IN-3 Inbound content never appears in tool descriptions, server instructions or error messages.
- IN-4 No code path turns inbound content into a tool call or command; the prompt-injection suite covers the change.
- IN-5 Seal pubkey equals `envelope.from`; signature valid; unknown senders → requests queue; `handshake` accepted only with a valid unused invite proof.
- IN-6 Every inbound object is schema-validated before use; size limits (envelope 24 KB, inline 12 KB, deflated invite size capped before inflation).
- IN-7 Per-contact rate limits; dedup by envelope ID with a seen-set ≥ 7 days.
- IN-8 `approval` and `policy` envelopes accepted only when signed by the owner key in the agent card.
- IN-9 Display names labelled self-declared unless registered; cloud autonomy off by default.

**Files, URLs, SSRF and realpath (FS)**: 04 §4, 06 §2.3
- FS-1 `agentlink_fetch_file`: `https` only; hosts resolving to loopback, private, link-local (incl. `169.254.169.254`), unique-local, unspecified or IPv4-mapped forms of these are rejected; the checked address is the one connected to.
- FS-2 Redirects ≤ 2, each re-checked; download capped at declared size plus overhead, enforced while streaming.
- FS-3 `ciphertextSha256` checked before decrypting, `plaintextSha256` after.
- FS-4 Downloads only into the inbox folder; never executed; names sanitized (no paths, control characters or hidden files); no write outside the inbox.
- FS-5 `agentlink_send` with `path`: `realpath` resolved; inside an allowed folder after resolution; hidden files, `~/.ssh`, `~/.agentlink` and keychain directories refused; outside → `needs_setup` without reading the file; the file read is the file checked.
- FS-6 Every path or URL from tool arguments or inbound content (incl. relay URLs from contact cards and `agentlink_verify_proof_pack.path`) gets the same rules.
- FS-7 Expiry ≤ 7 days; crypto-shred on `deleteAfter`; object keys contain no names.
- FS-8 Storage credentials only in keychain or Worker secrets.

**Logging (LG)**: I-7, 04 §8.4
- LG-1 Only the shared redacting logger; no direct `console.*` in packages.
- LG-2 Never logged, including debug mode: plaintext, keys, seeds, presigned URLs, salts, decrypted metadata, file keys, storage credentials, OAuth and session tokens, recovery codes.
- LG-3 Errors and stack traces carry no secrets and no inbound content.
- LG-4 The CI secret-pattern log test covers the new code paths.
- LG-5 No telemetry or analytics carrying any of the above.

**MCP tool surface (MCP)**: I-4, 06
- MCP-1 Tool names and schemas match 06 §2; an addition is a spec change; the tool-list CI test passes.
- MCP-2 No tool changes policies, exports keys, adds storage credentials, reads arbitrary files or bypasses approvals.
- MCP-3 `inputSchema` and `outputSchema` declared; `structuredContent` plus text; `status` within the enum; `nextStep` and `url` on non-`ok`; a behaviour test per status.
- MCP-4 `approvalId` valid once, for the identical action only, with expiry; `clientRequestId` idempotent.
- MCP-5 Server instructions match 06 §5 verbatim and are static; summaries follow 11 §5 vocabulary.
- MCP-6 Policy checks (budgets, `perActionMaxUSD`, `allowKeyDisclosure`) run in core, not in the model; `OPENED` only via explicit `agentlink_acknowledge`.
- MCP-7 Cloud: OAuth tokens scoped per agent and revocable; authorize requires owner proof.

**Contracts (CT)**: 05, esp. §8
- CT-1 05 §8 suite: unit per function and revert path; fuzz for signatures, fees, credits; the four invariant tests; ERC-1271 signers (Safe-style and passkey-style).
- CT-2 Checks-effects-interactions and `nonReentrant` on every value transfer; `call`, never `transfer`; native `msg.value` matches amount (zero on ERC-20 paths).
- CT-3 `SafeERC20`; credits equal the measured balance delta; fee-on-transfer tokens never allowlisted.
- CT-4 `depositWithAuthorization` calls `receiveWithAuthorization` with payee = vault (never `transferWithAuthorization`); `value ≥ minDeposit`; EIP-3009 flag required.
- CT-5 AccessManager: every restricted selector mapped to its intended role; nothing left reachable through the admin role by accident. OZ AccessManager execution delays attach to (role, account) grants, so **each delay tier is its own role** (e.g. Notary/Registry upgrades 48 h vs vault upgrades 7 d; ADMIN 48 h vs `freezeUpgrades` 7 d). Grant delays, target-admin delays and guardians set as configured.
- CT-6 No admin path can move, freeze or reduce a payer's credits; pause blocks charges and deposits and **never** `withdraw`.
- CT-7 `freezeUpgrades` is one-way: afterwards `_authorizeUpgrade` always reverts regardless of roles.
- CT-8 UUPS: implementations call `_disableInitializers()`; proxies initialised in the deploying transaction; initializers not re-runnable.
- CT-9 ERC-7201 namespaced storage; a storage-layout diff against the last deployed version accompanies every upgrade (no reorder, removal or type change).
- CT-10 EIP-712 parity: domain `{name:"OCC", version:"2", chainId, verifyingContract}`; AgentCard domain `{name:"OCC AgentCard", version:"1"}`; typehash strings exact; shared vectors pass both sides.
- CT-11 Replay: `recordId = keccak256(abi.encode(chainid, this, signer, nonce))` single use; deadlines enforced; one receipt per type; ACCEPTED/REJECTED exclusive; Registry `regOwnerSig` and `revoke` nonces; EIP-3009 nonces.
- CT-12 Signatures via `SignatureChecker.isValidSignatureNow`; malleable EOA signatures rejected.
- CT-13 Fees: `protocolFee ≤ maxProtocolFee`; integrator cap applied at charge time; `integratorFeeCapMultiple ≤ 10`; `total ≤ maxTotal`; inactive app reverts.
- CT-14 Gas targets met with snapshots: `notarize` ≤ 160k, `acknowledge` ≤ 75k, `notarizeBatch` ≤ 120k per item (n=20).
- CT-15 Slither and Aderyn clean, or each justification reviewed and recorded.
- CT-16 Deploy script: CreateX CREATE3 with a deployer-guarded salt (no cross-chain front-running); all roles transferred to the Safe in the same script; deployer holds no role; per-chain config verified; Solidity and `evm_version` pinned and supported on every target chain.
- CT-17 Clean-room: no OCC v1 code copied.

DECISION NEEDED (owner): pause behaviour of `withdrawIntegrator` and `sweep` (05 §2.5 covers payer withdrawals only).

**Web (WEB)**: 08 §2.3, §4
- WEB-1 CSP: `default-src 'self'`; `script-src 'self'` with SRI; `connect-src 'self' https: wss:`; Trusted Types; `frame-ancestors 'none'` on approval and console pages.
- WEB-2 No third-party scripts, analytics, CDNs or remote fonts.
- WEB-3 Separate origins (`console.`, `verify.`, `invite.`, `pay.`); the deposit page never touches owner keys.
- WEB-4 The URL fragment is never sent (requests, `Referer`, logs); `Referrer-Policy: no-referrer`; asserted in Playwright.
- WEB-5 Untrusted content rendered as text only; no raw HTML injection.
- WEB-6 Reproducible build; build hash shown in console Settings; service-worker updates cannot bypass SRI.

**CI/release supply chain (SC)**
- SC-1 Actions pinned to full SHAs; `zizmor` clean; top-level `permissions: {}` with minimal job permissions; `persist-credentials: false`.
- SC-2 No `pull_request_target` checkout of PR code; no secrets reachable from PR workflows; no event data interpolated into shell.
- SC-3 Frozen lockfile; install scripts disabled except the reviewed allowlist; Renovate cooldowns intact (3 d, 7 d crypto).
- SC-4 Release only via `release.yml`: Changesets, npm trusted publishing with provenance, bound to Environment `npm-next` (unattended, `main` only) for `next` and `npm-publish` (owner approval click, required reviewer with no removal date, D-52) for `latest`; no long-lived npm token; no registry override in `.npmrc` or `publishConfig`.
- SC-5 Caches written by untrusted workflows are never read by release workflows.
- SC-6 CODEOWNERS covers every S2 path plus `.github/`, `AGENTS.md`, `CLAUDE.md`, `.claude/`, the root `package.json` and `pnpm-workspace.yaml`, and `.npmrc` and `.pnpmfile.*` at any depth, and nothing else; its paths and the `review-gate` class rules match §2.2; new dependencies carry a justification.
- SC-7 Every publish and deploy job is guarded by `DEPLOY_FREEZE` (job condition and a re-check at start); production jobs run only in an Environment restricted to `main` and tags (the owner removes the `production` required reviewer at M1b; `npm-publish` keeps its required reviewer, D-52).
- SC-8 No job holding `id-token: write` or deploy credentials runs build or package code beyond the publish or deploy tool itself; health checks in those jobs read only; smoke tests that run published code have no credentials.
- SC-9 `review-gate`: no event data in scripts; logic still mirrors §2.2 and §3.3; automated PRs are identified only by the PR author, never by commit metadata, and meet (c) only through a code-owner approval on the head commit; no other exemption exists.

**Submitter (SUB)**: 07 §7
- SUB-1 Never sees plaintext; cannot alter records; stateless except rate-limit DO.
- SUB-2 `eth_call` simulation before submit; reject on insufficient credits; per-signer and per-IP rate limits.
- SUB-3 Deposit authorization: `value ≥ minDeposit` and EIP-3009 support checked.
- SUB-4 Gas keys only in Worker secrets set by the owner; low balances; alerts.
- SUB-5 No request logging beyond aggregates; never signatures linked to IPs.
- SUB-6 Request size, batch size and chain-ID allowlist enforced; RPC URLs from config only.
- SUB-7 Faucet refuses every mainnet chain ID (hard-coded allowlist of testnets).
- SUB-8 Gas-wallet nonce handling and idempotent resubmission.

---

## 6. Continuous-audit gates

| Control | Enforced by | Blocks merge |
|---|---|---|
| Lint, typecheck, build, unit tests (incl. secret-pattern log test, MCP tool-list test, policy-engine tests) | `ci.yml` → `ci-gate` | Yes |
| Cross-runtime vectors (Node, Playwright, Miniflare) | `ci.yml` → `ci-gate` | Yes |
| Dependency review (vulnerabilities, licences) | `security.yml` → `security-gate` | Yes |
| Secret scanning (gitleaks CLI) | `security.yml` → `security-gate` | Yes |
| CodeQL | `security.yml` → `security-gate` | Yes |
| Workflow security (zizmor) | `security.yml` → `security-gate` | Yes |
| Task-ID title, PR template sections | `pr-hygiene.yml` → `pr-hygiene` | Yes |
| Security class, review evidence, S2 approval, deploy freeze (§3.3) | `review-gate.yml` → `review-gate` | Yes |
| Owner's "merge" go-ahead on S2, CI, agent-rule and supply-chain paths (D-51, D-52) | Process (chat, recorded in the PR body) | No |
| Agents under the owner's account: no admin bypass, deny rules, owner go-ahead for S2 and sensitive paths (D-51) | Ruleset (empty bypass list), harness deny rules, process | Partly (process) |
| Context budgets of auto-loaded files (`development-process.md` §3.6) | `ci.yml` → `context-budget` → `ci-gate` | Yes |
| Contracts: fmt, build, tests incl. fuzz and invariant, gas snapshot, Slither, Aderyn, deployer-holds-no-role | `contracts-gate` | Yes (by process: Free plan, §6.1) |
| Dependency cooldown | `renovate.json` | — |
| Provenance on publish; registry health check and rollback | `release.yml` | Release |
| Staging smoke tests; production health check, rollback, freeze | `release.yml`; Cloudflare deploy workflow (`release-and-deployment.md` §4.5–§4.6) | Release |
| E2E and prompt-injection suite | DECISION NEEDED (`development-process.md` §10) | Release |

Once the monorepo skeleton exists, CI strict mode (`.github/ci-strict`) MUST be enabled so missing steps fail instead of skipping. The `main` ruleset has no bypass actors. Getting past a red gate is an owner-only break-glass action: the owner changes the ruleset temporarily, records the reason in the PR, restores the ruleset, and the event is reviewed at the next milestone gate. Agents never do this and never merge with admin bypass.

### 6.1 Plan limits

The organisation stays on the GitHub **Free** plan (D-27), revisited before M3. Rulesets, required checks and Environment reviewers are enforceable only on the public repo. The private repos (`occ-v2-contracts`, `agentlink-ops`) have no rulesets and no Environment protection, and CodeQL, dependency review and GitHub secret scanning there would need paid products. Compensating controls: testnet keys only, low balances, process discipline; `contracts-gate` plus gitleaks, verified by the owner before every merge; mainnet keys never touch GitHub.

---

## 7. Milestone audits (`M1-GATE`, `M2-GATE`, `M3-GATE`)

Run by a fresh Opus 5.5 audit session over everything merged in the milestone, then signed off by the owner.

| Part | Content | Evidence |
|---|---|---|
| A. Invariant walkthrough | I-1 … I-10, one row each: how it holds, where enforced, what could break it | Test names (`file › test`), CI run IDs, code locations at the gate commit |
| B. Threat model | Every row of 04 §7: mitigation implemented, tested, or still open; new threats introduced by the milestone | Same |
| C. Dependency and licence audit | Full tree; new dependencies since the last gate with justifications; licences vs allowlist; install scripts; advisories; unmaintained packages | Lockfile diff, report |
| D. Findings register | Every finding: state, disposition, verification; accepted risks reaffirmed by the owner | Tracker export |
| E. Boundary sweep | Public repo full history (incl. `sync`) scanned for secrets and private items (`development-process.md` §12) | gitleaks report |
| F. Process | Gate-bypass (break-glass) log; ruleset bypass list empty; required-check list; strict mode; CODEOWNERS and `review-gate` rules match §2.2; Environment reviewers and branch restrictions; every production deployment preceded by a green staging smoke test and every npm `latest` publish approved by the owner (D-52); `DEPLOY_FREEZE` history; review evidence on a sample of S1/S2 PRs; scope register complete | — |

Milestone additions: **M1**: same-OS-user test, prompt-injection suite, testnet contracts and faucet. **M2**: web checklist on console, verify and invite; cloud agent; Registry. **M3**: M3-1 closed (§8); release prerequisites of `release-and-deployment.md` §4.3.

**Exit criterion:** zero open Critical or High findings. Before mainnet (M3-GATE) also zero open Medium (§9.3). The report is stored privately (§4.5); a summary goes into the owner's sync file without vulnerability details.

---

## 8. External audits (M3-1)

| Rule | Detail |
|---|---|
| Scope | Contracts: external firm. `@agentlink/crypto` and `@agentlink/core`: independent review (10 M3-1, 04 §8.5). Scope = the S2 register (§3.2) at the audit commit. |
| Procurement | Start no later than when M1-3 contract interfaces stabilise; reputable firms book weeks to months ahead. DECISION NEEDED (owner): firms, budget, start date, and whether scope extends to `packages/node` (`OwnerKeyStore`) and console identity. |
| Readiness | Specs, threat model, NatSpec, coverage, Slither/Aderyn output, known-issues list and scope register handed over. |
| Pinned commit | The audited commit is tagged in each repo (`audit-<firm>-<yyyymmdd>`) and recorded with its SHA. |
| Deploy rule | Mainnet deploys only the audited commit (bytecode rebuilt and compared). Any change after the audit needs **auditor re-review** or a **recorded owner risk acceptance** (D-xx). |
| Fixes | Each fix is verified by the auditor; the final report lists every finding's status. |
| Disposition | For M3-1, High and Medium findings MUST be fixed (10 M3-1); accepted risk is not available for them unless the build plan is amended by a D-xx. |
| Publication | Reports are published at mainnet. Bug bounty after mainnet (05 §8). DECISION NEEDED (owner): bounty platform and budget. |

---

## 9. Findings management

### 9.1 Severity

| Severity | Definition (any one suffices) |
|---|---|
| **Critical** | Any breach of **I-1, I-2, I-3 or I-4**; loss, theft or freezing of user credits or funds; forged records, receipts, approvals or policies; bypass of owner presence; key or seed extraction; remote code execution. |
| **High** | Practical breach of I-5…I-10 (e.g. inbound content causing a tool call, replay of a record or receipt, secrets in local logs, owner unable to decrypt, no export path); SSRF to internal addresses; path escape from allowed folders; contract DoS of core functions; charging above `maxFee`. |
| **Medium** | Defence-in-depth failure without a direct exploit; spec deviation in security behaviour; missing tests for security behaviour; gas target missed. |
| **Low** | Hardening and best-practice gaps. |
| **Info** | Observations. |

A finding touching an invariant MUST NOT be rated below the floor above without the owner.

### 9.2 Tracking

| Repo | Tracker |
|---|---|
| `4thtech/agentlink` (public) | GitHub **private security advisories** (draft) for Critical, High and Medium. Low/Info MAY be public issues without exploit detail. |
| `4thtech/occ-v2-contracts` (private) | Private issues labelled `security` and `sev:<level>`. |

Unfixed Critical or High findings MUST NEVER appear in public issues, PRs, commit messages, sync files or the public scope register. Each record holds: ID, source (IR / milestone / external / CI / report), severity, invariant, component, commit, state, dates, disposition, fix PR, verifier, regression test.

### 9.3 SLAs

| Severity | SLA |
|---|---|
| Critical | **Stop the line** (§10) until fixed and verified. |
| High | Fixed before the milestone gate; never shipped to production. |
| Medium | Fixed before mainnet. |
| Low / Info | Dispositioned before mainnet. |

DECISION NEEDED (owner): post-mainnet SLAs for High, Medium and Low.

### 9.4 Dispositions

| Disposition | Requirements |
|---|---|
| **Fixed** | Fix PR plus a regression test that fails on the pre-fix commit. |
| **Accepted risk** | Owner sign-off recorded as D-xx with scope and expiry. **Not available** for a breach of any invariant (04 §1 is non-negotiable) or for M3-1 High/Medium findings. |
| **False positive** | Written rationale, agreed by someone other than the author of the code (the owner for Critical/High). |

The fix is **verified by someone other than the person or session that fixed it**: a fresh review session, a human reviewer, or the auditor for external findings. A regression reopens the finding.

---

## 10. Stop-the-line

### 10.1 Triggers

- An open Critical finding, or a suspected breach of I-1…I-4 anywhere.
- A secret, key or seed committed, pushed, logged, or exposed in CI output, artifacts, Curator, sync files or chat.
- A private item (`development-process.md` §12.1) in the public repo.
- Compromise or suspected compromise of GitHub, npm, Cloudflare, CI, a deployer key, a gas key or a Safe signer.
- An unexpected artifact: npm version without provenance or with unexpected contents; served site hash ≠ release hash.
- `main` red on `ci-gate` or `security-gate`; vectors failing across runtimes on `main`.
- A failed production health check or rollback (the release workflows set `DEPLOY_FREEZE` themselves).
- An agent attempting a forbidden action (admin-bypass merge, push to `main`, approving a PR or a deployment, clearing `DEPLOY_FREEZE`, changing rulesets, CODEOWNERS or environments, a workstation deploy, weakening a test).
- On-chain: unexpected role grant, scheduled operation, upgrade or pause.

### 10.2 Effects

`DEPLOY_FREEZE` is set (any agent MAY set it; `release-and-deployment.md` §3.1): every deploy stops and `review-gate` turns red, so nothing merges. Whoever sets it also disables auto-merge on open PRs. To land the fix, the owner clears the freeze when the fix PR is ready, and auto-merge stays off on every other PR until the incident is closed; production deploys through the normal pipeline once the freeze is cleared (D-52). The orchestrator stops new work in the affected area; the owner is notified immediately; an incident record is opened (`release-and-deployment.md` §7).

### 10.3 Secret-leak response

1. Assume compromise. Do not wait to confirm exploitation.
2. **Revoke and rotate first** (`release-and-deployment.md` §6); move funds off exposed gas keys.
3. Remove the secret from the repo or system. Rewriting public history needs the owner and does not un-publish it.
4. Assess: what the secret could reach; logs; on-chain activity.
5. Notify the owner; notify users if any user data or service integrity was affected.
6. Postmortem with root cause and a preventive control (scanner rule, test).

An agent that finds a secret MUST NOT copy, print, move or use it; it reports the location (file:line) only.

---

## 11. Audit trail and retention

| Record | Location |
|---|---|
| PRs, approvals, relayed reviews, CI results | GitHub (public repo / private repo) |
| Independent review, milestone and external audit reports | Private store (§4.5); published after closure |
| Findings | Advisories and private issues (§9.2) |
| Decisions, risk acceptances, gate passes | Decision log in `docs/foundation/00-README.md` |
| Deploy records, incidents | Per `release-and-deployment.md` |
| Feedback dispositions | Owner's sync file (`development-process.md` §14) |

CI logs expire, so evidence used for acceptance or audits MUST be copied (key output, counts, hashes) into the PR or report, not only linked. Reports are never edited after sign-off; corrections are addenda. DECISION NEEDED (owner): retention period for audit records (proposed: at least five years after the last production use of the component).

---

## 12. Vulnerability disclosure

- `SECURITY.md` in each public repo describes private reporting through GitHub private vulnerability reporting and a security contact, and coordinated disclosure: acknowledge, triage, fix, advisory, credit. DECISION NEEDED (owner): security contact address and disclosure timelines (proposed 90 days).
- External reports enter §9 like any finding.
- Legacy issues are tracked as `OPS-L1`…`OPS-L9` and referenced publicly by ID only. Details stay in private doc 09; 09 §4 is published only after L-1 and L-5 are fixed or confirmed offline. Notifying OCC v1 users (L-1) is an owner action.

---

## Change control

Changing this document requires the owner's approval and a decision log entry (D-xx) in `docs/foundation/00-README.md`. Changes that relax any requirement are S2. Agents may propose changes but MUST NOT enable auto-merge on them: the owner merges, or enables auto-merge, himself.
