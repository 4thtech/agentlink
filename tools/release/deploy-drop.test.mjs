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

  // M1-27b-b: the first real run deployed `<bundle>/index.js --no-bundle --env staging` without a
  // config. Wrangler looks for its config next to a positional script, not in the working directory,
  // so no [env.*] section, name, binding, var, limit, observability setting or route applied.
  it('passes the drop wrangler config to every wrangler call, for both environments', () => {
    const lines = workflow.split('\n');
    const calls = [];
    lines.forEach((line, index) => {
      if (/^\s*#/.test(line)) return;
      // Executed wrangler commands only; owner hints inside echo strings are not calls.
      const code = line.replace(/"[^"]*::(notice|error)::[^"]*"/g, '""');
      if (!/(^|[\s"(=$])(pnpm exec |npx |pnpm dlx )?wrangler\s/.test(code)) return;
      if (/^\s*(echo|printf)\b/.test(code)) return;
      let step = index;
      while (step > 0 && !/^ {6}- name:/.test(lines[step])) step -= 1;
      const header = lines.slice(step, index).join('\n');
      calls.push({
        line: line.trim(),
        inDrop: /\n {8}working-directory: apps\/drop\n/.test(header),
      });
    });
    expect(calls.length).toBeGreaterThanOrEqual(10);
    for (const call of calls) {
      expect(call.line).toMatch(
        /^(?:[A-Za-z_]+="[^"]*" )?(?:if [a-z]+="\$\(|live="\$\()?pnpm exec wrangler /,
      );
      expect(call.line).toMatch(/ --env (staging|production) /);
      const config = call.inDrop ? '--config wrangler.toml' : '--config apps/drop/wrangler.toml';
      expect(call.line, call.line).toContain(` ${config}`);
    }
    const deploys = calls.filter((c) => / wrangler deploy .*--no-bundle/.test(c.line));
    expect(deploys.map((c) => c.line.match(/--env (\w+)/)[1]).sort()).toEqual([
      'production',
      'staging',
    ]);
    for (const env of ['staging', 'production']) {
      expect(calls.some((c) => c.line.includes(`deployments status --env ${env} `))).toBe(true);
      expect(
        calls.some((c) => c.line.includes(`rollback "$`) && c.line.includes(`--env ${env} `)),
      ).toBe(true);
    }
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

describe('no step turns logging on (OPS-PRIV-1, I-7)', () => {
  it('never tails the Worker, passes a Logpush flag or sets observability on the command line', () => {
    expect(workflow).not.toMatch(/wrangler\s+tail\b/);
    expect(workflow).not.toMatch(/--logpush\b/);
    expect(workflow).not.toMatch(/--(?:observability|tail-consumers?)\b/);
  });

  it('deploys with the reviewed wrangler.toml, which keeps logging off', () => {
    const deploys = workflow.match(/pnpm exec wrangler deploy\b[^\n]*/g) ?? [];
    expect(deploys.length).toBeGreaterThan(0);
    for (const line of deploys) expect(line).toMatch(/--config wrangler\.toml/);
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

  // OPS-PRIV-1: streaming Tail Workers are Tail Workers too, and an export destination for logs
  // or traces sends them to a third party even when Workers Logs itself keeps nothing.
  it('refuses a streaming Tail Worker and a log or trace export destination', () => {
    expect(check({ success: true, result: off({ streaming_tail_consumers: null }) }).ok).toBe(true);
    expect(
      check({ success: true, result: off({ streaming_tail_consumers: [{ service: 'tail' }] }) }).ok,
    ).toBe(false);
    for (const part of ['logs', 'traces']) {
      expect(
        check({
          success: true,
          result: off({
            observability: { enabled: false, [part]: { enabled: false, destinations: [] } },
          }),
        }).ok,
      ).toBe(true);
      expect(
        check({
          success: true,
          result: off({
            observability: { enabled: false, [part]: { enabled: false, destinations: ['otel'] } },
          }),
        }).ok,
      ).toBe(false);
    }
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

// M1-27b-c: the first production deploy (run 39276990603, 2026-10-19). The health check met a
// TLS handshake failure for its whole 2.5-minute window while Cloudflare provisioned the new Custom
// Domain's certificate; the rollback was refused across a Durable Object / binding change; the
// freeze job's token could not set the repository variable.

/**
 * Fake `curl`, `sleep`, `pnpm` and `gh` driven by scripts (no network, no waiting).
 * curl: one [httpCode, exitCode] per call, the last one repeating; `-o` gets `body`.
 */
function scriptedTools({
  curl = [['200', 0]],
  body = '{"ok":true}',
  rollback = { output: 'Rolled back', exit: 0 },
  live = '',
  gh = { output: '', exit: 0 },
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'drop-scripted-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const q = (value) => JSON.stringify(String(value));
  const versions = live ? [{ version_id: live, percentage: 100 }] : [];
  writeFileSync(join(dir, 'body.json'), body);
  writeFileSync(join(dir, 'curl.txt'), curl.map(([code, exit]) => `${code} ${exit}\n`).join(''));
  writeFileSync(join(dir, 'calls'), '');
  writeFileSync(
    join(bin, 'curl'),
    [
      '#!/usr/bin/env bash',
      'out=""',
      'while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; shift; fi; shift; done',
      `calls=${q(join(dir, 'calls'))}`,
      'echo x >> "$calls"',
      'n="$(wc -l < "$calls" | tr -d " ")"',
      `script=${q(join(dir, 'curl.txt'))}`,
      'total="$(wc -l < "$script" | tr -d " ")"',
      'if [ "$n" -gt "$total" ]; then n="$total"; fi',
      'line="$(sed -n "${n}p" "$script")"',
      'code="${line%% *}"; rc="${line##* }"',
      `if [ -n "$out" ] && [ "$out" != /dev/null ]; then cp ${q(join(dir, 'body.json'))} "$out"; fi`,
      'printf "%s" "$code"',
      'exit "$rc"',
    ].join('\n'),
  );
  writeFileSync(join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
  writeFileSync(
    join(bin, 'pnpm'),
    [
      '#!/usr/bin/env bash',
      'case " $* " in',
      `  *" rollback "*) printf '%s\\n' ${q(rollback.output)}; exit ${rollback.exit} ;;`,
      `  *" deployments status "*) printf '%s\\n' ${q(JSON.stringify({ versions }))}; exit 0 ;;`,
      'esac',
      'exit 99',
    ].join('\n'),
  );
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env bash\nprintf '%s\\n' ${q(gh.output)} >&2\nexit ${gh.exit}\n`,
  );
  for (const tool of ['curl', 'sleep', 'pnpm', 'gh']) chmodSync(join(bin, tool), 0o755);
  const output = join(dir, 'github-output');
  const summary = join(dir, 'step-summary');
  writeFileSync(output, '');
  writeFileSync(summary, '');
  return { dir, bin, output, summary };
}

function runScripted(script, fakes, env) {
  const result = runWithFakes(script, fakes, {
    RUNNER_TEMP: fakes.dir,
    GITHUB_OUTPUT: fakes.output,
    GITHUB_STEP_SUMMARY: fakes.summary,
    ...env,
  });
  return {
    ...result,
    curlCalls: readFileSync(join(fakes.dir, 'calls'), 'utf8').split('\n').filter(Boolean).length,
    summary: readFileSync(fakes.summary, 'utf8'),
  };
}

describe('production health check (M1-27b-c)', () => {
  const copies = block('HEALTH-CHECK');
  const script = copies[0] ?? '';
  const run = (fake) =>
    runScripted(script, scriptedTools(fake), {
      DROP_PRODUCTION_ORIGIN: 'https://drop.example.test',
    });
  const pairs = (health, upload, times) =>
    Array.from({ length: times }, () => [health, upload]).flat();

  it('appears once, in the production health check step, with a step timeout', () => {
    expect(copies.length).toBe(1);
    const production = job('deploy-production');
    const step = production.slice(
      production.indexOf('id: health\n'),
      production.indexOf('HEALTH-CHECK-BEGIN'),
    );
    expect(step).toMatch(/timeout-minutes: (1[6-9]|20)\n/);
  });

  it('is healthy for /v1/health 200 {"ok":true} and an unsigned upload 401', () => {
    const result = run({
      curl: [
        ['200', 0],
        ['401', 0],
      ],
    });
    expect(result.ok, result.output).toBe(true);
    expect(result.curlCalls).toBe(2);
  });

  it('keeps waiting past 10 attempts while there is no TLS or connection yet (HTTP 000)', () => {
    const waiting = [
      ...pairs(['000', 35], ['000', 35], 12),
      ...pairs(['000', 6], ['000', 6], 4),
      ...pairs(['000', 7], ['000', 7], 4),
    ];
    const result = run({ curl: [...waiting, ['200', 0], ['401', 0]] });
    expect(result.ok, result.output).toBe(true);
    expect(result.curlCalls).toBe(42);
    expect(result.output).toMatch(/no TLS or connection yet/);
  });

  it('gives up after a bounded TLS window, naming the certificate', () => {
    const result = run({ curl: [['000', 35]] });
    expect(result.ok).toBe(false);
    expect(result.curlCalls).toBeGreaterThan(40);
    expect(result.curlCalls).toBeLessThanOrEqual(120);
    expect(result.output).toMatch(
      /::error::The production health check failed: no TLS or connection/,
    );
    expect(result.output).toMatch(/certificate/);
  });

  it('still fails fast (10 attempts) for real HTTP answers that are not the healthy pair', () => {
    for (const curl of [
      [['503', 0]],
      [
        ['200', 0],
        ['503', 0],
      ],
      [
        ['404', 0],
        ['401', 0],
      ],
    ]) {
      const result = run({ curl });
      expect(result.ok).toBe(false);
      expect(result.curlCalls).toBe(20);
      expect(result.output).toMatch(/::error::The production health check failed/);
    }
  });

  it('fails fast (10 attempts) for a curl error outside the TLS window codes (M1-27b-d)', () => {
    // Only curl exits 6, 7, 28 and 35 (DNS, connection, timeout, TLS handshake;
    // release-and-deployment.md §4.5) get the long window. An empty reply (52) or a certificate
    // that does not verify (60) counts toward the 10 attempts.
    for (const exit of [52, 60]) {
      const result = run({ curl: [['000', exit]] });
      expect(result.ok).toBe(false);
      expect(result.curlCalls).toBe(20);
      expect(result.output).toMatch(/::error::The production health check failed/);
      expect(result.output).not.toMatch(/no TLS or connection yet/);
    }
  });

  it('keeps waiting past 10 attempts on a timeout (curl exit 28) while the handshake hangs', () => {
    const result = run({ curl: [...pairs(['000', 28], ['000', 28], 15), ['200', 0], ['401', 0]] });
    expect(result.ok, result.output).toBe(true);
    expect(result.curlCalls).toBe(32);
    expect(result.output).toMatch(/no TLS or connection yet/);
  });

  it('documents exactly the curl exits the workflow gives the long window (M1-27b-d)', () => {
    const codes = (text) =>
      [...text.matchAll(/\d+/g)].map((m) => Number(m[0])).sort((a, b) => a - b);
    const line = script.match(/^\s*connect_exits="([^"]*)"/m);
    expect(line, 'connect_exits in HEALTH-CHECK').not.toBeNull();
    const docs = readFileSync(
      new URL('../../docs/process/release-and-deployment.md', import.meta.url),
      'utf8',
    );
    const row = docs.split('\n').find((l) => l.startsWith('| Production checks |')) ?? '';
    const listed = row.match(/curl exit ([\d, or]+)\)/);
    expect(listed, 'curl exit list in §4.5 Production checks').not.toBeNull();
    expect(codes(listed[1])).toEqual(codes(line[1]));
  });

  it('refuses a 200 whose body is not {"ok":true}', () => {
    const result = run({
      curl: [
        ['200', 0],
        ['401', 0],
      ],
      body: '{"ok":false}',
    });
    expect(result.ok).toBe(false);
    expect(result.curlCalls).toBe(20);
  });
});

describe('production rollback (M1-27b-c)', () => {
  const copies = block('ROLLBACK');
  const script = copies[0] ?? '';
  const PREVIOUS = '0123abcd-0000-4000-8000-000000000001';
  const run = (fake, env = {}) =>
    runScripted(script, scriptedTools(fake), {
      PREVIOUS,
      RUN_ID: '1',
      DROP_PRODUCTION_ORIGIN: 'https://drop.example.test',
      CLOUDFLARE_API_TOKEN: 'test-token-value',
      ...env,
    });

  it('appears once, in the rollback step', () => {
    expect(copies.length).toBe(1);
    const production = job('deploy-production');
    expect(production.slice(production.indexOf('id: rollback'))).toMatch(/ROLLBACK-BEGIN/);
  });

  it('rolls back, checks the live version and health', () => {
    const result = run({ live: PREVIOUS, curl: [['200', 0]] });
    expect(result.ok, result.output).toBe(true);
    expect(result.github).toContain('result=rolled-back');
  });

  it('reports a rollback refused across a binding or storage change, and fails for the freeze', () => {
    const refused =
      'Invalid deployment: the version 0123abcd cannot be deployed because it has a resource that was modified: the version depends on DropState';
    const result = run({ rollback: { output: refused, exit: 1 }, live: 'other' });
    expect(result.ok).toBe(false);
    expect(result.github).toContain('result=impossible-binding-change');
    expect(result.output).toMatch(
      /::error::Rollback impossible across a binding\/storage change[^\n]*new version stays live[^\n]*owner action required/,
    );
    expect(result.summary).toMatch(/Rollback impossible across a binding\/storage change/);
    expect(result.output).not.toContain('test-token-value');
  });

  it('reports any other rollback failure as failed, not as impossible', () => {
    const result = run({ rollback: { output: 'Authentication error', exit: 1 } });
    expect(result.ok).toBe(false);
    expect(result.github).toContain('result=rollback-failed');
    expect(result.github).not.toContain('impossible');
  });

  it('does not treat an unrelated refusal as a binding change (M1-27b-d)', () => {
    for (const output of [
      'Version 0123abcd cannot be deployed because the API token lacks permission',
      'cannot be deployed because the account is over its limit',
      'Conflict: resource that was modified by another request; retry',
    ]) {
      const result = run({ rollback: { output, exit: 1 } });
      expect(result.ok).toBe(false);
      expect(result.github, output).toContain('result=rollback-failed');
      expect(result.github, output).not.toContain('impossible');
    }
  });

  it('fails when the recorded version is not live afterwards, or there is no target', () => {
    expect(run({ live: 'other' }).github).toContain('result=rollback-not-live');
    const none = run({}, { PREVIOUS: '' });
    expect(none.ok).toBe(false);
    expect(none.github).toContain('result=no-target');
  });
});

describe('freeze (M1-27b-c)', () => {
  const copies = block('FREEZE');
  const script = copies[0] ?? '';
  const run = (fake, env = {}) =>
    runScripted(script, scriptedTools(fake), {
      GH_TOKEN: 'test-token-value',
      REPOSITORY: '4thtech/agentlink',
      ...env,
    });

  it('appears once, in the freeze job, with the same token as before', () => {
    expect(copies.length).toBe(1);
    expect(job('freeze')).toMatch(/FREEZE-BEGIN/);
    expect(job('freeze')).toMatch(/GH_TOKEN: \$\{\{ secrets\.DEPLOY_FREEZE_TOKEN \}\}/);
  });

  it('sets DEPLOY_FREEZE and fails the run on purpose, with a summary line', () => {
    const result = run({});
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/::error::[^\n]*DEPLOY_FREEZE is set/);
    expect(result.summary).toMatch(/DEPLOY_FREEZE is set/);
  });

  it('fails loudly, naming the owner fix, when the token cannot set the variable', () => {
    const result = run({
      gh: { output: 'HTTP 403: Resource not accessible by personal access token', exit: 1 },
    });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(
      /::error::Setting DEPLOY_FREEZE failed[^\n]*DEPLOY_FREEZE_TOKEN[^\n]*Variables: read and write on 4thtech\/agentlink/,
    );
    expect(result.output).toMatch(/HTTP 403/);
    expect(result.summary).toMatch(/DEPLOY_FREEZE is NOT set[\s\S]*Variables: read and write/);
    expect(result.output).not.toContain('test-token-value');
  });

  it('fails when the token is not configured', () => {
    const result = run({}, { GH_TOKEN: '' });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/DEPLOY_FREEZE_TOKEN is not configured/);
  });
});
