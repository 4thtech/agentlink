import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEPLOY_STEP,
  MAX_ATTEMPTS,
  REQUIRED_GATES,
  deployedCommit,
  parseArgs,
  pathMatches,
  pushPaths,
  reconcile,
  run,
} from './reconcile-deploy.mjs';
import { runScripts } from './workflow-run-steps.mjs';

// CHORE-DEPLOY-RECONCILE: a scheduled reconcile closes what the catch-up job (CHORE-DEPLOY-CATCHUP,
// #447) leaves open. When the head of main's CI flakes while it is still the head, its deploy run
// ends at ci-green and its catch-up finds itself at the head; later merges that do not touch the
// deploy paths start no deploy run, so production could lag indefinitely. Every hour the reconcile
// compares, per service, the commit production runs (the newest run whose deploy-production job
// deployed) with main's head, and when a commit in between touched the service's paths, main's
// head has green CI and no run for it is in flight, it dispatches the normal deploy workflow on
// main (at most MAX_ATTEMPTS runs per head). The dispatched run passes every gate itself.

const root = resolve(import.meta.dirname, '../..');
const read = (name) => readFileSync(resolve(root, '.github/workflows', name), 'utf8');

const REPO = '4thtech/agentlink';
const HEAD = 'c'.repeat(40);
const DEPLOYED = 'b'.repeat(40);
const WORKFLOW = 'deploy-submitter.yml';
const PATHS = ['apps/submitter/**', 'packages/chain/**', 'pnpm-lock.yaml'];

const headPath = `/repos/${REPO}/commits/main`;
const runsPath = `/repos/${REPO}/actions/workflows/${WORKFLOW}/runs`;
const dispatchPath = `/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`;
const comparePath = `/repos/${REPO}/compare/${DEPLOYED}...${HEAD}`;
const jobsPath = (id) => `/repos/${REPO}/actions/runs/${id}/jobs`;
const gateRunsPath = (wf) => `/repos/${REPO}/actions/workflows/${wf}/runs`;

const wfRun = (id, overrides = {}) => ({
  id,
  head_sha: DEPLOYED,
  head_branch: 'main',
  event: 'push',
  path: `.github/workflows/${WORKFLOW}`,
  status: 'completed',
  conclusion: 'success',
  ...overrides,
});

const deployJob = (deployConclusion = 'success', jobConclusion = 'success') => ({
  name: 'deploy-production',
  status: 'completed',
  conclusion: jobConclusion,
  steps: [
    { name: 'Check that this commit is still the head of main', conclusion: 'success' },
    { name: DEPLOY_STEP, conclusion: deployConclusion },
  ],
});

function fakeApi(routes) {
  const calls = [];
  const api = async (pathWithQuery, init = {}) => {
    calls.push({ path: pathWithQuery, method: init.method ?? 'GET', body: init.body });
    const [path, query = ''] = pathWithQuery.split('?');
    const route = routes[path];
    if (!route) throw new Error(`unexpected API path ${path}`);
    return route(new URLSearchParams(query), init);
  };
  return { api, calls };
}

// Green gates on HEAD: one push run of ci.yml and security.yml each, whose gate job succeeded.
const gateRoutes = (conclusion = 'success') => {
  const out = {};
  REQUIRED_GATES.forEach(({ workflow, job }, i) => {
    const id = 9000 + i;
    out[gateRunsPath(workflow)] = () => ({
      workflow_runs: [
        {
          id,
          head_sha: HEAD,
          head_branch: 'main',
          event: 'push',
          path: `.github/workflows/${workflow}`,
          status: 'completed',
          conclusion,
        },
      ],
    });
    out[jobsPath(id)] = () => ({ jobs: [{ name: job, status: 'completed', conclusion }] });
  });
  return out;
};

// Production runs DEPLOYED (run 100); main's head HEAD touched apps/submitter; no run for HEAD.
const routes = ({ headRuns = [], files = ['apps/submitter/src/index.ts'], ...overrides } = {}) => ({
  [headPath]: () => ({ sha: HEAD }),
  [runsPath]: (q) =>
    q.get('head_sha') === HEAD ? { workflow_runs: headRuns } : { workflow_runs: [wfRun(100)] },
  [jobsPath(100)]: () => ({ jobs: [{ name: 'build', conclusion: 'success' }, deployJob()] }),
  [comparePath]: () => ({ status: 'ahead', files: files.map((filename) => ({ filename })) }),
  [dispatchPath]: () => undefined,
  ...gateRoutes(),
  ...overrides,
});

