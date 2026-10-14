import { describe, expect, it } from 'vitest';
import {
  checkCoverage,
  checkPendingGate,
  checkPendingShrinks,
  diffSnapshots,
  pendingSuites,
  REQUIRED_RUNTIMES,
} from './rules.mjs';

const suites = [{ suite: 'placeholder-sha256', caseIds: ['a', 'b'] }];

function assertion(meta, status = 'passed') {
  return { status, meta: { vectors: meta } };
}

/** A report in which every runtime passed its identity test and every case. */
function fullReport(runtimes = REQUIRED_RUNTIMES) {
  return {
    testResults: runtimes.map((runtime) => ({
      assertionResults: [
        assertion({ kind: 'identity', runtime, detail: runtime }),
        assertion({ kind: 'case', runtime, suite: 'placeholder-sha256', caseId: 'a' }),
        assertion({ kind: 'case', runtime, suite: 'placeholder-sha256', caseId: 'b' }),
      ],
    })),
  };
}

describe('REQUIRED_RUNTIMES', () => {
  it('covers Node, the three Playwright browsers and workerd', () => {
    expect([...REQUIRED_RUNTIMES].sort()).toEqual(
      ['chromium', 'firefox', 'node', 'webkit', 'workerd'].sort(),
    );
  });
});

describe('checkCoverage', () => {
  it('accepts a run in which every runtime passed every case', () => {
    expect(checkCoverage(fullReport(), suites)).toEqual([]);
  });

  it('rejects a missing report', () => {
    expect(checkCoverage(undefined, suites)).toEqual(['the Vitest JSON report has no testResults']);
  });

  it('rejects a run with no committed suites', () => {
    expect(checkCoverage(fullReport(), [])).toContain('no vector suites found under test-vectors/');
  });

  it('rejects a run in which a runtime did not run at all', () => {
    const problems = checkCoverage(fullReport(['node', 'chromium', 'firefox', 'workerd']), suites);
    expect(problems).toEqual([
      'webkit: no passing runtime identity test',
      'webkit: placeholder-sha256: no passing result for a, b',
    ]);
  });

  it('rejects a silent fallback: the workers project reported Node', () => {
    const report = fullReport(['node', 'chromium', 'firefox', 'webkit', 'node']);
    expect(checkCoverage(report, suites)).toEqual([
      'workerd: no passing runtime identity test',
      'workerd: placeholder-sha256: no passing result for a, b',
    ]);
  });

  it('rejects a test that ran in an unknown runtime', () => {
    const report = fullReport();
    report.testResults[0].assertionResults.push(
      assertion({ kind: 'identity', runtime: 'unknown' }, 'failed'),
    );
    expect(checkCoverage(report, suites)).toEqual([
      'a vector test ran in an unexpected runtime "unknown"',
    ]);
  });

  it('rejects a failed identity test even when the cases passed', () => {
    const report = fullReport();
    report.testResults[1].assertionResults[0].status = 'failed';
    expect(checkCoverage(report, suites)).toEqual(['chromium: no passing runtime identity test']);
  });

  it.each(['failed', 'skipped', 'pending', 'todo'])('rejects a case that is %s', (status) => {
    const report = fullReport();
    report.testResults[4].assertionResults[2].status = status;
    expect(checkCoverage(report, suites)).toEqual([
      'workerd: placeholder-sha256: no passing result for b',
    ]);
  });

  it('rejects a suite with zero cases (IR-M0-9-1 F04)', () => {
    const empty = [...suites, { suite: 'empty-suite', caseIds: [] }];
    expect(checkCoverage(fullReport(), empty)).toEqual(['empty-suite: no cases']);
  });

  it('rejects a suite whose vector file has no cases array (IR-M0-9-1 F04)', () => {
    const broken = [...suites, { suite: 'broken-suite', caseIds: null }];
    expect(checkCoverage(fullReport(), broken)).toEqual(['broken-suite: no cases']);
  });

  it('rejects a committed case that no runtime ran', () => {
    const more = [{ suite: 'placeholder-sha256', caseIds: ['a', 'b', 'c'] }];
    const problems = checkCoverage(fullReport(), more);
    expect(problems).toHaveLength(REQUIRED_RUNTIMES.length);
    expect(problems[0]).toBe('node: placeholder-sha256: no passing result for c');
  });
});

describe('pending suites (M1-1h)', () => {
  const withPending = [...suites, { suite: 'hpke', caseIds: ['x', 'y'] }];

  /** fullReport plus a pending marker for `hpke` in the given runtimes. */
  function pendingReport(runtimes = REQUIRED_RUNTIMES, status = 'passed') {
    const report = fullReport();
    for (const file of report.testResults) {
      const runtime = file.assertionResults[0].meta.vectors.runtime;
      if (!runtimes.includes(runtime)) continue;
      file.assertionResults.push(
        assertion({ kind: 'pending', runtime, suite: 'hpke', detail: 'M1-1c' }, status),
      );
    }
    return report;
  }

  it('accepts a suite that every runtime reported as pending, and lists it', () => {
    const report = pendingReport();
    expect(checkCoverage(report, withPending)).toEqual([]);
    expect(pendingSuites(report)).toEqual(new Map([['hpke', 'M1-1c']]));
  });

  it('requires every case in a runtime that did not report the suite as pending', () => {
    const report = pendingReport(['node', 'chromium', 'firefox', 'webkit']);
    expect(checkCoverage(report, withPending)).toEqual([
      'workerd: hpke: no passing result for x, y',
    ]);
    expect(pendingSuites(report)).toEqual(new Map());
  });

  it('fails closed when the pending marker failed (the suite has a module)', () => {
    const report = pendingReport(REQUIRED_RUNTIMES, 'failed');
    const problems = checkCoverage(report, withPending);
    expect(problems).toHaveLength(REQUIRED_RUNTIMES.length);
    expect(problems[0]).toBe('node: hpke: no passing result for x, y');
  });

  it('fails a suite that reports pending and also ran cases', () => {
    const report = pendingReport();
    report.testResults[0].assertionResults.push(
      assertion({ kind: 'case', runtime: 'node', suite: 'hpke', caseId: 'x' }),
    );
    expect(checkCoverage(report, withPending)).toEqual(['hpke: reported as pending but ran cases']);
  });

  it('does not let a pending marker for one suite excuse another', () => {
    const report = pendingReport();
    report.testResults[2].assertionResults.splice(1, 1);
    expect(checkCoverage(report, withPending)).toEqual([
      'firefox: placeholder-sha256: no passing result for a',
    ]);
  });
});

