# RB-10 · Deploying and verifying by content

## Purpose
Prove that production runs exactly what was approved. "The deploy succeeded" is not proof: a deploy can report success while serving old code. The proof is a content comparison plus one live observation only the new code can produce.

## When to use
After every merge that CI deploys (Workers, static sites, npm `next` and `latest`). Not for mainnet contracts: those are owner-only, by hand, with a witness (`release-and-deployment.md` §4.3).

## Who runs it
CI deploys; nobody deploys from a workstation. The orchestrator (Opus) verifies. Agents hold no production credentials: they read what CI recorded and what the public endpoints and the npm registry serve.

## Preconditions
- The change is merged to `main` ([RB-09](merge-and-release.md)); `DEPLOY_FREEZE` is not `true`.
- The deploy pipeline for the artifact exists. Today:
  - `deploy-drop.yml` (encrypted drop Worker, `drop.agentlink.4thtech.io`) and `deploy-submitter.yml` (submitter and faucet, `submit.agentlink.4thtech.io`) deploy on every merge to `main` that touches their paths: staging first, a smoke test, then production through the `production` environment (an approval click while a required reviewer is set, D-52), with a health check, a read-back of the logging settings, an automatic rollback and the freeze on failure. Each writes a **deploy record draft** to the run summary.
  - `release.yml` publishes npm `next` and `latest` ([RB-09](merge-and-release.md)).
  - Static sites have no pipeline here yet; the static-site commands below are the procedure for when they do.
  - A deploy workflow does not run for a merge that touches none of its paths. Production can therefore lag `main` without anything being wrong; the question is whether it lags *on the deploy paths* (step 1).

## Steps
1. Find the run that deployed your merge commit and read its deploy record draft (the run summary):
   ```bash
   gh run list --branch main --limit 5 --json databaseId,workflowName,headSha,conclusion
   gh run view <run-id>
   ```
   Note what CI recorded: the artifact SHA-256 manifest, and the deployed version (Workers version ID or bundle hash, npm version).
   Read the run for what it did, not for its colour. A **green run can have deployed nothing**:
   - `ci-green` ended `superseded` (this commit's CI was cancelled because a newer push to `main` replaced it), or `deploy-production` logged "Superseded by `<sha>`" (a newer head exists): nothing changed in production. The `catch-up` job dispatches a new run for `main`'s head unless one is in flight or succeeded, and the run summary names the run that deploys instead. Look at *that* run.
   - Staging skipped with a notice (Cloudflare credentials or a required Worker secret not set): green, nothing deployed.
   - The head's own CI failed (a flake): the run ends at `ci-green`; `catch-up` hands it to a new run for the head. If no run follows, the hourly `Deploy reconcile` workflow (`deploy-reconcile.yml`, minute 23) compares the commit production runs with `main`'s head and dispatches the deploy when a commit in between touched the deploy paths and the head's CI is green (at most twice per head). It does nothing while `DEPLOY_FREEZE` is `true`.
   - The run waits for the `production` approval: it is "waiting", not failed ([RB-19](submitter-deploy.md) step 18).
   To see which commit production runs: the newest `push` or `workflow_dispatch` run of the workflow whose `deploy-production` job succeeded with its deploy step run (the reconcile script uses the same rule).
2. Confirm staging went first and its smoke tests passed in the same run, then production.
3. **Compare content with the record.**
   - Static site: hash what is served and compare with the manifest in the run or the GitHub release:
     ```bash
     curl -fsS https://<host>/<asset-path> | shasum -a 256
     curl -fsSI https://<host>/ | grep -iE 'content-security-policy|strict-transport-security'
     ```
   - Worker: the run summary's **Deploy record draft** table is CI's own read of Cloudflare: commit, bundle SHA-256 (the same bytes staging ran), version deployed, rollback target, health check, logging read-back, lifecycle check (drop only) and rollback result. Check that the commit is the merge you are verifying, the bundle SHA-256 is the one `build` published, and every result row says `success` (rollback: `not needed`). An agent holds no Cloudflare credential and cannot read the live version itself; the public proof is the live observation in step 4 (for the submitter, `https://submit.agentlink.4thtech.io/v1/health` answers `"ok":true`; for the drop, `https://drop.agentlink.4thtech.io/v1/health` answers `{"ok":true}` and an unsigned upload answers 401). The owner can read the live version with `wrangler deployments status`.
   - npm package:
     ```bash
     npm view @4thtech-io/agentlink@<version> dist.integrity
     ```
     compare with the integrity CI recorded for the packed tarball, and check provenance in a clean directory with `npm audit signatures` after installing that exact version.
4. **One live observation only the new code produces**: a response field, a header, a version string, a smoke-test result. Choose it before the deploy and name it in the PR or release note.
5. Write the result into the deploy record draft for the orchestrator to complete and file privately (`release-and-deployment.md` §5.2), and label it **verified** in your report to the owner.

## Verify
All of these hold, and you can show the commands and outputs: hashes or integrity match the CI record and the build of `main`; staging preceded production; the live observation was seen. If any one is missing, say "deployed, not verified", never "done" (`delivery-process.md` §5, condition 7).

## If it fails
- **No deploy run at all for your merge:** read the `on.push.paths` list at the top of the workflow; a merge outside it starts none. If the paths match, look for `ci-green` ending `superseded` or a failed CI of that commit, then wait for `catch-up` or the next hourly `Deploy reconcile` run, or dispatch the workflow on `main` (Actions → the workflow → Run workflow, branch `main`). The dispatched run passes every gate again. Do not re-run an old run: it deploys that old commit only if it is still `main`'s head.
- **A mismatch, a failed health check, or the new behaviour is absent:** set `DEPLOY_FREEZE` and follow [RB-11](rollback-and-freeze.md). CI's own failed health check already rolls back and freezes.
- **Cannot verify because no record exists:** that is a pipeline gap; tell the owner and open a CI card. Do not substitute "the job was green".

## Related
- Rules: [`delivery-process.md`](../process/delivery-process.md) §2 steps 10–11, §3.4, §5; [`release-and-deployment.md`](../process/release-and-deployment.md) §3, §4.1, §4.5, §4.6, §5.
- Cards: M1-10c, M1-27b, M1-16 in [`backlog.md`](../process/backlog.md).
