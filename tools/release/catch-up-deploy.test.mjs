import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { catchUp, parseArgs, run } from './catch-up-deploy.mjs';

// CHORE-CI-SUPERSEDED: a deploy run that does not deploy its commit because main moved on (its CI
// was superseded, or its production step found a newer head) makes sure main's head still gets a
// deploy run. The newer commit may not touch the workflow's paths, so no push run exists for it
// (52613475's submitter fix was never deployed this way). The dispatched run is an ordinary run of
// the same workflow on main: it waits for the head's own green CI, deploys staging, smokes, and
// deploys production behind the same environment, freeze and head-of-main gates.

const REPO = '4thtech/agentlink';
const SHA = 'a'.repeat(40);
const HEAD = 'c'.repeat(40);
const WORKFLOW = 'deploy-submitter.yml';
const headPath = `/repos/${REPO}/commits/main`;
const runsPath = `/repos/${REPO}/actions/workflows/${WORKFLOW}/runs`;
const dispatchPath = `/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`;

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

const routes = (overrides = {}) => ({
  [headPath]: () => ({ sha: HEAD }),
  [runsPath]: () => ({ workflow_runs: [] }),
  [dispatchPath]: () => undefined,
  ...overrides,
});

const dispatched = (calls) => calls.filter((c) => c.method === 'POST');

describe('catchUp', () => {
  const go = (r) => {
    const { api, calls } = fakeApi(r);
    const lines = [];
    return catchUp({
      api,
      repo: REPO,
      sha: SHA,
      workflow: WORKFLOW,
      log: (l) => lines.push(l),
    }).then((result) => ({ result, calls, lines: lines.join('\n') }));
  };

  it('dispatches the workflow on main when no run exists for the head of main', async () => {
    const { result, calls, lines } = await go(routes());
    expect(result).toEqual({ action: 'dispatched', head: HEAD });
    const posts = dispatched(calls);
    expect(posts).toHaveLength(1);
    expect(posts[0].path).toBe(dispatchPath);
    expect(posts[0].body).toEqual({ ref: 'main' });
    expect(lines).toMatch(/::notice::/);
    expect(lines).toContain(HEAD);
  });

  it('asks only for runs of the head commit on main', async () => {
    const { calls } = await go(routes());
    const query = new URLSearchParams(
      calls.find((c) => c.path.startsWith(runsPath)).path.split('?')[1],
    );
    expect(query.get('head_sha')).toBe(HEAD);
    expect(query.get('branch')).toBe('main');
  });

  it('does nothing when a push or dispatch run of this workflow already handles the head', async () => {
    for (const event of ['push', 'workflow_dispatch']) {
      for (const status of ['queued', 'in_progress', 'completed']) {
        const { result, calls } = await go(
          routes({ [runsPath]: () => ({ workflow_runs: [wfRun(7, { event, status })] }) }),
        );
        expect(result.action).toBe('none');
        expect(dispatched(calls)).toHaveLength(0);
      }
    }
  });

  it('ignores runs of another commit, branch, event or workflow file', async () => {
    const others = [
      wfRun(1, { head_sha: SHA }),
      wfRun(2, { head_branch: 'feature' }),
      wfRun(3, { event: 'pull_request' }),
      wfRun(4, { path: '.github/workflows/deploy-drop.yml' }),
    ];
    const { result, calls } = await go(routes({ [runsPath]: () => ({ workflow_runs: others }) }));
    expect(result.action).toBe('dispatched');
    expect(dispatched(calls)).toHaveLength(1);
  });

  it('does nothing when this commit is still the head of main', async () => {
    const { result, calls } = await go(routes({ [headPath]: () => ({ sha: SHA }) }));
    expect(result.action).toBe('none');
    expect(dispatched(calls)).toHaveLength(0);
  });

  it('throws, dispatching nothing, when the head of main cannot be read', async () => {
    await expect(go(routes({ [headPath]: () => ({ sha: 'nope' }) }))).rejects.toThrow(
      /head of main/,
    );
    await expect(
      go(
        routes({
          [headPath]: () => {
            throw new Error('HTTP 502');
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('run (the command line)', () => {
  const ENV = { GH_TOKEN: 'x', GITHUB_REPOSITORY: REPO, GITHUB_SHA: SHA };
  const invoke = async (r, { argv = ['--workflow', WORKFLOW], env = ENV } = {}) => {
    const { api, calls } = fakeApi(r);
    const lines = [];
    const code = await run({ argv, env, api, log: (l) => lines.push(l) });
    return { code, calls, lines: lines.join('\n') };
  };

  it('exits 0 after a dispatch and after finding a run', async () => {
    expect((await invoke(routes())).code).toBe(0);
    const found = await invoke(routes({ [runsPath]: () => ({ workflow_runs: [wfRun(9)] }) }));
    expect(found.code).toBe(0);
    expect(dispatched(found.calls)).toHaveLength(0);
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

  it('refuses a missing or malformed environment', async () => {
    expect((await invoke(routes(), { env: { ...ENV, GITHUB_SHA: 'x' } })).code).toBe(1);
    expect((await invoke(routes(), { env: { ...ENV, GH_TOKEN: '' } })).code).toBe(1);
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

// The `catch-up` job of both deploy workflows.
describe.each(['deploy-submitter.yml', 'deploy-drop.yml'])('%s catch-up job', (file) => {
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

  it('exists, with a timeout, and runs only after main moved on', () => {
    expect(catchUpJob).not.toBe('');
    expect(catchUpJob).toMatch(/timeout-minutes: \d+/);
    expect(catchUpJob).toMatch(/needs: \[ci-green, deploy-production\]/);
    const condition = catchUpJob.slice(
      catchUpJob.indexOf('\n    if:'),
      catchUpJob.indexOf('\n    runs-on:'),
    );
    expect(condition).toMatch(/always\(\)/);
    expect(condition).toMatch(/github\.repository == '4thtech\/agentlink'/);
    expect(condition).toMatch(/github\.ref == 'refs\/heads\/main'/);
    expect(condition).toMatch(/needs\.ci-green\.outputs\.result == 'superseded'/);
    expect(condition).toMatch(/needs\.deploy-production\.outputs\.current == 'false'/);
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

  it('deploy-production publishes whether this commit was still the head of main', () => {
    expect(jobOf('deploy-production')).toMatch(
      /outputs:\n(?: {6}.*\n)* {6}current: \$\{\{ steps\.head\.outputs\.current \}\}\n/,
    );
  });
});
