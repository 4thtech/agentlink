// Runs the real `pr-hygiene` script (the actions/github-script body in
// .github/workflows/pr-hygiene.yml) against fake pull requests, so a change to the section rules
// is tested, not just read. The template itself is checked against the script too: a PR body made
// from .github/pull_request_template.md, filled in, must pass.
// OPS-FAST-LANE-2 (owner Decision 54): every formality (title, sections, Docs impact wording, the
// class tick) is a warning; only AI attribution fails. `flagged` = a warning or an error names it.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(join(root, '.github/workflows/pr-hygiene.yml'), 'utf8');
const template = readFileSync(join(root, '.github/pull_request_template.md'), 'utf8');

// The script is the indented block after `script: |`.
const lines = workflow.split('\n');
const start = lines.findIndex((line) => /^\s+script: \|\s*$/.test(line));
const block = lines.slice(start + 1);
const indent = /^\s*/.exec(block[0])[0].length;
const source = block.map((line) => line.slice(indent)).join('\n');
const AsyncFunction = Object.getPrototypeOf(async function noop() {}).constructor;
const script = new AsyncFunction('context', 'core', source);

/** Runs the script on a fake pull request and returns { failed, errors, warnings }. */
async function check(body, title = 'CHORE docs check') {
  const errors = [];
  const warnings = [];
  let failed = false;
  const core = {
    info() {},
    warning: (message) => warnings.push(message),
    error: (message) => errors.push(message),
    setFailed: () => {
      failed = true;
    },
  };
  const repo = { full_name: '4thtech/agentlink' };
  const context = {
    payload: {
      pull_request: {
        title,
        body,
        user: { login: 'talirezun', type: 'User' },
        head: { ref: 'chore/x', repo },
        base: { repo },
      },
    },
  };
  await script(context, core);
  return { failed, errors, warnings };
}

/** A formality: never fails, always warns with the message. */
async function warns(body, title, text) {
  const r = await check(body, title);
  expect(r.failed).toBe(false);
  expect(r.errors).toEqual([]);
  expect(r.warnings.join('\n')).toContain(text);
  return r;
}

// A filled-in body: every section of the template, with real content.
const FILLED = {
  'Task ID & summary': 'CHORE: a docs check.',
  'Spec sections implemented': 'None',
  'Invariants touched': 'None',
  'Security class': '- [x] **S1**: sensitive\n- [ ] **S2**: critical',
  'Tests added': 'A test.',
  'Docs / spec updated': 'README.',
  'Docs impact': 'README Status and docs-site status page (regenerated from docs/status.yaml).',
  'Dependencies added': 'None',
  'Review requirements': '- [x] reviewed',
  'Independent review': 'pending',
  'Threat note': 'Short.',
  'Tests-first evidence': 'N/A',
  'Open questions': 'None',
  Checklist: '- [x] done',
};

function body(overrides = {}, order = Object.keys(FILLED)) {
  const sections = { ...FILLED, ...overrides };
  return order
    .filter((name) => sections[name] !== undefined)
    .map((name) => `## ${name}\n${sections[name]}\n`)
    .join('\n');
}

describe('pr-hygiene: the Docs impact section', () => {
  it('passes a body that lists the docs updated', async () => {
    expect(await check(body())).toEqual({ failed: false, errors: [], warnings: [] });
  });

  it.each([
    'none: internal refactor, no behaviour or interface change',
    'None: tooling only, no documentation affected',
    'README.md Status, CHANGELOG',
  ])('accepts "%s"', async (text) => {
    expect(await check(body({ 'Docs impact': text }))).toEqual({
      failed: false,
      errors: [],
      warnings: [],
    });
  });

  it('warns when the section is missing', async () => {
    await warns(body({ 'Docs impact': undefined }), undefined, 'Missing section "Docs impact"');
  });

  it('is not satisfied by the "Docs / spec updated" section, in either order', async () => {
    const without = Object.keys(FILLED).filter((name) => name !== 'Docs impact');
    await warns(
      body({ 'Docs impact': undefined }, without),
      undefined,
      'Missing section "Docs impact"',
    );
    // Docs impact first, and nothing under "Docs / spec updated": that one must still be asked for.
    const swapped = Object.keys(FILLED).filter((name) => name !== 'Docs / spec updated');
    await warns(
      body({ 'Docs / spec updated': undefined }, swapped),
      undefined,
      'Missing section "Docs / spec updated"',
    );
  });

  it('warns when the section is empty', async () => {
    await warns(
      body({ 'Docs impact': '<!-- only a comment -->' }),
      undefined,
      'Section "Docs impact" is empty',
    );
  });

  it.each([
    'None',
    'none.',
    'N/A',
    'TBD',
    '-',
    'none:',
    'None -',
    'none: <reason>',
    '<docs updated>',
  ])('warns on the empty answer "%s"', async (text) => {
    await warns(
      body({ 'Docs impact': text }),
      undefined,
      'Section "Docs impact": list the docs updated',
    );
  });

  it('warns, never fails, on the unedited template (comments only)', async () => {
    await warns(template, undefined, 'Section "Docs impact" is empty');
  });
});

