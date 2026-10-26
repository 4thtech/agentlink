# RB-07 · Adding a dependency

## Purpose
Add a third-party package only when it earns its place, at an exact, aged version, with no install scripts sneaking in, and inside the import zones that keep crypto in `@4thtech-io/crypto`.

## When to use
Any new runtime or dev dependency, or a new major version. Routine updates come from Renovate. Not for the crypto allowlist (`nostr-tools`, `viem`, `@noble/*`, `@hpke/core`, `aws4fetch`; `@cloudflare/workers-oauth-provider` in `apps/cloud-agent` only, D-131): adding to it changes 04 and needs a decision-log entry and the owner's approval.

## Who runs it
The builder, only when the brief grants the dependency ("Dependencies: name@version: justification"); otherwise it stops with `STATUS: escalate`. The orchestrator checks it in the verification protocol (`development-process.md` §5, step 3). Sonnet or above; S2 packages need Opus.

## Preconditions
- The monorepo skeleton (M0-2d) is on `main`: `pnpm-workspace.yaml` with `minimumReleaseAge`, `allowBuilds` and `strictDepBuilds`, and `eslint.config.mjs` with the import zones.
- You have considered "no dependency" and at least one alternative.

## Steps
1. Inspect the candidate without installing it:
   ```bash
   npm view <name>@<version> license scripts dependencies repository
   npm view <name> time --json | grep '"<version>"'
   ```
   - Licence compatible with MIT: the proposed allowlist is MIT, ISC, BSD-2/3-Clause, Apache-2.0, 0BSD, CC0-1.0 (owner decision pending, `development-process.md` §11.8; `security-gate` enforces its own list). Never GPL, LGPL, AGPL, EUPL, SSPL or BUSL.
   - `scripts` has no `preinstall`, `install` or `postinstall`, or you have a reason it must build (step 4).
   - Published at least 3 days ago (7 for crypto-related packages). pnpm enforces `minimumReleaseAge: 4320` minutes and refuses younger versions.
2. Add it with an exact version, to the one package that needs it:
   ```bash
   pnpm add --filter <workspace-package> -E <name>@<version>          # -D for a devDependency
   ```
3. Check the import zone. `eslint.config.mjs` allows each crypto or transport library only in named zones (for example `@noble/*` only in `packages/crypto`), and Node built-ins only in `packages/node` and `apps/cli`. Run:
   ```bash
   pnpm lint
   ```
   A `no-restricted-imports` error means the design is wrong, not the rule. Widening a zone is its own reviewed S1 change (M0-10).
4. If the install fails with `ERR_PNPM_IGNORED_BUILDS`, the package wants to run a build script. Prefer a package that does not. If it is unavoidable, propose an `allowBuilds` entry in `pnpm-workspace.yaml` plus the matching `rebuild:` line in `ci.yml`. Both are supply-chain or `.github` files: the owner's "merge" is required, and CI keeps `--ignore-scripts`. Never use `onlyBuiltDependencies` (lesson [LL-05](../lessons/LL-05-pnpm-allow-builds.md)).
5. Write the justification in the PR's **Dependencies added** section: purpose; alternatives considered (including none); maintainers and activity; licence; transitive count; install scripts; runtime targets (Node, browser, Workers).

## Verify
- `git diff origin/main...HEAD -- '**/package.json' pnpm-workspace.yaml` shows only the intended entry, pinned exactly (no `^` or `~`).
- `pnpm install --frozen-lockfile` and `pnpm lint && pnpm typecheck && pnpm test` pass.
- `security-gate` (dependency review: vulnerabilities and licence) is green on the PR.

## If it fails
- **Dependency review red:** pick another version or package; never add an exception yourself.
- **Too young for `minimumReleaseAge`:** wait, or pick an older version. Do not lower the setting.
- **Remove a dependency:** `pnpm remove --filter <workspace-package> <name>` and say why in the PR.

## Related
- Rules: [`development-process.md`](../process/development-process.md) §11 (dependency policy); `AGENTS.md` (allowlist, no `postinstall`, justification); [`ci-cd.md`](../process/ci-cd.md) "Contract with the monorepo skeleton"; [`audit-rules.md`](../process/audit-rules.md) §2.2 (supply-chain files are S1, some code-owned).
- Lessons: [LL-05](../lessons/LL-05-pnpm-allow-builds.md), [LL-07](../lessons/LL-07-playwright-lockfile-heuristic.md).
