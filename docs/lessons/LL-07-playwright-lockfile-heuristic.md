# LL-07 · The word "playwright" in the lockfile makes CI install browsers

**Problem.** Adding the root `vectors:check` script in the skeleton.

**Symptom.** The `vectors` job failed at `pnpm exec playwright install` with "Command playwright not found".

**Cause.** `ci.yml` decided to install Playwright by grepping `pnpm-lock.yaml` for "playwright". Vitest lists `@vitest/browser-playwright` as an optional peer, so the word is in the lockfile although Playwright is not installed.

**Rule.** Decide from the root `package.json`, not the lockfile. Since M0-9, `detect` installs browsers only when `playwright` or `@playwright/test` is a root devDependency. The vector harness uses `playwright` (through Vitest browser mode), not `@playwright/test`.

**Source.** M0-2d (PR #2) open question 6; fixed in M0-9 (PR #13), `.github/workflows/ci.yml` `detect` job.
