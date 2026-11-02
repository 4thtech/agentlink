import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { catchUpCiGreen, MAX_ATTEMPTS, parseArgs, run, SETTLE_MS } from './ci-green-catchup.mjs';

// OPS-CIGREEN-WAIT: release.yml and the deploy workflows start on the push to main and their
// `ci-green` job waits for this commit's CI. When CI is red on its first attempt (a flake that
// ci-auto-retry.yml re-runs) or slower than the wait, `ci-green` fails and nothing is released or
// deployed, although CI turns green later (2 Nov 2026: runs 41522347270, 41520829315). When CI or
// Security of a main push then completes green, ci-green-catchup.yml re-runs the failed jobs of
// every such run of that commit. The re-run is the original push run: its own ci-green verifies
// the gates again, and every environment, approval, freeze and head check applies unchanged.

const REPO = '4thtech/agentlink';
const SHA = 'a'.repeat(40);
const NEWER = 'b'.repeat(40);
const WORKFLOWS = ['release.yml', 'deploy-invite.yml'];

const runsPath = (workflow) => `/repos/${REPO}/actions/workflows/${workflow}/runs`;
const jobsPath = (id) => `/repos/${REPO}/actions/runs/${id}/jobs`;
const runPath = (id) => `/repos/${REPO}/actions/runs/${id}`;
const rerunPath = (id) => `/repos/${REPO}/actions/runs/${id}/rerun-failed-jobs`;
const headPath = `/repos/${REPO}/commits/main`;

const wfRun = (id, workflow, overrides = {}) => ({
  id,
  head_sha: SHA,
  head_branch: 'main',
  event: 'push',
  path: `.github/workflows/${workflow}`,
  status: 'completed',
  conclusion: 'failure',
  run_attempt: 1,
  ...overrides,
});
const job = (name, status, conclusion) => ({ name, status, conclusion });

/** CI and Security of SHA both green; main's head is SHA; one failed run per target workflow. */
function routes(overrides = {}) {
  return {
    [headPath]: () => ({ sha: SHA }),
    [runsPath('ci.yml')]: () => ({
      workflow_runs: [wfRun(11, 'ci.yml', { conclusion: 'success', run_attempt: 2 })],
    }),
    [jobsPath(11)]: () => ({ jobs: [job('ci-gate (push)', 'completed', 'success')] }),
    [runsPath('security.yml')]: () => ({
      workflow_runs: [wfRun(22, 'security.yml', { conclusion: 'success' })],
    }),
    [jobsPath(22)]: () => ({ jobs: [job('security-gate', 'completed', 'success')] }),
    [runsPath('release.yml')]: () => ({ workflow_runs: [wfRun(101, 'release.yml')] }),
    [jobsPath(101)]: () => ({ jobs: [job('ci-green', 'completed', 'failure')] }),
    [runPath(101)]: () => wfRun(101, 'release.yml'),
    [rerunPath(101)]: () => undefined,
    [runsPath('deploy-invite.yml')]: () => ({ workflow_runs: [wfRun(201, 'deploy-invite.yml')] }),
    [jobsPath(201)]: () => ({ jobs: [job('ci-green', 'completed', 'failure')] }),
    [runPath(201)]: () => wfRun(201, 'deploy-invite.yml'),
    [rerunPath(201)]: () => undefined,
    ...overrides,
  };
}

function fakeApi(table) {
  const calls = [];
  const counts = new Map();
  const api = async (pathWithQuery, init = {}) => {
    const path = pathWithQuery.split('?')[0];
    calls.push({ path, method: init.method ?? 'GET' });
    const route = table[path];
    if (!route) throw new Error(`unexpected API path ${path}`);
    const n = counts.get(path) ?? 0;
    counts.set(path, n + 1);
    return route(n);
  };
  return { api, calls };
}

function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => void (t += ms) };
}

