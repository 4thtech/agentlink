// CI-E2E-BROWSER: the real-browser (Playwright) suites run in their own ci.yml job `e2e-browser`,
// not in `checks`. The move must not drop a test or run one twice: every test file runs in exactly
// one of the two jobs, the new job is required wherever `checks` would have run those tests, and it
// is covered by the auto-retry and the quarantine like `checks`. This file pins that wiring.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FLAKY_JOBS } from './auto-retry.mjs';
import { SCOPES } from './quarantine.mjs';
import {
  BROWSER_JOB_PACKAGES,
  BROWSER_TEST_PACKAGES,
  E2E_PACKAGE,
  PACKAGE_JOBS,
  browserSplitFilters,
  loadWorkspace,
  selectAffected,
  turboFilters,
} from './select-affected.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const yml = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
const job = (name) => {
  const start = yml.indexOf(`\n  ${name}:\n`);
  expect(start, name).toBeGreaterThan(-1);
  const rest = yml.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z0-9-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
};
const step = (jobText, name) => {
  const start = jobText.indexOf(`- name: ${name}\n`);
  expect(start, name).toBeGreaterThan(-1);
  const rest = jobText.slice(start);
  const next = rest.slice(1).search(/\n {6}- (name|uses):/);
  return next === -1 ? rest : rest.slice(0, next + 1);
};

