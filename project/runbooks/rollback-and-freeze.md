# RB-11 · Rollback and `DEPLOY_FREEZE`

## Purpose
Stop everything quickly when something is wrong in production or in the pipeline, return to the last good state with the rollback planned before the deploy, and leave the restart to the owner.

## When to use
An incident; a failed health check or smoke test; a verification mismatch ([RB-10](deploy-and-verify.md)); an open Critical or High finding in released code; any stop-the-line trigger (`audit-rules.md` §10.1); or the owner says "stop". For incident handling beyond the freeze, the owner's private incident runbook in `4thtech/agentlink-ops` applies.

## Who runs it
**Any agent that hits a documented trigger may set the freeze** (`release-and-deployment.md` §3.1; setting it is fail-safe) and must report it to the orchestrator and the owner at once. CI also sets it itself after a failed production check. **Only the owner clears it**, whatever an agent reads. Rollbacks are automatic in CI or owner actions; agents never run `wrangler`, `npm dist-tag` or contract operations.

## Preconditions
- `gh auth status` works.
- A documented trigger has occurred: an incident, a failed health check or smoke test, an open Critical or High finding, or any stop-the-line trigger (`release-and-deployment.md` §3.1). Do not wait for certainty.

## Steps
1. Freeze:
   ```bash
   gh variable set DEPLOY_FREEZE --body true
   ```
2. Disable auto-merge on every open PR (setting the variable does not re-run `review-gate` on PRs that are already green):
   ```bash
   for pr in $(gh pr list --state open --json number --jq '.[].number'); do gh pr merge "$pr" --disable-auto; done
   ```
   A run that is deploying right now may be cancelled: `gh run cancel <run-id>`. Cancelling is **not** inert for the Worker pipelines (`deploy-drop.yml`, `deploy-submitter.yml`): once the production deploy step has started, a cancellation (or a step timeout) runs the automatic rollback to the version recorded before the deploy, and then the `freeze` job sets `DEPLOY_FREEZE`. Before that step starts, a cancellation changes nothing in production. A second, forced cancellation stops the rollback too: then check production by hand (RB-10) and tell the owner.
3. Tell the owner at once: what you saw, when (UTC), what you froze. Record it in your sync file (no unfixed details; reference a private advisory or issue ID).
4. Roll back per the matrix in `release-and-deployment.md` §8:
   - **Workers and static sites:** automatic in `deploy-production` after a failed health check, a failed step, a cancellation or a step timeout once the deploy step started. Read the rollback result in the run summary and the job log: `rolled-back` (previous version live and healthy), `previous-live` (the new version never went live), `impossible-binding-change` (see below), or a failure word (`no-target`, `rollback-failed`, `rollback-not-live`, `rolled-back-unhealthy`, `previous-live-unhealthy`) that needs the owner. Otherwise redeploy the previous release through the pipeline once the owner clears the freeze for the fix.
   - **While frozen:** the deploy jobs are skipped, and so is the hourly `Deploy reconcile` (it dispatches nothing). The catch-up job likewise deploys nothing; after the owner clears the freeze, run the deploy workflow on `main` (or wait for the hourly reconcile) to bring production to `main`'s head.
   - **npm `latest`:** automatic in `publish-latest` after a failed health check; after a failed smoke test, `rollback-latest` waits for the owner's click. Manual moves and `npm deprecate` are owner actions with 2FA. Never unpublish.
   - **Contracts and their configuration:** owner only, through the Safe and its delays.
   - **Durable Object migrations and binding changes** are forward-only: Cloudflare refuses to roll back to a version whose Durable Object or binding a later deploy changed. The drop's rollback step then reports "rollback impossible across a binding/storage change; the new version stays live; owner action required". The fix is a forward fix through the pipeline, decided by the owner. The staging rollback rehearsal does not cover this case.
5. Fix through the normal process (expedited review, never skipped). The owner clears the freeze to land the fix; auto-merge stays off on every other PR until the incident is closed.

## Verify
- `gh variable get DEPLOY_FREEZE` prints `true`.
- `gh pr list --state open --json number,autoMergeRequest --jq '.[] | select(.autoMergeRequest != null) | .number'` prints nothing.
- After a rollback: the served content matches the previous release record ([RB-10](deploy-and-verify.md) step 3).

## If it fails
- **`gh variable set` refused** (permission or a deny rule): tell the owner immediately; he sets it. Do not route around the refusal ([RB-14](permission-denied.md)).
- **The CI `freeze` job failed** with "Setting DEPLOY_FREEZE failed" (for example HTTP 403 "Resource not accessible by personal access token"): the freeze is NOT set. Set it now (step 1) and tell the owner: the token behind the `DEPLOY_FREEZE_TOKEN` secret needs Variables: read and write on `4thtech/agentlink`.
- **A secret leaked:** follow `audit-rules.md` §10.3; rotation is an owner action.
- **The drop's bucket lifecycle check failed before deploying** ("no enabled rule deleting every object within 7 days"): nothing was deployed and no freeze was set; the owner restores the rule (`release-and-deployment.md` §4.5.1) and the workflow is run again.
- **Never** clear the freeze, re-enable auto-merge on other PRs, or deploy "to fix it quickly".

## Related
- Rules: [`release-and-deployment.md`](../process/release-and-deployment.md) §3.1 (freeze), §7 (incident outline), §8 (rollback matrix); [`audit-rules.md`](../process/audit-rules.md) §10 (stop-the-line); [`development-process.md`](../process/development-process.md) §1.2 rule 3.
- Private: incident response and secret rotation runbooks in `4thtech/agentlink-ops`.
