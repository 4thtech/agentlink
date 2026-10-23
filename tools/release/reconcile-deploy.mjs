#!/usr/bin/env node
// CHORE-DEPLOY-RECONCILE: the scheduled `reconcile` job of deploy-reconcile.yml. The catch-up job
// of each deploy workflow (catch-up-deploy.mjs) hands a run that did not deploy to main's head, but
// when the head's own CI flakes while it is still the head, its catch-up finds itself at the head
// and stops; later merges that do not touch the deploy paths start no deploy run, so production
// could lag indefinitely. Once an hour, for each deploy workflow, this:
//
//   1. reads main's head;
//   2. finds the commit production runs: the newest push or dispatch run on main whose
//      `deploy-production` job succeeded with its deploy step run (not skipped);
//   3. compares that commit with the head; when no file between them matches the workflow's own
//      `on.push.paths`, production is current for this service;
//   4. otherwise requires the head's own CI gates green (ci.yml ci-gate, security.yml security-gate);
//   5. skips while a run of the workflow for ANY head waits for the production approval (at most
//      one pending approval per service; the summary asks the owner to approve or cancel it), and
//      skips while a push or dispatch run of the workflow for the head is in flight (queued,
//      running, or waiting for the production approval), and stops with a warning after
//      MAX_ATTEMPTS finished runs for the head;
//   6. dispatches the workflow on main, at most once per workflow per call.
//
// The deploy workflows only ever deploy main's head (their head-of-main check), so the head is the
// target: it contains every earlier deploy-path change. The dispatched run is an ordinary run on
// main: it waits for the head's own green CI and passes staging, the smoke test, the production
// environment, DEPLOY_FREEZE and the head check like any push run. Dispatching never deploys
// anything by itself. While DEPLOY_FREEZE is 'true' this does nothing at all.
//
//   node tools/release/reconcile-deploy.mjs --workflow deploy-submitter.yml --workflow deploy-drop.yml
//
// Environment: GH_TOKEN (the job's GITHUB_TOKEN with `actions: write`), GITHUB_REPOSITORY,
// GITHUB_SHA, GITHUB_API_URL and GITHUB_STEP_SUMMARY (both optional), DEPLOY_FREEZE. Prints no token.

import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkOnce, githubApi, readEnv } from './wait-for-ci.mjs';

const WORKFLOW_FILE = /^[A-Za-z0-9_-]+\.ya?ml$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const DEPLOY_EVENTS = new Set(['push', 'workflow_dispatch']);
/** The compare API lists at most 300 files; a full list may be truncated. */
const COMPARE_FILE_LIMIT = 300;
/** How many finished runs to search for the last production deploy. */
const MAX_RUNS = 30;

/** The production deploy step of deploy-submitter.yml and deploy-drop.yml (job deploy-production). */
export const DEPLOY_STEP = 'Deploy to production (Custom Domain)';
/** Finished runs for one head after which the reconcile stops dispatching and warns. */
export const MAX_ATTEMPTS = 2;
/** The CI gates every deploy run waits for (its ci-green job). */
export const REQUIRED_GATES = [
  { workflow: 'ci.yml', job: 'ci-gate' },
  { workflow: 'security.yml', job: 'security-gate' },
];

export function parseArgs(argv) {
  const usage = new Error(
    'usage: reconcile-deploy.mjs --workflow <workflow file name> [--workflow ...]',
  );
  if (argv.length === 0 || argv.length % 2 !== 0) throw usage;
  const workflows = [];
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] !== '--workflow' || !WORKFLOW_FILE.test(argv[i + 1] ?? '')) throw usage;
    workflows.push(argv[i + 1]);
  }
  return { workflows };
}

