import { describe, expect, it } from 'vitest';
import {
  checkDecisionCoverage,
  checkDecisionIndex,
  checkSectionRefs,
  checkThreatMirror,
  checkWording,
  citesSpec04,
  isDecided,
  loadConfig,
  normalise,
  parseDecision,
  parseThreats,
  runChecks,
  sectionNumbers,
  sectionRefs,
  securityDocsWarning,
} from './check-security-docs.mjs';

const SPEC04 = [
  '# 04',
  '## 6. Forward secrecy',
  '## 7. Threat model',
  '',
  '| Threat | Mitigation |',
  '|---|---|',
  '| **Malicious relay** | Gift wraps |',
  '| **Crafted `agentlink://` link** (detail) | Pattern check |',
  '',
  '## 8. Engineering rules',
  '| **Not a threat** | row outside §7 |',
].join('\n');

const decision = (n, status, text) =>
  parseDecision(`# D-${n}: Title\n\n- **Status:** ${status}\n\n## Decision\n\n${text}\n`);

describe('threat mirror', () => {
  it('reads only the bold names of the 04 §7 table', () => {
    expect(parseThreats(SPEC04)).toEqual(['Malicious relay', 'Crafted `agentlink://` link']);
  });

  it('matches case, code marks and whitespace loosely, and reports what is missing', () => {
    const page = '| **crafted agentlink://   link** | … |';
    expect(checkThreatMirror(SPEC04, page)).toEqual({ count: 2, missing: ['Malicious relay'] });
    expect(checkThreatMirror(SPEC04, page, { 'Malicious relay': 'reason' }).missing).toEqual([]);
  });

  it('normalises typographic quotes', () => {
    expect(normalise('“A” ‘b’ **C**')).toBe('"a" \'b\' c');
  });
});

describe('decision coverage', () => {
  it('classifies decided entries and 04 citations', () => {
    expect(isDecided('Decided (owner, 14 Nov 2026)')).toBe(true);
    expect(isDecided('(1) decided (owner); (2) proposed')).toBe(true);
    expect(isDecided('Proposed, owner confirms at merge')).toBe(false);
    expect(citesSpec04('Spec: 04 §2.5; 08 §1')).toBe(true);
    expect(citesSpec04('see 04-security-and-crypto.md')).toBe(true);
    expect(citesSpec04('version 0.4 §2 and 104 §3')).toBe(false);
  });

  it('requires a reference or an allowlist entry for decided 04 entries only', () => {
    const ds = [
      decision(1, 'Decided', 'Spec: 04 §1'),
      decision(2, 'Decided', 'Spec: 06 §3'),
      decision(3, 'Proposed', 'Spec: 04 §3'),
      decision(4, 'Decided', 'Spec: 04 §4'),
      decision(5, 'Decided', 'Spec: 04 §5'),
    ];
    const r = checkDecisionCoverage(ds, 'see D-001 and D-5', { 'D-4': 'internal only' });
    expect(r.required).toBe(3);
    expect(r.missing).toEqual([]);
    expect(checkDecisionCoverage(ds, 'D-5', {}).missing).toEqual(['D-1', 'D-4']);
  });

  it('flags an allowlist entry that a page now references', () => {
    const ds = [decision(4, 'Decided', '04 §4')];
    expect(checkDecisionCoverage(ds, 'D-4', { 'D-4': 'x' }).staleAllow).toEqual(['D-4']);
  });

  it('checks the index against the files', () => {
    const index = '| [D-1](D-001.md) | a |\n| [D-2](D-003.md) | b |\n';
    expect(checkDecisionIndex(index, ['D-001.md', 'D-004.md'])).toEqual([
      'D-003.md: row ID D-2',
      'D-003.md: index row without a file',
      'D-004.md: no row in decisions/README.md',
    ]);
  });

  it('refuses a decision file without heading or status', () => {
    expect(() => parseDecision('# Something\n', 'D-009.md')).toThrow(/D-009\.md/);
  });
});

describe('wording and stamps', () => {
  it('refuses design and next-release labels on shipped subjects only', () => {
    const text = '> **Status: Design.** Ships in the next release.';
    expect(checkWording(text, { shipped: true, currentVersion: '0.5.9' })).toHaveLength(2);
    expect(checkWording(text, { shipped: false, currentVersion: '0.5.9' })).toEqual([]);
  });

  it('refuses a stamp older than the current minor', () => {
    const at = (v) =>
      checkWording(`Current for v${v}.`, { shipped: false, currentVersion: '0.6.1' });
    expect(at('0.5.10')).toHaveLength(1);
    expect(at('0.6.0')).toEqual([]);
    expect(at('0.7.0')).toEqual([]);
    expect(
      checkWording('Current for v0.9.0', { shipped: false, currentVersion: '1.0.0' }),
    ).toHaveLength(1);
  });
});

describe('section references', () => {
  const specs = { '04': '## 2. Keys\n### 2.5 Owner\n#### 2.5.4 Start over\n## 7. Threat model\n' };

  it('finds references and numbered headings', () => {
    expect(
      sectionRefs('see 04 §2.5, (04 §7) and b11 §17.4, v0.4 §1').map((r) => r.section),
    ).toEqual(['2.5', '7']);
    expect([...sectionNumbers(specs['04'])]).toEqual(['2', '2.5', '2.5.4', '7']);
  });

  it('reports a missing section or spec, and ignores the private specs', () => {
    expect(checkSectionRefs('04 §2.5.4 and 04 §2.6 and 13 §1 and 01 §2', specs)).toEqual([
      '04 §2.6: no such section',
    ]);
    expect(checkSectionRefs('06 §3', specs)).toEqual(['06 §3: no spec 06']);
  });
});

describe('PR hygiene warning', () => {
  const config = loadConfig();

  it('warns when a sensitive path changes without a security page', () => {
    const w = securityDocsWarning(['packages/crypto/src/x.ts', 'README.md'], '', config);
    expect(w).toMatch(/packages\/crypto\/src\/x\.ts/);
    expect(w).toMatch(/security-docs: none/);
  });

  it('is quiet with a security page, an explicit none, or no sensitive path', () => {
    const paths = ['docs/foundation/04-security-and-crypto.md'];
    expect(
      securityDocsWarning([...paths, 'docs-site/technical/concepts/threat-model.md'], '', config),
    ).toBeNull();
    expect(securityDocsWarning(paths, 'security-docs: none (typo fix)', config)).toBeNull();
    expect(securityDocsWarning(['docs-site/guide/README.md'], '', config)).toBeNull();
  });
});

describe('the repository', () => {
  it('passes every check', () => {
    const { problems } = runChecks();
    expect(problems).toEqual([]);
  });
});
