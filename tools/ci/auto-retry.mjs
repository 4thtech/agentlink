// CHORE-CI-AUTORETRY: decides whether `.github/workflows/ci-auto-retry.yml` reruns the failed jobs of
// a completed CI or Security run, once. Rules (docs/process/ci-cd.md "Automatic rerun of flaky jobs"):
// - only a run that ended `failure` on its first attempt (attempt 2 or later never: no loops);
// - only pull_request and push on `main` (a failed merge-queue run already ejected the PR); only runs from this repository (no forks);
// - every failed job (the aggregating gate aside) must be on the workflow's flaky list, and for a
//   mixed job every failed step must be flaky-prone, because rerunning a deterministic job or step
//   (lint, typecheck, changesets, context-budget, ...) cannot turn it green.
// No dependencies; the workflow runs it with the runner's Node from a checkout of the default branch.
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Per workflow: the exact job name as the API reports it, and either `steps` (a mixed job: rerun only
// when every failed step is one of these flaky-prone steps; lint, typecheck, build and static checks
// never qualify) or no `steps` (a purely flaky-prone job: any failure qualifies). `matrix: true`
// accepts only "<name> (<leg>)". Names follow ci.yml, e2e.yml and security.yml.
export const FLAKY_JOBS = {
  CI: {
    checks: { steps: ['Unit tests', 'MCP tool surface and conformance'] },
    vectors: {
      steps: [
        'Install Playwright browsers',
        "Install the vector generators' pinned Python packages",
        'Check test vectors across runtimes',
      ],
    },
    'bundle-check': { steps: ['Set up Node.js and pnpm'] },
    keychain: { matrix: true },
    'node-os': { matrix: true },
    'relays-docker': {},
    'storage-minio': {},
    // the reusable e2e.yml called by the ci.yml job of the same name
    'e2e-deterministic / e2e-deterministic': {},
  },
  Security: {
    codeql: { matrix: true },
    'dependency-review': {},
  },
};

// Aggregating gates fail whenever an upstream job fails; `--failed` reruns them as dependents.
const GATES = new Set(['ci-gate', 'ci-gate (push)', 'security-gate']);
const FAILED = new Set(['failure', 'timed_out', 'cancelled']);
const EVENTS = new Set(['pull_request', 'push']);

// The allowlist entry for an exact job name, or for "<name> (<leg>)" of a matrix job; else null.
export function flakyEntry(workflow, name) {
  const table = Object.hasOwn(FLAKY_JOBS, workflow) ? FLAKY_JOBS[workflow] : null;
  if (!table) return null;
  const n = String(name);
  if (Object.hasOwn(table, n)) return table[n].matrix ? null : table[n];
  const m = /^([a-z0-9-]+) \([^()]+\)$/.exec(n);
  if (m && Object.hasOwn(table, m[1]) && table[m[1]].matrix) return table[m[1]];
  return null;
}

// A failed job qualifies when it is on the list and, for a mixed job, it failed in at least one
// step and every failed step is flaky-prone (a cancelled or timed-out mixed job does not qualify).
export function jobQualifies(workflow, job) {
  const entry = flakyEntry(workflow, job.name);
  if (!entry) return false;
  if (!entry.steps) return true;
  const steps = Array.isArray(job.failedSteps) ? job.failedSteps.map(String) : [];
  return steps.length > 0 && steps.every((s) => entry.steps.includes(s));
}

export function parseRunId(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value)) {
    throw new Error('run id must be a positive integer');
  }
  return value;
}

export function decide({ workflow, event, conclusion, attempt, repo, headRepo, headBranch, jobs }) {
  const no = (reason) => ({ rerun: false, reason, jobs: [] });
  if (!Object.hasOwn(FLAKY_JOBS, workflow)) return no('not a workflow this retries');
  if (attempt !== '1') return no('not the first attempt');
  if (conclusion !== 'failure') return no(`run ended ${conclusion || 'unknown'}, not failure`);
  if (!EVENTS.has(event)) return no(`event ${event || 'unknown'} is not retried`);
  if (event === 'push' && headBranch !== 'main') return no('push outside main is not retried');
  if (!repo || headRepo !== repo) return no('run is not from this repository');

  const failed = (jobs ?? [])
    .filter((j) => FAILED.has(j.conclusion))
    .filter((j) => !GATES.has(String(j.name)));
  if (failed.length === 0) return no('no failed job besides the gate');
  const deterministic = failed.filter((j) => !jobQualifies(workflow, j)).map((j) => String(j.name));
  if (deterministic.length > 0) {
    return {
      rerun: false,
      reason: 'a failed job or step is not on the flaky list',
      jobs: deterministic,
    };
  }
  return {
    rerun: true,
    reason: 'first attempt failed only in flaky-prone jobs or steps',
    jobs: failed.map((j) => String(j.name)),
  };
}

// One plain line for the job summary; job names come from the run's workflow file, so they are
// reduced to a safe character set (no markdown or HTML).
export function summaryLine(decision, workflow, runId) {
  const clean = (s) =>
    String(s)
      .replace(/[^A-Za-z0-9 ()/_.,:-]/g, '')
      .slice(0, 120);
  const jobs = decision.jobs.map(clean).join(', ') || 'none';
  const head = decision.rerun
    ? `Rerunning the failed jobs of ${clean(workflow)} run ${clean(runId)} once`
    : `No rerun for ${clean(workflow)} run ${clean(runId)}`;
  return `${head}: ${clean(decision.reason)}. Jobs: ${jobs}.`;
}

function main() {
  const env = process.env;
  const runId = parseRunId(env.RUN_ID);
  const jobs = readFileSync(env.JOBS_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const decision = decide({
    workflow: env.WORKFLOW_NAME,
    event: env.RUN_EVENT,
    conclusion: env.RUN_CONCLUSION,
    attempt: env.RUN_ATTEMPT,
    repo: env.REPO,
    headRepo: env.HEAD_REPO,
    headBranch: env.HEAD_BRANCH,
    jobs,
  });
  const line = summaryLine(decision, env.WORKFLOW_NAME, runId);
  console.log(line);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `rerun=${decision.rerun}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
