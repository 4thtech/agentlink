// DOCS-COMPACT-A: tests for check-spec-refs.mjs.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALLOWLIST, checkText, findMisses, headingAnchors } from './check-spec-refs.mjs';
import { baseAllowlist, readAllowlist, ratchet } from './docs/ratchet.mjs';

// Refs are built at run time so this file does not hold a miss itself (the check scans every file).
const ref = (spec, section) => `${spec} §${section}`;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const SPEC04 =
  '# 04\n\n## 2. Keys\n\n### 2.5 Owner operations and user presence\n\n## 7. Threat model\n\n## 7. Threat model\n';
const ctx = {
  specs: { '04': SPEC04 },
  exists: (p) => p === 'specs/04-security-and-crypto.md' || p === 'specs',
  anchorsOf: () => headingAnchors(SPEC04),
};

describe('headingAnchors', () => {
  it('slugs like GitHub, with suffixes for duplicates and nothing from code fences', () => {
    const a = headingAnchors('## 2.5 Owner operations & `presence`\n```\n# not\n```\n## A\n## A\n');
    expect([...a]).toEqual(['25-owner-operations--presence', 'a', 'a-1']);
  });
});

describe('checkText', () => {
  it('accepts existing sections and skips the private specs', () => {
    expect(checkText('x.ts', '// see 04 §2.5 and specs/04 §7, 01 §3 and 09 §1', ctx)).toEqual([]);
  });

  it('reports a missing section or spec', () => {
    const text = `// ${ref('04', '9.1')} and ${ref('13', '1')} and ${ref('05', '1')}`;
    expect(checkText('x.ts', text, ctx)).toEqual([
      `${ref('04', '9.1')}: no such section`,
      `${ref('05', '1')}: no spec 05`,
    ]);
  });

  it('checks links into the specs: file and anchor, relative and blob/main', () => {
    const md = [
      '[ok](../../specs/04-security-and-crypto.md#25-owner-operations-and-user-presence)',
      '[dup](https://github.com/4thtech/agentlink/blob/main/specs/04-security-and-crypto.md#7-threat-model-1)',
      '[bad anchor](../../specs/04-security-and-crypto.md#26-gone)',
      '[bad file](https://github.com/4thtech/agentlink/blob/main/specs/99-x.md)',
      '[private](../../specs/01-commercial-brief.md)',
      '[elsewhere](../other.md#x)',
    ].join('\n');
    expect(checkText('docs/guide/a.md', md, ctx)).toEqual([
      'link specs/04-security-and-crypto.md#26-gone: no such heading',
      'link specs/99-x.md: no such file',
    ]);
  });
});

describe('the repository', () => {
  it('has no spec reference miss outside the allowlist, and no stale allowlist entry', () => {
    const base = baseAllowlist(root, ALLOWLIST);
    const r = ratchet(findMisses(root), readAllowlist(root, ALLOWLIST), base);
    expect(r).toEqual({ fresh: [], stale: [], grown: [] });
  });
});