/** The `on.push.paths` patterns of a workflow, or null when it has none. */
export function pushPaths(source) {
  const on = /\non:\n((?: {2}.*\n|\s*\n)*)/.exec(`\n${source}`);
  if (!on) return null;
  const push = /(?:^|\n) {2}push:\n((?: {4}.*\n|\s*\n)*)/.exec(on[1]);
  if (!push) return null;
  const paths = /(?:^|\n) {4}paths:\n((?: {6}(?:- |#).*\n)*)/.exec(push[1]);
  if (!paths) return null;
  return [...paths[1].matchAll(/ {6}- (?:"([^"]*)"|'([^']*)'|(\S+))/g)].map(
    (m) => m[1] ?? m[2] ?? m[3],
  );
}

/** A GitHub filter pattern as a RegExp: `**` any characters, `*` any but `/`, `?` one character. */
function globToRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      out += '.*';
      i += 1;
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** True when the (positive-only) patterns cover a repo-relative file path. */
export function pathMatches(patterns, file) {
  if (patterns.some((p) => p.startsWith('!'))) {
    throw new Error('negated paths patterns are not supported by the reconcile');
  }
  return patterns.some((p) => globToRegExp(p).test(file));
}

/** A push or dispatch run of this workflow on main. */
function isDeployRun(run, workflow) {
  return (
    run?.head_branch === 'main' &&
    DEPLOY_EVENTS.has(run?.event) &&
    run?.path === `.github/workflows/${workflow}` &&
    typeof run?.head_sha === 'string' &&
    SHA_RE.test(run.head_sha)
  );
}

/** True when the run's (latest attempt) deploy-production job deployed and ended green. */
async function deployedIn({ api, repo, runId }) {
  const query = new URLSearchParams({ filter: 'latest', per_page: '100' });
  const body = await api(`/repos/${repo}/actions/runs/${runId}/jobs?${query}`);
  const job = (body?.jobs ?? []).find((j) => j?.name === 'deploy-production');
  if (job?.conclusion !== 'success') return false;
  return (job.steps ?? []).some((s) => s?.name === DEPLOY_STEP && s?.conclusion === 'success');
}

/**
 * The commit production runs for this workflow: the newest finished run on main whose
 * deploy-production job deployed and succeeded (a failed one rolled back and froze deploys).
 * Undefined when none of the last MAX_RUNS finished runs deployed.
 */
export async function deployedCommit({ api, repo, workflow }) {
  const query = new URLSearchParams({
    branch: 'main',
    status: 'completed',
    per_page: String(MAX_RUNS),
  });
  const body = await api(`/repos/${repo}/actions/workflows/${workflow}/runs?${query}`);
  const runs = (body?.workflow_runs ?? [])
    .filter((r) => isDeployRun(r, workflow) && r?.status === 'completed')
    .sort((a, b) => Number(b.id) - Number(a.id));
  for (const run of runs) {
    if (await deployedIn({ api, repo, runId: run.id })) return run.head_sha;
  }
  return undefined;
}

/**
 * Returns { action: 'none' | 'dispatched', reason?, head, deployed?, runId? }.
 * Throws when main's head or the GitHub API cannot be read.
 */
export async function reconcile({
  api,
  repo,
  workflow,
  paths,
  log = console.log,
  summary = () => {},
}) {
  const head = (await api(`/repos/${repo}/commits/main`))?.sha;
  if (typeof head !== 'string' || !SHA_RE.test(head)) {
    throw new Error('could not read the head of main');
  }
  const none = (reason, extra = {}) => ({ action: 'none', reason, head, ...extra });

  const deployed = await deployedCommit({ api, repo, workflow });
  if (!deployed) {
    log(
      `::warning::${workflow}: no production deploy among the last ${MAX_RUNS} finished runs; the reconcile cannot tell whether production lags. Check the deploy runs by hand.`,
    );
    summary(
      `**${workflow} unknown:** no production deploy among the last ${MAX_RUNS} finished runs, so the reconcile cannot tell whether production lags. Needs a look.`,
    );
    return none('unknown');
  }
  if (deployed === head) {
    log(`${workflow}: production runs main's head ${head}.`);
    return none('current', { deployed });
  }

  const compare = await api(`/repos/${repo}/compare/${deployed}...${head}`);
  if (compare?.status !== 'ahead') {
    log(
      `::warning::${workflow}: production runs ${deployed}, which is not an ancestor of main's head ${head} (${String(compare?.status)}); not reconciled.`,
    );
    return none('not-ahead', { deployed });
  }
  const files = compare.files ?? [];
  const touched =
    files.length >= COMPARE_FILE_LIMIT ||
    files.some(
      (f) =>
        (typeof f?.filename === 'string' && pathMatches(paths, f.filename)) ||
        (typeof f?.previous_filename === 'string' && pathMatches(paths, f.previous_filename)),
    );
  if (!touched) {
    log(`${workflow}: no change to its paths since ${deployed}; production is current.`);
    return none('current', { deployed });
  }

  // At most one pending production approval per service, whatever the head: a run waiting for an
  // older head would skip on approval (its head check), but the owner may still want to approve or
  // cancel it, so a new dispatch would only stack another request. Surface it instead.
  const waitingQuery = new URLSearchParams({ branch: 'main', status: 'waiting', per_page: '50' });
  const waitingBody = await api(
    `/repos/${repo}/actions/workflows/${workflow}/runs?${waitingQuery}`,
  );
  const pending = (waitingBody?.workflow_runs ?? []).find(
    (r) => isDeployRun(r, workflow) && r.status === 'waiting',
  );
  if (pending) {
    const runId = Number.isSafeInteger(pending.id) ? pending.id : String(pending.id);
    log(
      `::warning::${workflow}: production runs ${deployed}, behind main's head ${head}, and run ${runId} (${pending.event}, for ${pending.head_sha}) waits for the production approval; not dispatching another. Approve or cancel it.`,
    );
    summary(
      `**${workflow} waiting:** production runs \`${deployed}\`; run ${runId} for \`${pending.head_sha}\` waits for the production approval. The owner should approve or cancel it; no new run is dispatched while it waits.`,
    );
    return none('approval-pending', { deployed, runId });
  }

  const ci = await checkOnce({ api, repo, sha: head, require: REQUIRED_GATES });
  if (ci.state !== 'green') {
    log(
      `${workflow}: production runs ${deployed} and main's head ${head} changed its paths, but the head's CI is ${ci.state}; waiting for a green head.`,
    );
    return none(`head-ci-${ci.state}`, { deployed });
  }

  const query = new URLSearchParams({ head_sha: head, branch: 'main', per_page: '50' });
  const body = await api(`/repos/${repo}/actions/workflows/${workflow}/runs?${query}`);
  const headRuns = (body?.workflow_runs ?? []).filter(
    (r) => isDeployRun(r, workflow) && r.head_sha === head,
  );
  const live = headRuns.find((r) => r?.status !== 'completed');
  if (live) {
    const runId = Number.isSafeInteger(live.id) ? live.id : String(live.id);
    log(
      `${workflow}: run ${runId} (${live.event}, ${live.status}) for main's head ${head} is in flight.`,
    );
    return none('in-flight', { deployed, runId });
  }
  if (headRuns.length >= MAX_ATTEMPTS) {
    log(
      `::warning::${workflow}: production runs ${deployed}, behind main's head ${head}, and ${headRuns.length} runs for the head finished without deploying it; not dispatching again. Check the runs, then dispatch the workflow on main by hand.`,
    );
    summary(
      `**${workflow} behind:** production runs \`${deployed}\`; ${headRuns.length} runs for main's head \`${head}\` did not deploy it. Needs a look.`,
    );
    return none('attempts', { deployed });
  }

  await api(`/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
    method: 'POST',
    body: { ref: 'main' },
  });
  log(
    `::notice::${workflow}: production runs ${deployed}, behind main's green head ${head}: dispatched ${workflow} on main. It deploys only after staging, the smoke test and the production environment.`,
  );
  summary(
    `**${workflow} reconciled:** production runs \`${deployed}\`; dispatched a run on main for the green head \`${head}\`.`,
  );
  return { action: 'dispatched', head, deployed };
}

/** Appends one line to the run summary file, if the runner gave one. */
function summaryWriter(file) {
  if (!file) return () => {};
  return (line) => appendFileSync(file, `${line}\n`);
}

const readRepoWorkflow = (name) =>
  readFileSync(resolve(process.cwd(), '.github/workflows', name), 'utf8');

/** The command line. Returns the exit code. */
export async function run({ argv, env, api, log = console.log, readWorkflow = readRepoWorkflow }) {
  let workflows;
  let ctx;
  try {
    ({ workflows } = parseArgs(argv));
    if (env.DEPLOY_FREEZE === 'true') {
      log('::notice::DEPLOY_FREEZE is set; the reconcile does nothing until the owner clears it.');
      return 0;
    }
    const { token, repo, baseUrl } = readEnv(env);
    ctx = { api: api ?? githubApi({ token, baseUrl }), repo };
  } catch (error) {
    log(`::error::Deploy reconcile failed: ${error?.message ?? String(error)}`);
    return 1;
  }
  const summary = summaryWriter(env.GITHUB_STEP_SUMMARY);
  let code = 0;
  // One workflow's failure does not stop the others; each dispatches at most once.
  for (const workflow of workflows) {
    try {
      const paths = pushPaths(readWorkflow(workflow));
      if (!paths || paths.length === 0) throw new Error(`${workflow} has no on.push.paths filter`);
      await reconcile({ ...ctx, workflow, paths, log, summary });
    } catch (error) {
      log(`::error::Deploy reconcile of ${workflow} failed: ${error?.message ?? String(error)}`);
      code = 1;
    }
  }
  return code;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await run({ argv: process.argv.slice(2), env: process.env });
}
