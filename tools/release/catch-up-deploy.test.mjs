import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { catchUp, parseArgs, run } from './catch-up-deploy.mjs';

// CHORE-CI-SUPERSEDED: a deploy run that does not deploy its commit (its CI was superseded or
// failed, its production step found a newer commit that changes the service, or a job was
// cancelled) makes sure main's head still gets deployed. The dispatched run is an ordinary run of
// the same workflow on main: it waits for the head's own green CI, deploys staging, smokes, and
// deploys production behind the same environment, freeze and head checks.
//
// OPS-UNSTICK-A: (1) a run "covers" main's head when it is still going and its commit already
// contains the newest commit that changes this service (it will deploy exactly what main's head
// builds for the service), or when it finished successfully for main's head itself; (2) a cancelled
// job (GitHub keeps one pending job per concurrency group and cancels the older one) is handled too;
// (3) when nothing covers main's head and nothing can be dispatched, the command fails, so a run that
// left production behind is red, never silently green.

const REPO = '4thtech/agentlink';
const SHA = 'a'.repeat(40); // this run's commit
const SERVICE = 'b'.repeat(40); // a newer commit that changes the service
const HEAD = 'c'.repeat(40); // main's head (a docs commit)
const NEWER = 'd'.repeat(40); // pushed after this job fetched main: unknown locally
const ORDER = [SHA, SERVICE, HEAD];
const WORKFLOW = 'deploy-submitter.yml';
const runsPath = `/repos/${REPO}/actions/workflows/${WORKFLOW}/runs`;
const dispatchPath = `/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`;
const SPECS = [':(glob)apps/submitter/**'];

const wfRun = (id, overrides = {}) => ({
  id,
  head_sha: HEAD,
  head_branch: 'main',
  event: 'push',
  path: `.github/workflows/${WORKFLOW}`,
  status: 'in_progress',
  ...overrides,
});

function fakeApi(routes) {
  const calls = [];
  const api = async (pathWithQuery, init = {}) => {
    calls.push({ path: pathWithQuery, method: init.method ?? 'GET', body: init.body });
    const path = pathWithQuery.split('?')[0];
    const route = routes[path];
    if (!route) throw new Error(`unexpected API path ${path}`);
    return route(init);
  };
  return { api, calls };
}

/** A linear main SHA -> SERVICE -> HEAD; `last` is the newest commit that changes the service. */
function fakeGit({ head = HEAD, last = SERVICE } = {}) {
  return {
    head: () => (typeof head === 'function' ? head() : head),
    lastTouch: () => last,
    contains: (sha, ancestor) => {
      const a = ORDER.indexOf(sha);
      const b = ORDER.indexOf(ancestor);
      if (a < 0 || b < 0) return null;
      return a >= b;
    },
  };
}

const routes = (overrides = {}) => ({
  [runsPath]: () => ({ workflow_runs: [] }),
  [dispatchPath]: () => undefined,
  ...overrides,
});
const withRuns = (...runs) => routes({ [runsPath]: () => ({ workflow_runs: runs }) });

const dispatched = (calls) => calls.filter((c) => c.method === 'POST');