describe('pr-hygiene: the existing rules still hold', () => {
  it('requires every other section', async () => {
    for (const name of Object.keys(FILLED).filter((n) => !FILLED[n].startsWith('- [x] **S'))) {
      if (
        // Not required by the script; and /^tests\b/ also matches "Tests-first evidence", so
        // dropping "Tests added" alone is not detected today (existing behaviour, unchanged here).
        ['Independent review', 'Threat note', 'Tests-first evidence', 'Tests added'].includes(name)
      )
        continue;
      const { failed, warnings } = await check(body({ [name]: undefined }));
      expect(failed, name).toBe(false);
      expect(warnings.length, name).toBeGreaterThan(0);
    }
  });

  it('asks for exactly one security class (a warning)', async () => {
    await warns(body({ 'Security class': '- [ ] S0\n- [ ] S1' }), undefined, 'tick exactly one');
    await warns(body({ 'Security class': '- [x] S0\n- [x] S1' }), undefined, 'tick exactly one');
  });

  it('asks for a task-ID title (a warning)', async () => {
    await warns(body(), 'update the docs', 'Title should start with a task ID');
  });

  it('accepts OPS-<WORD>[-<WORD>]-<n> task IDs (OPS-CI-3, OPS-FAST-LANE-2)', async () => {
    for (const t of [
      'OPS-CI-3 ci: x',
      'OPS-REL-12 release: x',
      'OPS-7 x',
      'OPS-L2 x',
      'OPS-FAST-LANE-2: x',
    ]) {
      expect(await check(body(), t), t).toEqual({ failed: false, errors: [], warnings: [] });
    }
  });

  it('warns on malformed OPS titles', async () => {
    for (const t of [
      'OPS-ci-3 x',
      'OPS- x',
      'OPS-CI x',
      'OPS-CI- x',
      'OPS-CI-x x',
      'OPS-FAST-LANE x',
    ]) {
      await warns(body(), t, 'Title should start with a task ID');
    }
  });

  it('keeps the existing accepted prefixes', async () => {
    for (const t of [
      'M1-5 x',
      'M1-9d x',
      'M2-GATE x',
      'DESIGN-D3 x',
      'DOCS: x',
      'CHORE: x',
      'DEPS: x',
    ]) {
      expect(await check(body(), t), t).toEqual({ failed: false, errors: [], warnings: [] });
    }
  });

  it('keeps the template headings the script requires', () => {
    for (const name of Object.keys(FILLED)) {
      if (name === 'Checklist') continue;
      expect(template.split('\n'), name).toContain(`## ${name}`);
    }
  });
});

describe('pr-hygiene: the one failure is AI attribution (AGENTS.md)', () => {
  it.each([
    'Co-authored-by: Claude <noreply@anthropic.com>',
    '  co-authored-by: GitHub Copilot <x@y>',
    'Generated with [Claude Code](https://example.invalid)',
    'generated by ChatGPT',
    'Generated with Anthropic Claude',
  ])('fails on "%s" in the body', async (line) => {
    const r = await check(`${body()}\n${line}\n`);
    expect(r.failed).toBe(true);
    expect(r.errors.join('\n')).toContain('AI attribution found');
  });

  it('fails on attribution in the title', async () => {
    expect((await check(body(), 'CHORE: x, generated with Claude')).failed).toBe(true);
  });

  it('does not fail on a human co-author or on prose about the rule', async () => {
    const text = `${body()}\nCo-authored-by: Denis <d@example.invalid>\nNo AI attribution anywhere (AGENTS.md).\n`;
    expect((await check(text)).failed).toBe(false);
  });

  it('fails even when every formality is missing too', async () => {
    const r = await check('Co-authored-by: Claude <x@y>', 'whatever');
    expect(r.failed).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});
