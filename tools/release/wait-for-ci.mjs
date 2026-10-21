#!/usr/bin/env node
// OPS-CI-2: the first job of release.yml. Waits until the required gate jobs of the push runs of
// this exact `main` commit have finished, and fails unless every one of them succeeded.
//
//   node tools/release/wait-for-ci.mjs --require ci.yml:ci-gate --require security.yml:security-gate \
//     [--timeout-minutes 45] [--interval-seconds 30] [--missing-grace-minutes 10] [--superseded-ok]
//
// Environment: GH_TOKEN (the job's GITHUB_TOKEN with `actions: read`), GITHUB_REPOSITORY,
// GITHUB_SHA, GITHUB_API_URL (optional), GITHUB_OUTPUT (the step output file). Fails closed: a red,
// cancelled or skipped gate, a run that never appears, a gate still pending at the timeout, or an
// API that keeps failing all exit 1. On success it writes `result=green` to the step output.
//
// --superseded-ok (CHORE-CI-SUPERSEDED): GitHub keeps one pending run per concurrency group, so a
// newer push to main cancels an older commit's CI run while it still waits for a runner. When a
// required run of this commit was cancelled before its gate passed, no gate failed, and main's head
// has moved on to a descendant of this commit, the script writes `result=superseded`, prints a
// notice and exits 0. The caller MUST gate every later job on `result == 'green'`; a superseded run
// deploys and releases nothing (the newer commit's run, or the deploy catch-up, does). It needs a
// step output file and refuses to run without one.
// It reads only workflow-run and commit metadata; it prints no token and no event data.

import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const WORKFLOW_FILE = /^[A-Za-z0-9_-]+\.ya?ml$/;
const JOB_NAME = /^[A-Za-z0-9_. -]+$/;

