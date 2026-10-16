import { describe, expect, it } from 'vitest';
import { checkOnce, parseArgs, waitForGreen } from './wait-for-ci.mjs';

// OPS-CI-2: release.yml must not do anything for a `main` commit until that commit's CI is green.
// The GitHub API is faked: `routes` maps an API path (without the query string) to a function of
// the call number that returns the JSON body, or throws to simulate an API error.

const REPO = '4thtech/agentlink';
const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const REQUIRE = [
  { workflow: 'ci.yml', job: 'ci-gate' },
  { workflow: 'security.yml', job: 'security-gate' },
];

const run = (id, workflow, overrides = {}) => ({
  id,
  head_sha: SHA,
  event: 'push',
  path: `.github/workflows/${workflow}`,
  status: 'completed',
  conclusion: 'success',
  ...overrides,
});
const job = (name, status, conclusion) => ({ name, status, conclusion });
const runsPath = (workflow) => `/repos/${REPO}/actions/workflows/${workflow}/runs`;
const jobsPath = (id) => `/repos/${REPO}/actions/runs/${id}/jobs`;

function fakeApi(routes) {
  const calls = new Map();
  const seen = [];
  const api = async (pathWithQuery) => {
    seen.push(pathWithQuery);
    const path = pathWithQuery.split('?')[0];
    const route = routes[path];
    if (!route) throw new Error(`unexpected API path ${path}`);
    const n = calls.get(path) ?? 0;
    calls.set(path, n + 1);
    return route(n);
  };
  return { api, seen };
}

function greenRoutes(overrides = {}) {
  return {
    [runsPath('ci.yml')]: () => ({ workflow_runs: [run(11, 'ci.yml')] }),
    [jobsPath(11)]: () => ({
      jobs: [job('detect', 'completed', 'success'), job('ci-gate', 'completed', 'success')],
    }),
    [runsPath('security.yml')]: () => ({ workflow_runs: [run(22, 'security.yml')] }),
    [jobsPath(22)]: () => ({ jobs: [job('security-gate', 'completed', 'success')] }),
    ...overrides,
  };
}

// A fake clock: sleep advances it, so waits cost no real time.
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
}

const opts = (api, clock, extra = {}) => ({
  api,
  repo: REPO,
  sha: SHA,
  require: REQUIRE,
  timeoutMs: 45 * 60_000,
  intervalMs: 30_000,
  missingGraceMs: 10 * 60_000,
  now: clock.now,
  sleep: clock.sleep,
  log: () => {},
  ...extra,
});

