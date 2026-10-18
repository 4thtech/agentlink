import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { evaluatePin, parsePin, runCheck } from './check.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const stub = (sha, extra = '') =>
  `# Replace ${A} with a SHA\nname: Secret scan (sync)\njobs:\n  secret-scan:\n    uses: 4thtech/agentlink/.github/workflows/secret-scan.yml@${sha}${extra}\n`;

describe('parsePin', () => {
  it('reads the 40-char SHA of the reusable workflow call', () => {
    expect(parsePin(stub(B))).toBe(B);
    expect(parsePin(stub(B, ' # main'))).toBe(B);
  });
  it('ignores comments that mention another SHA', () => {
    expect(parsePin(stub(B))).not.toBe(A);
  });
  it('returns null for a branch ref, a short SHA, another workflow, or no call', () => {
    expect(parsePin(stub('main'))).toBeNull();
    expect(parsePin(stub('abc1234'))).toBeNull();
    expect(parsePin(stub(B).replace('secret-scan.yml@', 'other.yml@'))).toBeNull();
    expect(parsePin('name: x\n')).toBeNull();
  });
});

describe('evaluatePin', () => {
  it('passes when the pin is the required commit or a descendant', () => {
    expect(evaluatePin({ pin: B, required: B, isAncestor: () => true }).ok).toBe(true);
    expect(evaluatePin({ pin: B, required: A, isAncestor: () => true }).ok).toBe(true);
  });
  it('fails when the pin predates the required commit', () => {
    const r = evaluatePin({ pin: A, required: B, isAncestor: () => false });
    expect(r.ok).toBe(false);
    expect(r.message).toContain(A.slice(0, 12));
    expect(r.message).toContain(B.slice(0, 12));
  });
  it('fails when no pin can be read', () => {
    expect(evaluatePin({ pin: null, required: B, isAncestor: () => true }).ok).toBe(false);
  });
});

describe('runCheck against a temporary repository', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sync-pin-'));
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
      cwd: dir,
      encoding: 'utf8',
    }).trim();
  const commit = (file, content, msg) => {
    mkdirSync(join(dir, '.github/workflows'), { recursive: true });
    writeFileSync(join(dir, file), content);
    git('add', '-A');
    git('commit', '-q', '-m', msg);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q', '-b', 'main');
  const c1 = commit('.github/workflows/secret-scan.yml', 'v1\n', 'scan v1');
  const c2 = commit('README.md', 'x\n', 'unrelated');
  const c3 = commit('.gitleaks.toml', 'cfg\n', 'config');
  const c4 = commit('README.md', 'y\n', 'unrelated 2');

  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const opts = (pin) => ({ cwd: dir, mainRef: 'main', readStub: () => (pin ? stub(pin) : null) });

  it('fails for a pin older than the last scan-relevant change', () => {
    expect(runCheck(opts(c1)).ok).toBe(false);
    expect(runCheck(opts(c2)).ok).toBe(false);
  });
  it('passes for the last relevant change and for later commits', () => {
    expect(runCheck(opts(c3)).ok).toBe(true);
    expect(runCheck(opts(c4)).ok).toBe(true);
  });
  it('fails for a pin that is not a commit of this repository', () => {
    expect(runCheck(opts(B)).ok).toBe(false);
  });
  it('passes with a notice when the stub or branch is missing', () => {
    const r = runCheck(opts(null));
    expect(r.ok).toBe(true);
    expect(r.notice).toBeTruthy();
  });
});
