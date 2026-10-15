// Runs the real `pr-hygiene` script (the actions/github-script body in
// .github/workflows/pr-hygiene.yml) against fake pull requests, so a change to the section rules
// is tested, not just read. The template itself is checked against the script too: a PR body made
// from .github/pull_request_template.md, filled in, must pass.

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

/** Runs the script on a fake pull request and returns { failed, errors }. */
async function check(body, title = 'CHORE docs check') {
  const errors = [];
  let failed = false;
  const core = {
    info() {},
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
  return { failed, errors };
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
    expect(await check(body())).toEqual({ failed: false, errors: [] });
  });

  it.each([
    'none: internal refactor, no behaviour or interface change',
    'None: tooling only, no documentation affected',
    'README.md Status, CHANGELOG',
  ])('accepts "%s"', async (text) => {
    expect((await check(body({ 'Docs impact': text }))).failed).toBe(false);
  });

  it('fails when the section is missing', async () => {
    const { failed, errors } = await check(body({ 'Docs impact': undefined }));
    expect(failed).toBe(true);
    expect(errors.join('\n')).toContain('Missing section "Docs impact"');
  });

  it('is not satisfied by the "Docs / spec updated" section, in either order', async () => {
    const without = Object.keys(FILLED).filter((name) => name !== 'Docs impact');
    expect((await check(body({ 'Docs impact': undefined }, without))).failed).toBe(true);
    // Docs impact first, and nothing under "Docs / spec updated": that one must still be required.
    const swapped = Object.keys(FILLED).filter((name) => name !== 'Docs / spec updated');
    const result = await check(body({ 'Docs / spec updated': undefined }, swapped));
    expect(result.failed).toBe(true);
    expect(result.errors.join('\n')).toContain('Missing section "Docs / spec updated"');
  });

  it('fails when the section is empty', async () => {
    const { failed, errors } = await check(body({ 'Docs impact': '<!-- only a comment -->' }));
    expect(failed).toBe(true);
    expect(errors.join('\n')).toContain('Section "Docs impact" is empty');
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
  ])('refuses the empty answer "%s"', async (text) => {
    const { failed, errors } = await check(body({ 'Docs impact': text }));
    expect(failed).toBe(true);
    expect(errors.join('\n')).toContain('Section "Docs impact": list the docs updated');
  });

  it('fails on the unedited template (comments only)', async () => {
    const { failed, errors } = await check(template);
    expect(failed).toBe(true);
    expect(errors.join('\n')).toContain('Section "Docs impact" is empty');
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
      const { failed, errors } = await check(body({ [name]: undefined }));
      expect(failed, name).toBe(true);
      expect(errors.length, name).toBeGreaterThan(0);
    }
  });

  it('requires exactly one security class', async () => {
    expect((await check(body({ 'Security class': '- [ ] S0\n- [ ] S1' }))).failed).toBe(true);
    expect((await check(body({ 'Security class': '- [x] S0\n- [x] S1' }))).failed).toBe(true);
  });

  it('requires a task-ID title', async () => {
    expect((await check(body(), 'update the docs')).failed).toBe(true);
  });

  it('keeps the template headings the script requires', () => {
    for (const name of Object.keys(FILLED)) {
      if (name === 'Checklist') continue;
      expect(template.split('\n'), name).toContain(`## ${name}`);
    }
  });
});
