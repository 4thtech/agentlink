#!/usr/bin/env node
// OPS-CIGREEN-WAIT: the `pick-up` job of ci-green-catchup.yml. release.yml and the deploy workflows
// start on the push to main, and their `ci-green` job (wait-for-ci.mjs) waits for this commit's CI.
// When CI is red on its first attempt (a flake that ci-auto-retry.yml re-runs) or slower than the
// wait (the heavy lane queues for macOS runners), `ci-green` fails and nothing is released or
// deployed, although CI turns green later (2 Nov 2026). This picks those runs up: when a CI or
// Security run of a main push completes green, for the commit it ran on it
//
//   1. does nothing while DEPLOY_FREEZE is 'true';
//   2. does nothing when main has moved on past the commit: the newer commit has its own release
//      run (every push to main starts one, and it publishes every version npm lacks, OPS-UNSTICK-A),
//      and the deploy catch-up and the hourly deploy reconcile hand deploys to main's head;
//   3. does nothing until BOTH required gates of the commit are green (ci.yml `ci-gate (push)` and
//      security.yml `security-gate`, as every ci-green requires); the other workflow's completion
//      triggers this again;
//   4. for each target workflow takes the newest push or dispatch run of the commit on main and,
//      when its latest `ci-green` job failed or timed out, waits for the run to finish (its
//      catch-up job) and asks GitHub to re-run its failed jobs. A run whose ci-green passed, is
//      still waiting (it sees the green CI itself) or was cancelled (superseded; the deploy catch-up
//      handles it) is left alone.
//
// The re-run is the ORIGINAL push run: its ci-green verifies both gates again (fail closed), and
// every environment, approval click, DEPLOY_FREEZE check, concurrency group and head-of-main check
// applies unchanged. Re-running never publishes or deploys anything by itself. At most
// MAX_ATTEMPTS attempts per run (no loop). Anything that cannot be picked up (attempts used up, a
// run that does not finish, an API error) makes the command exit 1, so a release or deploy left
// undone is a red run, never a silent one.
//
//   node tools/release/ci-green-catchup.mjs --workflow release.yml --workflow deploy-drop.yml ...
//
// Environment: GH_TOKEN (the job's GITHUB_TOKEN with `actions: write`), GITHUB_REPOSITORY,
// RUN_HEAD_SHA (the head_sha of the completed CI or Security run, from the event payload),
// DEPLOY_FREEZE, GITHUB_API_URL and GITHUB_STEP_SUMMARY (both optional). Reads workflow-run and
// commit metadata only; prints no token and no event data beyond run ids and commit hashes.

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { checkOnce, githubApi } from './wait-for-ci.mjs';

const WORKFLOW_FILE = /^[A-Za-z0-9_-]+\.ya?ml$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RUN_EVENTS = new Set(['push', 'workflow_dispatch']);
/** ci-green conclusions that mean "gave up waiting or saw red": the ones a green CI can fix. */
const PICK_UP = new Set(['failure', 'timed_out']);

/** The job every target workflow gates its publish or deploy path on. */
export const CI_GREEN_JOB = 'ci-green';
/** A run is re-run only while its run_attempt is below this (attempt 1 plus two pick-ups). */
export const MAX_ATTEMPTS = 3;
/** The gates every ci-green requires (release.yml and the deploy workflows). */
export const REQUIRED_GATES = [
  { workflow: 'ci.yml', job: 'ci-gate (push)' },
  { workflow: 'security.yml', job: 'security-gate' },
];

export function parseArgs(argv) {
  const usage = new Error(
    'usage: ci-green-catchup.mjs --workflow <workflow file> [--workflow ...]',
  );
  if (argv.length === 0 || argv.length % 2 !== 0) throw usage;
  const workflows = [];
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] !== '--workflow' || !WORKFLOW_FILE.test(argv[i + 1] ?? '')) throw usage;
    workflows.push(argv[i + 1]);
  }
  return { workflows };
}

