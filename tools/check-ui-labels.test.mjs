// DOCS-COMPACT-A: tests for check-ui-labels.mjs.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALLOWLIST, boldLabels, findMisses, stringLiterals, uiCorpus } from './check-ui-labels.mjs';
import { readAllowlist, ratchet } from './docs/ratchet.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'ui-labels-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

describe('parsing', () => {
  it('reads string literals, splitting template parts', () => {
    expect(
      stringLiterals(`a = 'Invite someone'; b = "Don\\"t"; c = \`Hi \${name}, Go to Home\`;`),
    ).toEqual(['Invite someone', 'Don"t', 'Hi ', ', Go to Home']);
  });

  it('finds bold phrases outside code and trims end punctuation', () => {
    expect(
      boldLabels('Click **Settings**. Then **Save:**\n`**not**`\n```\n**nor**\n```\n'),
    ).toEqual(['Settings', 'Save']);
  });
});

describe('findMisses', () => {
  it('reports labels missing from the UI strings, never matching across two literals', () => {
    const root = tree({
      'apps/local-ui/src/pages/home/strings.ts':
        "export const s = { a: 'Invite someone', b: 'Go to', c: 'Home' };",
      'apps/local-ui/src/pages/home/view.ts': "const x = 'Not a strings file';",
      'apps/desktop/src/main/tray.ts': "label: 'Quit AgentLink'",
      'apps/desktop/src/main/tray.test.ts': "label: 'Only in a test'",
      'docs-site/guide/SUMMARY.md': '# T\n',
      'docs-site/guide/a.md':
        '**Invite someone**, **Quit AgentLink**, **Go to Home**, **Not a strings file**, **Only in a test**, **Home**\n',
    });
    expect(uiCorpus(root)).toContain('\0Home\0');
    expect(findMisses(root)).toEqual(['Go to Home', 'Not a strings file', 'Only in a test']);
  });
});

describe('the repository', () => {
  it('has no new label miss and no stale allowlist entry', () => {
    const r = ratchet(findMisses(repo), readAllowlist(repo, ALLOWLIST), null);
    expect(r.fresh).toEqual([]);
    expect(r.stale).toEqual([]);
  });
});
