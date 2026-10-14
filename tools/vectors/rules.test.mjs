import { describe, expect, it } from 'vitest';
import {
  cardPhases,
  checkCoverage,
  checkPendingCards,
  checkPendingGate,
  checkPendingCaseShrinks,
  checkPendingShrinks,
  diffSnapshots,
  pendingCaseEntries,
  pendingCases,
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
  const nodeOnly = [
    ...suites,
    { suite: 'keystore-file', caseIds: ['k'], runtimes: ['node'], runtimesSource: '04 §2.8' },
  ];

  it('rejects a narrowed suite that is not an allowed exception (IR-M1-1h-2 F-E)', () => {
    const other = [
      ...suites,
      { suite: 'hpke', caseIds: ['x'], runtimes: ['node'], runtimesSource: 'r' },
    ];
    expect(checkCoverage(fullReport(), other)).toContain(
      'hpke: declares runtimes but is not in RUNTIME_EXCEPTIONS',
    );
  });

  it('rejects unknown runtime names and a missing reason', () => {
    const bad = [
      ...suites,
      { suite: 'keystore-file', caseIds: ['k'], runtimes: ['deno'], runtimesSource: '' },
    ];
    const problems = checkCoverage(fullReport(), bad);
    expect(problems).toContain('keystore-file: declares unknown runtimes');
    expect(problems).toContain('keystore-file: declares runtimes without a reason');
  });

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

describe('pending cases of an implemented suite (M1-7d)', () => {
  /** fullReport plus a pending-case marker for placeholder-sha256 case `b`, which then does not run. */
  function caseReport(runtimes = REQUIRED_RUNTIMES, status = 'passed') {
    const report = fullReport();
    for (const file of report.testResults) {
      const runtime = file.assertionResults[0].meta.vectors.runtime;
      if (!runtimes.includes(runtime)) continue;
      file.assertionResults.splice(2, 1);
      file.assertionResults.push(
        assertion(
          {
            kind: 'pending-case',
            runtime,
            suite: 'placeholder-sha256',
            caseId: 'b',
            detail: 'M1-7c-b',
          },
          status,
        ),
      );
    }
    return report;
  }

  it('accepts a case every runtime reported as pending, and lists it', () => {
    const report = caseReport();
    expect(checkCoverage(report, suites)).toEqual([]);
    expect(pendingCases(report)).toEqual(
      new Map([['placeholder-sha256', { card: 'M1-7c-b', ids: ['b'] }]]),
    );
  });

  it('still requires the case in a runtime without the marker', () => {
    const report = fullReport();
    report.testResults[4].assertionResults.splice(2, 1);
    expect(checkCoverage(report, suites)).toEqual([
      'workerd: placeholder-sha256: no passing result for b',
    ]);
  });

  it('fails closed when the marker failed', () => {
    const problems = checkCoverage(caseReport(REQUIRED_RUNTIMES, 'failed'), suites);
    expect(problems).toHaveLength(REQUIRED_RUNTIMES.length);
    expect(problems[0]).toBe('node: placeholder-sha256: no passing result for b');
  });

  it('fails a case reported as pending that also ran', () => {
    const report = caseReport();
    report.testResults[0].assertionResults.push(
      assertion({ kind: 'case', runtime: 'node', suite: 'placeholder-sha256', caseId: 'b' }),
    );
    expect(checkCoverage(report, suites)).toEqual([
      'placeholder-sha256: case b reported as pending but also ran',
    ]);
  });
});

describe('checkPendingCaseShrinks (M1-7d)', () => {
  const entry = (ids, card = 'M1-7c-b') => ({ card, phase: 'M1a', ids });
  const head = (ids) => ({ cases: new Map([['owner-action', entry(ids)]]) });

  it('accepts cases of a suite that was wholly pending on the base, and a list that shrank', () => {
    const wholly = {
      pending: new Map([['owner-action', { card: 'M1-7d', phase: 'M1a' }]]),
      cases: new Map(),
      suites: new Set(['owner-action']),
    };
    expect(checkPendingCaseShrinks(head(['a', 'b']), wholly)).toEqual([]);
    const listed = {
      pending: new Map(),
      cases: head(['a', 'b']).cases,
      suites: new Set(['owner-action']),
    };
    expect(checkPendingCaseShrinks(head(['a']), listed)).toEqual([]);
  });

  it('rejects a case that ran on the base, and a suite that ran all its cases there', () => {
    const listed = {
      pending: new Map(),
      cases: head(['a']).cases,
      suites: new Set(['owner-action']),
    };
    expect(checkPendingCaseShrinks(head(['a', 'c']), listed)).toEqual([
      'owner-action: cases c ran on the base; pending cases only shrink',
    ]);
    const ran = { pending: new Map(), cases: new Map(), suites: new Set(['owner-action']) };
    expect(checkPendingCaseShrinks(head(['a']), ran)).toEqual([
      'owner-action: ran all its cases on the base branch; pending cases only shrink',
    ]);
  });

  it('rejects a changed card, a missing card and an empty or duplicate id list', () => {
    const listed = {
      pending: new Map(),
      cases: head(['a']).cases,
      suites: new Set(['owner-action']),
    };
    const moved = { cases: new Map([['owner-action', entry(['a'], 'M1-9z')]]) };
    expect(checkPendingCaseShrinks(moved, listed)).toEqual([
      'owner-action: its pending cases changed card or phase from M1-7c-b/M1a; an existing entry can only shrink',
    ]);
    const none = { pending: new Map(), cases: new Map(), suites: new Set() };
    expect(checkPendingCaseShrinks({ cases: new Map([['x', { ids: ['a'] }]]) }, none)).toEqual([
      'x: a pending-cases entry needs a card (e.g. M1-1a) and a phase (e.g. M1a)',
    ]);
    for (const ids of [[], ['a', 'a'], [''], 'a']) {
      expect(checkPendingCaseShrinks({ cases: new Map([['x', entry(ids)]]) }, none)).toEqual([
        'x: a pending-cases entry needs a non-empty list of distinct case ids',
      ]);
    }
  });

  it('gates a release on pending cases of the gated phase, by the backlog phase', () => {
    const cards = new Map([['M1-7c-b', 'M1a']]);
    expect(
      checkPendingGate({ pending: pendingCaseEntries(head(['a']).cases) }, ['M1a'], cards),
    ).toEqual([
      'owner-action (pending cases) is still pending (M1-7c-b, phase M1a): every M1a suite must be implemented before a release',
    ]);
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

describe('pending entries are frozen and tied to the backlog (IR-M1-1h-2 F-B)', () => {
  const backlog = [
    '#### M1-1a · crypto: encodings',
    '- **Status:** backlog · **Size:** S · **Tier:** Opus · **Security:** S2 · **Phase:** M1a',
    '#### M1-1d · crypto: STREAM',
    '- **Status:** backlog · **Size:** M · **Tier:** Opus · **Security:** S2 · **Phase:** M1b',
  ].join('\n');

  it("reads each card's phase from the backlog", () => {
    expect(cardPhases(backlog)).toEqual(
      new Map([
        ['M1-1a', 'M1a'],
        ['M1-1d', 'M1b'],
      ]),
    );
  });

  it('refuses an existing entry whose phase or card changed', () => {
    const base = {
      pending: new Map([['jcs', { card: 'M1-1a', phase: 'M1a' }]]),
      suites: new Set(['jcs']),
    };
    const head = { pending: new Map([['jcs', { card: 'M1-1a', phase: 'M9' }]]) };
    expect(checkPendingShrinks(head, base)).toEqual([
      'jcs: its pending entry changed from M1-1a/M1a to M1-1a/M9; an existing entry can only be removed',
    ]);
  });

  it("refuses an entry whose phase differs from its card's backlog phase, or an unknown card", () => {
    const head = {
      pending: new Map([
        ['jcs', { card: 'M1-1a', phase: 'M1b' }],
        ['x', { card: 'M7-9', phase: 'M7' }],
      ]),
    };
    expect(checkPendingCards(head, cardPhases(backlog))).toEqual([
      "jcs: phase M1b differs from card M1-1a's backlog phase M1a",
      'x: card M7-9 has no Phase in the backlog',
    ]);
  });

  it('gates on the backlog phase even if the entry claims another', () => {
    const head = { pending: new Map([['jcs', { card: 'M1-1a', phase: 'M9' }]]) };
    expect(checkPendingGate(head, ['M1a'], cardPhases(backlog))).toEqual([
      'jcs is still pending (M1-1a, phase M1a): every M1a suite must be implemented before a release',
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

  const cards = new Map([
    ['M1-1a', 'M1a'],
    ['M1-1d', 'M1b'],
  ]);

  it('fails a release while a suite of the gated phase is pending', () => {
    expect(checkPendingGate(head, ['M1a'], cards)).toEqual([
      'jcs is still pending (M1-1a, phase M1a): every M1a suite must be implemented before a release',
    ]);
  });

  it('passes when no pending suite belongs to a gated phase', () => {
    expect(
      checkPendingGate(
        { pending: new Map([['stream', head.pending.get('stream')]]) },
        ['M1a'],
        cards,
      ),
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