async function newestRun({ api, repo, sha, workflow }) {
  const query = new URLSearchParams({ head_sha: sha, branch: 'main', per_page: '50' });
  const body = await api(`/repos/${repo}/actions/workflows/${workflow}/runs?${query}`);
  const runs = (body?.workflow_runs ?? []).filter(
    (r) =>
      r?.head_sha === sha &&
      r?.head_branch === 'main' &&
      RUN_EVENTS.has(r?.event) &&
      r?.path === `.github/workflows/${workflow}` &&
      Number.isSafeInteger(r?.id) &&
      r.id > 0,
  );
  if (runs.length === 0) return undefined;
  return runs.reduce((a, b) => (b.id > a.id ? b : a));
}

async function ciGreenJob({ api, repo, runId }) {
  const query = new URLSearchParams({ filter: 'latest', per_page: '100' });
  const body = await api(`/repos/${repo}/actions/runs/${runId}/jobs?${query}`);
  return (body?.jobs ?? []).find((j) => j?.name === CI_GREEN_JOB);
}

/** One target workflow. Returns { workflow, outcome, runId? }. */
async function pickUp({
  api,
  repo,
  sha,
  workflow,
  settleMs,
  intervalMs,
  now,
  sleep,
  log,
  summary,
}) {
  const latest = await newestRun({ api, repo, sha, workflow });
  if (!latest) {
    log(`${workflow}: no run for this commit (its path filter did not match); nothing to pick up.`);
    return { workflow, outcome: 'none' };
  }
  const runId = latest.id;
  const gate = await ciGreenJob({ api, repo, runId });
  if (!gate || gate.status !== 'completed') {
    if (latest.status === 'completed') {
      log(`${workflow}: run ${runId} finished without a ${CI_GREEN_JOB} job; nothing to pick up.`);
      return { workflow, outcome: 'no-gate', runId };
    }
    log(
      `${workflow}: run ${runId} is still waiting in ${CI_GREEN_JOB}; it sees the green CI itself.`,
    );
    return { workflow, outcome: 'live', runId };
  }
  if (gate.conclusion === 'success') {
    log(`${workflow}: ${CI_GREEN_JOB} of run ${runId} passed; nothing to pick up.`);
    return { workflow, outcome: 'ok', runId };
  }
  if (!PICK_UP.has(gate.conclusion)) {
    log(
      `${workflow}: ${CI_GREEN_JOB} of run ${runId} ended as ${String(gate.conclusion)}; the deploy catch-up or a newer run handles it.`,
    );
    return { workflow, outcome: 'cancelled', runId };
  }

  // ci-green gave up. Wait for the run to finish (its catch-up job): only a finished run re-runs.
  const start = now();
  let current = await api(`/repos/${repo}/actions/runs/${runId}`);
  while (current?.status !== 'completed') {
    if (now() - start >= settleMs) {
      log(
        `::error::${workflow}: run ${runId} (${CI_GREEN_JOB} failed) did not finish within ${settleMs / 60_000} min, so its failed jobs could not be re-run. Re-run them by hand once it has finished.`,
      );
      summary(
        `- **Not picked up:** run ${runId} of ${workflow} did not finish in time; re-run its failed jobs.`,
      );
      return { workflow, outcome: 'unsettled', runId };
    }
    await sleep(intervalMs);
    current = await api(`/repos/${repo}/actions/runs/${runId}`);
  }
  const attempt = Number(current?.run_attempt);
  if (!Number.isSafeInteger(attempt) || attempt >= MAX_ATTEMPTS) {
    log(
      `::error::${workflow}: run ${runId} already ran ${String(current?.run_attempt)} attempts; not re-running it again. Its ${CI_GREEN_JOB} still fails although CI and Security of ${sha} are green: look at the run.`,
    );
    summary(
      `- **Not picked up:** run ${runId} of ${workflow} used up its attempts; look at the run.`,
    );
    return { workflow, outcome: 'exhausted', runId };
  }
  try {
    await api(`/repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`, { method: 'POST' });
  } catch (error) {
    log(`::error::${workflow}: could not re-run run ${runId}: ${error?.message ?? String(error)}`);
    summary(`- **Not picked up:** the re-run of run ${runId} of ${workflow} was refused.`);
    return { workflow, outcome: 'error', runId };
  }
  log(
    `::notice::${workflow}: re-running the failed jobs of run ${runId}: its ${CI_GREEN_JOB} gave up before CI of ${sha} turned green.`,
  );
  summary(
    `- **Picked up:** re-running the failed jobs of run ${runId} of ${workflow} (attempt ${attempt + 1}); its own ${CI_GREEN_JOB} checks the gates again.`,
  );
  return { workflow, outcome: 'rerun', runId };
}

