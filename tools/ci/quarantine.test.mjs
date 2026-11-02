import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluate, failuresOf, MAX_DAYS, MAX_ENTRIES, run, validate } from './quarantine.mjs';

// OPS-UNSTICK-A (report C8): a visible, expiring quarantine for evidence-backed flaky tests.
// A quarantined test still runs and is reported; while its entry is live, its failure alone does
// not fail the job. Any other failure still fails. An expired or malformed entry fails CI.

const ROOT = '/repo';
const TODAY = '2026-11-02';
const FILE = 'packages/node/src/sqlite-store.test.ts';
const TEST_ID = `${FILE} > SqliteStore > migrates a version 10 file`;

const entry = (overrides = {}) => ({
  id: TEST_ID,
  scope: 'node-os',
  reason: 'Times out on the Windows runner (26 s against 20 s).',
  evidence: 'CI run 41461928665 attempt 1, job 125333004643',
  owner: 'talirezun',
  added: '2026-11-02',
  expires: '2026-11-16',
  ...overrides,
});
const config = (...entries) => ({ entries });

const assertion = (title, status, ancestors = ['SqliteStore']) => ({
  ancestorTitles: ancestors,
  title,
  fullName: [...ancestors, title].join(' '),
  status,
  failureMessages: status === 'failed' ? ['Error: Test timed out in 20000ms.'] : [],
});
const report = (file, assertions, extra = {}) => ({
  testResults: [{ name: `${ROOT}/${file}`, status: 'passed', assertionResults: assertions, ...extra }],
});

describe('validate', () => {
  it('accepts a complete, live entry', () => {
    expect(validate(config(entry()), TODAY).problems).toEqual([]);
  });

  it('fails an expired entry, by name', () => {
    const { problems } = validate(config(entry()), '2026-11-17');
    expect(problems.join('\n')).toMatch(/expired/);
    expect(problems.join('\n')).toContain(TEST_ID);
    // The expiry day itself is still live.
    expect(validate(config(entry()), '2026-11-16').problems).toEqual([]);
  });

  it(`refuses an expiry more than ${MAX_DAYS} days after it was added, or before it`, () => {
    expect(validate(config(entry({ expires: '2026-11-17' })), TODAY).problems).not.toEqual([]);
    expect(validate(config(entry({ expires: '2026-11-01' })), TODAY).problems).not.toEqual([]);
  });

  it(`refuses more than ${MAX_ENTRIES} entries`, () => {
    const many = Array.from({ length: MAX_ENTRIES + 1 }, (_, i) =>
      entry({ id: `${FILE} > SqliteStore > test ${i}` }),
    );
    expect(validate(config(...many), TODAY).problems.join('\n')).toMatch(/at most/);
  });

  it('refuses missing or malformed fields and duplicates', () => {
    for (const bad of [
      { id: '' },
      { id: 'no separator' },
      { id: 'src/x.ts > a test' },
      { scope: 'everything' },
      { reason: '' },
      { evidence: '' },
      { owner: '' },
      { owner: 'not a login!' },
      { added: '2 Nov' },
      { expires: 'never' },
    ]) {
      expect(validate(config(entry(bad)), TODAY).problems, JSON.stringify(bad)).not.toEqual([]);
    }
    expect(validate(config(entry(), entry()), TODAY).problems.join('\n')).toMatch(/twice/);
    expect(validate({}, TODAY).problems).not.toEqual([]);
    expect(validate(null, TODAY).problems).not.toEqual([]);
  });
});

describe('failuresOf', () => {
  it('names failed tests by repo path and titles, and files that failed outside any test', () => {
    const r = {
      testResults: [
        {
          name: `${ROOT}/${FILE}`,
          status: 'failed',
          assertionResults: [
            assertion('migrates a version 10 file', 'failed'),
            assertion('passes', 'passed'),
          ],
        },
        { name: `${ROOT}/packages/node/src/boom.test.ts`, status: 'failed', assertionResults: [] },
      ],
    };
    expect(failuresOf(r, ROOT)).toEqual({
      failed: [TEST_ID],
      fileErrors: ['packages/node/src/boom.test.ts'],
    });
  });

  it('uses forward slashes for Windows paths', () => {
    const r = {
      testResults: [
        {
          name: 'D:\\a\\agentlink\\agentlink\\packages\\node\\src\\sqlite-store.test.ts',
          status: 'failed',
          assertionResults: [assertion('migrates a version 10 file', 'failed')],
        },
      ],
    };
    expect(failuresOf(r, 'D:\\a\\agentlink\\agentlink').failed).toEqual([TEST_ID]);
  });
});

