// DOCS-COMPACT-A: tests for the version banner, threat-model table and llms.txt generators.
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  LLMS_NOTICE,
  extractThreatTable,
  renderBanner,
  renderThreatModel,
  strayStamps,
} from './generated.mjs';
import { run } from './status.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A copy of the parts of this repository the generators read (no screenshots). */
function copyRepo() {
  const root = mkdtempSync(join(tmpdir(), 'docs-gen-'));
  for (const rel of ['README.md', 'llms.txt', 'docs/status.yaml', 'docs/foundation', 'knowledge'])
    cpSync(join(repo, rel), join(root, rel), { recursive: true });
  cpSync(join(repo, 'docs-site'), join(root, 'docs-site'), {
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

  it('is generated into marked files, and then stray stamps fail the check', () => {
    const root = copyRepo();
    edit(root, 'docs-site/guide/README.md', (t) =>
      t.replace(
        /^# .*\n/,
        (h) => `${h}\n<!-- version-banner:start -->\n<!-- version-banner:end -->\n`,
      ),
    );
    const checked = run({ root, check: true });
    expect(checked.problems.some((p) => /guide\/README\.md is out of date/.test(p))).toBe(true);
    // The stamps still on the pages are reported once a banner exists.
    expect(
      checked.problems.filter((p) => /a version stamp outside/.test(p)).length,
    ).toBeGreaterThan(10);
    run({ root });
    expect(readFileSync(join(root, 'docs-site/guide/README.md'), 'utf8')).toMatch(
      /<!-- version-banner:start -->\n\*Applies to AgentLink \d+\.\d+\.\d+ \(pre-alpha, test networks\)\.\*\n<!-- version-banner:end -->/,
    );
  });
});

describe('threat model', () => {
  it('copies the 04 §7 table and makes bare section refs explicit', () => {
    const spec =
      '## 6. X\n\n## 7. Threat model\n\n| Threat | Mitigation |\n|---|---|\n| **A** | B (§3.5, 07 §4.2) |\n\n---\n\n## 8. Rules\n| not | this |\n';
    expect(extractThreatTable(spec)).toHaveLength(3);
    expect(renderThreatModel(spec)).toBe(
      '| Threat | Mitigation |\n|---|---|\n| **A** | B (04 §3.5, 07 §4.2) |',
    );
    expect(() => extractThreatTable('## 6. X\n')).toThrow(/no "## 7. Threat model"/);
  });

  it('renders every row of the real spec into a marked page', () => {
    const root = copyRepo();
    const page = 'docs-site/technical/concepts/threat-model.md';
    edit(
      root,
      page,
      (t) => `${t}\n<!-- threat-model-table:start -->\n<!-- threat-model-table:end -->\n`,
    );
    run({ root });
    const spec = readFileSync(join(root, 'docs/foundation/04-security-and-crypto.md'), 'utf8');
    const rows = extractThreatTable(spec).length;
    const block = readFileSync(join(root, page), 'utf8')
      .split('<!-- threat-model-table:start -->')[1]
      .split('<!-- threat-model-table:end -->')[0];
    expect(block.trim().split('\n')).toHaveLength(rows);
    expect(block).not.toMatch(/\(§\d/);
    expect(run({ root, check: true }).problems).toEqual([]);
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
    const { skipped } = run({ root, check: true });
    expect(skipped).toContain('llms.txt has no generated notice; skipped');
  });
});