const dispatched = (calls) => calls.filter((c) => c.method === 'POST');

async function go(r, paths = PATHS) {
  const { api, calls } = fakeApi(r);
  const lines = [];
  const summary = [];
  const result = await reconcile({
    api,
    repo: REPO,
    workflow: WORKFLOW,
    paths,
    log: (l) => lines.push(l),
    summary: (l) => summary.push(l),
  });
  return { result, calls, lines, summary };
}

describe('pushPaths and pathMatches', () => {
  it('reads the push paths filter of each deploy workflow, comments left out', () => {
    for (const name of ['deploy-submitter.yml', 'deploy-drop.yml']) {
      const paths = pushPaths(read(name));
      expect(paths).toContain(`.github/workflows/${name}`);
      expect(paths).toContain('pnpm-lock.yaml');
      expect(paths.some((p) => p.startsWith('#'))).toBe(false);
    }
    expect(pushPaths(read('deploy-submitter.yml'))).toContain('apps/submitter/**');
    expect(pushPaths(read('deploy-drop.yml'))).toContain('apps/drop/**');
    expect(pushPaths('name: x\non:\n  workflow_dispatch:\n')).toBeNull();
  });

  it('matches GitHub filter globs', () => {
    expect(pathMatches(PATHS, 'apps/submitter/src/index.ts')).toBe(true);
    expect(pathMatches(PATHS, 'pnpm-lock.yaml')).toBe(true);
    expect(pathMatches(PATHS, 'apps/drop/src/index.ts')).toBe(false);
    expect(pathMatches(PATHS, 'docs/process/ci-cd.md')).toBe(false);
    expect(pathMatches(['a/*.ts'], 'a/b/c.ts')).toBe(false);
    expect(() => pathMatches(['!apps/**'], 'apps/x')).toThrow(/negated/);
  });
});

describe('deployedCommit', () => {
  it('is the commit of the newest run whose deploy-production job deployed', async () => {
    const { api } = fakeApi({
      [runsPath]: () => ({
        workflow_runs: [
          wfRun(103, { head_sha: 'f'.repeat(40), status: 'completed', conclusion: 'failure' }),
          wfRun(101, { head_sha: 'e'.repeat(40) }),
          wfRun(102, { head_sha: 'd'.repeat(40), conclusion: 'success' }),
          wfRun(104, { head_sha: '9'.repeat(40), event: 'pull_request' }),
        ],
      }),
      // 103 failed at ci-green; 102 skipped production (superseded); 101 deployed.
      [jobsPath(103)]: () => ({ jobs: [{ name: 'ci-green', conclusion: 'failure' }] }),
      [jobsPath(102)]: () => ({ jobs: [deployJob('skipped')] }),
      [jobsPath(101)]: () => ({ jobs: [deployJob()] }),
    });
    expect(await deployedCommit({ api, repo: REPO, workflow: WORKFLOW })).toBe('e'.repeat(40));
  });

  it('does not count a deploy that failed and was rolled back', async () => {
    const { api } = fakeApi({
      [runsPath]: () => ({ workflow_runs: [wfRun(101)] }),
      [jobsPath(101)]: () => ({ jobs: [deployJob('success', 'failure')] }),
    });
    expect(await deployedCommit({ api, repo: REPO, workflow: WORKFLOW })).toBeUndefined();
  });
});