describe('evaluate', () => {
  const failing = report(FILE, [assertion('migrates a version 10 file', 'failed')]);
  const go = (overrides) =>
    evaluate({
      config: config(entry()),
      today: TODAY,
      scope: 'node-os',
      exitCode: 1,
      reports: [{ file: 'r.json', report: failing }],
      root: ROOT,
      ...overrides,
    });

  it('passes, with a warning, when every failure is quarantined in this scope', () => {
    const result = go();
    expect(result.ok).toBe(true);
    expect(result.lines.join('\n')).toMatch(/::warning::.*quarantined/);
    expect(result.summary.join('\n')).toContain(TEST_ID);
    expect(result.summary.join('\n')).toContain('2026-11-16');
  });

  it('fails when any failure is not quarantined', () => {
    const mixed = report(FILE, [
      assertion('migrates a version 10 file', 'failed'),
      assertion('a real regression', 'failed'),
    ]);
    const result = go({ reports: [{ file: 'r.json', report: mixed }] });
    expect(result.ok).toBe(false);
    expect(result.lines.join('\n')).toMatch(/::error::.*a real regression/);
  });

  it('fails for a quarantined test outside its scope', () => {
    expect(go({ scope: 'checks' }).ok).toBe(false);
  });

  it('fails once the entry expired, even when the test passed', () => {
    expect(go({ today: '2026-11-17' }).ok).toBe(false);
    expect(go({ today: '2026-11-17', exitCode: 0, reports: [] }).ok).toBe(false);
  });

  it('fails when the command failed but no report names a failed test (a crash)', () => {
    expect(go({ reports: [] }).ok).toBe(false);
    expect(go({ reports: [{ file: 'r.json', report: null }] }).ok).toBe(false);
    expect(
      go({
        reports: [{ file: 'r.json', report: report(FILE, [assertion('x', 'passed')]) }],
      }).ok,
    ).toBe(false);
  });

  it('fails for a file that failed outside any test', () => {
    const broken = report(FILE, [assertion('migrates a version 10 file', 'failed')], {
      status: 'failed',
    });
    broken.testResults.push({
      name: `${ROOT}/packages/node/src/boom.test.ts`,
      status: 'failed',
      assertionResults: [],
    });
    expect(go({ reports: [{ file: 'r.json', report: broken }] }).ok).toBe(false);
  });

  it('passes a green command, and reports how a quarantined test did', () => {
    const passing = report(FILE, [assertion('migrates a version 10 file', 'passed')]);
    const result = go({ exitCode: 0, reports: [{ file: 'r.json', report: passing }] });
    expect(result.ok).toBe(true);
    expect(result.summary.join('\n')).toContain(TEST_ID);
  });
});