async function go(table, options = {}) {
  const { api, calls } = fakeApi(table);
  const lines = [];
  const summary = [];
  const result = await catchUpCiGreen({
    api,
    repo: REPO,
    sha: SHA,
    workflows: WORKFLOWS,
    settleMs: 10 * 60_000,
    intervalMs: 30_000,
    log: (l) => lines.push(l),
    summary: (l) => summary.push(l),
    ...fakeClock(),
    ...options,
  });
  const reruns = calls.filter((c) => c.method === 'POST').map((c) => c.path);
  return { result, calls, reruns, lines, summary };
}

const outcomes = (result) => Object.fromEntries(result.results.map((r) => [r.workflow, r.outcome]));

describe('catchUpCiGreen', () => {
  it('re-runs the failed jobs of every run whose ci-green failed, once CI and Security are green', async () => {
    const { result, reruns, summary } = await go(routes());
    expect(reruns).toEqual([rerunPath(101), rerunPath(201)]);
    expect(outcomes(result)).toEqual({ 'release.yml': 'rerun', 'deploy-invite.yml': 'rerun' });
    expect(result.ok).toBe(true);
    expect(summary.join('\n')).toMatch(/run 101 of release\.yml/);
  });

  it('re-runs a ci-green that timed out', async () => {
    const { reruns } = await go(
      routes({ [jobsPath(101)]: () => ({ jobs: [job('ci-green', 'completed', 'timed_out')] }) }),
    );
    expect(reruns).toContain(rerunPath(101));
  });

  it('also re-runs a dispatched run (deploy catch-up) of the commit', async () => {
    const { reruns } = await go(
      routes({
        [runsPath('release.yml')]: () => ({ workflow_runs: [] }),
        [runsPath('deploy-invite.yml')]: () => ({
          workflow_runs: [wfRun(201, 'deploy-invite.yml', { event: 'workflow_dispatch' })],
        }),
      }),
    );
    expect(reruns).toEqual([rerunPath(201)]);
  });

  it('does nothing while DEPLOY_FREEZE is set', async () => {
    const { result, calls } = await go(routes(), { freeze: true });
    expect(result.action).toBe('frozen');
    expect(calls).toEqual([]);
  });

  it('does nothing when main has moved on (the newer commit runs its own release and deploys)', async () => {
    const { result, reruns } = await go(routes({ [headPath]: () => ({ sha: NEWER }) }));
    expect(result.action).toBe('moved-on');
    expect(result.ok).toBe(true);
    expect(reruns).toEqual([]);
  });

  it('fails closed on an unreadable head of main', async () => {
    const { result, reruns } = await go(routes({ [headPath]: () => ({ sha: 'nope' }) }));
    expect(result.ok).toBe(false);
    expect(reruns).toEqual([]);
  });

  it('does nothing until BOTH gates are green (the other completion triggers it again)', async () => {
    const { result, reruns } = await go(
      routes({ [jobsPath(22)]: () => ({ jobs: [job('security-gate', 'in_progress', null)] }) }),
    );
    expect(result.action).toBe('not-green');
    expect(result.ok).toBe(true);
    expect(reruns).toEqual([]);
  });

  it('never re-runs when a gate is red', async () => {
    const { result, reruns } = await go(
      routes({ [jobsPath(11)]: () => ({ jobs: [job('ci-gate (push)', 'completed', 'failure')] }) }),
    );
    expect(result.action).toBe('not-green');
    expect(reruns).toEqual([]);
  });

  it('accepts only the main push gate `ci-gate (push)`, not a job named `ci-gate`', async () => {
    const { reruns } = await go(
      routes({ [jobsPath(11)]: () => ({ jobs: [job('ci-gate', 'completed', 'success')] }) }),
    );
    expect(reruns).toEqual([]);
  });

  it('leaves a run alone whose ci-green passed (its failure is a real one) or is still waiting', async () => {
    const { result, reruns } = await go(
      routes({
        [jobsPath(101)]: () => ({ jobs: [job('ci-green', 'completed', 'success')] }),
        [runsPath('deploy-invite.yml')]: () => ({
          workflow_runs: [
            wfRun(201, 'deploy-invite.yml', { status: 'in_progress', conclusion: null }),
          ],
        }),
        [jobsPath(201)]: () => ({ jobs: [job('ci-green', 'in_progress', null)] }),
      }),
    );
    expect(reruns).toEqual([]);
    expect(outcomes(result)).toEqual({ 'release.yml': 'ok', 'deploy-invite.yml': 'live' });
    expect(result.ok).toBe(true);
  });

  it('leaves a cancelled ci-green to the deploy catch-up (superseded or cancelled by hand)', async () => {
    const { result, reruns } = await go(
      routes({ [jobsPath(101)]: () => ({ jobs: [job('ci-green', 'completed', 'cancelled')] }) }),
    );
    expect(reruns).toEqual([rerunPath(201)]);
    expect(outcomes(result)['release.yml']).toBe('cancelled');
  });

  it('skips a workflow without a run for the commit (its path filter did not match)', async () => {
    const { result, reruns } = await go(
      routes({ [runsPath('deploy-invite.yml')]: () => ({ workflow_runs: [] }) }),
    );
    expect(reruns).toEqual([rerunPath(101)]);
    expect(outcomes(result)['deploy-invite.yml']).toBe('none');
  });

  it('ignores runs of another commit, branch, event or workflow file, and takes the newest run', async () => {
    const { reruns } = await go(
      routes({
        [runsPath('release.yml')]: () => ({
          workflow_runs: [
            wfRun(90, 'release.yml'),
            wfRun(300, 'release.yml', { head_sha: NEWER }),
            wfRun(301, 'release.yml', { head_branch: 'wave-4' }),
            wfRun(302, 'release.yml', { event: 'pull_request' }),
            wfRun(303, 'release.yml', { path: '.github/workflows/other.yml' }),
            wfRun(101, 'release.yml'),
          ],
        }),
      }),
    );
    expect(reruns).toEqual([rerunPath(101), rerunPath(201)]);
  });

  it('waits for a run whose ci-green failed to finish (its catch-up job), then re-runs it', async () => {
    const { reruns } = await go(
      routes({
        [runsPath('release.yml')]: () => ({
          workflow_runs: [wfRun(101, 'release.yml', { status: 'in_progress', conclusion: null })],
        }),
        [runPath(101)]: (n) =>
          n < 2
            ? wfRun(101, 'release.yml', { status: 'in_progress', conclusion: null })
            : wfRun(101, 'release.yml'),
      }),
    );
    expect(reruns).toEqual([rerunPath(101), rerunPath(201)]);
  });

  it('is red when such a run does not finish within the settle time', async () => {
    const { result, reruns } = await go(
      routes({
        [runsPath('release.yml')]: () => ({
          workflow_runs: [wfRun(101, 'release.yml', { status: 'in_progress', conclusion: null })],
        }),
        [runPath(101)]: () =>
          wfRun(101, 'release.yml', { status: 'in_progress', conclusion: null }),
      }),
    );
    expect(reruns).toEqual([rerunPath(201)]);
    expect(outcomes(result)['release.yml']).toBe('unsettled');
    expect(result.ok).toBe(false);
  });

  it(`stops after ${MAX_ATTEMPTS} attempts and is red (no loop)`, async () => {
    const { result, reruns, lines } = await go(
      routes({ [runPath(101)]: () => wfRun(101, 'release.yml', { run_attempt: MAX_ATTEMPTS }) }),
    );
    expect(reruns).toEqual([rerunPath(201)]);
    expect(outcomes(result)['release.yml']).toBe('exhausted');
    expect(result.ok).toBe(false);
    expect(lines.join('\n')).toMatch(/::error::/);
  });

  it('a failed re-run request is red, and the other workflows are still handled', async () => {
    const { result, reruns } = await go(
      routes({
        [rerunPath(101)]: () => {
          throw new Error('HTTP 403');
        },
      }),
    );
    expect(reruns).toEqual([rerunPath(101), rerunPath(201)]);
    expect(outcomes(result)).toEqual({ 'release.yml': 'error', 'deploy-invite.yml': 'rerun' });
    expect(result.ok).toBe(false);
  });
});

