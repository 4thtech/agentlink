// OPS-CI-7: guards on the nightly two-machine workflow (sensitive path, S2). They read the workflow
// as text, so a later edit cannot quietly move it into the merge gate, widen its permissions, unpin
// an action, print the invite or let it run for a pull request.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string =>
  readFileSync(decodeURIComponent(new URL(`../../${path}`, import.meta.url).pathname), 'utf8');
const nightly = read('.github/workflows/nightly-two-machine.yml');

describe('nightly-two-machine.yml (OPS-CI-7)', () => {
  it('runs on a schedule and by manual dispatch only, never for a pull request', () => {
    const on = /^on:\n([\s\S]*?)\n(?=\S)/m.exec(nightly)?.[1] ?? '';
    expect(on).toContain('schedule:');
    expect(on).toContain('workflow_dispatch:');
    expect(on).not.toMatch(/pull_request|push:|merge_group|workflow_call/);
    expect(nightly).not.toContain('pull_request_target');
  });

  it('is not part of the merge gate', () => {
    expect(read('.github/workflows/ci.yml')).not.toContain('nightly-two-machine');
    expect(read('.github/workflows/e2e.yml')).not.toContain('nightly-two-machine');
  });

  it('starts with no permissions and grants only contents and actions read per job', () => {
    expect(nightly).toMatch(/^permissions: \{\}$/m);
    const grants = [...nightly.matchAll(/^ {6}(\w[\w-]*): (read|write)$/gm)].map((m) => m.slice(1));
    expect(grants.length).toBeGreaterThan(0);
    for (const [name, level] of grants) {
      expect(['actions', 'contents']).toContain(name);
      expect(level).toBe('read');
    }
  });

  it('pins every action to a full commit SHA', () => {
    const uses = [...nightly.matchAll(/^\s+(?:- )?uses: (\S+)/gm)].map((m) => m[1] ?? '');
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) {
      expect(u.startsWith('./') || /^[\w./-]+@[0-9a-f]{40}$/.test(u)).toBe(true);
    }
  });

  it('caps every job at 45 minutes and serialises runs', () => {
    const timeouts = [...nightly.matchAll(/^ {4}timeout-minutes: (\d+)$/gm)].map((m) =>
      Number(m[1]),
    );
    expect(timeouts.length).toBe(4);
    for (const t of timeouts) expect(t).toBeLessThanOrEqual(45);
    expect(nightly).toContain('group: nightly-two-machine');
  });

  it('keeps the invite out of logs and artifacts', () => {
    expect(nightly).toContain('::add-mask::');
    expect(nightly).toContain('retention-days: 1');
    // the key is only ever named as a secret in the steps that need it, never echoed
    expect(nightly).not.toMatch(/echo[^\n]*(ANTHROPIC_API_KEY|RENDEZVOUS_KEY|NIGHTLY_PASS)/);
    // only the sanitized results folder is uploaded as results, never the transcripts
    expect(nightly).not.toMatch(/path: \$\{\{ runner\.temp \}\}\/e2e-artifacts\s*$/m);
  });

  it('runs the agents on two different runners', () => {
    expect(nightly).toMatch(/runs-on: macos-26/);
    expect(nightly).toMatch(/agent-b:[\s\S]*?runs-on: ubuntu-24\.04/);
  });
});