describe('reconcile', () => {
  it('dispatches the deploy workflow on main when a deploy path changed and nothing covers the head', async () => {
    const { result, calls, lines, summary } = await go(routes());
    expect(result).toMatchObject({ action: 'dispatched', head: HEAD, deployed: DEPLOYED });
    expect(dispatched(calls)).toEqual([
      { path: dispatchPath, method: 'POST', body: { ref: 'main' } },
    ]);
    expect(lines.join('\n')).toMatch(/::notice::.*dispatched/);
    expect(summary.join('\n')).toContain(HEAD);
  });

  it('counts a renamed file by its old path too', async () => {
    const r = routes({
      [comparePath]: () => ({
        status: 'ahead',
        files: [{ filename: 'docs/x.md', previous_filename: 'apps/submitter/x.md' }],
      }),
    });
    expect((await go(r)).result.action).toBe('dispatched');
  });

  it('treats a truncated file list (300 files) as touching the paths', async () => {
    const files = Array.from({ length: 300 }, (_, i) => `docs/f${i}.md`);
    expect((await go(routes({ files }))).result.action).toBe('dispatched');
  });

  it('does nothing when production already runs main head', async () => {
    const r = routes({ [headPath]: () => ({ sha: DEPLOYED }) });
    const { result, calls } = await go(r);
    expect(result).toMatchObject({ action: 'none', reason: 'current' });
    expect(dispatched(calls)).toEqual([]);
  });

  it('does nothing when no commit since the deployed one touched the service paths', async () => {
    const { result, calls } = await go(routes({ files: ['docs/process/ci-cd.md'] }));
    expect(result).toMatchObject({ action: 'none', reason: 'current' });
    expect(dispatched(calls)).toEqual([]);
  });

  it('does nothing while the head of main is not green', async () => {
    for (const conclusion of ['failure', null]) {
      const gates = gateRoutes(conclusion ?? 'success');
      if (conclusion === null) {
        // CI still running on the head.
        for (const k of Object.keys(gates)) {
          if (k.endsWith('/jobs')) gates[k] = () => ({ jobs: [{ name: 'ci-gate', status: 'in_progress' }] });
        }
      }
      const { result, calls } = await go({ ...routes(), ...gates });
      expect(result.action).toBe('none');
      expect(result.reason).toMatch(/^head-ci-/);
      expect(dispatched(calls)).toEqual([]);
    }
  });

  it('does nothing while a run for the head is in flight (queued, running or waiting for approval)', async () => {
    for (const status of ['queued', 'in_progress', 'waiting']) {
      const headRuns = [wfRun(200, { head_sha: HEAD, status, conclusion: null })];
      const { result, calls } = await go(routes({ headRuns }));
      expect(result).toMatchObject({ action: 'none', reason: 'in-flight', runId: 200 });
      expect(dispatched(calls)).toEqual([]);
    }
  });

  it('retries a failed run for the head once, then stops at MAX_ATTEMPTS with a warning', async () => {
    const failed = (id) =>
      wfRun(id, { head_sha: HEAD, event: 'workflow_dispatch', conclusion: 'failure' });
    expect(MAX_ATTEMPTS).toBe(2);
    expect((await go(routes({ headRuns: [failed(200)] }))).result.action).toBe('dispatched');
    const { result, calls, lines } = await go(routes({ headRuns: [failed(200), failed(201)] }));
    expect(result).toMatchObject({ action: 'none', reason: 'attempts' });
    expect(dispatched(calls)).toEqual([]);
    expect(lines.join('\n')).toMatch(/::warning::/);
  });

  it('ignores runs for the head on other branches or from other events', async () => {
    const headRuns = [
      wfRun(300, { head_sha: HEAD, head_branch: 'feature', status: 'in_progress' }),
      wfRun(301, { head_sha: HEAD, event: 'pull_request', status: 'in_progress' }),
    ];
    expect((await go(routes({ headRuns }))).result.action).toBe('dispatched');
  });

  it('does nothing when the deployed commit is not an ancestor of the head', async () => {
    const r = routes({ [comparePath]: () => ({ status: 'diverged', files: [] }) });
    const { result, calls } = await go(r);
    expect(result).toMatchObject({ action: 'none', reason: 'not-ahead' });
    expect(dispatched(calls)).toEqual([]);
  });

  it('does nothing when no production deploy is found', async () => {
    const r = routes({ [jobsPath(100)]: () => ({ jobs: [deployJob('skipped')] }) });
    const { result, calls } = await go(r);
    expect(result).toMatchObject({ action: 'none', reason: 'unknown' });
    expect(dispatched(calls)).toEqual([]);
  });

  it('throws when the head of main cannot be read', async () => {
    await expect(go(routes({ [headPath]: () => ({ sha: 'nope' }) }))).rejects.toThrow(/head of main/);
  });
});

