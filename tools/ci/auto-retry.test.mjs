// CHORE-CI-AUTORETRY: one automatic rerun of the flaky-prone failed jobs of a CI or Security run.
// The workflow runs on `workflow_run`, which holds `actions: write` in the base repository, so the
// tests pin both the decision (attempt guard, allowlist, same-repository runs only) and the workflow
// shape (triggers, permissions, no pull request code checked out or executed).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FLAKY_JOBS, baseJobName, decide, parseRunId, summaryLine } from './auto-retry.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const wf = readFileSync(join(root, '.github/workflows/ci-auto-retry.yml'), 'utf8');
const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
const security = readFileSync(join(root, '.github/workflows/security.yml'), 'utf8');

const base = {
  workflow: 'CI',
  event: 'pull_request',
  conclusion: 'failure',
  attempt: '1',
  repo: '4thtech/agentlink',
  headRepo: '4thtech/agentlink',
  headBranch: 'CHORE-X',
  jobs: [
    { name: 'detect', conclusion: 'success' },
    { name: 'checks', conclusion: 'failure' },
    { name: 'ci-gate', conclusion: 'failure' },
  ],
};

describe('decide', () => {
  it('reruns a first-attempt failure whose failed jobs are all flaky-prone', () => {
    const d = decide(base);
    expect(d.rerun).toBe(true);
    expect(d.jobs).toEqual(['checks']);
  });

  it('never reruns attempt 2 or later (no loops)', () => {
    for (const attempt of ['2', '3', '10']) expect(decide({ ...base, attempt }).rerun).toBe(false);
  });

  it('rejects a non-numeric or missing attempt', () => {
    for (const attempt of ['', '1a', ' 1', undefined, '01x'])
      expect(decide({ ...base, attempt }).rerun).toBe(false);
  });

  it('never reruns cancelled, successful or other conclusions', () => {
    for (const conclusion of [
      'cancelled',
      'success',
      'timed_out',
      'skipped',
      'action_required',
      '',
    ])
      expect(decide({ ...base, conclusion }).rerun).toBe(false);
  });

  it('only handles pull_request, merge_group and push on main', () => {
    expect(decide({ ...base, event: 'merge_group' }).rerun).toBe(true);
    expect(decide({ ...base, event: 'push', headBranch: 'main' }).rerun).toBe(true);
    expect(decide({ ...base, event: 'push', headBranch: 'CHORE-X' }).rerun).toBe(false);
    for (const event of ['schedule', 'workflow_dispatch', 'pull_request_target', 'workflow_run'])
      expect(decide({ ...base, event }).rerun).toBe(false);
  });

  it('never reruns a run from another repository (forks)', () => {
    expect(decide({ ...base, headRepo: 'someone/agentlink' }).rerun).toBe(false);
    expect(decide({ ...base, headRepo: '' }).rerun).toBe(false);
  });

  it('only handles the CI and Security workflows', () => {
    expect(decide({ ...base, workflow: 'Release' }).rerun).toBe(false);
  });

  it('skips when a deterministic job failed too (a rerun cannot help)', () => {
    for (const name of [
      'changesets',
      'context-budget',
      'stale-precheck',
      'detect',
      'path-guard (ubuntu-24.04)',
    ]) {
      const jobs = [...base.jobs, { name, conclusion: 'failure' }];
      const d = decide({ ...base, jobs });
      expect(d.rerun).toBe(false);
      expect(d.reason).toMatch(/not on the flaky list/);
    }
  });

  it('skips when only the gate failed', () => {
    const d = decide({ ...base, jobs: [{ name: 'ci-gate', conclusion: 'failure' }] });
    expect(d.rerun).toBe(false);
  });

  it('accepts matrix legs, reusable-workflow jobs and timed-out or fail-fast-cancelled legs', () => {
    const jobs = [
      { name: 'node-os (macos-15)', conclusion: 'failure' },
      { name: 'node-os (windows-2025)', conclusion: 'cancelled' },
      { name: 'keychain (ubuntu-24.04)', conclusion: 'timed_out' },
      { name: 'e2e-deterministic / e2e-deterministic', conclusion: 'failure' },
      { name: 'ci-gate', conclusion: 'failure' },
    ];
    const d = decide({ ...base, jobs });
    expect(d.rerun).toBe(true);
    expect(d.jobs).toHaveLength(4);
  });

  it('uses the per-workflow allowlist (Security: codeql and dependency-review only)', () => {
    const sec = { ...base, workflow: 'Security' };
    expect(
      decide({ ...sec, jobs: [{ name: 'codeql (javascript-typescript)', conclusion: 'failure' }] })
        .rerun,
    ).toBe(true);
    expect(
      decide({ ...sec, jobs: [{ name: 'secret-scan / gitleaks', conclusion: 'failure' }] }).rerun,
    ).toBe(false);
    expect(decide({ ...sec, jobs: [{ name: 'checks', conclusion: 'failure' }] }).rerun).toBe(false);
  });

  it('keeps the CI allowlist to the flaky-prone jobs and away from the deterministic ones', () => {
    expect([...FLAKY_JOBS.CI].sort()).toEqual(
      [
        'bundle-check',
        'checks',
        'e2e',
        'e2e-deterministic',
        'keychain',
        'node-os',
        'relays-docker',
        'storage-minio',
        'vectors',
      ].sort(),
    );
    for (const j of [
      'pr-hygiene',
      'review-gate',
      'changesets',
      'context-budget',
      'detect',
      'ci-gate',
    ])
      expect(FLAKY_JOBS.CI.has(j)).toBe(false);
  });
});