const FAILED = new Set(['unsettled', 'exhausted', 'error']);

/**
 * Returns { action: 'frozen' | 'moved-on' | 'not-green' | 'checked', ok, results }. `ok` is false
 * when something could not be picked up (the command then exits 1).
 */
export async function catchUpCiGreen({
  api,
  repo,
  sha,
  workflows,
  freeze = false,
  settleMs = 15 * 60_000,
  intervalMs = 30_000,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console.log,
  summary = () => {},
}) {
  if (freeze) {
    log('DEPLOY_FREEZE is set: nothing is picked up.');
    return { action: 'frozen', ok: true, results: [] };
  }
  let head;
  try {
    head = (await api(`/repos/${repo}/commits/main`))?.sha;
  } catch (error) {
    log(`::error::Could not read the head of main: ${error?.message ?? String(error)}`);
    return { action: 'checked', ok: false, results: [] };
  }
  if (typeof head !== 'string' || !SHA_RE.test(head)) {
    log('::error::Could not read the head of main.');
    return { action: 'checked', ok: false, results: [] };
  }
  if (head !== sha) {
    log(
      `main has moved on to ${head}: its own release run, the deploy catch-up and the deploy reconcile handle it; nothing is picked up for ${sha}.`,
    );
    return { action: 'moved-on', ok: true, results: [] };
  }
  const gates = await checkOnce({ api, repo, sha, require: REQUIRED_GATES, branch: 'main' });
  for (const reason of gates.reasons) log(reason);
  if (gates.state !== 'green') {
    log(
      `CI of ${sha} is ${gates.state}, not green: nothing is picked up (the completion of the other gate triggers this again).`,
    );
    return { action: 'not-green', ok: true, results: [] };
  }
  const results = [];
  for (const workflow of workflows) {
    try {
      results.push(
        await pickUp({ api, repo, sha, workflow, settleMs, intervalMs, now, sleep, log, summary }),
      );
    } catch (error) {
      log(`::error::${workflow}: ${error?.message ?? String(error)}`);
      results.push({ workflow, outcome: 'error' });
    }
  }
  return { action: 'checked', ok: !results.some((r) => FAILED.has(r.outcome)), results };
}

/** Checks GH_TOKEN, GITHUB_REPOSITORY and RUN_HEAD_SHA. Throws on a missing or malformed value. */
export function readEnv(env) {
  const token = env.GH_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  const sha = env.RUN_HEAD_SHA;
  const baseUrl = env.GITHUB_API_URL || 'https://api.github.com';
  if (!token || !repo || !sha)
    throw new Error('GH_TOKEN, GITHUB_REPOSITORY and RUN_HEAD_SHA are required');
  if (!SHA_RE.test(sha) || !REPO_RE.test(repo)) {
    throw new Error('RUN_HEAD_SHA or GITHUB_REPOSITORY is malformed');
  }
  return { token, repo, sha, baseUrl };
}

/** The command line. Returns the exit code. */
export async function run({ argv, env, api, log = console.log, now, sleep }) {
  try {
    const { workflows } = parseArgs(argv);
    const { token, repo, sha, baseUrl } = readEnv(env);
    const file = env.GITHUB_STEP_SUMMARY;
    const result = await catchUpCiGreen({
      api: api ?? githubApi({ token, baseUrl }),
      repo,
      sha,
      workflows,
      freeze: env.DEPLOY_FREEZE === 'true',
      log,
      summary: file ? (line) => appendFileSync(file, `${line}\n`) : () => {},
      ...(now ? { now } : {}),
      ...(sleep ? { sleep } : {}),
    });
    return result.ok ? 0 : 1;
  } catch (error) {
    log(`::error::ci-green pick-up failed: ${error?.message ?? String(error)}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await run({ argv: process.argv.slice(2), env: process.env });
}