describe('catchUpCiGreen: audit follow-ups (Fable, #779)', () => {
  it('re-checks the head of main right before each re-run and skips once main moved on', async () => {
    const { result, reruns } = await go(
      routes({ [headPath]: (n) => ({ sha: n === 0 ? SHA : NEWER }) }),
    );
    expect(reruns).toEqual([]);
    expect(outcomes(result)).toEqual({
      'release.yml': 'moved-on',
      'deploy-invite.yml': 'moved-on',
    });
    expect(result.ok).toBe(true);
  });

  it('re-checks per run: the first re-runs, the second sees main moved on', async () => {
    const { reruns, result } = await go(
      routes({ [headPath]: (n) => ({ sha: n < 2 ? SHA : NEWER }) }),
    );
    expect(reruns).toEqual([rerunPath(101)]);
    expect(outcomes(result)).toEqual({ 'release.yml': 'rerun', 'deploy-invite.yml': 'moved-on' });
  });

  it('fails closed when the head cannot be read before a re-run', async () => {
    const { reruns, result } = await go(
      routes({ [headPath]: (n) => ({ sha: n === 0 ? SHA : 'nope' }) }),
    );
    expect(reruns).toEqual([]);
    expect(result.ok).toBe(false);
  });

  it('treats a 409 (already re-running, a sibling pick-up started it) as live, not an error', async () => {
    const conflict = Object.assign(new Error('HTTP 409 for /x'), { status: 409 });
    const { result } = await go(
      routes({
        [rerunPath(101)]: () => {
          throw conflict;
        },
        [rerunPath(201)]: () => {
          throw new Error('HTTP 409 for /repos/x/actions/runs/201/rerun-failed-jobs');
        },
      }),
    );
    expect(outcomes(result)).toEqual({ 'release.yml': 'live', 'deploy-invite.yml': 'live' });
    expect(result.ok).toBe(true);
  });

  it(`waits ${SETTLE_MS / 60_000} min per run by default, and the job timeout covers four of them`, async () => {
    expect(SETTLE_MS).toBe(5 * 60_000);
    const pending = wfRun(101, 'release.yml', { status: 'in_progress', conclusion: null });
    const clock = fakeClock();
    const { api } = fakeApi(
      routes({
        [runsPath('release.yml')]: () => ({ workflow_runs: [pending] }),
        [runPath(101)]: () => pending,
      }),
    );
    const result = await catchUpCiGreen({
      api,
      repo: REPO,
      sha: SHA,
      workflows: ['release.yml'],
      log: () => {},
      ...clock,
    });
    expect(outcomes(result)['release.yml']).toBe('unsettled');
    expect(clock.now()).toBeGreaterThanOrEqual(SETTLE_MS);
    expect(clock.now()).toBeLessThan(SETTLE_MS + 60_000);
    const source = readFileSync(
      resolve(import.meta.dirname, '../../.github/workflows/ci-green-catchup.yml'),
      'utf8',
    );
    const jobMinutes = Number(/timeout-minutes: (\d+)/.exec(source)?.[1]);
    expect(jobMinutes * 60_000).toBeGreaterThan(4 * SETTLE_MS + 10 * 60_000);
  });
});

