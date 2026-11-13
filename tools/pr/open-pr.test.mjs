// OPS-FAST-LANE-2 (owner Decision 54, item 3): open-pr.mjs fills in the paperwork. The generated
// body is run through the real pr-hygiene and review-gate scripts, so "it passes first time" is
// tested, and so is "S2 is never filled in for you".
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFragment } from '../release/roll-changelog.mjs';
import { classifyFiles, repoRoot, titleRule } from './classes.mjs';
import {
  buildBody,
  changesetStub,
  fragmentStub,
  needsChangeset,
  needsFragment,
  normalizeTitle,
  parseArgs,
  parseNameStatus,
  plan,
  resolveTask,
} from './open-pr.mjs';

const template = readFileSync(join(repoRoot, '.github/pull_request_template.md'), 'utf8');
const titleRe = titleRule();
const AsyncFunction = Object.getPrototypeOf(async function noop() {}).constructor;

function workflowScript(file, params) {
  const lines = readFileSync(join(repoRoot, '.github/workflows', file), 'utf8').split('\n');
  const start = lines.findIndex((line) => /^\s+script: \|\s*$/.test(line));
  const block = lines.slice(start + 1);
  const indent = /^\s*/.exec(block[0])[0].length;
  return new AsyncFunction(
    ...params,
    block.map((l) => (l.trim() === '' ? '' : l.slice(indent))).join('\n'),
  );
}
const hygiene = workflowScript('pr-hygiene.yml', ['context', 'core']);
const reviewGate = workflowScript('review-gate.yml', ['github', 'context', 'core']);

function fakeCore() {
  const out = { failed: false, errors: [], warnings: [] };
  const core = {
    info() {},
    warning: (m) => out.warnings.push(m),
    error: (m) => out.errors.push(m),
    setFailed: () => {
      out.failed = true;
    },
  };
  return { out, core };
}

async function runHygiene(title, body) {
  const { out, core } = fakeCore();
  const repo = { full_name: '4thtech/agentlink' };
  await hygiene(
    {
      payload: {
        pull_request: {
          title,
          body,
          user: { login: 'talirezun', type: 'User' },
          head: { ref: 'x', repo },
          base: { repo },
        },
      },
    },
    core,
  );
  return out;
}

async function runGate(files, body) {
  const { out, core } = fakeCore();
  const listFiles = Symbol('listFiles');
  const github = {
    rest: {
      pulls: {
        get: async () => ({
          data: {
            body,
            user: { login: 'talirezun' },
            head: { sha: 'a' },
            changed_files: files.length,
          },
        }),
        listFiles,
        listReviews: Symbol('listReviews'),
      },
    },
    paginate: async (fn) => (fn === listFiles ? files.map((filename) => ({ filename })) : []),
  };
  const context = {
    eventName: 'pull_request',
    repo: { owner: 'o', repo: 'r' },
    payload: { pull_request: { number: 1 } },
  };
  await reviewGate(github, context, core);
  return out;
}

const changed = (...paths) => paths.map((path) => ({ status: 'M', path }));

describe('normalizeTitle', () => {
  it.each([
    ['OPS-FAST-LANE-2', 'fast lane paperwork', 'OPS-FAST-LANE-2: fast lane paperwork'],
    [
      'OPS-FAST-LANE-2',
      'OPS-FAST-LANE-2: fast lane paperwork',
      'OPS-FAST-LANE-2: fast lane paperwork',
    ],
    ['OPS-FAST-LANE-2', 'ops-fast-lane-2 - fast lane', 'OPS-FAST-LANE-2: fast lane'],
    ['M1-9d', 'M1-9d sync', 'M1-9d: sync'],
    ['W5-WINDOWS', 'cmd /c npx entries', 'CHORE W5-WINDOWS: cmd /c npx entries'],
    ['W5-WINDOWS', 'CHORE W5-WINDOWS: cmd /c npx', 'CHORE W5-WINDOWS: cmd /c npx'],
    ['DOCS-README-046', 'Docs for the README', 'DOCS-README-046: Docs for the README'],
  ])('%s + "%s" → "%s"', (task, title, want) => {
    const got = normalizeTitle({ task, title, titleRe });
    expect(got).toBe(want);
    expect(titleRe.test(got)).toBe(true);
  });
});

