// DOCS-COMPACT-A: tests for the version banner and llms.txt generators.
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LLMS_NOTICE, renderBanner, strayStamps } from './generated.mjs';
import { run } from './status.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A copy of the parts of this repository the generators read (no screenshots). */
function copyRepo() {
  const root = mkdtempSync(join(tmpdir(), 'docs-gen-'));
  for (const rel of ['README.md', 'llms.txt', 'docs/status.yaml', 'specs', 'knowledge'])
    cpSync(join(repo, rel), join(root, rel), { recursive: true });
  cpSync(join(repo, 'docs'), join(root, 'docs'), {
    recursive: true,
    filter: (src) => !/\.(png|jpe?g|gif|webp|svg)$/i.test(src),
  });
  return root;
}

const edit = (root, rel, fn) =>
  writeFileSync(join(root, rel), fn(readFileSync(join(root, rel), 'utf8')));

describe('version banner', () => {
  it('renders the version, stage and networks', () => {
    expect(renderBanner({ version: 'v0.5.11' })).toBe(
      '*Applies to AgentLink 0.5.11 (pre-alpha, test networks).*',
    );
    expect(renderBanner({ version: 'v1.0.0', stage: 'beta', networks: 'main' })).toBe(
      '*Applies to AgentLink 1.0.0 (beta, main networks).*',
    );
  });

  it('finds stamps outside the banner only', () => {
    const files = [
      [
        'a.md',
        '<!-- version-banner:start -->\nApplies to AgentLink 0.5.11\n<!-- version-banner:end -->\n',
      ],
      ['b.md', '# B\n\n*Applies to AgentLink 0.5.8, a pre-alpha release.*\n'],
      ['c.md', 'Applies to AgentLink when ready (no number)\n'],
    ];
    expect(strayStamps(files)).toEqual([
      'b.md:3: *Applies to AgentLink 0.5.8, a pre-alpha release.*',
    ]);
  });

  it('keeps the marked banner current, and a stray stamp fails the check', () => {
    const root = copyRepo();
    const readme = 'docs/guide/README.md';
    edit(root, readme, (t) =>
      t.replace(/Applies to AgentLink \d+\.\d+\.\d+/, 'Applies to AgentLink 0.0.1'),
    );
    edit(root, 'docs/guide/pricing.md', (t) => `${t}\n*Applies to AgentLink 0.5.8.*\n`);
    const checked = run({ root, check: true });
    expect(checked.problems.some((p) => /guide\/README\.md is out of date/.test(p))).toBe(true);
    expect(checked.problems.filter((p) => /a version stamp outside/.test(p))).toEqual([
      expect.stringMatching(/^docs\/guide\/pricing\.md:\d+: /),
    ]);
    run({ root });
    expect(readFileSync(join(root, readme), 'utf8')).toMatch(
      /<!-- version-banner:start -->\n\*Applies to AgentLink \d+\.\d+\.\d+ \(pre-alpha, test networks\)\.\*\n<!-- version-banner:end -->/,
    );
  });
});

describe('llms.txt', () => {
  it('is generated whole once it carries the notice, then kept in sync', () => {
    const root = copyRepo();
    writeFileSync(join(root, 'llms.txt'), `${LLMS_NOTICE}\n`);
    expect(run({ root, check: true }).problems).toContain(
      'llms.txt is out of date with the docs; run: node tools/docs-status/index.mjs',
    );
    run({ root });
    const text = readFileSync(join(root, 'llms.txt'), 'utf8');
    expect(text.startsWith('# AgentLink\n\n> ')).toBe(true);
    expect(text).toContain(LLMS_NOTICE);
    expect(text).toContain('releases/latest/download/agentlink-knowledge.md');
    expect(text).toContain('## User guide');
    expect(text).toContain('- [What is AgentLink?](https://wiki.4thtech.io/products/agentlink)');
    expect(text).toContain('## Technical docs');
    expect(run({ root, check: true }).problems).toEqual([]);
  });

  it('is left alone without the notice', () => {
    const root = copyRepo();
    writeFileSync(join(root, 'llms.txt'), '# Hand-written\n');
    const { skipped } = run({ root, check: true });
    expect(skipped).toContain('llms.txt has no generated notice; skipped');
  });
});
