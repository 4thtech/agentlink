// M1-6a-2: guards on the storage integration workflows (sensitive path). They read the workflows as
// text, so a later edit cannot quietly put the R2 secrets into the merge gate or a pull request run,
// widen the permissions, unpin an action, let a secret leave its one step, or drop the no-skip check.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string =>
  readFileSync(decodeURIComponent(new URL(`../../${path}`, import.meta.url).pathname), 'utf8');
// Comments describe what the workflow must never do, so only the code is checked.
const code = (text: string): string =>
  text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

const r2 = code(read('.github/workflows/storage-r2.yml'));
const ci = code(read('.github/workflows/ci.yml'));
const minio = /^ {2}storage-minio:\n([\s\S]*?)(?=^ {2}\S)/m.exec(ci)?.[0] ?? '';

describe('storage-r2.yml (M1-6a-2)', () => {
  it('runs on a schedule and by manual dispatch only, on main, never for a pull request', () => {
    const on = /^on:\n([\s\S]*?)\n(?=\S)/m.exec(r2)?.[1] ?? '';
    expect(on).toContain('schedule:');
    expect(on).toContain('workflow_dispatch:');
    expect(on).not.toMatch(/pull_request|push:|merge_group|workflow_call/);
    expect(r2).not.toContain('pull_request_target');
    expect(r2).toContain("github.ref == 'refs/heads/main'");
  });

  it('is not part of the merge gate and ci.yml holds no R2 secret', () => {
    expect(ci).not.toMatch(/uses:[^\n]*storage-r2/);
    expect(ci).not.toContain('R2_TEST');
    expect(ci).not.toContain('r2-test');
  });

  it('starts with no permissions and grants only contents read', () => {
    expect(r2).toMatch(/^permissions: \{\}$/m);
    const grants = [...r2.matchAll(/^ {6}(\w[\w-]*): (read|write)$/gm)].map((m) => m.slice(1));
    expect(grants).toEqual([['contents', 'read']]);
  });

  it('pins every action to a full commit SHA and keeps the pnpm store cache off', () => {
    const uses = [...r2.matchAll(/^\s+(?:- )?uses: (\S+)/gm)].map((m) => m[1] ?? '');
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) {
      expect(u.startsWith('./') || /^[\w./-]+@[0-9a-f]{40}$/.test(u)).toBe(true);
    }
    expect(r2).toMatch(/cache: "false"/);
    expect(r2).toContain('persist-credentials: false');
  });

  it('uses the environment r2-test, a time cap and one run at a time', () => {
    expect(r2).toMatch(/^ {4}environment: r2-test$/m);
    const timeouts = [...r2.matchAll(/^ {4}timeout-minutes: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toBeLessThanOrEqual(15);
    expect(r2).toContain('group: storage-r2');
  });

  it('names each secret once, in the one step that runs the test, and never echoes it', () => {
    for (const name of [
      'R2_TEST_ACCOUNT_ID',
      'R2_TEST_ACCESS_KEY_ID',
      'R2_TEST_SECRET_ACCESS_KEY',
    ]) {
      expect([...r2.matchAll(new RegExp(`secrets\\.${name}`, 'g'))]).toHaveLength(1);
    }
    expect(r2).not.toMatch(
      /echo[^\n]*(AGENTLINK_STORAGE_IT_(ACCESS_KEY_ID|SECRET)|\$\{?R2_TEST_ACCOUNT_ID)[^\n]*>>/,
    );
    expect(r2).toContain('::add-mask::$R2_TEST_ACCOUNT_ID');
  });

  it('scans the output for query strings and credentials, and fails on a skipped or missing test', () => {
    expect(r2).toContain("'X-Amz-'");
    expect(r2).toContain('rm -f "$out" "$report"');
    expect(r2).toContain('AGENTLINK_STORAGE_IT: r2');
    expect(r2).toMatch(/if \[ -z "\$\{!name\}" \]/);
    expect(r2).toMatch(/t\.length < 5 \|\| bad\.length > 0/);
  });

  it('builds the endpoint from the account id and uses the region auto', () => {
    expect(r2).toContain('https://${R2_TEST_ACCOUNT_ID}.r2.cloudflarestorage.com');
    expect(r2).toContain('AGENTLINK_STORAGE_IT_REGION: auto');
  });
});

describe('storage-minio job in ci.yml (M1-6a-2)', () => {
  it('exists, is in ci-gate and uses no secret', () => {
    expect(minio).not.toBe('');
    const gate = /^ {4}needs: \[([^\]]*)\]\n {4}if: always\(\)/m.exec(ci)?.[1] ?? '';
    expect(gate.split(',').map((s) => s.trim())).toContain('storage-minio');
    expect(minio).not.toContain('secrets.');
    expect(minio).not.toContain('environment:');
    expect(minio).toMatch(/contents: read/);
  });

  it('pins the image by digest and trusts a one-day CI certificate over TLS', () => {
    expect(minio).toMatch(/MINIO_IMAGE: \S+@sha256:[0-9a-f]{64}$/m);
    expect(minio).toContain('-days 1');
    expect(minio).toContain('NODE_EXTRA_CA_CERTS');
    expect(minio).toContain('MINIO_SCHEME=https');
  });

  it('scans the output and fails on a skipped or missing test', () => {
    expect(minio).toContain("'X-Amz-'");
    expect(minio).toContain('AGENTLINK_STORAGE_IT: minio');
    expect(minio).toMatch(/t\.length < 5 \|\| bad\.length > 0/);
  });
});
