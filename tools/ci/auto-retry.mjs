// CHORE-CI-AUTORETRY: decides whether `.github/workflows/ci-auto-retry.yml` reruns the failed jobs of
// a completed CI or Security run, once. Rules (docs/process/ci-cd.md "Automatic rerun of flaky jobs"):
// - only a run that ended `failure` on its first attempt (attempt 2 or later never: no loops);
// - only pull_request, merge_group, and push on `main`; only runs from this repository (no forks);
// - every failed job (the aggregating gate aside) must be on the workflow's flaky list, because
//   rerunning a deterministic job (changesets, context-budget, ...) cannot turn it green.
// No dependencies; the workflow runs it with the runner's Node from a checkout of the default branch.
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const FLAKY_JOBS = {
  CI: new Set([
    'checks',
    'vectors',
    'e2e',
    'e2e-deterministic',
    'keychain',
    'storage-minio',
    'relays-docker',
    'node-os',
    'bundle-check',
  ]),
  Security: new Set(['codeql', 'dependency-review']),
};

// Aggregating gates fail whenever an upstream job fails; `--failed` reruns them as dependents.
const GATES = new Set(['ci-gate', 'security-gate']);
const FAILED = new Set(['failure', 'timed_out', 'cancelled']);
const EVENTS = new Set(['pull_request', 'merge_group', 'push']);

// "node-os (macos-15)" -> "node-os"; "e2e-deterministic / e2e-deterministic" -> "e2e-deterministic".
export function baseJobName(name) {
  return String(name)
    .split(' / ')[0]
    .replace(/ \(.*\)$/, '')
    .trim();
}

export function parseRunId(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value)) {
    throw new Error('run id must be a positive integer');
  }
  return value;
}

export function decide({ workflow, event, conclusion, attempt, repo, headRepo, headBranch, jobs }) {
  const no = (reason) => ({ rerun: false, reason, jobs: [] });
  const flaky = Object.hasOwn(FLAKY_JOBS, workflow) ? FLAKY_JOBS[workflow] : null;
  if (!flaky) return no('not a workflow this retries');
  if (attempt !== '1') return no('not the first attempt');
  if (conclusion !== 'failure') return no(`run ended ${conclusion || 'unknown'}, not failure`);
  if (!EVENTS.has(event)) return no(`event ${event || 'unknown'} is not retried`);
  if (event === 'push' && headBranch !== 'main') return no('push outside main is not retried');
  if (!repo || headRepo !== repo) return no('run is not from this repository');

  const failed = (jobs ?? [])
    .filter((j) => FAILED.has(j.conclusion))
    .map((j) => String(j.name))
    .filter((n) => !GATES.has(baseJobName(n)));
  if (failed.length === 0) return no('no failed job besides the gate');
  const deterministic = failed.filter((n) => !flaky.has(baseJobName(n)));
  if (deterministic.length > 0) {
    return { rerun: false, reason: 'a failed job is not on the flaky list', jobs: deterministic };
  }
  return { rerun: true, reason: 'first attempt failed only in flaky-prone jobs', jobs: failed };
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
