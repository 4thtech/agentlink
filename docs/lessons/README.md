# Lessons learned

Each file is one hard-won lesson: the **problem** we were solving, the **symptom** we saw, the **cause**, and the **rule** we now follow. Read them all on your first day; they take ten minutes.

A lesson explains a rule; it does not create one. When a lesson needs a binding rule, that rule goes into a process document (`delivery-process.md` §3.5) or a runbook, in a PR, and the lesson links to it. IDs are `LL-<nn>` so they never collide with the legacy security items `L-1`…`L-9`.

| ID | Lesson |
|---|---|
| [LL-01](LL-01-classifier-blocks-gate-edits.md) | The safety classifier blocks agent edits to merge-gate logic |
| [LL-02](LL-02-pr-title-prefix.md) | PR titles must start with a task ID or an allowed prefix |
| [LL-03](LL-03-no-push-to-main.md) | Never push to `main`; always branch plus PR |
| [LL-04](LL-04-turbo-agent-guidance.md) | Turborepo rewrites `AGENTS.md` unless told not to |
| [LL-05](LL-05-pnpm-allow-builds.md) | pnpm 11 and later ignore `onlyBuiltDependencies` |
| [LL-06](LL-06-vitest-root-config.md) | A root `vitest.config.ts` leaks into every package |
| [LL-07](LL-07-playwright-lockfile-heuristic.md) | The word "playwright" in the lockfile makes CI install browsers |
| [LL-08](LL-08-drive-docs-stale.md) | Copies of the specs outside the repository go stale |
| [LL-09](LL-09-shared-scratch-files.md) | Parallel agents overwrite each other's scratch files |
| [LL-10](LL-10-zsh-glob-in-gh-api.md) | zsh treats `?` in a URL as a glob |
| [LL-11](LL-11-ambiguous-go-ahead.md) | An ambiguous owner message is not a merge go-ahead |
| [LL-12](LL-12-stacked-pr-after-squash.md) | A stacked PR conflicts after its base is squash-merged |
| [LL-13](LL-13-open-prs-after-review.md) | Failed-run emails come from PR runs under the owner's account; open PRs only after review |
| [LL-14](LL-14-red-ci-emails-owner.md) | Red CI runs e-mail the owner; prove red locally, and the reviewer reproduces it |
| [LL-15](LL-15-s2-red-commit-unchecked.md) | An S2 PR merges only with its RED commit checked |
| [LL-16](LL-16-design-status-one-place.md) | The design status lives in one place, and session start reads it |
| [LL-17](LL-17-ci-starvation-stale-pr-ejections.md) | 2026-10-22 CI starvation and stale-PR ejections: causes and fixes |

## Adding a lesson

1. Write it in the PR that fixes the problem, or the next one.
2. Copy the shape of an existing file: a title line `# LL-<nn> · <the rule in a few words>`, then **Problem**, **Symptom**, **Cause**, **Rule**, **Source**. Keep it under 20 lines.
3. Public repository: no secrets, nothing from the private docs 01 or 09, no details of unfixed vulnerabilities (reference a private advisory or issue ID instead).
4. Add a row to the table above.