describe('parseArgs', () => {
  it('takes one or more workflow file names', () => {
    expect(parseArgs(['--workflow', 'release.yml', '--workflow', 'deploy-drop.yml'])).toEqual({
      workflows: ['release.yml', 'deploy-drop.yml'],
    });
  });
  it.each([[[]], [['--workflow']], [['--workflow', '../x.yml']], [['--other', 'a.yml']]])(
    'rejects %j',
    (argv) => {
      expect(() => parseArgs(argv)).toThrow();
    },
  );
});

describe('run (command line)', () => {
  const env = {
    GH_TOKEN: 'x',
    GITHUB_REPOSITORY: REPO,
    RUN_HEAD_SHA: SHA,
  };
  const argv = ['--workflow', 'release.yml', '--workflow', 'deploy-invite.yml'];

  it('exits 0 after re-running, and 1 on a malformed head sha', async () => {
    const ok = fakeApi(routes());
    expect(await run({ argv, env, api: ok.api, log: () => {}, ...fakeClock() })).toBe(0);
    const bad = fakeApi(routes());
    expect(
      await run({ argv, env: { ...env, RUN_HEAD_SHA: 'main' }, api: bad.api, log: () => {} }),
    ).toBe(1);
    expect(bad.calls).toEqual([]);
  });

  it('honours DEPLOY_FREEZE', async () => {
    const { api, calls } = fakeApi(routes());
    expect(await run({ argv, env: { ...env, DEPLOY_FREEZE: 'true' }, api, log: () => {} })).toBe(0);
    expect(calls).toEqual([]);
  });

  it('exits 1 when a run cannot be picked up', async () => {
    const { api } = fakeApi(
      routes({ [runPath(101)]: () => wfRun(101, 'release.yml', { run_attempt: MAX_ATTEMPTS }) }),
    );
    expect(await run({ argv, env, api, log: () => {}, ...fakeClock() })).toBe(1);
  });
});