describe('catchUp', () => {
  const go = (r, { git = fakeGit(), cancelled = false, event = 'push', runId = 1 } = {}) => {
    const { api, calls } = fakeApi(r);
    const lines = [];
    const summary = [];
    return catchUp({
      api,
      git,
      repo: REPO,
      sha: SHA,
      runId,
      event,
      cancelled,
      workflow: WORKFLOW,
      specs: SPECS,
      log: (l) => lines.push(l),
      summary: (l) => summary.push(l),
    }).then((result) => ({
      result,
      calls,
      lines: lines.join('\n'),
      summary: summary.join('\n'),
    }));
  };

  it("dispatches the workflow on main when no run covers main's head", async () => {
    const { result, calls, lines, summary } = await go(routes());
    expect(result).toEqual({ action: 'dispatched', head: HEAD });
    const posts = dispatched(calls);
    expect(posts).toHaveLength(1);
    expect(posts[0].path).toBe(dispatchPath);
    expect(posts[0].body).toEqual({ ref: 'main' });
    expect(lines).toMatch(/::notice::/);
    expect(lines).toContain(HEAD);
    expect(summary).toMatch(/Superseded by `c{40}`/);
    expect(summary).toMatch(/deploying there/);
  });

  it('asks for the recent runs of this workflow on main', async () => {
    const { calls } = await go(routes());
    const query = new URLSearchParams(
      calls.find((c) => c.path.startsWith(runsPath)).path.split('?')[1],
    );
    expect(query.get('branch')).toBe('main');
  });

  it('is covered by a live push or dispatch run whose commit contains the newest service change', async () => {
    for (const event of ['push', 'workflow_dispatch']) {
      for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
        for (const head_sha of [SERVICE, HEAD, NEWER]) {
          const { result, calls, summary } = await go(
            withRuns(wfRun(7, { event, status, head_sha })),
          );
          expect(result).toEqual({ action: 'covered', head: HEAD, runId: 7 });
          expect(dispatched(calls)).toHaveLength(0);
          expect(summary).toContain('7');
          expect(summary).toContain(head_sha);
          expect(summary).toMatch(/deploying there/);
        }
      }
    }
  });

  it('is not covered by a live run of a commit older than the newest service change', async () => {
    const { result, calls } = await go(withRuns(wfRun(7, { head_sha: SHA })));
    expect(result.action).toBe('dispatched');
    expect(dispatched(calls)).toHaveLength(1);
  });

  it("is covered by a successful run for main's head, not by one for an older commit", async () => {
    const done = { status: 'completed', conclusion: 'success' };
    expect((await go(withRuns(wfRun(7, done)))).result.action).toBe('covered');
    // A finished run of an older commit may have deployed nothing (superseded); do not trust it.
    expect((await go(withRuns(wfRun(7, { ...done, head_sha: SERVICE })))).result.action).toBe(
      'dispatched',
    );
  });

  // CHORE-DEPLOY-CATCHUP: a finished run that did not succeed does not deploy the head.
  it('never counts a finished run that did not succeed', async () => {
    for (const conclusion of [
      'failure',
      'cancelled',
      'timed_out',
      'startup_failure',
      'action_required',
      null,
    ]) {
      const { result, calls } = await go(withRuns(wfRun(7, { status: 'completed', conclusion })));
      expect(result.action).toBe('dispatched');
      expect(dispatched(calls)).toHaveLength(1);
    }
  });

  it('counts a live run even next to a failed one', async () => {
    const { result } = await go(
      withRuns(wfRun(6, { status: 'completed', conclusion: 'failure' }), wfRun(8)),
    );
    expect(result).toEqual({ action: 'covered', head: HEAD, runId: 8 });
  });

  it('ignores this run itself and runs of another branch, event, workflow file or a bad SHA', async () => {
    const others = [
      wfRun(1),
      wfRun(2, { head_branch: 'feature' }),
      wfRun(3, { event: 'pull_request' }),
      wfRun(4, { path: '.github/workflows/deploy-drop.yml' }),
      wfRun(5, { head_sha: 'not-a-sha' }),
    ];
    const { result, calls } = await go(withRuns(...others), { runId: 1 });
    expect(result.action).toBe('dispatched');
    expect(dispatched(calls)).toHaveLength(1);
  });

  describe("when this commit is main's head", () => {
    const atHead = fakeGit({ head: SHA, last: SHA });

    it('fails (stranded) when its CI was not green and nothing else covers it', async () => {
      const { result, calls, lines, summary } = await go(routes(), { git: atHead });
      expect(result).toEqual({ action: 'stranded', head: SHA });
      expect(dispatched(calls)).toHaveLength(0);
      expect(lines).toMatch(/::error::/);
      expect(summary).toMatch(/Not deployed/);
      expect(summary).toContain(SHA);
    });

    it('dispatches once when a push run was cancelled (a pending job replaced in its group)', async () => {
      const { result, calls } = await go(routes(), { git: atHead, cancelled: true });
      expect(result).toEqual({ action: 'dispatched', head: SHA });
      expect(dispatched(calls)).toHaveLength(1);
    });

    it('does not dispatch again for a cancelled dispatched run (no loop): fails instead', async () => {
      const { result, calls } = await go(routes(), {
        git: atHead,
        cancelled: true,
        event: 'workflow_dispatch',
      });
      expect(result.action).toBe('stranded');
      expect(dispatched(calls)).toHaveLength(0);
    });

    it('is still covered by another live run for the head', async () => {
      const { result } = await go(withRuns(wfRun(9, { head_sha: SHA })), { git: atHead });
      expect(result).toEqual({ action: 'covered', head: SHA, runId: 9 });
    });
  });

  it('throws, dispatching nothing, when the head of main cannot be read', async () => {
    await expect(go(routes(), { git: fakeGit({ head: 'nope' }) })).rejects.toThrow(/head of main/);
    await expect(
      go(routes(), {
        git: fakeGit({
          head: () => {
            throw new Error('git failed');
          },
        }),
      }),
    ).rejects.toThrow();
  });
});