describe('resolveTask', () => {
  it('prefers --task, then the title, then the branch', () => {
    expect(resolveTask({ task: 'X-1', title: 'OPS-CI-3 y', branch: 'z' })).toBe('X-1');
    expect(resolveTask({ title: 'OPS-CI-3: y', branch: 'z' })).toBe('OPS-CI-3');
    expect(resolveTask({ title: 'just words', branch: 'ops-fast-lane-2-open-pr' })).toBe(
      'OPS-FAST-LANE-2',
    );
    expect(resolveTask({ title: 'just words', branch: 'feature' })).toBe(null);
  });
});

describe('parseArgs', () => {
  it('reads the options', () => {
    expect(parseArgs(['--task', 'X-1', '--summary', 's', '--dry-run'])).toMatchObject({
      task: 'X-1',
      summary: 's',
      dryRun: true,
      base: 'main',
      changelogSection: 'Changed',
    });
  });
  it('refuses unknown options, missing values and odd bases', () => {
    expect(() => parseArgs(['--wat'])).toThrow();
    expect(() => parseArgs(['--task'])).toThrow();
    expect(() => parseArgs(['--task', '../x'])).toThrow(/one path segment/);
    expect(() => parseArgs(['--task', 'a/b'])).toThrow(/one path segment/);
    expect(() => parseArgs(['--base', 'main;rm'])).toThrow();
    expect(() => parseArgs(['--changelog-section', 'Misc'])).toThrow();
  });
  it('parses name-status output', () => {
    expect(parseNameStatus('M\ta.md\nD\tb c.md\n')).toEqual([
      { status: 'M', path: 'a.md' },
      { status: 'D', path: 'b c.md' },
    ]);
  });
});

describe('stubs', () => {
  it('a library change needs a changeset and a fragment', () => {
    const c = changed('packages/ui/src/a.tsx');
    expect(needsChangeset({ cwd: repoRoot, changed: c })).toBe(true);
    expect(needsFragment({ changed: c })).toBe(true);
  });
  it('an added changeset or fragment satisfies them', () => {
    const c = [
      ...changed('packages/ui/src/a.tsx'),
      { status: 'A', path: '.changeset/x.md' },
      { status: 'A', path: 'changelog.d/X.md' },
    ];
    expect(needsChangeset({ cwd: repoRoot, changed: c })).toBe(false);
    expect(needsFragment({ changed: c })).toBe(false);
  });
  it('tooling and plain docs need neither; a process doc needs a fragment only', () => {
    expect(
      needsChangeset({ cwd: repoRoot, changed: changed('tools/pr/open-pr.mjs', 'README.md') }),
    ).toBe(false);
    expect(needsFragment({ changed: changed('tools/pr/open-pr.mjs', 'README.md') })).toBe(false);
    expect(needsChangeset({ cwd: repoRoot, changed: changed('docs/process/audit-rules.md') })).toBe(
      false,
    );
    expect(needsFragment({ changed: changed('docs/process/audit-rules.md') })).toBe(true);
  });
  it('the stubs are valid', () => {
    expect(changesetStub({ task: 'X-1', summary: 'a  b' })).toBe('---\n---\n\nX-1: a b\n');
    for (const section of [
      'Added',
      'Changed',
      'Fixed',
      'Security',
      'Deprecated',
      'Removed',
      'none',
    ]) {
      const text = fragmentStub({ task: 'X-1', summary: 'Did a thing.', section, cls: 1 });
      expect(() => parseFragment({ name: 'X-1.md', text }), section).not.toThrow();
    }
  });
});

