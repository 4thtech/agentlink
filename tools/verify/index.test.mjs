// W4-VERIFY: the selection and summary logic of `pnpm verify`. The git and process parts are thin
// wrappers around these pure functions; the selection itself is tools/ci/select-affected.mjs.
import { describe, expect, it } from 'vitest';
import { buildPlan, parseChanged, pickBase, summarize } from './plan.mjs';

const ws = [
  { name: '@4thtech-io/types', dir: 'packages/types', deps: [], refs: [], playwright: false },
  {
    name: '@4thtech-io/local-ui',
    dir: 'apps/local-ui',
    deps: ['@4thtech-io/types'],
    refs: [],
    playwright: true,
  },
  {
    name: '@4thtech-io/e2e',
    dir: 'e2e',
    deps: ['@4thtech-io/local-ui'],
    refs: [],
    playwright: false,
  },
  { name: '@4thtech-io/tools', dir: 'tools', deps: [], refs: [], playwright: false },
  { name: '@4thtech-io/zzz', dir: 'packages/zzz', deps: [], refs: [], playwright: false },
];
const have = { journey: true, wave3: true };

describe('pickBase', () => {
  it('uses origin/wave-4 when the branch sits on top of it', () => {
    expect(pickBase({ hasWave4: true, wave4Closer: true })).toBe('origin/wave-4');
  });
  it('falls back to origin/main when there is no wave-4 or the branch is not on it', () => {
    expect(pickBase({ hasWave4: false, wave4Closer: false })).toBe('origin/main');
    expect(pickBase({ hasWave4: true, wave4Closer: false })).toBe('origin/main');
  });
});

describe('parseChanged', () => {
  it('merges the diff and the untracked files, drops blanks and duplicates, sorts', () => {
    expect(parseChanged('b.ts\na.ts\n\n', 'c.ts\na.ts\n')).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });
  it('accepts empty output', () => {
    expect(parseChanged('', '')).toEqual([]);
  });
});

