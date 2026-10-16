#!/usr/bin/env node
// OPS-CI-2: the first job of release.yml. Waits until the required gate jobs of the push runs of
// this exact `main` commit have finished, and fails unless every one of them succeeded.
//
//   node tools/release/wait-for-ci.mjs --require ci.yml:ci-gate --require security.yml:security-gate \
//     [--timeout-minutes 45] [--interval-seconds 30] [--missing-grace-minutes 10]
//
// Environment: GH_TOKEN (the job's GITHUB_TOKEN with `actions: read`), GITHUB_REPOSITORY,
// GITHUB_SHA, GITHUB_API_URL (optional). Fails closed: a red, cancelled or skipped gate, a run that
// never appears, a gate still pending at the timeout, or an API that keeps failing all exit 1.
// It reads only workflow-run metadata; it prints no token and no event data.

import { pathToFileURL } from 'node:url';

const WORKFLOW_FILE = /^[A-Za-z0-9_-]+\.ya?ml$/;
const JOB_NAME = /^[A-Za-z0-9_. -]+$/;

export function parseArgs(argv) {
  const out = {
    require: [],
    timeoutMs: 45 * 60_000,
    intervalMs: 30_000,
    missingGraceMs: 10 * 60_000,
  };
  const positive = (flag, value, unit) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} needs a positive number`);
    return n * unit;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
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

// One look at every required gate. Returns { state: 'green' | 'red' | 'pending', reasons, missing }.
export async function checkOnce({ api, repo, sha, require }) {
  const reasons = [];
  const missing = [];
  let anyRed = false;
  let anyPending = false;

  for (const { workflow, job } of require) {
    const query = new URLSearchParams({ head_sha: sha, event: 'push', per_page: '50' });
    const body = await api(`/repos/${repo}/actions/workflows/${workflow}/runs?${query}`);
    const runs = (body?.workflow_runs ?? []).filter(
      (r) =>
        r?.head_sha === sha && r?.event === 'push' && r?.path === `.github/workflows/${workflow}`,
    );
    if (runs.length === 0) {
      anyPending = true;
      missing.push(workflow);
      reasons.push(`${workflow}: no push run for this commit yet`);
      continue;
    }
    const newest = runs.reduce((a, b) => (Number(b.id) > Number(a.id) ? b : a));
    const jobsBody = await api(
      `/repos/${repo}/actions/runs/${newest.id}/jobs?filter=latest&per_page=100`,
    );
    const gate = (jobsBody?.jobs ?? []).find((j) => j?.name === job);

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

  const state = anyRed ? 'red' : anyPending ? 'pending' : 'green';
  return { state, reasons, missing };
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

function githubApi({ token, baseUrl }) {
  return async (path) => {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${path.split('?')[0]}`);
    return response.json();
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.GH_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA;
  const baseUrl = process.env.GITHUB_API_URL || 'https://api.github.com';
  if (!token || !repo || !sha)
    throw new Error('GH_TOKEN, GITHUB_REPOSITORY and GITHUB_SHA are required');
  if (!/^[0-9a-f]{40}$/.test(sha) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error('GITHUB_SHA or GITHUB_REPOSITORY is malformed');
  }
  console.log(
    `Waiting for ${args.require.map((r) => `${r.workflow}:${r.job}`).join(', ')} on ${sha}`,
  );
  const result = await waitForGreen({ ...args, api: githubApi({ token, baseUrl }), repo, sha });
  if (!result.ok) {
    console.log(
      `::error::CI of this commit is not green; nothing is released. ${result.reasons.at(-1)}`,
    );
    process.exit(1);
  }
  console.log('CI of this commit is green.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.log(`::error::${error?.message ?? String(error)}`);
    process.exit(1);
  });
}
