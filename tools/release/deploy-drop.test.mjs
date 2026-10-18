import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// M1-27b: the encrypted drop's deploy workflow (release-and-deployment.md §4.5, D-25, D-52).
// Structure checks on .github/workflows/deploy-drop.yml as text, and the two read-back checks
// (bucket lifecycle rule, Worker logging settings), extracted between their READBACK markers and
// run on fixtures shaped like the Cloudflare API responses. The read-backs run inline in the
// credentialed `deploy-staging` and `deploy-production` jobs.

const workflow = readFileSync(
  resolve(import.meta.dirname, '../../.github/workflows/deploy-drop.yml'),
  'utf8',
);

/** The body of one job: from `  <name>:` to the next job header or the end. */
function job(name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  if (start < 0) return '';
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 2);
}

function jobNames() {
  const jobs = workflow.slice(workflow.indexOf('\njobs:\n'));
  return [...jobs.matchAll(/\n {2}([a-z][a-z0-9-]*):\n/g)].map((m) => m[1]);
}

/** A marked bash block, unindented. Every copy of it must be identical. */
function block(marker) {
  const copies = [
    ...workflow.matchAll(new RegExp(`# ${marker}-BEGIN\\n([\\s\\S]*?)\\n\\s*# ${marker}-END`, 'g')),
  ].map((m) => m[1].replace(/^ {10}/gm, ''));
  return copies;
}