export function parseArgs(argv) {
  const out = {
    require: [],
    timeoutMs: 45 * 60_000,
    intervalMs: 30_000,
    missingGraceMs: 10 * 60_000,
    supersededOk: false,
  };
  const positive = (flag, value, unit) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} needs a positive number`);
    return n * unit;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--superseded-ok') {
      out.supersededOk = true;
      continue;
    }
    switch (flag) {
      case '--require': {
        const [workflow, job, ...rest] = String(value ?? '').split(':');
        if (rest.length || !WORKFLOW_FILE.test(workflow ?? '') || !JOB_NAME.test(job ?? '')) {
          throw new Error(
            `--require needs <workflow file>:<job name>, got ${JSON.stringify(value)}`,
          );
        }
        out.require.push({ workflow, job });
        break;
      }
      case '--timeout-minutes':
        out.timeoutMs = positive(flag, value, 60_000);
        break;
      case '--interval-seconds':
        out.intervalMs = positive(flag, value, 1_000);
        break;
      case '--missing-grace-minutes':
        out.missingGraceMs = positive(flag, value, 60_000);
        break;
      default:
        throw new Error(`unknown option ${JSON.stringify(flag)}`);
    }
    i += 1;
  }
  if (out.require.length === 0)
    throw new Error('at least one --require <workflow>:<job> is needed');
  return out;
}

const JOBS_PER_PAGE = 100;
const MAX_JOB_PAGES = 10;

// Pages through the run's jobs (latest attempt) until the named job is found or the list ends.
async function findJob({ api, repo, runId, name }) {
  for (let page = 1; page <= MAX_JOB_PAGES; page += 1) {
    const query = new URLSearchParams({
      filter: 'latest',
      per_page: String(JOBS_PER_PAGE),
      page: String(page),
    });
    const body = await api(`/repos/${repo}/actions/runs/${runId}/jobs?${query}`);
    const jobs = body?.jobs ?? [];
    const found = jobs.find((j) => j?.name === name);
    if (found) return found;
    if (jobs.length < JOBS_PER_PAGE) return undefined;
  }
  throw new Error(`run ${runId} has more than ${MAX_JOB_PAGES * JOBS_PER_PAGE} jobs`);
}

// A run cancelled before its gate passed: the gate never ran, or ended cancelled or skipped.
const CANCELLED_GATE = new Set(['cancelled', 'skipped']);

// One look at every required gate. Returns
// { state: 'green' | 'red' | 'cancelled' | 'pending', reasons, missing, cancelled }.
// 'cancelled': no gate failed, and at least one required run was cancelled before its gate passed.
export async function checkOnce({ api, repo, sha, require }) {
  const reasons = [];
  const missing = [];
  const cancelled = [];
  let anyRed = false;
  let anyPending = false;

  for (const { workflow, job } of require) {
    // Only push runs on `main`: pushing a new branch at the same commit starts another push run
    // whose gate is `ci-gate (push)`, which must neither satisfy nor block the release.
    const query = new URLSearchParams({
      head_sha: sha,
      event: 'push',
      branch: 'main',
      per_page: '50',
    });
    const body = await api(`/repos/${repo}/actions/workflows/${workflow}/runs?${query}`);
    const runs = (body?.workflow_runs ?? []).filter(
      (r) =>
        r?.head_sha === sha &&
        r?.event === 'push' &&
        r?.head_branch === 'main' &&
        r?.path === `.github/workflows/${workflow}`,
    );
    if (runs.length === 0) {
      anyPending = true;
      missing.push(workflow);
      reasons.push(`${workflow}: no push run for this commit yet`);
      continue;
    }
    const newest = runs.reduce((a, b) => (Number(b.id) > Number(a.id) ? b : a));
    const gate = await findJob({ api, repo, runId: newest.id, name: job });
    const runCancelled = newest.status === 'completed' && newest.conclusion === 'cancelled';

    if (
      runCancelled &&
      (!gate || (gate.status === 'completed' && CANCELLED_GATE.has(gate.conclusion)))
    ) {
      cancelled.push(workflow);
      reasons.push(`${workflow}: run ${newest.id} was cancelled before "${job}" passed`);
      continue;
    }
    if (!gate) {
      if (newest.status === 'completed') {
        anyRed = true;
        reasons.push(`${workflow}: run ${newest.id} completed without a job named "${job}"`);
      } else {
        anyPending = true;
        reasons.push(`${workflow}: run ${newest.id} is ${newest.status}; "${job}" not started`);
      }
      continue;
    }
    if (gate.status !== 'completed') {
      anyPending = true;
      reasons.push(`${workflow}: "${job}" is ${gate.status} (run ${newest.id})`);
      continue;
    }
    if (gate.conclusion === 'success') {
      reasons.push(`${workflow}: "${job}" succeeded (run ${newest.id})`);
    } else {
      anyRed = true;
      reasons.push(`${workflow}: "${job}" ended as ${String(gate.conclusion)} (run ${newest.id})`);
    }
  }

  const state = anyRed
    ? 'red'
    : cancelled.length > 0
      ? 'cancelled'
      : anyPending
        ? 'pending'
        : 'green';
  return { state, reasons, missing, cancelled };
}

const SHA_RE = /^[0-9a-f]{40}$/;

// The head of main when it has moved on to a descendant of `sha`, otherwise undefined.
// Throws when the head cannot be read (the caller retries, then fails closed).
export async function supersededBy({ api, repo, sha }) {
  const head = (await api(`/repos/${repo}/commits/main`))?.sha;
  if (typeof head !== 'string' || !SHA_RE.test(head)) {
    throw new Error('could not read the head of main');
  }
  if (head === sha) return undefined;
  // `ahead`: head contains this commit and more; anything else is not a supersede.
  const compare = await api(`/repos/${repo}/compare/${sha}...${head}`);
  return compare?.status === 'ahead' ? head : undefined;
}

// Polls until green (ok), red (not ok, at once), or the limits run out (not ok).
export async function waitForGreen({
  api,
  repo,
  sha,
  require,
  timeoutMs,
  intervalMs,
  missingGraceMs,
  supersededOk = false,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console.log,
}) {
  const start = now();
  let last;
  for (;;) {
    const elapsed = now() - start;
    try {
      const result = await checkOnce({ api, repo, sha, require });
      last = result;
      for (const reason of result.reasons) log(reason);
      if (result.state === 'green') return { ok: true, reasons: result.reasons };
      if (result.state === 'red') return { ok: false, reasons: result.reasons };
      if (result.state === 'cancelled') {
        const head = supersededOk ? await supersededBy({ api, repo, sha }) : undefined;
        if (head) {
          return {
            ok: false,
            superseded: true,
            head,
            reasons: [...result.reasons, `main has moved on to ${head}`],
          };
        }
        return {
          ok: false,
          reasons: [
            ...result.reasons,
            supersededOk
              ? 'this commit was cancelled but main has not moved on past it'
              : `${result.cancelled.join(', ')} cancelled`,
          ],
        };
      }
      if (result.missing.length > 0 && elapsed >= missingGraceMs) {
        return {
          ok: false,
          reasons: [
            ...result.reasons,
            `no run of ${result.missing.join(', ')} appeared within ${missingGraceMs / 60_000} min`,
          ],
        };
      }
    } catch (error) {
      last = { reasons: [`GitHub API error: ${error?.message ?? String(error)}`] };
      log(last.reasons[0]);
    }
    if (elapsed >= timeoutMs) {
      return {
        ok: false,
        reasons: [...last.reasons, `timed out after ${timeoutMs / 60_000} min waiting for CI`],
      };
    }
    await sleep(intervalMs);
  }
}

export function githubApi({ token, baseUrl }) {
  return async (path, { method = 'GET', body } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${path.split('?')[0]}`);
    return response.status === 204 ? undefined : response.json();
  };
}

