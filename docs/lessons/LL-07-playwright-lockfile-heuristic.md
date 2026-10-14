# LL-07 · The word "playwright" in the lockfile makes CI install browsers

**Problem.** Adding the root `vectors:check` script in the skeleton.

**Symptom.** The `vectors` job failed at `pnpm exec playwright install` with "Command playwright not found".

**Cause.** `ci.yml` decides to install Playwright by grepping `pnpm-lock.yaml` for "playwright". Vitest lists `@vitest/browser-playwright` as an optional peer, so the word is in the lockfile although Playwright is not installed.

**Rule.** Add the root `vectors:check` script only together with a real `@playwright/test` root devDependency (M0-9). A better heuristic (read the root `package.json`) is a `.github` change for the owner.

**Source.** M0-2d (PR #2) open question 6; `.github/workflows/ci.yml` `detect` job.