describe('checkOnce', () => {
  it('is green when every required gate job succeeded', async () => {
    const { api } = fakeApi(greenRoutes());
    const result = await checkOnce({ api, repo: REPO, sha: SHA, require: REQUIRE });
    expect(result.state).toBe('green');
  });

  it('asks only for push runs of the exact commit', async () => {
    const { api, seen } = fakeApi(greenRoutes());
    await checkOnce({ api, repo: REPO, sha: SHA, require: REQUIRE });
    const runsCall = seen.find((p) => p.startsWith(runsPath('ci.yml')));
    expect(runsCall).toContain(`head_sha=${SHA}`);
    expect(runsCall).toContain('event=push');
  });

  it('is red when a gate job failed', async () => {
    const { api } = fakeApi(
      greenRoutes({
        [jobsPath(11)]: () => ({ jobs: [job('ci-gate', 'completed', 'failure')] }),
      }),
    );
    const result = await checkOnce({ api, repo: REPO, sha: SHA, require: REQUIRE });
    expect(result.state).toBe('red');
    expect(result.reasons.join('\n')).toContain('ci-gate');
  });

  for (const conclusion of ['cancelled', 'skipped', 'timed_out', 'neutral', 'action_required', null]) {
    it(`is red when the gate job ended as ${String(conclusion)}`, async () => {
      const { api } = fakeApi(
        greenRoutes({
          [jobsPath(22)]: () => ({ jobs: [job('security-gate', 'completed', conclusion)] }),
        }),
      );
      const result = await checkOnce({ api, repo: REPO, sha: SHA, require: REQUIRE });
      expect(result.state).toBe('red');
    });
  }

  it('is pending while the gate job has not completed', async () => {
    const { api } = fakeApi(
      greenRoutes({
        [runsPath('ci.yml')]: () => ({
          workflow_runs: [run(11, 'ci.yml', { status: 'in_progress', conclusion: null })],
        }),
        [jobsPath(11)]: () => ({ jobs: [job('ci-gate', 'queued', null)] }),
      }),
    );
    const result = await checkOnce({ api, repo: REPO, sha: SHA, require: REQUIRE });
    expect(result.state).toBe('pending');
  });

  it('does not wait for jobs outside the gate once the gate succeeded', async () => {
    const { api } = fakeApi(
      greenRoutes({
        [runsPath('ci.yml')]: () => ({
          workflow_runs: [run(11, 'ci.yml', { status: 'in_progress', conclusion: null })],
        }),
        [jobsPath(11)]: () => ({
          jobs: [job('node-os', 'in_progress', null), job('ci-gate', 'completed', 'success')],
        }),
      }),
    );
    const result = await checkOnce({ api, repo: REPO, sha: SHA, require: REQUIRE });
    expect(result.state).toBe('green');
  });

  it('matches the gate job name exactly (a feature-branch "ci-gate (push)" does not count)', async () => {
    const { api } = fakeApi(
      greenRoutes({
        [jobsPath(11)]: () => ({ jobs: [job('ci-gate (push)', 'completed', 'success')] }),
      }),
    );
    const result = await checkOnce({ api, repo: REPO, sha: SHA, require: REQUIRE });
    expect(result.state).toBe('red');
  });

  it('is red when the run completed without the gate job', async () => {
    const { api } = fakeApi(
      greenRoutes({ [jobsPath(11)]: () => ({ jobs: [job('detect', 'completed', 'success')] }) }),
    );
    const result = await checkOnce({ api, repo: REPO, sha: SHA, require: REQUIRE });
    expect(result.state).toBe('red');
  });

  it('ignores runs of another commit, another event or another workflow file', async () => {
    const { api } = fakeApi(
      greenRoutes({
        [runsPath('ci.yml')]: () => ({
          workflow_runs: [
            run(31, 'ci.yml', { head_sha: OTHER_SHA }),
            run(32, 'ci.yml', { event: 'pull_request' }),
            run(33, 'other.yml'),
          ],
        }),
      }),
    );
    const result = await checkOnce({ api, repo: REPO, sha: SHA, require: REQUIRE });
    expect(result.state).toBe('pending');
    expect(result.missing).toContain('ci.yml');
  });

  it('judges the newest run when several exist for the commit', async () => {
    const { api } = fakeApi(
      greenRoutes({
        [runsPath('ci.yml')]: () => ({ workflow_runs: [run(11, 'ci.yml'), run(12, 'ci.yml')] }),
        [jobsPath(12)]: () => ({ jobs: [job('ci-gate', 'completed', 'failure')] }),
      }),
    );
    const result = await checkOnce({ api, repo: REPO, sha: SHA, require: REQUIRE });
    expect(result.state).toBe('red');
  });
});