/** Checks GH_TOKEN, GITHUB_REPOSITORY and GITHUB_SHA. Throws on a missing or malformed value. */
export function readEnv(env) {
  const token = env.GH_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  const sha = env.GITHUB_SHA;
  const baseUrl = env.GITHUB_API_URL || 'https://api.github.com';
  if (!token || !repo || !sha)
    throw new Error('GH_TOKEN, GITHUB_REPOSITORY and GITHUB_SHA are required');
  if (!SHA_RE.test(sha) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error('GITHUB_SHA or GITHUB_REPOSITORY is malformed');
  }
  return { token, repo, sha, baseUrl };
}

/**
 * The command line. Returns the exit code. `writeOutput` appends one `key=value` line to the step
 * output (GITHUB_OUTPUT); `api` defaults to the GitHub REST API.
 */
export async function run({ argv, env, api, log = console.log, writeOutput, now, sleep }) {
  try {
    const args = parseArgs(argv);
    const { token, repo, sha, baseUrl } = readEnv(env);
    if (args.supersededOk && !writeOutput) {
      throw new Error('--superseded-ok needs GITHUB_OUTPUT: the result must gate the next job');
    }
    log(`Waiting for ${args.require.map((r) => `${r.workflow}:${r.job}`).join(', ')} on ${sha}`);
    const result = await waitForGreen({
      ...args,
      api: api ?? githubApi({ token, baseUrl }),
      repo,
      sha,
      log,
      ...(now ? { now } : {}),
      ...(sleep ? { sleep } : {}),
    });
    if (result.superseded) {
      writeOutput('result=superseded');
      log(
        `::notice::Superseded: CI of ${sha} was cancelled before it ran because main moved on to ${result.head}. Nothing is deployed or released for this commit; the newer commit's run (or the deploy catch-up) handles it.`,
      );
      return 0;
    }
    if (!result.ok) {
      log(`::error::CI of this commit is not green; nothing is released. ${result.reasons.at(-1)}`);
      return 1;
    }
    writeOutput?.('result=green');
    log('CI of this commit is green.');
    return 0;
  } catch (error) {
    log(`::error::${error?.message ?? String(error)}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const outputFile = process.env.GITHUB_OUTPUT;
  process.exitCode = await run({
    argv: process.argv.slice(2),
    env: process.env,
    writeOutput: outputFile ? (line) => appendFileSync(outputFile, `${line}\n`) : undefined,
  });
}