describe('the generated body', () => {
  const cases = [
    ['S0 docs', ['README.md', 'knowledge/a.md']],
    ['S1 library', ['packages/ui/src/a.tsx', 'packages/ui/src/a.test.tsx']],
    ['S1 sensitive', ['.github/workflows/pr-hygiene.yml', 'AGENTS.md']],
    ['S2 core', ['packages/core/src/a.ts']],
  ];

  it.each(cases)('%s: pr-hygiene passes with no warning', async (_, paths) => {
    const verdict = classifyFiles(paths);
    const body = buildBody({
      template,
      task: 'OPS-CI-3',
      summary: 'A change.',
      verdict,
      files: changed(...paths),
    });
    expect(await runHygiene('OPS-CI-3: a change', body)).toEqual({
      failed: false,
      errors: [],
      warnings: [],
    });
  });

  it.each(cases)('%s: ticks exactly the computed class', (_, paths) => {
    const verdict = classifyFiles(paths);
    const body = buildBody({
      template,
      task: 'X-1',
      summary: 's',
      verdict,
      files: changed(...paths),
    });
    const ticked = body.split('\n').filter((l) => /^- \[x\] \*\*S[012]/.test(l));
    expect(ticked).toHaveLength(1);
    expect(ticked[0]).toContain(`**${verdict.name}**`);
  });

  it('S0 and S1 outside the sensitive paths pass review-gate at once', async () => {
    for (const paths of [cases[0][1], cases[1][1]]) {
      const body = buildBody({
        template,
        task: 'X-1',
        summary: 's',
        verdict: classifyFiles(paths),
        files: changed(...paths),
      });
      expect(await runGate(paths, body), paths.join()).toEqual({
        failed: false,
        errors: [],
        warnings: [],
      });
    }
  });

  it('sensitive paths stay red until the IR line is recorded', async () => {
    const paths = cases[2][1];
    const body = buildBody({
      template,
      task: 'X-1',
      summary: 's',
      verdict: classifyFiles(paths),
      files: changed(...paths),
    });
    const r = await runGate(paths, body);
    expect(r.failed).toBe(true);
    expect(r.errors.join('\n')).toContain('no review report ID');
  });

  it('S2: the threat note and tests-first evidence are never generated', async () => {
    const paths = cases[3][1];
    const body = buildBody({
      template,
      task: 'X-1',
      summary: 's',
      verdict: classifyFiles(paths),
      files: changed(...paths),
    });
    expect(body).toMatch(/## Threat note\n\n## Tests-first evidence\n\n##/);
    const withIr = body.replace(/(## Independent review\n)[^\n]*/, '$1IR-X-1-1: PASS at abc');
    const r = await runGate(paths, withIr);
    expect(r.failed).toBe(true);
    expect(r.errors.join('\n')).toContain('"Threat note" section is empty');
    expect(r.errors.join('\n')).toContain('"Tests-first evidence" section is empty');
  });
});

describe('plan', () => {
  it('computes the title, class, stubs and body without writing', () => {
    const p = plan({
      cwd: repoRoot,
      opts: {
        task: 'OPS-TEST-1',
        summary: 'Lists things. More detail.',
        changelogSection: 'Changed',
      },
      changed: changed('packages/ui/src/a.tsx'),
      branch: 'ops-test-1',
      template,
      titleRe,
    });
    expect(p.title).toBe('OPS-TEST-1: Lists things');
    expect(p.verdict).toMatchObject({ name: 'S1', reviewRequired: false });
    expect(p.writes.map((w) => w.path)).toEqual([
      '.changeset/ops-test-1.md',
      'changelog.d/OPS-TEST-1.md',
    ]);
    expect(p.body).toContain('`.changeset/ops-test-1.md`');
  });

  it('refuses to run without a task ID', () => {
    expect(() =>
      plan({
        cwd: repoRoot,
        opts: { summary: 's', changelogSection: 'Changed' },
        changed: changed('README.md'),
        branch: 'x',
        template,
        titleRe,
      }),
    ).toThrow(/No task ID/);
  });
});

// UPD-3 (Fable L3, IR-UPD-1-1): the update pin every installed app trusts is a sensitive path, so a pin
// change needs the independent review and the owner's "merge" (as S2 already does for apps/desktop).
describe('the desktop update pin is a sensitive path', () => {
  it('root-key.json and root-key.updates-off.json are sensitive; other updater files are S2 only', () => {
    for (const path of [
      'apps/desktop/src/main/updater/root-key.json',
      'apps/desktop/src/main/updater/root-key.updates-off.json',
    ]) {
      const v = classifyFiles([path]);
      expect(v.sensitive, path).toBe(true);
      expect(v.cls).toBe(2);
      expect(v.reviewRequired).toBe(true);
    }
    expect(classifyFiles(['apps/desktop/src/main/updater/manifest.ts']).sensitive).toBe(false);
    expect(classifyFiles(['apps/desktop/src/main/updater/root-key.json.bak']).sensitive).toBe(false);
  });

  it('CODEOWNERS names the pin files explicitly', () => {
    const owners = readFileSync(join(repoRoot, '.github/CODEOWNERS'), 'utf8');
    expect(owners).toMatch(/^\/apps\/desktop\/src\/main\/updater\/root-key\*\.json\s+@talirezun/m);
  });
});