describe('waitForGreen', () => {
  it('returns ok at once when CI is already green', async () => {
    const clock = fakeClock();
    const { api } = fakeApi(greenRoutes());
    const result = await waitForGreen(opts(api, clock));
    expect(result.ok).toBe(true);
    expect(clock.now()).toBe(0);
  });

  it('waits while CI runs and then proceeds when it turns green', async () => {
    const clock = fakeClock();
    const { api } = fakeApi(
      greenRoutes({
        [jobsPath(11)]: (n) => ({
          jobs: [n < 3 ? job('ci-gate', 'in_progress', null) : job('ci-gate', 'completed', 'success')],
        }),
      }),
    );
    const result = await waitForGreen(opts(api, clock));
    expect(result.ok).toBe(true);
    expect(clock.now()).toBe(3 * 30_000);
  });

  it('stops as soon as CI is red, without waiting for the timeout', async () => {
    const clock = fakeClock();
    const { api } = fakeApi(
      greenRoutes({
        [jobsPath(11)]: (n) => ({
          jobs: [n < 1 ? job('ci-gate', 'in_progress', null) : job('ci-gate', 'completed', 'failure')],
        }),
      }),
    );
    const result = await waitForGreen(opts(api, clock));
    expect(result.ok).toBe(false);
    expect(clock.now()).toBe(30_000);
  });

  it('fails closed when no CI run appears within the grace period', async () => {
    const clock = fakeClock();
    const { api } = fakeApi(greenRoutes({ [runsPath('ci.yml')]: () => ({ workflow_runs: [] }) }));
    const result = await waitForGreen(opts(api, clock));
    expect(result.ok).toBe(false);
    expect(result.reasons.join('\n')).toMatch(/no .*run/i);
    expect(clock.now()).toBeGreaterThanOrEqual(10 * 60_000);
    expect(clock.now()).toBeLessThan(45 * 60_000);
  });

  it('fails closed when CI is still pending at the timeout', async () => {
    const clock = fakeClock();
    const { api } = fakeApi(
      greenRoutes({ [jobsPath(11)]: () => ({ jobs: [job('ci-gate', 'queued', null)] }) }),
    );
    const result = await waitForGreen(opts(api, clock));
    expect(result.ok).toBe(false);
    expect(result.reasons.join('\n')).toMatch(/timed out|timeout/i);
    expect(clock.now()).toBeGreaterThanOrEqual(45 * 60_000);
  });

  it('retries after a transient API error', async () => {
    const clock = fakeClock();
    const { api } = fakeApi(
      greenRoutes({
        [runsPath('ci.yml')]: (n) => {
          if (n === 0) throw new Error('HTTP 502');
          return { workflow_runs: [run(11, 'ci.yml')] };
        },
      }),
    );
    const result = await waitForGreen(opts(api, clock));
    expect(result.ok).toBe(true);
  });

  it('fails closed when the API keeps failing', async () => {
    const clock = fakeClock();
    const { api } = fakeApi(
      greenRoutes({
        [runsPath('ci.yml')]: () => {
          throw new Error('HTTP 403');
        },
      }),
    );
    const result = await waitForGreen(opts(api, clock));
    expect(result.ok).toBe(false);
  });
});

describe('parseArgs', () => {
  it('reads the required gates and the limits', () => {
    const parsed = parseArgs([
      '--require',
      'ci.yml:ci-gate',
      '--require',
      'security.yml:security-gate',
      '--timeout-minutes',
      '45',
      '--interval-seconds',
      '30',
      '--missing-grace-minutes',
      '10',
    ]);
    expect(parsed.require).toEqual(REQUIRE);
    expect(parsed.timeoutMs).toBe(45 * 60_000);
    expect(parsed.intervalMs).toBe(30_000);
    expect(parsed.missingGraceMs).toBe(10 * 60_000);
  });

  it('refuses to run without a required gate', () => {
    expect(() => parseArgs([])).toThrow();
  });

  for (const bad of ['ci.yml', ':ci-gate', 'ci.yml:', '../x.yml:ci-gate', 'ci.yaml.sh:ci-gate']) {
    it(`refuses the malformed gate ${JSON.stringify(bad)}`, () => {
      expect(() => parseArgs(['--require', bad])).toThrow();
    });
  }

  it('refuses unknown options and non-positive limits', () => {
    expect(() => parseArgs(['--require', 'ci.yml:ci-gate', '--bogus'])).toThrow();
    expect(() => parseArgs(['--require', 'ci.yml:ci-gate', '--timeout-minutes', '0'])).toThrow();
  });
});
