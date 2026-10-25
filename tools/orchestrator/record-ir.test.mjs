// PROC-ORCH-PLAYBOOK: record-ir.py records a PASS line in the "Independent review" section and
// refuses anything else. Runs the script offline (--body-file + --dry-run); it never calls gh here.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const script = join(dirname(fileURLToPath(import.meta.url)), 'record-ir.py');
const dir = mkdtempSync(join(tmpdir(), 'record-ir-test-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SHA = 'a'.repeat(40);
const LINE = `IR-M1-5-1: PASS at ${SHA} (Opus 5.5, fresh context; no findings)`;
const ORDER = 'Merge: owner standing order (test text).';

function run(body, line, name, extra = []) {
  const file = join(dir, `${name}.md`);
  writeFileSync(file, body);
  return spawnSync(
    'python3',
    ['-I', script, '7', line, '--body-file', file, '--dry-run', ...extra],
    { encoding: 'utf8' },
  );
}

const pending =
  '## Task ID & summary\nx\n\n## Independent review\nPending (orchestrator).\n\n## Threat note\nN/A\n';

describe('record-ir.py', () => {
  it('by default replaces "Pending (orchestrator)." with the line and adds no merge line', () => {
    const r = run(pending, LINE, 'pending');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`## Independent review\n${LINE}\n\n## Threat note`);
    expect(r.stdout).not.toContain('Pending (orchestrator).');
    expect(r.stdout).not.toMatch(/standing order|Merge:/i);
  });

  it('adds the owner merge line only with --owner-merge', () => {
    const r = run(pending, LINE, 'owner', ['--owner-merge', ORDER]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`## Independent review\n${LINE}\n${ORDER}\n\n## Threat note`);
  });

  it('appends a second line below the first without repeating the owner merge line', () => {
    const first = run(pending, LINE, 'first', ['--owner-merge', ORDER]).stdout;
    const second = `IR-M1-5-2: PASS (mechanical) at ${SHA} (Haiku 5.5, D-126 verifier; clean merge)`;
    const r = run(first, second, 'second', ['--owner-merge', ORDER]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`${LINE}\n${ORDER}\n\n${second}\n`);
    expect(r.stdout.split(ORDER)).toHaveLength(2);
  });

  it('refuses a line that is not a PASS line', () => {
    const r = run(pending, `IR-M1-5-1: FAIL at ${SHA}`, 'fail');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('refuse: line must start with IR-<ID>-<n>: PASS');
  });

  it('refuses a body without an Independent review section', () => {
    const r = run('## Task ID & summary\nx\n', LINE, 'nosection');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("refuse: no '## Independent review' section");
  });

  it('refuses when the section would contain "verdict ... fail"', () => {
    const body = '## Independent review\nEarlier verdict: fail (round 1)\n\n## Threat note\nN/A\n';
    const r = run(body, LINE, 'verdict', ['--owner-merge', ORDER]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("refuse: section would contain 'verdict ... fail'");
  });
});