describe('run (the command line)', () => {
  const ENV = {
    GH_TOKEN: 'x',
    GITHUB_REPOSITORY: REPO,
    GITHUB_SHA: SHA,
    GITHUB_RUN_ID: '1',
    GITHUB_EVENT_NAME: 'push',
  };
  const cwd = resolve(import.meta.dirname, '../..');
  const invoke = async (
    r,
    { argv = ['--workflow', WORKFLOW], env = ENV, git = fakeGit() } = {},
  ) => {
    const { api, calls } = fakeApi(r);
    const lines = [];
    const code = await run({ argv, env, api, git, cwd, log: (l) => lines.push(l) });
    return { code, calls, lines: lines.join('\n') };
  };

  it('exits 0 after a dispatch and when another run covers the head', async () => {
    expect((await invoke(routes())).code).toBe(0);
    const found = await invoke(withRuns(wfRun(9)));
    expect(found.code).toBe(0);
    expect(dispatched(found.calls)).toHaveLength(0);
  });

  it("exits 1 when nothing will deploy main's head", async () => {
    const result = await invoke(routes(), { git: fakeGit({ head: SHA, last: SHA }) });
    expect(result.code).toBe(1);
    expect(result.lines).toMatch(/::error::/);
  });

  it('reads a cancelled job from DEPLOY_CANCELLED', async () => {
    const result = await invoke(routes(), {
      env: { ...ENV, DEPLOY_CANCELLED: 'true' },
      git: fakeGit({ head: SHA, last: SHA }),
    });
    expect(result.code).toBe(0);
    expect(dispatched(result.calls)).toHaveLength(1);
  });

  it('exits 1 with an error when the API fails, and never prints the token', async () => {
    const result = await invoke(
      routes({
        [dispatchPath]: () => {
          throw new Error('HTTP 403 for /dispatches');
        },
      }),
      { env: { ...ENV, GH_TOKEN: 'secret-token-value' } },
    );
    expect(result.code).toBe(1);
    expect(result.lines).toMatch(/::error::/);
    expect(result.lines).not.toContain('secret-token-value');
  });

  describe('run summary', () => {
    const withSummary = async (r, opts = {}) => {
      const file = join(mkdtempSync(join(tmpdir(), 'catch-up-')), 'summary');
      writeFileSync(file, '');
      const result = await invoke(r, { ...opts, env: { ...ENV, GITHUB_STEP_SUMMARY: file } });
      return { ...result, summary: readFileSync(file, 'utf8') };
    };

    it('names the commit and the run that deploys instead', async () => {
      const { code, summary } = await withSummary(withRuns(wfRun(4242)));
      expect(code).toBe(0);
      expect(summary).toMatch(/Superseded by/);
      expect(summary).toContain(HEAD);
      expect(summary).toContain('4242');
    });

    it("says a new run was dispatched for main's head", async () => {
      const { summary } = await withSummary(routes());
      expect(summary).toMatch(/Superseded by/);
      expect(summary).toContain(HEAD);
      expect(summary).toMatch(/dispatched/);
    });

    it('says production stays behind when nothing deploys the head', async () => {
      const { summary } = await withSummary(routes(), { git: fakeGit({ head: SHA, last: SHA }) });
      expect(summary).toMatch(/production keeps the previous version/);
      expect(summary).toContain(SHA);
    });

    it('works without a summary file', async () => {
      expect((await invoke(routes())).code).toBe(0);
    });
  });

  it('refuses a missing or malformed environment', async () => {
    expect((await invoke(routes(), { env: { ...ENV, GITHUB_SHA: 'x' } })).code).toBe(1);
    expect((await invoke(routes(), { env: { ...ENV, GH_TOKEN: '' } })).code).toBe(1);
    expect((await invoke(routes(), { env: { ...ENV, GITHUB_RUN_ID: 'x' } })).code).toBe(1);
  });
});

describe('parseArgs', () => {
  it('needs exactly one workflow file name', () => {
    expect(parseArgs(['--workflow', 'deploy-drop.yml'])).toEqual({ workflow: 'deploy-drop.yml' });
    for (const bad of [
      [],
      ['--workflow'],
      ['--workflow', '../x.yml'],
      ['--workflow', 'x.sh'],
      ['--bogus', 'x'],
    ]) {
      expect(() => parseArgs(bad)).toThrow();
    }
  });
});