describe('ci-green-catchup.yml', () => {
  const source = readFileSync(
    resolve(import.meta.dirname, '../../.github/workflows/ci-green-catchup.yml'),
    'utf8',
  );

  it('runs on completed CI and Security runs of main pushes from this repository only', () => {
    expect(source).toMatch(
      /workflow_run:[^\n]*\n\s+workflows: \[CI, Security\]\n\s+types: \[completed\]/,
    );
    expect(source).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(source).toContain("github.event.workflow_run.event == 'push'");
    expect(source).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(source).toContain(
      'github.event.workflow_run.head_repository.full_name == github.repository',
    );
  });

  it('never checks out the triggering run, holds only actions: write and contents: read', () => {
    expect(source).toContain('permissions: {}');
    expect(source).toContain('ref: ${{ github.sha }}');
    expect(source).not.toMatch(/head_sha \}\}[^\n]*\n[^\n]*checkout|ref: \$\{\{ github\.event/);
    expect(source).toMatch(/persist-credentials: false/);
    expect(source).not.toMatch(/secrets\./);
    expect(source).not.toMatch(/write-all|contents: write|id-token/);
  });

  it('passes the head sha only through env, and covers release and every deploy workflow', () => {
    expect(source).toContain('RUN_HEAD_SHA: ${{ github.event.workflow_run.head_sha }}');
    expect(source).not.toMatch(/run: [^\n]*\$\{\{/);
    for (const workflow of [
      'release.yml',
      'deploy-submitter.yml',
      'deploy-drop.yml',
      'deploy-invite.yml',
    ]) {
      expect(source).toContain(`--workflow ${workflow}`);
    }
  });

  it('serialises per commit and never cancels a pick-up in flight', () => {
    expect(source).toContain('group: ci-green-catchup-${{ github.event.workflow_run.head_sha }}');
    expect(source).toContain('cancel-in-progress: false');
  });
});

describe('deploy ci-green waits', () => {
  it.each(['deploy-submitter.yml', 'deploy-drop.yml', 'deploy-invite.yml', 'release.yml'])(
    '%s waits at least 90 minutes for the heavy lane',
    (workflow) => {
      const source = readFileSync(
        resolve(import.meta.dirname, '../../.github/workflows', workflow),
        'utf8',
      );
      const ciGreen = source.slice(source.indexOf('\n  ci-green:'));
      const minutes = Number(/--timeout-minutes (\d+)/.exec(ciGreen)?.[1]);
      expect(minutes).toBeGreaterThanOrEqual(90);
      const jobTimeout = Number(/timeout-minutes: (\d+)/.exec(ciGreen)?.[1]);
      expect(jobTimeout).toBeGreaterThan(minutes);
    },
  );
});