describe('the command line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quarantine-'));
  const file = join(dir, 'quarantine.json');
  writeFileSync(file, JSON.stringify(config(entry())));
  const reportFile = join(dir, 'report.json');
  writeFileSync(
    reportFile,
    JSON.stringify(report(FILE, [assertion('migrates a version 10 file', 'failed')])),
  );
  const go = (argv, env = {}) => {
    const lines = [];
    const code = run({ argv, env, root: ROOT, log: (l) => lines.push(l) });
    return { code, out: lines.join('\n') };
  };

  it('check: 0 while live, 1 once expired', () => {
    expect(go(['check', '--file', file, '--today', TODAY]).code).toBe(0);
    expect(go(['check', '--file', file, '--today', '2026-11-30']).code).toBe(1);
  });

  it('evaluate with explicit reports', () => {
    const args = ['evaluate', '--file', file, '--today', TODAY, '--scope', 'node-os'];
    expect(go([...args, '--exit-code', '1', '--report', reportFile]).code).toBe(0);
    expect(go([...args, '--exit-code', '1', '--report', join(dir, 'missing.json')]).code).toBe(1);
    expect(go([...args, '--exit-code', '0']).code).toBe(0);
  });

  // `checks` runs the tests through turbo (--continue --summarize): every failed task must have
  // left a vitest report whose failures are all quarantined.
  describe('evaluate with a turbo run summary', () => {
    const repo = mkdtempSync(join(tmpdir(), 'quarantine-repo-'));
    const runs = join(repo, '.turbo/runs');
    mkdirSync(runs, { recursive: true });
    mkdirSync(join(repo, 'packages/node'), { recursive: true });
    mkdirSync(join(repo, 'packages/core'), { recursive: true });
    const tasks = (...list) =>
      writeFileSync(join(runs, 'run.json'), JSON.stringify({ tasks: list }));
    const task = (pkg, exitCode) => ({
      taskId: `@4thtech-io/${pkg}#test`,
      package: `@4thtech-io/${pkg}`,
      directory: `packages/${pkg}`,
      execution: { exitCode },
    });
    writeFileSync(
      join(repo, 'packages/node/.vitest-report.json'),
      JSON.stringify({
        testResults: [
          {
            name: `${repo}/${FILE}`,
            status: 'failed',
            assertionResults: [assertion('migrates a version 10 file', 'failed')],
          },
        ],
      }),
    );
    const evalTurbo = () => {
      const lines = [];
      const code = run({
        argv: [
          'evaluate',
          '--file',
          file,
          '--today',
          TODAY,
          '--scope',
          'node-os',
          '--exit-code',
          '1',
          '--turbo-runs',
          runs,
        ],
        env: {},
        root: repo,
        log: (l) => lines.push(l),
      });
      return { code, out: lines.join('\n') };
    };

    it('passes when the only failed task failed only on quarantined tests', () => {
      tasks(task('node', 1), task('core', 0));
      expect(evalTurbo().code).toBe(0);
    });

    it('fails when another task failed without a report, or a task has no exit code', () => {
      tasks(task('node', 1), task('core', 1));
      expect(evalTurbo().code).toBe(1);
      tasks(task('node', 1), { taskId: 'x#test', package: 'x', directory: 'packages/core' });
      expect(evalTurbo().code).toBe(1);
    });

    it('fails when the summary is missing', () => {
      expect(
        run({
          argv: ['evaluate', '--file', file, '--today', TODAY, '--scope', 'node-os', '--exit-code', '1', '--turbo-runs', join(repo, 'nope')],
          env: {},
          root: repo,
          log: () => {},
        }),
      ).toBe(1);
    });
  });

  it('refuses unknown commands and arguments', () => {
    expect(go(['bogus']).code).toBe(1);
    expect(go(['evaluate', '--file', file, '--scope', 'node-os']).code).toBe(1);
    expect(go(['evaluate', '--file', file, '--exit-code', '1']).code).toBe(1);
  });
});

// The real list: it must stay valid and small; only evidence-backed flakes (OPS-UNSTICK-A).
describe('tools/ci/quarantine.json', () => {
  const real = JSON.parse(
    readFileSync(resolve(import.meta.dirname, 'quarantine.json'), 'utf8'),
  );

  it('is well formed (expiry itself is checked by `quarantine.mjs check` in CI, on the real date)', () => {
    const first = real.entries.map((e) => e.added).sort()[0] ?? TODAY;
    expect(validate(real, first).problems).toEqual([]);
  });

  it('every entry names a test file that exists', () => {
    for (const e of real.entries) {
      const path = e.id.split(' > ')[0];
      expect(() => readFileSync(resolve(import.meta.dirname, '../..', path)), path).not.toThrow();
    }
  });
});

describe('ci.yml wiring', () => {
  const ci = readFileSync(resolve(import.meta.dirname, '../../.github/workflows/ci.yml'), 'utf8');

  it('checks the list (expiry) and evaluates the unit tests and the node-os tests through it', () => {
    expect(ci).toContain('node tools/ci/quarantine.mjs check');
    expect(ci).toMatch(/node tools\/ci\/quarantine\.mjs evaluate --scope checks [^\n]*--turbo-runs/);
    expect(ci).toMatch(/node tools\/ci\/quarantine\.mjs evaluate --scope node-os [^\n]*--report/);
    expect(ci).toMatch(/turbo run test --continue --summarize/);
  });
});