// The `catch-up` job of every deploy workflow.
const CATCH_UP_WORKFLOWS = ['deploy-submitter.yml', 'deploy-drop.yml', 'deploy-invite.yml'];
describe.each(CATCH_UP_WORKFLOWS)('%s catch-up job', (file) => {
  const source = readFileSync(
    resolve(import.meta.dirname, `../../.github/workflows/${file}`),
    'utf8',
  );
  const jobOf = (name) => {
    const start = source.indexOf(`\n  ${name}:\n`);
    if (start < 0) return '';
    const rest = source.slice(start + 1);
    const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
    return next < 0 ? rest : rest.slice(0, next + 2);
  };
  const catchUpJob = jobOf('catch-up');
  const condition = catchUpJob.slice(
    catchUpJob.indexOf('\n    if:'),
    catchUpJob.indexOf('\n    runs-on:'),
  );

  it('exists, with a timeout, after every job that can leave production behind', () => {
    expect(catchUpJob).not.toBe('');
    expect(catchUpJob).toMatch(/timeout-minutes: \d+/);
    expect(catchUpJob).toMatch(
      /needs: \[ci-green, build, deploy-staging, smoke-staging, deploy-production\]/,
    );
    expect(condition).toMatch(/always\(\)/);
    expect(condition).toMatch(/github\.repository == '4thtech\/agentlink'/);
    expect(condition).toMatch(/github\.ref == 'refs\/heads\/main'/);
    expect(condition).toMatch(/needs\.ci-green\.outputs\.result == 'superseded'/);
    expect(condition).toMatch(/needs\.deploy-production\.outputs\.current == 'false'/);
  });

  // CHORE-DEPLOY-CATCHUP: a ci-green failure (a flake on this commit) also hands off.
  it("also runs when this commit's CI failed", () => {
    expect(condition).toMatch(/needs\.ci-green\.result == 'failure'/);
  });

  // OPS-UNSTICK-A: 10 deploy-drop runs in a row ended with deploy-production `cancelled` and the
  // catch-up job skipped. Any cancelled job now hands off too, and the job says so to the tool.
  it('also runs when any job it needs was cancelled, and tells the tool', () => {
    expect(condition).toMatch(/contains\(needs\.\*\.result, 'cancelled'\)/);
    expect(catchUpJob).toMatch(
      /DEPLOY_CANCELLED: \$\{\{ contains\(needs\.\*\.result, 'cancelled'\) \}\}/,
    );
  });

  it('reads the full history of main (path-aware coverage)', () => {
    expect(catchUpJob).toMatch(/fetch-depth: 0/);
  });

  it('dispatches this same workflow with only actions: write and contents: read, no environment or secrets', () => {
    expect(catchUpJob).toMatch(/permissions:\n {6}actions: write\b[^\n]*\n {6}contents: read\n/);
    expect(catchUpJob).not.toMatch(/environment:|secrets\.|id-token/);
    expect(catchUpJob).toContain(`node tools/release/catch-up-deploy.mjs --workflow ${file}`);
    expect(catchUpJob).toMatch(/GH_TOKEN: \$\{\{ github\.token \}\}/);
  });

  it('is the only job that may write actions', () => {
    const writers = [...source.matchAll(/\n {2}([a-z][a-z0-9-]*):\n/g)]
      .map((m) => m[1])
      .filter((name) => /actions: write/.test(jobOf(name)));
    expect(writers).toEqual(['catch-up']);
  });

  it("deploy-production publishes whether this run deploys main's state for the service", () => {
    const production = jobOf('deploy-production');
    expect(production).toMatch(
      /outputs:\n(?: {6}.*\n)* {6}current: \$\{\{ steps\.head\.outputs\.current \}\}\n/,
    );
    expect(production).toContain(
      `node tools/release/deploy-paths.mjs head-check --workflow ${file}`,
    );
    expect(production).toMatch(/fetch-depth: 0/);
  });

  // OPS-UNSTICK-A: no approval wait any more, but a production deploy in flight is never cancelled
  // (a cancel after the deploy started would roll back and set DEPLOY_FREEZE).
  it('serializes production deploys without cancelling one in flight', () => {
    expect(jobOf('deploy-production')).toMatch(
      /concurrency:\n {6}group: deploy-[a-z]+-production\n {6}cancel-in-progress: false\n/,
    );
  });
});