const ws = loadWorkspace(root);
const dirOf = (name) => ws.find((p) => p.name === name)?.dir;
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
// The glob of the packages' vitest configs: `**/*browser.test.?(c|m)[jt]s?(x)`.
const BROWSER_FILE = /browser\.test\.[cm]?[jt]sx?$/;
const PLAYWRIGHT_IMPORT = /from ['"]playwright['"]/;

describe('the split of the test files', () => {
  it('names real workspace packages', () => {
    for (const name of BROWSER_JOB_PACKAGES) expect(dirOf(name), name).toBeDefined();
    expect(BROWSER_JOB_PACKAGES).toEqual([E2E_PACKAGE, ...BROWSER_TEST_PACKAGES]);
    expect([...PACKAGE_JOBS['e2e-browser']].sort()).toEqual([...BROWSER_JOB_PACKAGES].sort());
  });

  it('every package that splits its browser files reads the switch, with one glob and no projects', () => {
    for (const name of BROWSER_TEST_PACKAGES) {
      const config = readFileSync(join(root, dirOf(name), 'vitest.config.ts'), 'utf8');
      expect(config, name).toContain('process.env.AGENTLINK_CI_BROWSER_TESTS');
      expect(config, name).toContain("const BROWSER_TESTS = '**/*browser.test.?(c|m)[jt]s?(x)';");
      expect(config, name).toContain("browserTests === 'only'");
      expect(config, name).toContain('? { include: [BROWSER_TESTS] }');
      expect(config, name).toContain("browserTests === 'skip'");
      expect(config, name).toContain('{ exclude: [...configDefaults.exclude, BROWSER_TESTS] }');
      expect(config, name).toContain('...browserSplit,');
      // A `projects` config would not take the top-level include and exclude.
      expect(config, name).not.toMatch(/\bprojects\s*:/);
      // ... and holds a browser file for `only` to find (vitest fails on no files).
      expect(
        tracked.some((f) => f.startsWith(`${dirOf(name)}/`) && BROWSER_FILE.test(f)),
        name,
      ).toBe(true);
    }
  });

  it('every Playwright test file outside the e2e package is a split browser file', () => {
    const e2eDir = `${dirOf(E2E_PACKAGE)}/`;
    const splitDirs = BROWSER_TEST_PACKAGES.map((n) => `${dirOf(n)}/`);
    const playwrightTests = tracked.filter(
      (f) =>
        /\.test\.[cm]?[jt]sx?$/.test(f) &&
        !f.startsWith(e2eDir) &&
        !f.startsWith('tools/') &&
        PLAYWRIGHT_IMPORT.test(readFileSync(join(root, f), 'utf8')),
    );
    expect(playwrightTests.length).toBeGreaterThan(0);
    for (const f of playwrightTests) {
      expect(BROWSER_FILE.test(f), f).toBe(true);
      expect(
        splitDirs.some((d) => f.startsWith(d)),
        `${f} must be in BROWSER_TEST_PACKAGES`,
      ).toBe(true);
    }
  });

  it('turbo passes the switch to the test task', () => {
    const turbo = JSON.parse(readFileSync(join(root, 'turbo.json'), 'utf8'));
    expect(turbo.tasks.test.env).toContain('AGENTLINK_CI_BROWSER_TESTS');
  });
});

describe('ci.yml: checks leaves the browser suites to e2e-browser', () => {
  const tests = step(job('checks'), 'Unit tests');

  it('skips the split browser files and the e2e package, in both lanes', () => {
    expect(tests).toContain('AGENTLINK_CI_BROWSER_TESTS: skip');
    expect(tests).toContain(
      'pnpm exec turbo run test --continue --summarize \'--filter=!@4thtech-io/e2e\' -- "${reporters[@]}"',
    );
    expect(tests).toContain('$CHECKS_TEST_FILTERS -- "${reporters[@]}"');
    expect(tests).toContain('CHECKS_TEST_FILTERS: ${{ needs.detect.outputs.checks_test_filters }}');
    expect(tests).not.toContain('$TURBO_FILTERS');
  });

  it('the filtered lists drop e2e from checks and keep only the browser packages for e2e-browser', () => {
    const r = selectAffected({ files: ['packages/node/src/x.ts'], workspace: ws });
    expect(r.scope).toBe('filtered');
    const f = browserSplitFilters(r.packages);
    expect(f.checks).not.toContain(`--filter=${E2E_PACKAGE}`);
    expect(f.checks).toContain('--filter=@4thtech-io/node');
    expect(f.browser.split(' ').sort()).toEqual(
      r.packages
        .filter((p) => BROWSER_JOB_PACKAGES.includes(p))
        .map((p) => `--filter=${p}`)
        .sort(),
    );
    expect(f.browser).toContain(`--filter=${E2E_PACKAGE}`);
    // A package outside the browser set never reaches e2e-browser.
    expect(browserSplitFilters(['@4thtech-io/tools'])).toEqual({
      checks: '--filter=@4thtech-io/tools',
      browser: '',
    });
  });

  it('detect passes both filter lists through', () => {
    const detect = job('detect');
    expect(detect).toContain(
      'checks_test_filters: ${{ steps.affected.outputs.checks_test_filters }}',
    );
    expect(detect).toContain(
      'e2e_browser_filters: ${{ steps.affected.outputs.e2e_browser_filters }}',
    );
  });
});

describe('ci.yml: the e2e-browser job', () => {
  const browser = job('e2e-browser');
  const tests = step(browser, 'Browser tests');

  it('runs when checks would have run the browser suites, never for docs-only', () => {
    expect(browser).toContain(
      "if: needs.detect.outputs.has_skeleton == 'true' && needs.detect.outputs.docs_only != 'true' && needs.detect.outputs.has_test == 'true' && needs.detect.outputs.run_e2e_browser == 'true'",
    );
    expect(job('detect')).toContain(
      "run_e2e_browser: ${{ steps.affected.outputs.run_e2e_browser || 'true' }}",
    );
  });

  it('runs only the browser files, one package at a time, with the full-run list on a full run', () => {
    expect(tests).toContain('AGENTLINK_CI_BROWSER_TESTS: only');
    expect(tests).toContain(
      'pnpm exec turbo run test --continue --summarize --concurrency=1 $filters -- "${reporters[@]}"',
    );
    expect(browser).toContain(`FULL_BROWSER_FILTERS: ${turboFilters([...BROWSER_JOB_PACKAGES])}`);
    expect(tests).toContain('E2E_BROWSER_FILTERS: ${{ needs.detect.outputs.e2e_browser_filters }}');
  });

  it('evaluates the quarantine under its own scope and checks the list first', () => {
    expect(SCOPES.has('e2e-browser')).toBe(true);
    expect(tests).toContain(
      'node tools/ci/quarantine.mjs evaluate --scope e2e-browser --exit-code "$status" --turbo-runs .turbo/runs',
    );
    expect(browser).toContain('run: node tools/ci/quarantine.mjs check');
    expect(tests).toContain('tools/ci/vitest-run-reporter.mjs');
  });

  it('is on the auto-retry list by its flaky-prone steps', () => {
    for (const s of FLAKY_JOBS.CI['e2e-browser'].steps) expect(browser).toContain(`- name: ${s}\n`);
  });

  it('uploads the failure diagnostics with a pinned action, read-only, no secrets', () => {
    const upload = step(browser, 'Upload the failure diagnostics');
    expect(upload).toContain('if: failure()');
    expect(upload).toMatch(/uses: actions\/upload-artifact@[0-9a-f]{40} # v/);
    expect(upload).toContain('/tmp/agentlink-e2e-*.png');
    expect(upload).toContain('if-no-files-found: ignore');
    expect(browser).toContain('permissions:\n      contents: read\n');
    expect(browser).not.toMatch(/secrets\.|id-token|: write/);
    for (const u of browser.match(/uses: \S+/g) ?? []) {
      if (!u.startsWith('uses: ./')) expect(u).toMatch(/@[0-9a-f]{40}$/);
    }
  });
});

describe('ci.yml: ci-gate requires e2e-browser', () => {
  const gate = job('ci-gate');

  it('needs it and requires it in the heavy lane', () => {
    expect(gate).toMatch(/needs: \[[^\]]*\be2e-browser\b/);
    expect(gate).toMatch(/HEAVY_REQUIRED: checks e2e-browser /);
    expect(gate).toContain('[ "$job" != e2e-browser ]');
  });

  it('fails when checks ran with a browser selection but e2e-browser did not succeed', () => {
    expect(gate).toContain('RUN_E2E_BROWSER: ${{ needs.detect.outputs.run_e2e_browser }}');
    expect(gate).toContain('HAS_TEST: ${{ needs.detect.outputs.has_test }}');
    expect(gate).toContain(
      'if [ "$checks_result" != skipped ] && [ "$HAS_TEST" = true ] && [ "$RUN_E2E_BROWSER" = true ] && [ "$browser_result" != success ]; then',
    );
  });
});
