# RB-18 · Releasing v0.1.0 (owner checklist)

## Purpose
Everything Tali does to publish `@4thtech-io/agentlink@0.1.0` to npm `latest`, in order, as one checklist. Agents prepared the code and docs; they never click, approve or publish.

## When to use
Once, for the first release. Later releases skip Part A.

## Who runs it
The owner (Tali). Parts B and C work on the web or GitHub mobile; Part A needs a terminal.

## Preconditions
- The PR `DOCS: v0.1.0 release checklist, release note and docs pass` is merged first, so its CHANGELOG line flows into the "Version packages" PR (#124), which the bot then refreshes.
- `gh variable get DEPLOY_FREEZE` is empty or `false`.

## Steps

### Part A: npm (do this first)

**What npm says.** A trusted publisher can only be added to a package that already exists on the registry. [`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust) states "The package you're configuring must already exist on the npm registry", and the [trusted publishing page](https://docs.npmjs.com/trusted-publishers) describes no pending-publisher flow (read 2026-10-16). It also says a new trusted-publisher configuration must complete its first successful publish within 2 days or it expires. So the order is: bootstrap once by hand, then configure, then release.

1. npm account and org. Sign in to npmjs.com as the owner of org `4thtech-io`. Turn on 2FA for your account (Account → Two-Factor Authentication, "authorization and writes"). Org `4thtech-io` → Settings → require 2FA for all members.
2. Check the name is still free: `npm view @4thtech-io/agentlink` must say 404. Then make a new empty folder (for example `mkdir ~/al-bootstrap && cd ~/al-bootstrap`) for step 3.
3. **Bootstrap the package once by hand, as a placeholder (version 0.0.1, no real code).** No token is created and nothing is stored. In an empty temporary folder (not the repo), create `package.json` with this content:
   ```json
   {"name":"@4thtech-io/agentlink","version":"0.0.1","description":"Placeholder — install 0.1.0 or later","license":"MIT","repository":{"type":"git","url":"git+https://github.com/4thtech/agentlink.git"},"publishConfig":{"access":"public"}}
   ```
   and a `README.md` with exactly one line: `Placeholder. Install AgentLink 0.1.0 or later: https://github.com/4thtech/agentlink`. Then:
   ```bash
   npm login                        # browser, with 2FA
   npm publish --access public      # enter the 2FA code when asked
   npm logout
   ```
   *What happened on 2026-10-16 (done by the owner):* npm uses **staged publishing**. The first manual publish created a `0.0.0-stage` holding version, and `0.0.1` appeared a few minutes later; no staged-packages entry was left to approve (the account's staged-packages page was empty; the org has no such page). Wait until `npm view @4thtech-io/agentlink versions` lists `0.0.1` before step 4.

   Why a placeholder: publishing the real build by hand would have no provenance, and the release workflow would then find 0.1.0 already there. Version 0.0.1 also gives the automatic rollback something to move `latest` back to. It has no `bin`, so it does nothing if run.
   *Alternative, not recommended:* a granular token limited to the `4thtech-io` scope, used once and revoked. It needs the same manual publish and leaves a secret to revoke; the 2FA path above leaves none.
4. Configure the trusted publishers (package page → Settings → Trusted Publisher → GitHub Actions). **Do this no more than 2 days before release day (Part C).** Add **two** entries:

   | Field | Entry 1 | Entry 2 |
   |---|---|---|
   | Organization or user | `4thtech` | `4thtech` |
   | Repository | `agentlink` | `agentlink` |
   | Workflow filename | `release.yml` | `release.yml` |
   | Environment | `npm-next` | `npm-publish` |
   | Allow publish | on | on |
   | Allow npm dist-tag | off | **on** (automatic rollback of `latest`) |

   *State on 2026-10-16:* the owner configured one entry (`4thtech/agentlink`, `release.yml`, environment `npm-publish`, permissions: npm publish, npm stage publish, npm dist-tag). npm shows it as **"Pending validation: publish once before Oct 18, 2026, 13:41 UTC"**. The v0.1.0 release (Part C) must therefore run before then, or the entry must be deleted and re-created (the 2-day rule). The `npm-next` entry can wait until the first prerelease is wanted.

   Entry 1 is only needed for later prereleases on `next`. If npm refuses two entries for one workflow file, keep entry 2 (`npm-publish`) and tell the orchestrator. npm does not check entries when you save them; mistakes show up only at publish time.
5. Same Settings page, Publishing access: "Require two-factor authentication and disallow tokens".

### Part B: GitHub (repository `4thtech/agentlink`)

6. Environments (Settings → Environments). Check each exists with these settings (full table: `docs/process/ci-cd.md` §4):
   - `npm-publish`: Required reviewers = `talirezun`; **Prevent self-review OFF**; deployment branches and tags: `main` and tag pattern `*@*`. No secrets.
   - `npm-next`: no reviewer; branches `main` only; no secrets.
   - `deploy-freeze`: no reviewer; "Selected branches" → `main`.
7. `DEPLOY_FREEZE_TOKEN` (`ci-cd.md` §8; once, before release day):
   1. github.com → avatar → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.
   2. Name `agentlink DEPLOY_FREEZE`; Resource owner `4thtech` (approve it under the org's Settings → Personal access tokens → Pending requests if asked); expiry 90 days or less (calendar the renewal).
   3. Repository access: only `4thtech/agentlink`. Permission: **Variables: Read and write** only.
   4. Generate and copy the token once.
   5. Repo → Settings → Environments → `deploy-freeze` → Environment secrets → Add secret `DEPLOY_FREEZE_TOKEN` → paste. Not a repository or org secret.
   6. Round trip: Actions → "Deploy freeze" → Run workflow → `main`. It must be green and set `DEPLOY_FREEZE` to `true`. **Then clear it:** Settings → Secrets and variables → Actions → Variables → `DEPLOY_FREEZE` → `false` (or `gh variable set DEPLOY_FREEZE --body false --repo 4thtech/agentlink`). Do not release while it is `true`.
8. Settings → Actions → General: "Allow GitHub Actions to create and approve pull requests" must be ON (or a GitHub App token is wired; `ci-cd.md` §3 records which). #124 already exists, so this is already working if it was opened by the bot.
9. Merge queue (recommended, not required for v0.1.0): Settings → Rules → Rulesets → `main protection` → turn on **Require merge queue**, merge method **Squash**. Our workflows (`ci.yml`, `review-gate.yml`, `e2e.yml`) already run on `merge_group`. It also removes the stale-base problem of the weekly dependency PRs (`ci-cd.md` §6).

### Part C: release day

10. Confirm Parts A and B are done and that step 4 was done no more than 2 days ago.
11. Open PR **#124** "CHORE: Version packages". If its checks have not run (a PR made with `GITHUB_TOKEN` does not start them), close and reopen it. Review it:
    - `apps/cli/package.json` goes to `0.1.0` (`@4thtech-io/agentlink`); the private `@4thtech-io/*` libraries go to `0.1.0` too (one fixed group; they are not published);
    - `CHANGELOG.md` has a `## [0.1.0] - <date>` section and a fresh empty `## [Unreleased]`; that section becomes the GitHub Release text;
    - the changeset files are consumed and nothing else changed.
12. Approve #124 (a code-owner approval on its head commit is what `review-gate` waits for), then say **"merge"** in chat. Agents enable auto-merge only after that word and never approve.
13. After the merge, `release.yml` runs on `main`:
    1. `ci-green` waits for this commit's CI and security checks and stops unless both are green. If red: fix, re-run CI, then re-run the release's failed jobs.
    2. `guard`, `select-mode`, then `pack` (build and tarballs, no publish rights).
    3. `publish-latest` **pauses for your approval**: GitHub mobile, or Actions → the run → "Review deployments" → tick `npm-publish` → **Approve and deploy**. It re-checks `DEPLOY_FREEZE` after your click.
    4. It publishes `@4thtech-io/agentlink@0.1.0` over OIDC with provenance, checks that `latest` is 0.1.0 and the provenance attestation exists (`npm audit signatures`), then creates the GitHub Release `v0.1.0` from the CHANGELOG section, and the git tags.
    5. (Staged publishing: the CI publish may land as a staged version that needs your approval on npmjs.com, as the first manual publish briefly did. If `npm view @4thtech-io/agentlink dist-tags` still shows `0.0.1` after the job, look for a staged version on the package page or under your account's staged packages, and approve it; the job's checks wait for it for a few minutes.)
    6. `smoke-latest` runs `npx -y @4thtech-io/agentlink@0.1.0 --version` on a clean machine. If a check fails, `latest` is moved back to 0.0.1 (the placeholder), `DEPLOY_FREEZE` is set, and the rollback job asks for a second approval click.
14. Verify yourself:
    ```bash
    npx -y @4thtech-io/agentlink@latest --version     # 0.1.0
    npm view @4thtech-io/agentlink dist-tags            # latest: 0.1.0
    ```
    The npmjs.com package page shows the provenance badge ("Built and signed on GitHub Actions") linking to the `release.yml` run. The GitHub Release `v0.1.0` exists.
15. After the release (agents do the docs once you say it is out):
    - (done 2026-10-16, post-release docs pass) flip `docs/status.yaml` to released (version `v0.1.0`, M1a done), run `node tools/docs-status/index.mjs`, and update README Status, `knowledge/`, `llms.txt`, docs-site get-started; remove the "not released yet" notes;
    - remove the draft banner from `docs/releases/v0.1.0.md`;
    - announce (your call): README, the release note, social. State the known limits from the release note and claim nothing beyond it;
    - run the two-person dogfood ([RB-17](dogfood-m1a.md)) against the published package.

### Post-release record (2026-10-16)
- Released: `@4thtech-io/agentlink@0.1.0` is on npm `latest` with provenance; the `release.yml` run for #193 passed `publish-latest`, `smoke-latest` and `record`. Tags `v0.1.0` and `@4thtech-io/agentlink@0.1.0` exist.
- **The GitHub Release `v0.1.0` was not created.** Its step failed with HTTP 422 "body is too long (maximum is 125000 characters)": the `## [0.1.0]` CHANGELOG section is about 130 KB. By design the step only warns (`continue-on-error`). Owner action: create the release by hand from the short note, for example `gh release create v0.1.0 --verify-tag --title "v0.1.0" --notes-file docs/releases/v0.1.0.md`. Follow-up (OPS-REL-3): make the workflow fall back to the release note or a link to the CHANGELOG when the section is too long.
- Docs pass done in `DOCS: post-release docs pass for v0.1.0`. Still to do: the two-person dogfood (RB-17) against the published package, and the announcement (owner's call).

## Verify
`npm view @4thtech-io/agentlink dist-tags` shows `latest: 0.1.0`; the provenance badge is visible; `npx -y @4thtech-io/agentlink --version` prints `0.1.0`; GitHub Release `v0.1.0` exists; `DEPLOY_FREEZE` is not `true`.

## If it fails
- **Never `npm unpublish`.** Roll back with `npm deprecate "@4thtech-io/agentlink@0.1.0" "Broken, do not use"` (owner, 2FA) and move `latest` back (`npm dist-tag add @4thtech-io/agentlink@0.0.1 latest`, or let the `rollback-latest` job do it after your click). Publish a fixed patch through the same flow. Edit or delete the GitHub Release. Details: [RB-11](rollback-and-freeze.md), `release-and-deployment.md` §8.
- **Publish step fails with an OIDC, 404 or 403 error:** the trusted publisher entry is wrong or expired (2-day rule). Delete and re-create it (step 4) and re-run the failed job.
- **`ci-green` red or "no run":** [RB-08](ci-red.md); re-run the release's failed jobs after CI is green.
- **Frozen:** only you clear `DEPLOY_FREEZE`.

## Related
[RB-09](merge-and-release.md), [RB-11](rollback-and-freeze.md), [RB-17](dogfood-m1a.md); `docs/process/ci-cd.md` §4, §5, §8; `docs/process/release-and-deployment.md` §4.1, §5, §8; `docs/process/versioning.md` §5, §6, §9; draft release note [`docs/releases/v0.1.0.md`](../releases/v0.1.0.md).
