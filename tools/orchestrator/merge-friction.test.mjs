// OPS-MERGE-FRICTION: record-ir.py re-runs only a failed review-gate run after recording.
// (retrigger-version-pr.py was removed by OPS-UNSTICK-B: the release App opens the version PR.)
// A fake `gh` (shell script) logs every call and answers from a JSON fixture; nothing is networked.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'merge-friction-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SHA = 'b'.repeat(40);
const LINE = `IR-X-1: PASS at ${SHA} (Opus 5.5; ok)`;
const body = '## Independent review\nPending (orchestrator).\n';

function fakeGh(name, { pr, runs }) {
  const log = join(dir, `${name}.log`);
  writeFileSync(log, '');
  const fx = join(dir, `${name}.json`);
  writeFileSync(fx, JSON.stringify({ pr, runs }));
  const gh = join(dir, `${name}-gh`);
  const pick = (key) =>
    `node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1])).${key}))' "${fx}"`;
  writeFileSync(
    gh,
    `#!/bin/sh
echo "$@" >> "${log}"
case "$1 $2" in
  "pr view") ${pick('pr')} ;;
  "run list") ${pick('runs')} ;;
esac
exit 0
`,
  );
  chmodSync(gh, 0o755);
  return { gh, log };
}
const calls = (log) => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);

function recordIr(name, runs, extra = []) {
  const f = fakeGh(name, { pr: { body, headRefOid: SHA }, runs });
  const bf = join(dir, `${name}.md`);
  writeFileSync(bf, body);
  const r = spawnSync(
    'python3',
    ['-I', join(here, 'record-ir.py'), '7', LINE, '--body-file', bf, ...extra],
    { encoding: 'utf8', env: { ...process.env, RECORD_IR_GH: f.gh, RECORD_IR_WAIT: '0' } },
  );
  return { r, log: f.log };
}
const run = (id, status, conclusion, createdAt) => ({
  databaseId: id,
  status,
  conclusion,
  createdAt,
});

describe('record-ir.py review-gate re-run', () => {
  it('re-runs only the latest run when it failed', () => {
    const { r, log } = recordIr('fail', [
      run(1, 'completed', 'failure', '2026-11-01T10:00:00Z'),
      run(2, 'completed', 'failure', '2026-11-01T10:05:00Z'),
      run(3, 'completed', 'success', '2026-11-01T09:00:00Z'),
    ]);
    expect(r.status).toBe(0);
    expect(calls(log).filter((c) => c.startsWith('run rerun'))).toEqual([
      'run rerun 2 --repo 4thtech/agentlink',
    ]);
    expect(r.stdout).toContain('re-ran review-gate run 2');
  });

  it('leaves a passing latest run alone', () => {
    const { r, log } = recordIr('pass', [run(5, 'completed', 'success', '2026-11-01T10:00:00Z')]);
    expect(r.status).toBe(0);
    expect(calls(log).some((c) => c.startsWith('run rerun'))).toBe(false);
  });

  it('leaves a run in flight alone', () => {
    const { r, log } = recordIr('inflight', [run(6, 'in_progress', null, '2026-11-01T10:00:00Z')]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('still in_progress');
    expect(calls(log).some((c) => c.startsWith('run rerun'))).toBe(false);
  });

  it('--no-rerun skips the lookup', () => {
    const { r, log } = recordIr(
      'norerun',
      [run(7, 'completed', 'failure', '2026-11-01T10:00:00Z')],
      ['--no-rerun'],
    );
    expect(r.status).toBe(0);
    expect(calls(log).some((c) => c.startsWith('run '))).toBe(false);
  });
});
