<!--
Title format: start with the task ID, e.g. `M1-5 transport-nostr sync`
(other allowed prefixes: OPS-<n>, OPS-<WORD>-<n> such as OPS-CI-3, DOCS, CHORE, DEPS).

Two required checks read this description:
- `pr-hygiene`: every section below up to "Checklist" must contain something.
  Write "None" or "N/A" where nothing applies, except in "Docs impact", which must list
  the docs updated or say "none: <reason>".
- `review-gate`: reads "Security class", "Independent review", "Threat note" and
  "Tests-first evidence". It derives the class from the changed files and fails
  if the ticked class is lower (docs/process/audit-rules.md §2-§3).
Keep the section headings exactly as they are. HTML comments are ignored.
One task per pull request (docs/process/backlog.md).
-->

## Task ID & summary
<!-- Task ID from docs/process/backlog.md (e.g. M1-5) and 2-4 sentences: what changed and why. -->


## Spec sections implemented
<!-- e.g. 04 §3.5, 07 §4.2. Specs in docs/foundation/ are the source of truth. -->


## Invariants touched
<!--
Which of I-1 ... I-10 (docs/foundation/04-security-and-crypto.md §1) does this change touch, and how does each one still hold?
Never weaken an invariant, test or policy default to make something pass; flag it here instead.
Write "None" if no invariant is touched.
-->


## Security class
<!-- Tick exactly one. Path defaults and content rules: audit-rules.md §2. The highest applicable class wins; only the owner may lower one. -->
- [ ] **S0**: none (docs outside docs/foundation and docs/process, tooling without secrets, styling without data-flow change)
- [ ] **S1**: sensitive (inbound content; files, paths or URLs; storage credentials; policy or approval UI; CI, release or supply-chain configuration; the chain client; specs and agent instructions)
- [ ] **S2**: critical (crypto; keys and owner presence; envelope or pairing protocol; policy engine; contracts; anything that signs; the submitter; deploy scripts with roles; test vectors)


## Tests added
<!-- Crypto, policy engine and anything that signs: tests first, including test vectors. Every MCP tool: schema test + one behaviour test per `status` value. Bug fixes: a regression test. -->


## Docs / spec updated
<!-- Cross-package interfaces change only through a PR that updates the relevant spec document. Status changes (a card done, a milestone or component moved, a deploy, a release) go in docs/status.yaml, then run `node tools/docs-status/index.mjs` to regenerate the README Status and the docs-site and knowledge pages; never claim unimplemented features. "None" if nothing changed. -->


## Docs impact
<!-- Required. List every doc updated by this PR (README Status, docs/status.yaml and its generated blocks, docs-site/, knowledge/, changelog fragment in changelog.d/, specs, runbooks), or write "none: <reason>" (for example "none: internal refactor, no behaviour or interface change"). A bare "None" is refused by pr-hygiene. -->


## Dependencies added
<!-- Package, version, why it is needed, license, why not zero-dependency. No `postinstall` scripts. "None" if no dependency was added. -->


## Review requirements
<!-- audit-rules.md §3, D-51. S0/S1: agents may enable auto-merge (`gh pr merge N --auto --match-head-commit <sha>`; the merge queue decides the method); GitHub merges when every check is green. S2 and sensitive paths (.github, AGENTS.md, CLAUDE.md, .claude, supply-chain files): merge only after CI, the independent AI review and Tali's "merge" in chat; record the go-ahead here. Agents never approve and never use admin bypass. -->
- [ ] S1/S2: independent review report referenced under "Independent review"
- [ ] S2 and sensitive paths (`.github/**`, `AGENTS.md`, `CLAUDE.md`, `.claude/**`, supply-chain files): Tali's explicit "merge" in chat, recorded here (D-51); Denis's approval is not required
- [ ] S2: threat note and tests-first evidence filled in below


## Independent review
<!--
S1/S2 (review-gate checks it): the one-line summary of the independent review report (audit-rules.md §4.5):
report ID (IR-<TASK-ID>-<n>), verdict, finding counts by severity, tracker IDs, and the link to the
private report in 4thtech/agentlink-ops. No unfixed vulnerability details here: this repository is public.
S0: N/A.
-->


## Threat note
<!-- S1: short; S2: full (audit-rules.md §3.1). Not given to the independent reviewer. S0: N/A. -->


## Tests-first evidence
<!-- S2: the RED commit SHA (before the implementation commit), the exact command and a short output excerpt from your local red run. S0/S1: N/A. -->


## Open questions
<!-- Anything you want a decision on. "None" if nothing. -->


## Checklist
- [ ] Task ID in branch name and PR title
- [ ] Spec sections implemented are listed above
- [ ] Invariants touched are listed above (and how they hold)
- [ ] Tests added; `pnpm test`, `pnpm lint` and `pnpm typecheck` pass
- [ ] Docs/spec updated if an interface changed; `docs/status.yaml` updated (and `node tools/docs-status/index.mjs` run) if status changed; "Docs impact" filled in
- [ ] No private keys, seeds, plaintext, file keys, salts or presigned URLs in code, tests, logs or fixtures (labelled test vectors excepted)
- [ ] No OCC v2 Solidity source, docs 01/09 or unfixed vulnerability details (this repository is public)
