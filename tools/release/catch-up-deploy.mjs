#!/usr/bin/env node
// The `catch-up` job of deploy-submitter.yml, deploy-drop.yml and deploy-invite.yml
// (CHORE-CI-SUPERSEDED, CHORE-DEPLOY-CATCHUP, OPS-UNSTICK-A). It runs when a deploy run did not
// deploy its commit: the commit's CI was superseded (wait-for-ci.mjs --superseded-ok) or failed,
// deploy-production found a NEWER commit on main that changes this service, or a job was cancelled
// (GitHub keeps one pending job per concurrency group and cancels the older pending one). It makes
// sure main's head still gets deployed for this service, and says which run does it.
//
// "Covered": a run of this same workflow on main (push or dispatch, not this run) that
//   - is still going and whose commit contains the newest commit on main that changes this service
//     (it deploys exactly what main's head builds for the service; tools/release/deploy-paths.mjs), or
//   - finished successfully for main's head itself.
// A finished run of an older commit does not count: it may have deployed nothing.
//
// Otherwise it dispatches this workflow on main, when main's head is another commit, or when this
// run's own jobs were cancelled and this run was a push run (one re-dispatch; a cancelled DISPATCHED
// run does not dispatch again, so this cannot loop). If nothing covers the head and nothing may be
// dispatched (main's head is this commit and its CI is not green), it exits 1: a run that left
// production behind is red, never silently green. The run summary (GITHUB_STEP_SUMMARY) says
// "Superseded by <sha> ... deploying there", or that production keeps the previous version.
//
//   node tools/release/catch-up-deploy.mjs --workflow deploy-submitter.yml
//
// Environment: GH_TOKEN (the job's GITHUB_TOKEN with `actions: write`, which may dispatch workflows
// of this repository and nothing more), GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_RUN_ID,
// GITHUB_EVENT_NAME, DEPLOY_CANCELLED ('true' when a needed job was cancelled), GITHUB_API_URL and
// GITHUB_STEP_SUMMARY (both optional). Needs the full history of main (`fetch-depth: 0`).
// The dispatched run is an ordinary run on main: it waits for the head's own green CI and goes
// through staging, the smoke test, the production environment, DEPLOY_FREEZE and the head check
// like any push run. Dispatching never deploys anything by itself. Prints no token.

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { gitRunner, SHA_RE, WORKFLOW_FILE, workflowSpecs } from './deploy-paths.mjs';
import { githubApi, readEnv } from './wait-for-ci.mjs';

const HANDLED_BY = new Set(['push', 'workflow_dispatch']);

export function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--workflow' || !WORKFLOW_FILE.test(argv[1] ?? '')) {
    throw new Error('usage: catch-up-deploy.mjs --workflow <workflow file name>');
  }
  return { workflow: argv[1] };
}

const idOf = (run) => (Number.isSafeInteger(run?.id) ? run.id : String(run?.id));

/**
 * Returns { action: 'covered' | 'dispatched' | 'stranded', head, runId? }. Throws when main's head
 * cannot be read. `summary` (optional) receives Markdown lines for the run summary.
 */
export async function catchUp({
  api,
  git,
  repo,
  sha,
  runId,
  event,
  cancelled = false,
  workflow,
  specs,
  log = console.log,
  summary = () => {},
}) {
  const head = git.head();
  if (typeof head !== 'string' || !SHA_RE.test(head)) {
    throw new Error('could not read the head of main');
  }
  const last = git.lastTouch(head, specs) ?? head;
  const query = new URLSearchParams({ branch: 'main', per_page: '50' });
  const body = await api(`/repos/${repo}/actions/workflows/${workflow}/runs?${query}`);
  const cover = (body?.workflow_runs ?? []).find((r) => {
    if (String(r?.id) === String(runId)) return false;
    if (r?.head_branch !== 'main' || !HANDLED_BY.has(r?.event)) return false;
    if (r?.path !== `.github/workflows/${workflow}` || !SHA_RE.test(r?.head_sha ?? ''))
      return false;
    if (r.status !== 'completed') return git.contains(r.head_sha, last) !== false;
    return r.conclusion === 'success' && r.head_sha === head;
  });
  if (cover) {
    const id = idOf(cover);
    log(
      `::notice::Superseded by ${cover.head_sha}: run ${id} of ${workflow} (${cover.event}, ${cover.status}) deploys main's state for this service.`,
    );
    summary(
      `**Superseded by \`${cover.head_sha}\`, deploying there:** this run did not change production; run ${id} of ${workflow} (${cover.event}, ${cover.status}) deploys main's state for this service.`,
    );
    return { action: 'covered', head, runId: id };
  }
  if (head !== sha || (cancelled && event === 'push')) {
    await api(`/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
      method: 'POST',
      body: { ref: 'main' },
    });
    log(
      `::notice::Superseded by ${head}: no live or successful run of ${workflow} covers main's head, so a new run was dispatched on main. It deploys only once the head's own CI is green.`,
    );
    summary(
      `**Superseded by \`${head}\`, deploying there:** this run did not change production; dispatched a new run of ${workflow} on main for that head (it deploys only once the head's own CI is green).`,
    );
    return { action: 'dispatched', head };
  }
  log(
    `::error::Nothing deploys main's head ${head} for ${workflow}: this run did not deploy it (its CI is not green, or a job was cancelled) and no other run covers it. Re-run the failed jobs once CI is green, or dispatch ${workflow} on main.`,
  );
  summary(
    `**Not deployed:** \`${head}\` is the head of main but this run did not pass every gate, and no other run covers it; production keeps the previous version until a re-run of this run, or a run for a newer head of main, deploys.`,
  );
  return { action: 'stranded', head };
}

/** Appends one line to the run summary file, if the runner gave one. */
function summaryWriter(file) {
  if (!file) return () => {};
  return (line) => appendFileSync(file, `${line}\n`);
}

/** The command line. Returns the exit code. */
export async function run({ argv, env, api, git, cwd = process.cwd(), log = console.log }) {
  try {
    const { workflow } = parseArgs(argv);
    const { token, repo, sha, baseUrl } = readEnv(env);
    const runId = env.GITHUB_RUN_ID;
    if (!/^[1-9][0-9]*$/.test(runId ?? '')) throw new Error('GITHUB_RUN_ID is malformed');
    const result = await catchUp({
      api: api ?? githubApi({ token, baseUrl }),
      git: git ?? gitRunner({ cwd }),
      repo,
      sha,
      runId,
      event: env.GITHUB_EVENT_NAME,
      cancelled: env.DEPLOY_CANCELLED === 'true',
      workflow,
      specs: workflowSpecs(workflow, cwd),
      log,
      summary: summaryWriter(env.GITHUB_STEP_SUMMARY),
    });
    return result.action === 'stranded' ? 1 : 0;
  } catch (error) {
    log(`::error::Deploy catch-up failed: ${error?.message ?? String(error)}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await run({ argv: process.argv.slice(2), env: process.env });
}
