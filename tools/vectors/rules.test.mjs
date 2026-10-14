import { describe, expect, it } from 'vitest';
import { checkCoverage, diffSnapshots, REQUIRED_RUNTIMES } from './rules.mjs';

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
