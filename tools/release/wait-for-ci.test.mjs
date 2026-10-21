import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkOnce, parseArgs, run as runCommand, waitForGreen } from './wait-for-ci.mjs';

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
  head_branch: 'main',
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

  for (const conclusion of [
    'cancelled',
    'skipped',
    'timed_out',
    'neutral',
    'action_required',
    null,
  ]) {
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

  it('asks only for runs on main', async () => {
    const { api, seen } = fakeApi(greenRoutes());
    await checkOnce({ api, repo: REPO, sha: SHA, require: REQUIRE });
    expect(seen.find((p) => p.startsWith(runsPath('ci.yml')))).toContain('branch=main');
  });

  it('ignores a newer push run of the same commit on another branch', async () => {
    const { api } = fakeApi(
      greenRoutes({
        [runsPath('ci.yml')]: () => ({
          workflow_runs: [run(11, 'ci.yml'), run(99, 'ci.yml', { head_branch: 'feature/x' })],
        }),
        [jobsPath(99)]: () => ({ jobs: [job('ci-gate (push)', 'completed', 'success')] }),
      }),
    );
    const result = await checkOnce({ api, repo: REPO, sha: SHA, require: REQUIRE });
    expect(result.state).toBe('green');
  });

  it('pages through the jobs list to find the gate', async () => {
    const filler = Array.from({ length: 100 }, (_, i) =>
      job(`matrix ${i}`, 'completed', 'success'),
    );
    const { api, seen } = fakeApi(
      greenRoutes({
        [jobsPath(11)]: (n) =>
          n === 0 ? { jobs: filler } : { jobs: [job('ci-gate', 'completed', 'success')] },
      }),
    );
    const result = await checkOnce({ api, repo: REPO, sha: SHA, require: REQUIRE });
    expect(result.state).toBe('green');
    expect(
      seen.filter((p) => p.startsWith(jobsPath(11))).map((p) => p.match(/[?&]page=(\d+)/)?.[1]),
    ).toEqual(['1', '2']);
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
          jobs: [
            n < 3 ? job('ci-gate', 'in_progress', null) : job('ci-gate', 'completed', 'success'),
          ],
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
          jobs: [
            n < 1 ? job('ci-gate', 'in_progress', null) : job('ci-gate', 'completed', 'failure'),
          ],
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

// CHORE-CI-SUPERSEDED: GitHub keeps one pending run per concurrency group, so a newer push to main
// cancels the older commit's CI while it still waits for a runner (run 39579893667 for 52613475).
// That commit's own CI never ran, so it is never deployed or released; with --superseded-ok the run
// ends as superseded (exit 0, `result=superseded`, every later job skipped) instead of failing,
// and only when main has moved on past this commit. Nothing is ever judged green without its gate.
const HEAD = 'c'.repeat(40);
const headPath = `/repos/${REPO}/commits/main`;
const comparePath = (base, head) => `/repos/${REPO}/compare/${base}...${head}`;
const cancelledCi = (overrides = {}) =>
  greenRoutes({
    [runsPath('ci.yml')]: () => ({
      workflow_runs: [run(11, 'ci.yml', { conclusion: 'cancelled' })],
    }),
    [jobsPath(11)]: () => ({ jobs: [job('detect', 'completed', 'cancelled')] }),
    [headPath]: () => ({ sha: HEAD }),
    [comparePath(SHA, HEAD)]: () => ({ status: 'ahead' }),
    ...overrides,
  });

describe('checkOnce with a cancelled CI run', () => {
  it('reports a run cancelled before its gate ran as cancelled, not red', async () => {
    const { api } = fakeApi(cancelledCi());
    const result = await checkOnce({ api, repo: REPO, sha: SHA, require: REQUIRE });
    expect(result.state).toBe('cancelled');
    expect(result.cancelled).toEqual(['ci.yml']);
  });

  it('reports a gate job cancelled or skipped in a cancelled run as cancelled', async () => {
    for (const conclusion of ['cancelled', 'skipped']) {
      const { api } = fakeApi(
        cancelledCi({
          [jobsPath(11)]: () => ({ jobs: [job('ci-gate', 'completed', conclusion)] }),
        }),
      );
      const result = await checkOnce({ api, repo: REPO, sha: SHA, require: REQUIRE });
      expect(result.state).toBe('cancelled');
    }
  });

  it('stays red when a gate failed, even if another run was cancelled', async () => {
    const { api } = fakeApi(
      cancelledCi({
        [jobsPath(22)]: () => ({ jobs: [job('security-gate', 'completed', 'failure')] }),
      }),
    );
    const result = await checkOnce({ api, repo: REPO, sha: SHA, require: REQUIRE });
    expect(result.state).toBe('red');
  });

  it('stays red for a gate that failed in a run cancelled afterwards', async () => {
    const { api } = fakeApi(
      cancelledCi({ [jobsPath(11)]: () => ({ jobs: [job('ci-gate', 'completed', 'failure')] }) }),
    );
    const result = await checkOnce({ api, repo: REPO, sha: SHA, require: REQUIRE });
    expect(result.state).toBe('red');
  });
});

describe('waitForGreen with supersededOk', () => {
  it("ends as superseded when this commit's CI was cancelled and main moved on past it", async () => {
    const clock = fakeClock();
    const { api } = fakeApi(cancelledCi());
    const result = await waitForGreen(opts(api, clock, { supersededOk: true }));
    expect(result.ok).toBe(false);
    expect(result.superseded).toBe(true);
    expect(result.head).toBe(HEAD);
  });

  it('fails without the option (the default stays fail-closed)', async () => {
    const clock = fakeClock();
    const { api } = fakeApi(cancelledCi());
    const result = await waitForGreen(opts(api, clock));
    expect(result.ok).toBe(false);
    expect(result.superseded).toBeFalsy();
  });

  it('fails when this commit is still the head of main (a cancel, not a supersede)', async () => {
    const clock = fakeClock();
    const { api } = fakeApi(cancelledCi({ [headPath]: () => ({ sha: SHA }) }));
    const result = await waitForGreen(opts(api, clock, { supersededOk: true }));
    expect(result.ok).toBe(false);
    expect(result.superseded).toBeFalsy();
  });

  it('fails when the head of main does not descend from this commit', async () => {
    for (const status of ['diverged', 'behind', 'identical']) {
      const clock = fakeClock();
      const { api } = fakeApi(cancelledCi({ [comparePath(SHA, HEAD)]: () => ({ status }) }));
      const result = await waitForGreen(opts(api, clock, { supersededOk: true }));
      expect(result.ok).toBe(false);
      expect(result.superseded).toBeFalsy();
    }
  });

  it('fails when the head of main cannot be read', async () => {
    const clock = fakeClock();
    const { api } = fakeApi(cancelledCi({ [headPath]: () => ({ sha: 'not-a-sha' }) }));
    const result = await waitForGreen(opts(api, clock, { supersededOk: true }));
    expect(result.ok).toBe(false);
    expect(result.superseded).toBeFalsy();
  });

  it('is still red, not superseded, when a gate failed', async () => {
    const clock = fakeClock();
    const { api } = fakeApi(
      cancelledCi({
        [jobsPath(22)]: () => ({ jobs: [job('security-gate', 'completed', 'failure')] }),
      }),
    );
    const result = await waitForGreen(opts(api, clock, { supersededOk: true }));
    expect(result.ok).toBe(false);
    expect(result.superseded).toBeFalsy();
  });

  it("still returns ok for green CI, whatever main's head is", async () => {
    const clock = fakeClock();
    const { api } = fakeApi(greenRoutes());
    const result = await waitForGreen(opts(api, clock, { supersededOk: true }));
    expect(result.ok).toBe(true);
  });
});

describe('run (the command line)', () => {
  const ENV = { GH_TOKEN: 'x', GITHUB_REPOSITORY: REPO, GITHUB_SHA: SHA };
  const ARGV = ['--require', 'ci.yml:ci-gate', '--require', 'security.yml:security-gate'];
  const invoke = async (routes, { argv = ARGV, output = true } = {}) => {
    const lines = [];
    const outputs = [];
    const clock = fakeClock();
    const { api } = fakeApi(routes);
    const code = await runCommand({
      argv,
      env: ENV,
      api,
      log: (line) => lines.push(line),
      writeOutput: output ? (line) => outputs.push(line) : undefined,
      now: clock.now,
      sleep: clock.sleep,
    });
    return { code, lines: lines.join('\n'), outputs };
  };

  it('writes result=green and exits 0 for green CI', async () => {
    const result = await invoke(greenRoutes());
    expect(result.code).toBe(0);
    expect(result.outputs).toEqual(['result=green']);
  });

  it('exits 1 with no output for red CI', async () => {
    const result = await invoke(
      greenRoutes({ [jobsPath(11)]: () => ({ jobs: [job('ci-gate', 'completed', 'failure')] }) }),
    );
    expect(result.code).toBe(1);
    expect(result.outputs).toEqual([]);
    expect(result.lines).toMatch(/::error::CI of this commit is not green/);
  });

  it('writes result=superseded and exits 0, with a notice naming the new head', async () => {
    const result = await invoke(cancelledCi(), { argv: [...ARGV, '--superseded-ok'] });
    expect(result.code).toBe(0);
    expect(result.outputs).toEqual(['result=superseded']);
    expect(result.lines).toMatch(/::notice::.*superseded/i);
    expect(result.lines).toContain(HEAD);
    expect(result.lines).not.toMatch(/::error::/);
  });

  it('fails a cancelled run without --superseded-ok', async () => {
    const result = await invoke(cancelledCi());
    expect(result.code).toBe(1);
    expect(result.outputs).toEqual([]);
  });

  it('refuses --superseded-ok without a step output to carry the result', async () => {
    const result = await invoke(cancelledCi(), {
      argv: [...ARGV, '--superseded-ok'],
      output: false,
    });
    expect(result.code).toBe(1);
  });
});

describe('parseArgs --superseded-ok', () => {
  it('is a flag without a value, off by default', () => {
    expect(parseArgs(['--require', 'ci.yml:ci-gate']).supersededOk).toBe(false);
    const parsed = parseArgs(['--superseded-ok', '--require', 'ci.yml:ci-gate']);
    expect(parsed.supersededOk).toBe(true);
    expect(parsed.require).toEqual([{ workflow: 'ci.yml', job: 'ci-gate' }]);
  });
});

// Every workflow that waits for CI gates its next job on `result == 'green'`: a superseded
// (exit 0) ci-green must never let a deploy or a release through.
describe('workflows that wait for CI', () => {
  const read = (name) =>
    readFileSync(resolve(import.meta.dirname, `../../.github/workflows/${name}`), 'utf8');
  const jobOf = (source, name) => {
    const start = source.indexOf(`\n  ${name}:\n`);
    if (start < 0) return '';
    const rest = source.slice(start + 1);
    const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
    return next < 0 ? rest : rest.slice(0, next + 2);
  };
  const jobsOf = (source) =>
    [...source.slice(source.indexOf('\njobs:\n')).matchAll(/\n {2}([a-z][a-z0-9-]*):\n/g)].map(
      (m) => m[1],
    );

  for (const name of ['release.yml', 'deploy-submitter.yml', 'deploy-drop.yml']) {
    it(`${name}: ci-green publishes its result and guard requires it to be green`, () => {
      const source = read(name);
      const ciGreen = jobOf(source, 'ci-green');
      expect(ciGreen).toMatch(/--superseded-ok/);
      expect(ciGreen).toMatch(/outputs:\n {6}result: \$\{\{ steps\.wait\.outputs\.result \}\}/);
      expect(ciGreen).toMatch(/id: wait\n/);
      const guard = jobOf(source, 'guard');
      expect(guard).toMatch(/needs: ci-green\n/);
      expect(guard).toMatch(/\n {4}if: .*needs\.ci-green\.outputs\.result == 'green'/);
      // Every other job reaches ci-green only through guard (catch-up only dispatches).
      for (const other of jobsOf(source)) {
        if (['ci-green', 'guard', 'catch-up'].includes(other)) continue;
        expect(jobOf(source, other)).not.toMatch(/needs:.*ci-green/);
      }
    });
  }
});