describe('run (command line)', () => {
  const env = {
    GH_TOKEN: 'test-token-not-real',
    GITHUB_REPOSITORY: REPO,
    GITHUB_SHA: HEAD,
  };
  const readWorkflow = (name) => `name: x\non:\n  push:\n    branches: [main]\n    paths:\n      - "apps/submitter/**"\n      - ".github/workflows/${name}"\n`;

  it('parses one or more --workflow arguments and refuses anything else', () => {
    expect(parseArgs(['--workflow', 'deploy-submitter.yml', '--workflow', 'deploy-drop.yml'])).toEqual({
      workflows: ['deploy-submitter.yml', 'deploy-drop.yml'],
    });
    for (const argv of [[], ['--workflow'], ['--workflow', '../x.yml'], ['--other', 'a.yml']]) {
      expect(() => parseArgs(argv)).toThrow(/usage/);
    }
  });

  it('does nothing at all while DEPLOY_FREEZE is set', async () => {
    const { api, calls } = fakeApi(routes());
    const lines = [];
    const code = await run({
      argv: ['--workflow', WORKFLOW],
      env: { ...env, DEPLOY_FREEZE: 'true' },
      api,
      log: (l) => lines.push(l),
      readWorkflow,
    });
    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(lines.join('\n')).toMatch(/DEPLOY_FREEZE/);
  });

  it('dispatches at most once per workflow per run and never prints the token', async () => {
    const { api, calls } = fakeApi(routes());
    const lines = [];
    const code = await run({ argv: ['--workflow', WORKFLOW], env, api, log: (l) => lines.push(l), readWorkflow });
    expect(code).toBe(0);
    expect(dispatched(calls)).toHaveLength(1);
    expect(lines.join('\n')).not.toContain(env.GH_TOKEN);
  });

  it('exits 1 when a workflow has no push paths filter or the API fails', async () => {
    const { api } = fakeApi(routes());
    const log = () => {};
    expect(
      await run({ argv: ['--workflow', WORKFLOW], env, api, log, readWorkflow: () => 'on:\n  workflow_dispatch:\n' }),
    ).toBe(1);
    const failing = async () => {
      throw new Error('HTTP 500 for /x');
    };
    expect(await run({ argv: ['--workflow', WORKFLOW], env, api: failing, log, readWorkflow })).toBe(1);
  });
});

describe('deploy-reconcile.yml', () => {
  const wf = read('deploy-reconcile.yml');

  it('runs on a schedule and by hand only', () => {
    expect(wf).toMatch(/\non:\n {2}schedule:\n {4}- cron: "[0-9]+ \* \* \* \*"\n {2}workflow_dispatch:\n\n/);
    expect(wf).not.toMatch(/\n {2}(push|pull_request|pull_request_target|workflow_run):/);
  });

  it('holds no permissions at the top, one concurrency group without cancellation', () => {
    expect(wf).toMatch(/\npermissions: \{\}\n/);
    expect(wf).toMatch(/\nconcurrency:\n {2}group: deploy-reconcile\n {2}cancel-in-progress: false\n/);
  });

  it('has a single job, the only one with actions: write, skipped while DEPLOY_FREEZE is set', () => {
    const jobs = [...wf.slice(wf.indexOf('\njobs:\n')).matchAll(/\n {2}([a-z][a-z0-9-]*):\n/g)];
    expect(jobs.map((m) => m[1])).toEqual(['reconcile']);
    expect(wf).toMatch(/\n {4}permissions:\n {6}actions: write\b.*\n {6}contents: read\n {4}steps:/);
    expect(wf).toContain("github.repository == '4thtech/agentlink'");
    expect(wf).toContain("github.ref == 'refs/heads/main'");
    expect(wf).toContain("vars.DEPLOY_FREEZE != 'true'");
  });

  it('pins every action to a full commit and passes values through env only', () => {
    for (const m of wf.matchAll(/uses: (\S+)/g)) expect(m[1]).toMatch(/@[0-9a-f]{40}$/);
    expect(wf).toContain('persist-credentials: false');
    const scripts = runScripts(wf).map((s) => s.script);
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) expect(s).not.toContain('${{');
    expect(wf).toMatch(/DEPLOY_FREEZE: \$\{\{ vars\.DEPLOY_FREEZE \}\}/);
    expect(wf).toMatch(/GH_TOKEN: \$\{\{ github\.token \}\}/);
  });

  it('reconciles both deploy workflows in one call', () => {
    const scripts = runScripts(wf).map((s) => s.script).join('\n');
    expect(scripts).toMatch(
      /node tools\/release\/reconcile-deploy\.mjs[\s\\]+--workflow deploy-submitter\.yml[\s\\]+--workflow deploy-drop\.yml/,
    );
  });

  it('matches the deploy workflows it reads: dispatchable, the deploy step, the same CI gates', () => {
    for (const name of ['deploy-submitter.yml', 'deploy-drop.yml']) {
      const source = read(name);
      expect(source).toMatch(/\n {2}workflow_dispatch:\n/);
      const prod = source.slice(source.indexOf('\n  deploy-production:\n'));
      expect(prod).toContain(`- name: ${DEPLOY_STEP}\n`);
      for (const { workflow, job } of REQUIRED_GATES) {
        expect(source).toContain(`--require ${workflow}:${job}`);
      }
    }
  });
});