function runBlock(script, env) {
  try {
    const stdout = execFileSync('bash', ['-euo', 'pipefail', '-c', script], {
      env: { PATH: process.env.PATH, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output: stdout };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

function fixture(value) {
  const dir = mkdtempSync(join(tmpdir(), 'drop-readback-'));
  const file = join(dir, 'response.json');
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}

describe('deploy-drop.yml structure', () => {
  it('runs on pushes to main and by dispatch, never on pull requests, with no default permissions', () => {
    expect(workflow).toMatch(/\non:\n {2}push:\n {4}branches: \[main\]/);
    expect(workflow).toMatch(/\n {2}workflow_dispatch:/);
    expect(workflow).not.toMatch(/pull_request/);
    expect(workflow).toMatch(/\npermissions: \{\}\n/);
  });

  it('pins every action to a full commit SHA', () => {
    const uses = [...workflow.matchAll(/uses: ([^\s#]+)/g)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) {
      if (use.startsWith('./')) continue;
      expect(use).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it('has a timeout on every job', () => {
    const names = jobNames();
    expect(names).toEqual(
      expect.arrayContaining([
        'ci-green',
        'guard',
        'build',
        'deploy-staging',
        'smoke-staging',
        'deploy-production',
        'freeze',
      ]),
    );
    for (const name of names) expect(job(name)).toMatch(/timeout-minutes: \d+/);
  });

  it('waits for green CI before anything deploys', () => {
    expect(job('ci-green')).toMatch(/wait-for-ci\.mjs/);
    expect(job('guard')).toMatch(/needs: ci-green/);
  });

  it('builds the bundle once, with no credentials, and deploys that artifact to both environments', () => {
    const build = job('build');
    expect(build).toMatch(/--dry-run/);
    expect(build).not.toMatch(/environment:|secrets\./);
    expect(job('deploy-staging')).toMatch(/--no-bundle/);
    expect(job('deploy-production')).toMatch(/--no-bundle/);
    expect(job('deploy-staging')).toMatch(/sha256sum -c/);
    expect(job('deploy-production')).toMatch(/sha256sum -c/);
  });

  it('deploys staging in environment staging, frozen by DEPLOY_FREEZE and re-checked at start', () => {
    const staging = job('deploy-staging');
    expect(staging).toMatch(/environment: staging/);
    expect(staging).toMatch(/vars\.DEPLOY_FREEZE != 'true'/);
    expect(staging).toMatch(/Stop if DEPLOY_FREEZE is set/);
    expect(staging).toMatch(/--env staging/);
  });

  it('skips cleanly while the Cloudflare credentials or the Worker secret are missing', () => {
    for (const name of ['deploy-staging', 'deploy-production']) {
      const body = job(name);
      expect(body).toMatch(/CLOUDFLARE_API_TOKEN/);
      expect(body).toMatch(/secret list/);
      expect(body).toMatch(/DROP_URL_KEY/);
      expect(body).toMatch(/ready=false/);
    }
  });

  it('runs the staging smoke without credentials', () => {
    const smoke = job('smoke-staging');
    expect(smoke).toMatch(/DROP_SMOKE_URL/);
    expect(smoke).toMatch(/drop-smoke-remote/);
    expect(smoke).not.toMatch(/environment:/);
    expect(smoke).not.toMatch(/secrets\./);
  });

  it('deploys production only after a green staging smoke, frozen by DEPLOY_FREEZE', () => {
    const production = job('deploy-production');
    expect(production).toMatch(/needs: \[[^\]]*smoke-staging[^\]]*\]/);
    expect(production).toMatch(/needs\.smoke-staging\.result == 'success'/);
    expect(production).toMatch(/environment: production/);
    expect(production).toMatch(/vars\.DEPLOY_FREEZE != 'true'/);
    expect(production).toMatch(/Stop if DEPLOY_FREEZE is set/);
    expect(production).toMatch(/--env production/);
  });

  it('records the rollback target, health-checks and rolls back automatically', () => {
    const production = job('deploy-production');
    expect(production).toMatch(/deployments status/);
    expect(production).toMatch(/wrangler rollback/);
    expect(production).toMatch(/\/v1\/health/);
    expect(production).toMatch(/if: failure\(\)/);
  });

  it('reads back the lifecycle rule and the logging settings after each deploy', () => {
    for (const name of ['deploy-staging', 'deploy-production']) {
      const body = job(name);
      expect(body).toMatch(/READBACK-LIFECYCLE-BEGIN/);
      expect(body).toMatch(/READBACK-SETTINGS-BEGIN/);
      expect(body).toMatch(/\/script-settings/);
      expect(body).toMatch(/\/lifecycle/);
    }
  });

  it('sets DEPLOY_FREEZE when production failed after deploying', () => {
    const freeze = job('freeze');
    expect(freeze).toMatch(/environment: deploy-freeze/);
    expect(freeze).toMatch(/DEPLOY_FREEZE_TOKEN/);
    expect(freeze).toMatch(/needs\.deploy-production\.outputs\.deployed == 'true'/);
  });

  it('writes a deploy record draft', () => {
    expect(job('deploy-production')).toMatch(/GITHUB_STEP_SUMMARY/);
  });

  it('never cancels a deploy in flight and never interpolates event data into run scripts', () => {
    expect(workflow).toMatch(/cancel-in-progress: false/);
    expect(workflow).not.toMatch(/cancel-in-progress: true/);
    expect(workflow).not.toMatch(/\$\{\{\s*github\.event\./);
    // `${{ }}` only outside run: blocks (if:, env:, with:, outputs:, environment:).
    const runBlocks = [...workflow.matchAll(/run: \|\n((?: {10,}.*\n|\n)*)/g)].map((m) => m[1]);
    expect(runBlocks.length).toBeGreaterThan(5);
    for (const body of runBlocks) expect(body).not.toMatch(/\$\{\{/);
  });

  it('never prints the API token and never traces shell commands', () => {
    expect(workflow).not.toMatch(/(echo|printf)[^\n]*\$\{?CLOUDFLARE_API_TOKEN/);
    expect(workflow).not.toMatch(/(echo|printf)[^\n]*\$\{?auth\b/);
    expect(workflow).not.toMatch(/set -x|set -o xtrace/);
  });
});

describe('lifecycle read-back', () => {
  const copies = block('READBACK-LIFECYCLE');
  const script = copies[0] ?? '';
  const rule = (overrides = {}) => ({
    id: 'expire-7d',
    enabled: true,
    conditions: { prefix: '' },
    deleteObjectsTransition: { condition: { type: 'Age', maxAge: 604_800 } },
    ...overrides,
  });
  const check = (body) => runBlock(script, { LIFECYCLE_JSON: fixture(body) });

  it('is the same block in staging and production', () => {
    expect(copies.length).toBe(2);
    expect(copies[1]).toBe(copies[0]);
  });

  it('accepts an enabled whole-bucket rule deleting objects after 7 days', () => {
    expect(check({ success: true, result: { rules: [rule()] } }).ok).toBe(true);
  });

  it('accepts a shorter age and an absent prefix', () => {
    const shorter = rule({
      conditions: {},
      deleteObjectsTransition: { condition: { type: 'Age', maxAge: 86_400 } },
    });
    expect(check({ success: true, result: { rules: [shorter] } }).ok).toBe(true);
  });

  it('refuses no rule, a disabled rule, a longer age, a prefix-only rule or a date rule', () => {
    expect(check({ success: true, result: { rules: [] } }).ok).toBe(false);
    expect(check({ success: true, result: { rules: [rule({ enabled: false })] } }).ok).toBe(false);
    const longer = rule({
      deleteObjectsTransition: { condition: { type: 'Age', maxAge: 604_801 } },
    });
    expect(check({ success: true, result: { rules: [longer] } }).ok).toBe(false);
    const prefixed = rule({ conditions: { prefix: 'objects/' } });
    expect(check({ success: true, result: { rules: [prefixed] } }).ok).toBe(false);
    const dated = rule({
      deleteObjectsTransition: { condition: { type: 'Date', date: '2027-01-01T00:00:00Z' } },
    });
    expect(check({ success: true, result: { rules: [dated] } }).ok).toBe(false);
  });

  it('refuses an API error and a response that is not JSON', () => {
    expect(check({ success: false, errors: [{ code: 10000 }] }).ok).toBe(false);
    expect(check('<html>').ok).toBe(false);
  });
});

describe('logging settings read-back', () => {
  const copies = block('READBACK-SETTINGS');
  const script = copies[0] ?? '';
  const off = (overrides = {}) => ({
    logpush: false,
    observability: { enabled: false, logs: { enabled: false, invocation_logs: false } },
    tail_consumers: [],
    ...overrides,
  });
  const check = (body) => runBlock(script, { SETTINGS_JSON: fixture(body) });

  it('is the same block in staging and production', () => {
    expect(copies.length).toBe(2);
    expect(copies[1]).toBe(copies[0]);
  });

  it('accepts everything off, and absent fields', () => {
    expect(check({ success: true, result: off() }).ok).toBe(true);
    expect(check({ success: true, result: { tail_consumers: null } }).ok).toBe(true);
  });

  it('refuses Logpush, observability, invocation logs or a Tail Worker', () => {
    expect(check({ success: true, result: off({ logpush: true }) }).ok).toBe(false);
    expect(check({ success: true, result: off({ observability: { enabled: true } }) }).ok).toBe(
      false,
    );
    expect(
      check({
        success: true,
        result: off({ observability: { enabled: false, logs: { enabled: true } } }),
      }).ok,
    ).toBe(false);
    expect(
      check({
        success: true,
        result: off({
          observability: { enabled: false, logs: { enabled: false, invocation_logs: true } },
        }),
      }).ok,
    ).toBe(false);
    expect(
      check({ success: true, result: off({ tail_consumers: [{ service: 'tail' }] }) }).ok,
    ).toBe(false);
  });

  it('refuses an API error and a response that is not JSON', () => {
    expect(check({ success: false, errors: [{ code: 10007 }] }).ok).toBe(false);
    expect(check('not json').ok).toBe(false);
  });
});