describe('declared runtimes (IR-M1-1h-1 Q7)', () => {
  const nodeOnly = [...suites, { suite: 'keystore-file', caseIds: ['k'], runtimes: ['node'] }];

  it('requires the cases only in the declared runtimes', () => {
    const report = fullReport();
    report.testResults[0].assertionResults.push(
      assertion({ kind: 'case', runtime: 'node', suite: 'keystore-file', caseId: 'k' }),
    );
    expect(checkCoverage(report, nodeOnly)).toEqual([]);
  });

  it('still requires them in a declared runtime', () => {
    expect(checkCoverage(fullReport(), nodeOnly)).toEqual([
      'node: keystore-file: no passing result for k',
    ]);
  });

  it('rejects a result from a runtime the suite did not declare', () => {
    const report = fullReport();
    report.testResults[0].assertionResults.push(
      assertion({ kind: 'case', runtime: 'node', suite: 'keystore-file', caseId: 'k' }),
    );
    report.testResults[4].assertionResults.push(
      assertion({ kind: 'case', runtime: 'workerd', suite: 'keystore-file', caseId: 'k' }),
    );
    expect(checkCoverage(report, nodeOnly)).toEqual([
      'workerd: keystore-file: ran outside its declared runtimes',
    ]);
  });

  it('lists a node-only pending suite as pending', () => {
    const report = fullReport();
    report.testResults[0].assertionResults.push(
      assertion({ kind: 'pending', runtime: 'node', suite: 'keystore-file', detail: 'M1-1f' }),
    );
    expect(checkCoverage(report, nodeOnly)).toEqual([]);
    expect(pendingSuites(report, nodeOnly)).toEqual(new Map([['keystore-file', 'M1-1f']]));
  });
});

describe('checkPendingShrinks (IR-M1-1h-1 F2)', () => {
  const entry = { card: 'M1-1a', phase: 'M1a' };
  const head = (names) => ({ pending: new Map(names.map((n) => [n, entry])) });

  it('accepts a list that shrank, and new suites that arrive pending with their vectors', () => {
    const base = {
      pending: new Map([
        ['jcs', entry],
        ['hpke', entry],
      ]),
      suites: new Set(['jcs', 'hpke']),
    };
    expect(checkPendingShrinks(head(['jcs', 'stream']), base)).toEqual([]);
  });

  it('rejects a suite that was implemented on the base becoming pending again', () => {
    const base = { pending: new Map([['jcs', entry]]), suites: new Set(['jcs', 'hpke']) };
    expect(checkPendingShrinks(head(['jcs', 'hpke']), base)).toEqual([
      'hpke: has vectors on the base branch and was not pending there; pending suites only shrink',
    ]);
  });

  it('rejects an entry without a card or a phase', () => {
    const base = { pending: new Map(), suites: new Set() };
    expect(checkPendingShrinks({ pending: new Map([['x', { card: 'soon' }]]) }, base)).toEqual([
      'x: a pending entry needs a card (e.g. M1-1a) and a phase (e.g. M1a)',
    ]);
  });
});

describe('checkPendingGate (IR-M1-1h-1 F2)', () => {
  const head = {
    pending: new Map([
      ['jcs', { card: 'M1-1a', phase: 'M1a' }],
      ['stream', { card: 'M1-1d', phase: 'M1b' }],
    ]),
  };

  it('fails a release while a suite of the gated phase is pending', () => {
    expect(checkPendingGate(head, ['M1a'])).toEqual([
      'jcs is still pending (M1-1a, phase M1a): every M1a suite must be implemented before a release',
    ]);
  });

  it('passes when no pending suite belongs to a gated phase', () => {
    expect(
      checkPendingGate({ pending: new Map([['stream', head.pending.get('stream')]]) }, ['M1a']),
    ).toEqual([]);
  });
});

describe('diffSnapshots', () => {
  const before = new Map([
    ['placeholder-sha256/vectors.json', 'h1'],
    ['schema/vector-file.schema.json', 'h2'],
  ]);

  it('accepts an unchanged tree', () => {
    expect(diffSnapshots(before, new Map(before))).toEqual([]);
  });

  it('rejects a changed, deleted or created file', () => {
    const after = new Map([
      ['placeholder-sha256/vectors.json', 'h1-regenerated'],
      ['placeholder-sha256/extra.json', 'h3'],
    ]);
    expect(diffSnapshots(before, after)).toEqual([
      'test-vectors/placeholder-sha256/vectors.json changed during the run',
      'test-vectors/schema/vector-file.schema.json was deleted during the run',
      'test-vectors/placeholder-sha256/extra.json was created during the run',
    ]);
  });
});
