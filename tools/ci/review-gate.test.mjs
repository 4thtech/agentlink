// CHORE-CI-DOCS-FASTLANE (owner decision D2, 2026-10-25): review-gate derives `docs-site/**` as S1
// (audit-rules.md §2.2, D-57), except the one generated status page, whose source docs/status.yaml
// is S0 and whose drift `tools/docs-status` checks. The path rules live inline in review-gate.yml,
// so the test lifts them out of the workflow text and runs them.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const yml = readFileSync(join(root, '.github', 'workflows', 'review-gate.yml'), 'utf8');

const start = yml.indexOf('const RULES = [');
const end = yml.indexOf('const files = await github.paginate');
const classify = new Function(`${yml.slice(start, end)}\nreturn classify;`)();

describe('review-gate path classes', () => {
  it('lifts the rules out of the workflow', () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(classify('docs/foundation/04-security-and-crypto.md')).toBe(2);
  });

  it('a docs-site file is S1', () => {
    expect(classify('docs-site/guide/getting-started.md')).toBe(1);
    expect(classify('docs-site/technical/project/other.md')).toBe(1);
  });

  it('the generated status page is S0', () => {
    expect(classify('docs-site/technical/project/status-and-roadmap.md')).toBe(0);
  });

  it('only that exact page is exempt', () => {
    expect(classify('docs-site/technical/project/status-and-roadmap.md.bak')).toBe(1);
    expect(classify('docs-site/x/technical/project/status-and-roadmap.md')).toBe(1);
  });

  it('other docs stay as before', () => {
    expect(classify('docs/process/ci-cd.md')).toBe(1);
    expect(classify('docs/lessons/x.md')).toBe(0);
    expect(classify('knowledge/a.md')).toBe(0);
    expect(classify('README.md')).toBe(0);
    expect(classify('changelog.d/X.md')).toBe(0);
  });
});