describe('helpers', () => {
  it('baseJobName strips matrix suffixes and reusable-workflow paths', () => {
    expect(baseJobName('node-os (macos-15)')).toBe('node-os');
    expect(baseJobName('e2e-deterministic / e2e-deterministic')).toBe('e2e-deterministic');
    expect(baseJobName('checks')).toBe('checks');
  });

  it('parseRunId accepts only a plain positive integer', () => {
    expect(parseRunId('123456789')).toBe('123456789');
    for (const bad of ['', '0', '-1', '1e9', '12 ', '12;rm', '$(id)', undefined, '1'.repeat(21)])
      expect(() => parseRunId(bad)).toThrow();
  });

  it('summaryLine says what was rerun and why, without markdown from job names', () => {
    const line = summaryLine({ rerun: true, reason: 'r', jobs: ['checks', 'x`|<b>'] }, 'CI', '42');
    expect(line).toContain('checks');
    expect(line).toContain('42');
    expect(line).not.toMatch(/[`|<>]/);
  });
});

describe('ci-auto-retry.yml', () => {
  it('runs on workflow_run completion of exactly the CI and Security workflows', () => {
    expect(wf).toMatch(/\n {2}workflow_run: # zizmor: ignore\[dangerous-triggers\]/);
    expect(wf).toMatch(/workflows: \[CI, Security\]/);
    expect(wf).toMatch(/types: \[completed\]/);
    expect(ci).toMatch(/\nname: CI\n/);
    expect(security).toMatch(/\nname: Security\n/);
    const on = wf.slice(wf.indexOf('\non:'), wf.indexOf('\npermissions:'));
    expect(on).not.toMatch(/pull_request|push:|schedule|workflow_dispatch/);
  });

  it('has no top-level permissions and actions: write on the one job only', () => {
    expect(wf).toMatch(/\npermissions: \{\}\n/);
    expect(wf.match(/actions: write/g)).toHaveLength(1);
    expect(wf).not.toMatch(/contents: write|id-token|pull-requests: write|secrets\./);
  });

  it('guards attempt, conclusion, event and repository in the job condition too', () => {
    expect(wf).toContain("github.event.workflow_run.conclusion == 'failure'");
    expect(wf).toContain('github.event.workflow_run.run_attempt == 1');
    expect(wf).toContain(
      'github.event.workflow_run.head_repository.full_name == github.repository',
    );
  });

  it('one concurrency group per run id, never cancelling', () => {
    expect(wf).toMatch(/group: ci-auto-retry-\$\{\{ github\.event\.workflow_run\.id \}\}/);
    expect(wf).toMatch(/cancel-in-progress: false/);
  });

  it('never checks out or runs pull request code', () => {
    expect(wf).not.toMatch(/head_sha|head_commit|pull_requests|head_branch\s*\}\}.*ref/);
    const checkout = wf.match(/uses: actions\/checkout@[0-9a-f]{40} # v[\s\S]*?\n {6}- /);
    expect(checkout).not.toBeNull();
    expect(checkout[0]).toContain('ref: ${{ github.sha }}');
    expect(checkout[0]).toContain('persist-credentials: false');
    expect(checkout[0]).toContain('tools/ci/auto-retry.mjs');
    expect(wf).not.toMatch(/pnpm|npm |npx|setup-node/);
  });

  it('passes event data only through env:, never interpolated into run:', () => {
    const runs = wf
      .split(/\n {8}run: \|/)
      .slice(1)
      .map((s) => s.split(/\n {6}- /)[0]);
    expect(runs.length).toBeGreaterThan(0);
    for (const r of runs) expect(r).not.toContain('${{');
    expect(wf).toMatch(/RUN_ID: \$\{\{ github\.event\.workflow_run\.id \}\}/);
  });

  it('pins every action to a full commit SHA and has a timeout', () => {
    for (const u of wf.match(/uses: \S+/g) ?? []) expect(u).toMatch(/@[0-9a-f]{40}$/);
    expect(wf).toMatch(/timeout-minutes: \d+/);
  });

  it('reruns only the failed jobs, once, and writes a job summary', () => {
    expect(wf).toMatch(/gh run rerun "\$RUN_ID" --failed/);
    expect(wf.match(/gh run rerun/g)).toHaveLength(1);
    expect(wf).toContain("steps.decide.outputs.rerun == 'true'");
    expect(wf).toContain('node tools/ci/auto-retry.mjs');
  });
});
