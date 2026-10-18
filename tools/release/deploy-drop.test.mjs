import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
      expect(body).toMatch(/SECRET-CHECK-BEGIN/);
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
    expect(production).toMatch(
      /if: \(failure\(\) \|\| cancelled\(\)\) && steps\.deploy\.outputs\.deployed == 'true'\n/,
    );
    // The rollback is verified by the live version, not only by /v1/health.
    const rollback = production.slice(production.indexOf('id: rollback'));
    expect(rollback).toMatch(/deployments status[\s\S]*"\$live" != "\$PREVIOUS"/);
  });

  it('changes production only while this commit is the head of main (IR-M1-27b-1 M-2)', () => {
    const production = job('deploy-production');
    const head = production.indexOf('id: head\n');
    const ready = production.indexOf('id: ready');
    const deploy = production.indexOf('id: deploy\n');
    expect(head).toBeGreaterThan(-1);
    expect(head).toBeLessThan(ready);
    expect(ready).toBeLessThan(deploy);
    expect(production).toMatch(/id: ready\n {8}if: steps\.head\.outputs\.current == 'true'/);
    // The rollback is not gated on the head of main (IR-M1-27b-2 M-3): the concurrency group
    // serializes runs, so this run's version is live and must be rolled back even if main moved on.
    const rollback = production.slice(
      production.indexOf('- name: Roll back to the recorded version'),
      production.indexOf('id: rollback\n') + 200,
    );
    expect(rollback).not.toMatch(/steps\.head/);
    expect(production).not.toMatch(/head-rollback/);
    expect(production.match(/HEAD-CHECK-BEGIN/g)?.length).toBe(1);
    expect(job('deploy-production')).toMatch(/concurrency:\n {6}group: deploy-drop-production/);
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

  it('refuses Logpush, observability, invocation logs, traces or a Tail Worker', () => {
    expect(check({ success: true, result: off({ logpush: true }) }).ok).toBe(false);
    expect(
      check({
        success: true,
        result: off({ observability: { enabled: false, traces: { enabled: true } } }),
      }).ok,
    ).toBe(false);
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

/** A directory with fake `curl` and `gh` that answer from fixture files (no network). */
function fakeTools({ httpCode = '200', body = '{}', head = '' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'drop-fake-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(dir, 'body.json'), body);
  writeFileSync(
    join(bin, 'curl'),
    [
      '#!/usr/bin/env bash',
      'out=""',
      'while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; shift; fi; shift; done',
      `[ -n "$out" ] && cp ${JSON.stringify(join(dir, 'body.json'))} "$out"`,
      `printf '%s' ${JSON.stringify(httpCode)}`,
    ].join('\n'),
  );
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash\nprintf '%s\\n' ${JSON.stringify(head)}\n`);
  chmodSync(join(bin, 'curl'), 0o755);
  chmodSync(join(bin, 'gh'), 0o755);
  const output = join(dir, 'github-output');
  writeFileSync(output, '');
  return { dir, bin, output };
}

function runWithFakes(script, fakes, env) {
  const result = (() => {
    try {
      const stdout = execFileSync('bash', ['-euo', 'pipefail', '-c', script], {
        env: { PATH: `${fakes.bin}:${process.env.PATH}`, ...env },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { ok: true, output: stdout };
    } catch (error) {
      return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
    }
  })();
  return { ...result, github: readFileSync(fakes.output, 'utf8') };
}

describe('credential and Worker secret check', () => {
  const copies = block('SECRET-CHECK');
  const script = copies[0] ?? '';
  const ACCOUNT = '0123456789abcdef0123456789abcdef';
  const run = (fake, env = {}) => {
    const fakes = fakeTools(fake);
    return runWithFakes(script, fakes, {
      CLOUDFLARE_API_TOKEN: 'test-token-value',
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      DEPLOY_ENV: 'staging',
      WORKER: 'agentlink-drop-staging',
      RUNNER_TEMP: fakes.dir,
      GITHUB_OUTPUT: fakes.output,
      ...env,
    });
  };
  const listing = (names) =>
    JSON.stringify({ success: true, result: names.map((name) => ({ name, type: 'secret_text' })) });

  it('is the same block in staging and production', () => {
    expect(copies.length).toBe(2);
    expect(copies[1]).toBe(copies[0]);
  });

  it('skips cleanly without credentials', () => {
    const result = run({}, { CLOUDFLARE_API_TOKEN: '' });
    expect(result.ok).toBe(true);
    expect(result.github).toContain('ready=false');
  });

  it('skips cleanly while the Worker does not exist or has no DROP_URL_KEY', () => {
    const missing = run({ httpCode: '404', body: '{"success":false}' });
    expect(missing.ok).toBe(true);
    expect(missing.github).toContain('ready=false');
    const noKey = run({ body: listing(['OTHER']) });
    expect(noKey.ok).toBe(true);
    expect(noKey.github).toContain('ready=false');
  });

  it('is ready with DROP_URL_KEY set', () => {
    const result = run({ body: listing(['DROP_URL_KEY']) });
    expect(result.ok).toBe(true);
    expect(result.github).toContain('ready=true');
  });

  it('fails loudly for a token the API refuses, an unreachable API or a malformed answer', () => {
    for (const code of ['401', '403', '500', '000', '']) {
      const result = run({ httpCode: code, body: '{"success":false}' });
      expect(result.ok).toBe(false);
      expect(result.github).not.toContain('ready=');
    }
    expect(run({ body: '<html>' }).ok).toBe(false);
  });

  it('fails when DROP_CORS_ORIGINS exists as a Worker secret (it is a reviewed var)', () => {
    expect(run({ body: listing(['DROP_URL_KEY', 'DROP_CORS_ORIGINS']) }).ok).toBe(false);
  });

  it('fails for a malformed account ID and never prints the token', () => {
    expect(run({}, { CLOUDFLARE_ACCOUNT_ID: 'not-an-id' }).ok).toBe(false);
    for (const code of ['200', '403', '404']) {
      expect(run({ httpCode: code, body: listing(['DROP_URL_KEY']) }).output).not.toContain(
        'test-token-value',
      );
    }
  });
});

describe('head-of-main check', () => {
  const copies = block('HEAD-CHECK');
  const script = copies[0] ?? '';
  const SHA = 'a'.repeat(40);
  const run = (head, commit = SHA) => {
    const fakes = fakeTools({ head });
    return runWithFakes(script, fakes, {
      REPOSITORY: '4thtech/agentlink',
      COMMIT: commit,
      GITHUB_OUTPUT: fakes.output,
    });
  };

  it('appears once, before the production deploy only', () => {
    expect(copies.length).toBe(1);
  });

  it('is current when main still points at this commit', () => {
    const result = run(SHA);
    expect(result.ok).toBe(true);
    expect(result.github).toContain('current=true');
  });

  it('is not current once main moved on (a newer run owns production)', () => {
    const result = run('b'.repeat(40));
    expect(result.ok).toBe(true);
    expect(result.github).toContain('current=false');
  });

  it('fails when the head of main cannot be read', () => {
    expect(run('').ok).toBe(false);
    expect(run('not-a-sha').ok).toBe(false);
  });
});
