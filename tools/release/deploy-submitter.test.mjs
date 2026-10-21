import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readbackDiagnosisSuite, runReadback } from './readback-settings-suite.mjs';
import { commandLines, isDeployCall, runScripts, wranglerCalls } from './workflow-run-steps.mjs';

// M1-10c: the submitter and faucet deploy workflow (release-and-deployment.md §4.5, D-25, D-52,
// D-88), mirroring deploy-drop.yml (tools/release/deploy-drop.test.mjs). Structure checks on
// .github/workflows/deploy-submitter.yml as text, and its marked bash blocks (credential and
// Worker-secret check, logging read-back, head-of-main check, health check, rollback, freeze),
// extracted between their BEGIN/END markers and run against fake curl, gh, pnpm and sleep (no
// network, no Cloudflare). apps/submitter/test/smoke-config.test.ts ties the workflow's
// required-secret list to wrangler.toml.

const workflow = readFileSync(
  resolve(import.meta.dirname, '../../.github/workflows/deploy-submitter.yml'),
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
  return [
    ...workflow.matchAll(new RegExp(`# ${marker}-BEGIN\\n([\\s\\S]*?)\\n\\s*# ${marker}-END`, 'g')),
  ].map((m) => m[1].replace(/^ {10}/gm, ''));
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

/**
 * Fake `curl`, `sleep`, `pnpm` and `gh` driven by scripts (no network, no waiting).
 * curl: one [httpCode, exitCode, body?] per call, the last one repeating; `-o` gets the body.
 */
function scriptedTools({
  curl = [['200', 0]],
  body = '{}',
  rollback = { output: 'Rolled back', exit: 0 },
  live = '',
  gh = { output: '', exit: 0 },
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'submitter-scripted-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const q = (value) => JSON.stringify(String(value));
  const versions = live ? [{ version_id: live, percentage: 100 }] : [];
  curl.forEach(([, , callBody], index) =>
    writeFileSync(join(dir, `body-${String(index + 1)}.json`), callBody ?? body),
  );
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
      `if [ -n "$out" ] && [ "$out" != /dev/null ]; then cp ${q(dir)}/body-$n.json "$out"; fi`,
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
    [
      '#!/usr/bin/env bash',
      'if [ "${1:-}" = "api" ]; then',
      `  printf '%s\\n' ${q(gh.output)}`,
      'else',
      `  printf '%s\\n' ${q(gh.output)} >&2`,
      'fi',
      `exit ${gh.exit}`,
    ].join('\n'),
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

describe('deploy-submitter.yml structure', () => {
  it('runs on pushes to main and by dispatch, never on pull requests, with no default permissions', () => {
    expect(workflow).toMatch(/\non:\n {2}push:\n {4}branches: \[main\]/);
    expect(workflow).toMatch(/\n {2}workflow_dispatch:/);
    expect(workflow).not.toMatch(/pull_request/);
    expect(workflow).toMatch(/\npermissions: \{\}\n/);
  });

  it('triggers on the submitter, its workspace dependencies and the workflow itself', () => {
    const paths = workflow.slice(
      workflow.indexOf('    paths:\n'),
      workflow.indexOf('  workflow_dispatch:'),
    );
    for (const path of [
      'apps/submitter/**',
      'packages/chain/**',
      'packages/crypto/**',
      'packages/occ-v2-abi/**',
      'packages/types/**',
      'pnpm-lock.yaml',
      '.github/workflows/deploy-submitter.yml',
    ]) {
      expect(paths).toContain(`"${path}"`);
    }
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
        'rollback-rehearsal',
      ]),
    );
    for (const name of names) expect(job(name)).toMatch(/timeout-minutes: \d+/);
  });

  it('waits for green CI before anything deploys', () => {
    expect(job('ci-green')).toMatch(/wait-for-ci\.mjs/);
    expect(job('guard')).toMatch(/needs: ci-green/);
    expect(job('guard')).toMatch(/apps\/submitter\/wrangler\.toml/);
  });

  it('builds the bundle once, with no credentials, and deploys that artifact to both environments', () => {
    const build = job('build');
    expect(build).toMatch(/--dry-run/);
    expect(build).toMatch(/--filter='@4thtech-io\/submitter\.\.\.'/);
    expect(build).not.toMatch(/environment:|secrets\./);
    for (const name of ['deploy-staging', 'deploy-production']) {
      expect(job(name)).toMatch(/--no-bundle/);
      expect(job(name)).toMatch(/sha256sum -c/);
      expect(job(name)).toMatch(/name: submitter-bundle/);
    }
  });

  it('deploys staging in environment staging, frozen by DEPLOY_FREEZE and re-checked at start', () => {
    const staging = job('deploy-staging');
    expect(staging).toMatch(/environment: staging/);
    expect(staging).toMatch(/vars\.DEPLOY_FREEZE != 'true'/);
    expect(staging).toMatch(/Stop if DEPLOY_FREEZE is set/);
    expect(staging).toMatch(/--env staging/);
    expect(staging).toMatch(/concurrency:\n {6}group: deploy-submitter-staging/);
  });

  it('checks the Worker secrets by name before each deploy (owner-set, never in GitHub)', () => {
    for (const [name, worker] of [
      ['deploy-staging', 'agentlink-submitter-staging'],
      ['deploy-production', 'agentlink-submitter'],
    ]) {
      const body = job(name);
      expect(body).toMatch(/SECRET-CHECK-BEGIN/);
      expect(body).toMatch(new RegExp(`WORKER: ${worker}\\n`));
      expect(body).toMatch(/REQUIRED_SECRETS: \$\{\{ env\.SUBMITTER_REQUIRED_SECRETS \}\}/);
      expect(body).toMatch(/SHADOW_VARS: \$\{\{ env\.SUBMITTER_SHADOW_VARS \}\}/);
    }
    // The gas and faucet keys are Worker secrets only: GitHub never holds them (release §4.5, §6).
    expect(workflow).not.toMatch(/secrets\.SUBMITTER_/);
    expect(workflow).not.toMatch(/secrets\.[A-Z_]*(GAS|FAUCET|RPC|IP_KEY)/);
    // CI never sets a Worker secret: `wrangler secret` appears only in owner hints and comments.
    const executed = workflow
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .map((line) => line.replace(/"[^"]*"/g, '""'));
    expect(executed.filter((line) => /wrangler secret/.test(line))).toEqual([]);
  });

  it('runs the staging smoke without credentials, against the staging origin', () => {
    const smoke = job('smoke-staging');
    expect(smoke).toMatch(/SUBMITTER_SMOKE_URL: \$\{\{ needs\.deploy-staging\.outputs\.url \}\}/);
    expect(smoke).toMatch(/--project submitter-smoke-remote/);
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
    expect(production).toMatch(/concurrency:\n {6}group: deploy-submitter-production/);
  });

  it('records the rollback target, health-checks and rolls back automatically', () => {
    const production = job('deploy-production');
    expect(production).toMatch(/deployments status/);
    expect(production).toMatch(/wrangler rollback/);
    expect(production).toMatch(/\/v1\/health/);
    expect(production).toMatch(
      /if: \(failure\(\) \|\| cancelled\(\)\) && steps\.deploy\.outputs\.deployed == 'true'\n/,
    );
    const rollback = production.slice(production.indexOf('id: rollback'));
    expect(rollback).toMatch(/deployments status[\s\S]*"\$live" != "\$PREVIOUS"/);
  });

  it('changes production only while this commit is the head of main', () => {
    const production = job('deploy-production');
    const head = production.indexOf('id: head\n');
    const ready = production.indexOf('id: ready');
    const deploy = production.indexOf('id: deploy\n');
    expect(head).toBeGreaterThan(-1);
    expect(head).toBeLessThan(ready);
    expect(ready).toBeLessThan(deploy);
    expect(production).toMatch(/id: ready\n {8}if: steps\.head\.outputs\.current == 'true'/);
    const rollback = production.slice(
      production.indexOf('- name: Roll back to the recorded version'),
      production.indexOf('id: rollback\n') + 200,
    );
    expect(rollback).not.toMatch(/steps\.head/);
  });

  it('reads back the logging settings after each deploy (07 §7, I-7)', () => {
    for (const name of ['deploy-staging', 'deploy-production']) {
      const body = job(name);
      expect(body).toMatch(/READBACK-SETTINGS-BEGIN/);
      expect(body).toMatch(/\/script-settings/);
    }
  });

  it('sets DEPLOY_FREEZE when production failed after deploying', () => {
    const freeze = job('freeze');
    expect(freeze).toMatch(/environment: deploy-freeze/);
    expect(freeze).toMatch(/GH_TOKEN: \$\{\{ secrets\.DEPLOY_FREEZE_TOKEN \}\}/);
    expect(freeze).toMatch(/needs\.deploy-production\.outputs\.deployed == 'true'/);
  });

  it('writes a deploy record draft with no secrets', () => {
    const production = job('deploy-production');
    const record = production.slice(production.indexOf('- name: Write the deploy record draft'));
    expect(record).toMatch(/GITHUB_STEP_SUMMARY/);
    expect(record).toMatch(/Deploy record draft \(submitter and faucet Worker\)/);
    expect(record).not.toMatch(/CLOUDFLARE_API_TOKEN|secrets\./);
  });

  it('rehearses the rollback on staging by dispatch only', () => {
    const rehearsal = job('rollback-rehearsal');
    expect(rehearsal).toMatch(/if: inputs\.rehearse-rollback && /);
    expect(rehearsal).toMatch(/environment: staging/);
    expect(rehearsal).toMatch(/group: deploy-submitter-staging/);
    expect(rehearsal).toMatch(/wrangler rollback "\$PREVIOUS" --env staging/);
    expect(rehearsal).toMatch(/wrangler rollback "\$CURRENT" --env staging/);
  });

  it('never cancels a deploy in flight and never interpolates event data into run scripts', () => {
    expect(workflow).toMatch(/cancel-in-progress: false/);
    expect(workflow).not.toMatch(/cancel-in-progress: true/);
    expect(workflow).not.toMatch(/\$\{\{\s*github\.event\./);
    const runBlocks = [...workflow.matchAll(/run: \|\n((?: {10,}.*\n|\n)*)/g)].map((m) => m[1]);
    expect(runBlocks.length).toBeGreaterThan(5);
    for (const body of runBlocks) expect(body).not.toMatch(/\$\{\{/);
  });

  it('never prints the API token, the health body or a Worker secret, and never traces commands', () => {
    expect(workflow).not.toMatch(/(echo|printf)[^\n]*\$\{?CLOUDFLARE_API_TOKEN/);
    expect(workflow).not.toMatch(/(echo|printf)[^\n]*\$\{?auth\b/);
    expect(workflow).not.toMatch(/set -x|set -o xtrace/);
    // The health answer carries gas balances; it is parsed with jq, never printed.
    expect(workflow).not.toMatch(/cat [^\n]*health\.json/);
    expect(workflow).not.toMatch(/(echo|printf)[^\n]*\$\{?(SUBMITTER_(GAS|FAUCET|IP)|RPC_URL)/);
  });

  it('passes the submitter wrangler config to every wrangler call, for both environments', () => {
    const lines = workflow.split('\n');
    const calls = [];
    lines.forEach((line, index) => {
      if (/^\s*#/.test(line)) return;
      const code = line.replace(/"[^"]*::(notice|error)::[^"]*"/g, '""');
      if (!/(^|[\s"(=$])(pnpm exec |npx |pnpm dlx )?wrangler\s/.test(code)) return;
      if (/^\s*(echo|printf)\b/.test(code)) return;
      let step = index;
      while (step > 0 && !/^ {6}- name:/.test(lines[step])) step -= 1;
      const header = lines.slice(step, index).join('\n');
      calls.push({
        line: line.trim(),
        inSubmitter: /\n {8}working-directory: apps\/submitter\n/.test(header),
      });
    });
    expect(calls.length).toBeGreaterThanOrEqual(10);
    for (const call of calls) {
      expect(call.line).toMatch(
        /^(?:[A-Za-z_]+="[^"]*" )?(?:if [a-z]+="\$\(|live="\$\()?pnpm exec wrangler /,
      );
      expect(call.line).toMatch(/ --env (staging|production) /);
      expect(call.inSubmitter, call.line).toBe(true);
      expect(call.line, call.line).toContain(' --config wrangler.toml');
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

  // The secrets the workflow waits for are exactly the ones the Worker needs for the chains that
  // apps/submitter/wrangler.toml serves in each environment, and the shadow list is its vars.
  it('requires the Worker secrets that wrangler.toml implies, in both environments', () => {
    const toml = readFileSync(
      resolve(import.meta.dirname, '../../apps/submitter/wrangler.toml'),
      'utf8',
    );
    const listed = (name) =>
      (new RegExp(`\\n {2}${name}: "([A-Z0-9_ ]+)"\\n`).exec(workflow)?.[1] ?? '')
        .split(' ')
        .filter(Boolean)
        .sort();
    for (const env of ['staging', 'production']) {
      const section = toml.split(`[env.${env}.vars]\n`)[1]?.split('\n\n')[0] ?? '';
      const vars = Object.fromEntries(
        [...section.matchAll(/^([A-Z0-9_]+) = "([^"]*)"$/gm)].map((m) => [m[1], m[2]]),
      );
      const ids = (raw) => (raw ?? '').split(',').filter(Boolean);
      const required = [
        'SUBMITTER_IP_KEY',
        ...ids(vars.SUBMITTER_CHAINS).map((id) => `SUBMITTER_GAS_KEY_${id}`),
        ...ids(vars.SUBMITTER_FAUCET_CHAINS).map((id) => `SUBMITTER_FAUCET_KEY_${id}`),
      ].sort();
      expect(ids(vars.SUBMITTER_CHAINS).length, env).toBeGreaterThan(0);
      expect(listed('SUBMITTER_REQUIRED_SECRETS'), env).toEqual(required);
      expect(listed('SUBMITTER_SHADOW_VARS'), env).toEqual(Object.keys(vars).sort());
    }
  });

  it('names the production hostname of release §1.1 (D-28)', () => {
    expect(workflow).toMatch(
      /\n {2}SUBMITTER_PRODUCTION_ORIGIN: https:\/\/submit\.agentlink\.4thtech\.io\n/,
    );
  });
});

describe('no step turns logging on (OPS-PRIV-1, I-7)', () => {
  // The `run:` steps read as YAML (tools/release/workflow-run-steps.mjs), not by a regex over the
  // whole file. `--logpush` is wrangler's only command-line switch for a logging setting; Workers
  // Logs, traces and Tail Workers come from wrangler.toml, which every deploy must name.
  const scripts = runScripts(workflow);
  const lines = scripts.flatMap(({ script }) => commandLines(script));
  const calls = lines.flatMap((line) => wranglerCalls(line));

  it('finds the run steps and the wrangler calls in them', () => {
    expect(scripts.length).toBeGreaterThan(5);
    expect(calls.filter(isDeployCall).length).toBeGreaterThan(0);
  });

  it('runs wrangler only from run steps, never through a wrangler action', () => {
    const outside = workflow
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .flatMap((line) => wranglerCalls(line));
    expect(outside.length).toBe(calls.length);
    expect(workflow).not.toMatch(/uses:\s*cloudflare\/wrangler-action/);
  });

  it('every deploy, versions deploy or versions upload names the reviewed wrangler.toml', () => {
    for (const call of calls.filter(isDeployCall)) {
      expect(call.text).toMatch(/--config[ =]wrangler\.toml(?:\s|$)/);
    }
  });

  it('never tails a Worker and never passes --logpush', () => {
    for (const call of calls) expect(call.subcommand).not.toBe('tail');
    for (const line of lines) expect(line).not.toMatch(/--logpush\b/);
  });
});

describe('workflow run-step reader', () => {
  it('reads block, plain and quoted run values as mapping keys and sequence entries', () => {
    const source = [
      'jobs:',
      '  a:',
      '    steps:',
      '      - name: one',
      '        run: |',
      '          set -e',
      '          # a comment',
      '          pnpm exec wrangler deploy x.js \\',
      '            --env staging --config wrangler.toml',
      '      - run: npx wrangler versions upload',
      "      - run: 'wrangler tail'",
      '        env:',
      '          A: b',
    ].join('\n');
    const scripts = runScripts(source);
    expect(scripts.map((s) => s.line)).toEqual([5, 10, 11]);
    const lines = scripts.flatMap(({ script }) => commandLines(script));
    expect(lines).toEqual([
      'set -e',
      'pnpm exec wrangler deploy x.js --env staging --config wrangler.toml',
      'npx wrangler versions upload',
      'wrangler tail',
    ]);
    const calls = lines.flatMap((line) => wranglerCalls(line));
    expect(calls.map((c) => [c.subcommand, isDeployCall(c)])).toEqual([
      ['deploy', true],
      ['versions', true],
      ['tail', false],
    ]);
  });

  it('does not count wrangler.toml or WRANGLER_ variables as calls', () => {
    expect(wranglerCalls('WRANGLER_OUTPUT_FILE_PATH=x cat wrangler.toml')).toEqual([]);
  });

  it('throws on a plain run value continued on a more-indented line', () => {
    const source = [
      '      - run: pnpm exec wrangler deploy x.js',
      '          --env production',
    ].join('\n');
    expect(() => runScripts(source)).toThrow(/unsupported/);
  });

  it('joins the lines of a folded (>) block with spaces', () => {
    const source = [
      '      - run: >',
      '          pnpm exec wrangler deploy x.js',
      '          --env production',
      '      - run: echo done',
    ].join('\n');
    const scripts = runScripts(source);
    expect(scripts.map((s) => s.script)).toEqual([
      'pnpm exec wrangler deploy x.js --env production',
      'echo done',
    ]);
    const calls = commandLines(scripts[0].script).flatMap((line) => wranglerCalls(line));
    expect(calls[0]?.text).toBe('wrangler deploy x.js --env production');
  });

  it('fails closed on a run value it does not know', () => {
    expect(() => runScripts('      - run:\n          wrangler deploy')).toThrow(/unsupported/);
    expect(() => runScripts('        run: [a]')).toThrow(/unsupported/);
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
  const check = (body) => runReadback(script, body).ok;

  it('is the same block in staging and production', () => {
    expect(copies.length).toBe(2);
    expect(copies[1]).toBe(copies[0]);
  });

  it('accepts everything off, with the optional fields absent, null or empty', () => {
    expect(check({ success: true, result: off() })).toBe(true);
    expect(check({ success: true, result: off({ tail_consumers: null }) })).toBe(true);
    expect(
      check({ success: true, result: { logpush: false, observability: { enabled: false } } }),
    ).toBe(true);
    expect(
      check({
        success: true,
        result: off({
          observability: {
            enabled: false,
            logs: { enabled: false, invocation_logs: false, destinations: [] },
            traces: { enabled: false, destinations: [] },
          },
          streaming_tail_consumers: [],
        }),
      }),
    ).toBe(true);
  });

  // IR-OPS-PRIV-1-2: Cloudflare documents `observability.traces.enabled` as optional.
  it('accepts traces without `enabled`, and refuses traces enabled or exported', () => {
    const traces = (t) => off({ observability: { enabled: false, traces: t } });
    expect(check({ success: true, result: traces({}) })).toBe(true);
    expect(check({ success: true, result: traces({ destinations: [] }) })).toBe(true);
    expect(check({ success: true, result: traces({ enabled: true }) })).toBe(false);
    expect(check({ success: true, result: traces({ destinations: ['otel'] }) })).toBe(false);
  });

  // IR-OPS-PRIV-1-1 HIGH: a missing, null or renamed field is not "off"; the check fails closed.
  it('fails closed on an unexpected response shape', () => {
    const shapes = [
      { success: true },
      { success: true, result: null },
      { success: true, result: {} },
      { success: true, result: [] },
      { success: true, result: { tail_consumers: null } },
      { success: true, result: { observability: { enabled: false } } },
      { success: true, result: { log_push: false, observability: { enabled: false } } },
      { success: true, result: { logpush: false, observability: {} } },
      { success: true, result: { logpush: 'false', observability: { enabled: false } } },
      { success: true, result: { logpush: null, observability: { enabled: false } } },
      { success: true, result: off({ observability: { enabled: false, logs: 'off' } }) },
      { success: true, result: off({ observability: { enabled: false, logs: {} } }) },
      {
        success: true,
        result: off({ observability: { enabled: false, traces: { destinations: {} } } }),
      },
      {
        success: true,
        result: off({
          observability: { enabled: false, logs: { enabled: false, destinations: {} } },
        }),
      },
      { success: true, result: off({ tail_consumers: {} }) },
      { success: true, result: off({ streaming_tail_consumers: 'none' }) },
      { result: off() },
      { success: 'true', result: off() },
    ];
    for (const shape of shapes) expect(check(shape), JSON.stringify(shape)).toBe(false);
  });

  it('refuses Logpush, observability, invocation logs, traces or a Tail Worker', () => {
    expect(check({ success: true, result: off({ logpush: true }) })).toBe(false);
    expect(check({ success: true, result: off({ observability: { enabled: true } }) })).toBe(false);
    expect(
      check({
        success: true,
        result: off({ observability: { enabled: false, traces: { enabled: true } } }),
      }),
    ).toBe(false);
    expect(
      check({
        success: true,
        result: off({ observability: { enabled: false, logs: { enabled: true } } }),
      }),
    ).toBe(false);
    expect(
      check({
        success: true,
        result: off({
          observability: { enabled: false, logs: { enabled: false, invocation_logs: true } },
        }),
      }),
    ).toBe(false);
    expect(check({ success: true, result: off({ tail_consumers: [{ service: 'tail' }] }) })).toBe(
      false,
    );
  });

  // OPS-PRIV-1: streaming Tail Workers are Tail Workers too, and an export destination for logs
  // or traces sends them to a third party even when Workers Logs itself keeps nothing.
  it('refuses a streaming Tail Worker and a log or trace export destination', () => {
    expect(check({ success: true, result: off({ streaming_tail_consumers: null }) })).toBe(true);
    expect(
      check({ success: true, result: off({ streaming_tail_consumers: [{ service: 'tail' }] }) }),
    ).toBe(false);
    for (const part of ['logs', 'traces']) {
      expect(
        check({
          success: true,
          result: off({
            observability: { enabled: false, [part]: { enabled: false, destinations: [] } },
          }),
        }),
      ).toBe(true);
      expect(
        check({
          success: true,
          result: off({
            observability: { enabled: false, [part]: { enabled: false, destinations: ['otel'] } },
          }),
        }),
      ).toBe(false);
    }
  });

  it('refuses an API error and a response that is not JSON', () => {
    expect(check({ success: false, errors: [{ code: 10007 }] })).toBe(false);
    expect(check('not json')).toBe(false);
  });
});

readbackDiagnosisSuite('deploy-submitter.yml', block('READBACK-SETTINGS'));

describe('credential and Worker secret check', () => {
  const copies = block('SECRET-CHECK');
  const script = copies[0] ?? '';
  const ACCOUNT = '0123456789abcdef0123456789abcdef';
  const REQUIRED = 'SUBMITTER_IP_KEY SUBMITTER_GAS_KEY_84532 SUBMITTER_FAUCET_KEY_84532';
  const run = (fake, env = {}) => {
    const fakes = scriptedTools(fake);
    return runScripted(script, fakes, {
      CLOUDFLARE_API_TOKEN: 'test-token-value',
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      DEPLOY_ENV: 'staging',
      WORKER: 'agentlink-submitter-staging',
      REQUIRED_SECRETS: REQUIRED,
      SHADOW_VARS: 'SUBMITTER_CHAINS SUBMITTER_FAUCET_CHAINS',
      ...env,
    });
  };
  const listing = (names) =>
    JSON.stringify({ success: true, result: names.map((name) => ({ name, type: 'secret_text' })) });
  const all = REQUIRED.split(' ');

  it('is the same block in staging and production', () => {
    expect(copies.length).toBe(2);
    expect(copies[1]).toBe(copies[0]);
  });

  it('skips cleanly without credentials', () => {
    const result = run({}, { CLOUDFLARE_API_TOKEN: '' });
    expect(result.ok).toBe(true);
    expect(result.github).toContain('ready=false');
    expect(result.curlCalls).toBe(0);
  });

  it('skips cleanly while the Worker does not exist', () => {
    const missing = run({ curl: [['404', 0]], body: '{"success":false}' });
    expect(missing.ok).toBe(true);
    expect(missing.github).toContain('ready=false');
  });

  it('skips cleanly, naming every missing secret, until all required secrets exist', () => {
    for (const absent of all) {
      const result = run({ body: listing(all.filter((name) => name !== absent)) });
      expect(result.ok, result.output).toBe(true);
      expect(result.github).toContain('ready=false');
      expect(result.output).toContain(absent);
    }
    expect(run({ body: listing([]) }).output).toContain(all.join(' '));
  });

  it('is ready with every required secret set, optional RPC URLs allowed', () => {
    const result = run({ body: listing([...all, 'SUBMITTER_RPC_URLS_84532']) });
    expect(result.ok, result.output).toBe(true);
    expect(result.github).toContain('ready=true');
  });

  it('fails when a reviewed var also exists as a Worker secret (it would shadow the var)', () => {
    for (const shadow of ['SUBMITTER_CHAINS', 'SUBMITTER_FAUCET_CHAINS']) {
      const result = run({ body: listing([...all, shadow]) });
      expect(result.ok).toBe(false);
      expect(result.output).toMatch(new RegExp(`::error::[^\\n]*${shadow}`));
    }
  });

  it('fails loudly for a token the API refuses, an unreachable API or a malformed answer', () => {
    for (const code of ['401', '403', '500', '000', '']) {
      const result = run({ curl: [[code, 0]], body: '{"success":false}' });
      expect(result.ok).toBe(false);
      expect(result.github).not.toContain('ready=');
    }
    expect(run({ body: '<html>' }).ok).toBe(false);
  });

  it('fails for a malformed account ID or an empty required list, and never prints the token', () => {
    expect(run({}, { CLOUDFLARE_ACCOUNT_ID: 'not-an-id' }).ok).toBe(false);
    expect(run({ body: listing(all) }, { REQUIRED_SECRETS: '' }).ok).toBe(false);
    for (const code of ['200', '403', '404']) {
      expect(run({ curl: [[code, 0]], body: listing(all) }).output).not.toContain(
        'test-token-value',
      );
    }
  });
});

describe('head-of-main check', () => {
  const copies = block('HEAD-CHECK');
  const script = copies[0] ?? '';
  const SHA = 'a'.repeat(40);
  const run = (head, commit = SHA) =>
    runScripted(script, scriptedTools({ gh: { output: head, exit: 0 } }), {
      REPOSITORY: '4thtech/agentlink',
      COMMIT: commit,
    });

  it('appears once, before the production deploy only', () => {
    expect(copies.length).toBe(1);
  });

  it('is current when main still points at this commit, not once main moved on', () => {
    expect(run(SHA).github).toContain('current=true');
    const moved = run('b'.repeat(40));
    expect(moved.ok).toBe(true);
    expect(moved.github).toContain('current=false');
  });

  it('fails when the head of main cannot be read', () => {
    expect(run('').ok).toBe(false);
    expect(run('not-a-sha').ok).toBe(false);
  });
});

describe('production health check', () => {
  const copies = block('HEALTH-CHECK');
  const script = copies[0] ?? '';
  const HEALTHY = JSON.stringify({
    ok: true,
    chains: [{ chainId: 84532, available: true, gasBalance: '1000', queueDepth: 0 }],
  });
  const run = (fake) =>
    runScripted(script, scriptedTools({ body: HEALTHY, ...fake }), {
      SUBMITTER_PRODUCTION_ORIGIN: 'https://submit.example.test',
    });
  const pairs = (health, notarize, times) =>
    Array.from({ length: times }, () => [health, notarize]).flat();

  it('appears once, in the production health check step, with a step timeout', () => {
    expect(copies.length).toBe(1);
    const production = job('deploy-production');
    const step = production.slice(
      production.indexOf('id: health\n'),
      production.indexOf('HEALTH-CHECK-BEGIN'),
    );
    expect(step).toMatch(/timeout-minutes: (1[6-9]|20)\n/);
  });

  it('is healthy for /v1/health 200 with every chain available and an empty notarize 400', () => {
    const result = run({
      curl: [
        ['200', 0],
        ['400', 0],
      ],
    });
    expect(result.ok, result.output).toBe(true);
    expect(result.curlCalls).toBe(2);
  });

  it('never prints the health answer (it carries gas balances)', () => {
    const result = run({
      curl: [
        ['200', 0],
        ['400', 0],
      ],
    });
    expect(result.output).not.toContain('gasBalance');
    expect(result.output).not.toContain('1000');
  });

  it('refuses ok:false, an unavailable chain, no chains or a body that is not JSON', () => {
    for (const body of [
      JSON.stringify({ ok: false, chains: [{ chainId: 84532, available: false }] }),
      JSON.stringify({ ok: true, chains: [{ chainId: 84532, available: false }] }),
      JSON.stringify({ ok: true, chains: [] }),
      '<html>',
    ]) {
      const result = run({
        curl: [
          ['200', 0],
          ['400', 0],
        ],
        body,
      });
      expect(result.ok).toBe(false);
      expect(result.curlCalls).toBe(20);
    }
  });

  it('keeps waiting past 10 attempts while there is no TLS or connection yet (HTTP 000)', () => {
    const waiting = [...pairs(['000', 35], ['000', 35], 12), ...pairs(['000', 7], ['000', 7], 8)];
    const result = run({ curl: [...waiting, ['200', 0], ['400', 0]] });
    expect(result.ok, result.output).toBe(true);
    expect(result.curlCalls).toBe(42);
    expect(result.output).toMatch(/no TLS or connection yet/);
  });

  it('gives up after a bounded TLS window, naming the certificate', () => {
    const result = run({ curl: [['000', 35]] });
    expect(result.ok).toBe(false);
    expect(result.curlCalls).toBeGreaterThan(40);
    expect(result.curlCalls).toBeLessThanOrEqual(120);
    expect(result.output).toMatch(/::error::The production health check failed: no TLS/);
    expect(result.output).toMatch(/certificate/);
  });

  it('fails after 10 attempts for real HTTP answers that are not the healthy pair', () => {
    for (const curl of [
      [['503', 0]],
      [
        ['200', 0],
        ['503', 0],
      ],
      [
        ['404', 0],
        ['400', 0],
      ],
    ]) {
      const result = run({ curl });
      expect(result.ok).toBe(false);
      expect(result.curlCalls).toBe(20);
      expect(result.output).toMatch(/::error::The production health check failed/);
    }
  });
});

describe('production rollback', () => {
  const copies = block('ROLLBACK');
  const script = copies[0] ?? '';
  const PREVIOUS = '0123abcd-0000-4000-8000-000000000001';
  const run = (fake, env = {}) =>
    runScripted(script, scriptedTools(fake), {
      PREVIOUS,
      RUN_ID: '1',
      SUBMITTER_PRODUCTION_ORIGIN: 'https://submit.example.test',
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
      'the version 0123abcd cannot be deployed because it has a resource that was modified';
    const result = run({ rollback: { output: refused, exit: 1 }, live: 'other' });
    expect(result.ok).toBe(false);
    expect(result.github).toContain('result=impossible-binding-change');
    expect(result.output).toMatch(/::error::Rollback impossible across a binding\/storage change/);
    expect(result.summary).toMatch(/Rollback impossible/);
    expect(result.output).not.toContain('test-token-value');
  });

  it('reports any other rollback failure as failed, not as impossible', () => {
    const result = run({ rollback: { output: 'Authentication error', exit: 1 } });
    expect(result.ok).toBe(false);
    expect(result.github).toContain('result=rollback-failed');
  });

  it('fails when the recorded version is not live afterwards, or there is no target', () => {
    expect(run({ live: 'other' }).github).toContain('result=rollback-not-live');
    const none = run({}, { PREVIOUS: '' });
    expect(none.ok).toBe(false);
    expect(none.github).toContain('result=no-target');
  });
});

describe('freeze', () => {
  const copies = block('FREEZE');
  const script = copies[0] ?? '';
  const run = (fake, env = {}) =>
    runScripted(script, scriptedTools(fake), {
      GH_TOKEN: 'test-token-value',
      REPOSITORY: '4thtech/agentlink',
      ...env,
    });

  it('appears once, in the freeze job', () => {
    expect(copies.length).toBe(1);
    expect(job('freeze')).toMatch(/FREEZE-BEGIN/);
  });

  it('sets DEPLOY_FREEZE and fails the run on purpose, with a summary line', () => {
    const result = run({});
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/::error::[^\n]*submitter[^\n]*DEPLOY_FREEZE is set/);
    expect(result.summary).toMatch(/DEPLOY_FREEZE is set/);
  });

  it('fails loudly, naming the owner fix, when the token cannot set the variable', () => {
    const result = run({
      gh: { output: 'HTTP 403: Resource not accessible by personal access token', exit: 1 },
    });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(
      /::error::Setting DEPLOY_FREEZE failed[^\n]*Variables: read and write on 4thtech\/agentlink/,
    );
    expect(result.summary).toMatch(/DEPLOY_FREEZE is NOT set/);
    expect(result.output).not.toContain('test-token-value');
  });

  it('fails when the token is not configured', () => {
    const result = run({}, { GH_TOKEN: '' });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/DEPLOY_FREEZE_TOKEN is not configured/);
  });
});