describe('buildPlan', () => {
  it('filters one turbo call to the affected packages (same rules as CI)', () => {
    const plan = buildPlan({ files: ['apps/local-ui/src/a.ts'], workspace: ws, ...have });
    const turbo = plan.steps.find((s) => s.id === 'turbo');
    expect(turbo.args.slice(0, 6)).toEqual(['run', 'build', 'typecheck', 'lint', 'check', 'test']);
    expect(turbo.args).toContain('--filter=@4thtech-io/local-ui');
    expect(turbo.args).toContain('--filter=@4thtech-io/e2e');
    expect(turbo.args).toContain('--filter=@4thtech-io/tools');
    expect(turbo.args).not.toContain('--filter=@4thtech-io/types');
    expect(plan.scope).toBe('filtered');
  });
  it('runs everything for a global trigger (no filters)', () => {
    const plan = buildPlan({ files: ['package.json'], workspace: ws, ...have });
    const turbo = plan.steps.find((s) => s.id === 'turbo');
    expect(turbo.args.some((a) => a.startsWith('--filter'))).toBe(false);
    expect(plan.scope).toBe('full');
    expect(plan.steps.some((s) => s.id === 'journey')).toBe(true);
  });
  it('orders the steps: turbo, prettier, deps-check, journey', () => {
    const plan = buildPlan({ files: ['apps/local-ui/src/a.ts'], workspace: ws, ...have });
    expect(plan.steps.map((s) => s.id)).toEqual(['turbo', 'prettier', 'deps-check', 'journey']);
  });
  it('runs prettier on the changed files only, never on prose', () => {
    const plan = buildPlan({
      files: ['apps/local-ui/src/a.ts', 'docs/x.md', 'README.md', 'e2e/test/b.ts'],
      workspace: ws,
      ...have,
    });
    const p = plan.steps.find((s) => s.id === 'prettier');
    expect(p.args).toEqual([
      'exec',
      'prettier',
      '--check',
      '--ignore-unknown',
      'apps/local-ui/src/a.ts',
      'e2e/test/b.ts',
    ]);
  });
  it('skips prettier when no non-prose file changed', () => {
    const plan = buildPlan({ files: ['docs/x.md'], workspace: ws, ...have });
    expect(plan.steps.some((s) => s.id === 'prettier')).toBe(false);
  });
  it('selects the journey through e2e, and skips it when e2e is not selected', () => {
    const below = buildPlan({ files: ['packages/types/src/a.ts'], workspace: ws, ...have });
    expect(below.steps.some((s) => s.id === 'journey')).toBe(true);
    const lone = buildPlan({ files: ['packages/zzz/a.ts'], workspace: ws, ...have });
    expect(lone.steps.some((s) => s.id === 'journey')).toBe(false);
  });
  it('runs the journey with CI=1 and only the test files that exist', () => {
    const files = ['e2e/test/a.ts'];
    const both = buildPlan({ files, workspace: ws, journey: true, wave3: true });
    const j = both.steps.find((s) => s.id === 'journey');
    expect(j.env).toEqual({ CI: '1' });
    expect(j.args).toEqual([
      '--filter',
      '@4thtech-io/e2e',
      'exec',
      'vitest',
      'run',
      'test/journey',
      'test/local-app-wave3.test.ts',
    ]);
    const some = buildPlan({ files, workspace: ws, journey: false, wave3: true });
    expect(some.steps.find((s) => s.id === 'journey').args.slice(-1)).toEqual([
      'test/local-app-wave3.test.ts',
    ]);
    const none = buildPlan({ files, workspace: ws, journey: false, wave3: false });
    expect(none.steps.some((s) => s.id === 'journey')).toBe(false);
  });
  it('limits browser tests to Chromium unless all browsers are asked for', () => {
    const files = ['apps/local-ui/src/a.ts'];
    const local = buildPlan({ files, workspace: ws, ...have });
    expect(local.steps.find((s) => s.id === 'turbo').env).toEqual({ VERIFY_BROWSERS: 'chromium' });
    const all = buildPlan({ files, workspace: ws, ...have, allBrowsers: true });
    expect(all.steps.find((s) => s.id === 'turbo').env).toEqual({});
  });
  it('treats an empty diff as a full run', () => {
    expect(buildPlan({ files: [], workspace: ws, ...have }).scope).toBe('full');
  });
});

describe('summarize', () => {
  const results = [
    { id: 'turbo', label: 'turbo build typecheck lint check test', ok: true, ms: 61_000 },
    { id: 'prettier', label: 'prettier --check (3 files)', ok: true, ms: 1_200 },
    { id: 'deps-check', label: 'deps-check', ok: true, ms: 800 },
  ];
  it('is a short PR-ready block with base, scope, steps and total', () => {
    const text = summarize({
      base: 'origin/wave-4',
      files: ['a', 'b'],
      scope: 'filtered',
      packages: ['@4thtech-io/tools', '@4thtech-io/types'],
      results,
      skipped: [],
    });
    expect(text.split('\n').length).toBeLessThanOrEqual(30);
    expect(text).toContain('origin/wave-4');
    expect(text).toContain('2 files');
    expect(text).toContain('PASS');
    expect(text).toContain('1m 03s');
    expect(text).toMatch(/turbo build typecheck lint check test\s+ok\s+1m 01s/);
  });
  it('names the failed step and the steps that did not run', () => {
    const text = summarize({
      base: 'origin/main',
      files: ['a'],
      scope: 'full',
      packages: [],
      results: [{ id: 'turbo', label: 'turbo', ok: false, ms: 5_000 }],
      skipped: ['prettier', 'deps-check'],
    });
    expect(text).toContain('FAIL');
    expect(text).toContain('not run');
    expect(text).toContain('prettier');
  });
  it('stays within 30 lines for a long package list', () => {
    const packages = Array.from({ length: 80 }, (_, i) => `@4thtech-io/p${i}`);
    const text = summarize({
      base: 'origin/main',
      files: Array.from({ length: 500 }, (_, i) => `f${i}`),
      scope: 'filtered',
      packages,
      results,
      skipped: [],
    });
    expect(text.split('\n').length).toBeLessThanOrEqual(30);
    expect(text).toContain('500 files');
  });
});
