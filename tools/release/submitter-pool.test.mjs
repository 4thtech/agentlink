import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runScripts } from './workflow-run-steps.mjs';

// M1-10b-e: the scheduled faucet and gas pool alert. `.github/workflows/submitter-pool.yml` reads
// the production submitter's public `GET /v1/health` and runs one jq program,
// `.github/scripts/submitter-pool.jq`, over the answer. The run fails (GitHub's failure notice for
// a scheduled run tells the owner) when any served chain is unavailable, its gas wallet is low, or
// its faucet is low or paused. The program prints only chain IDs (numbers) and the fixed state
// words; never a balance, an address or any other string from the answer.

const ROOT = resolve(import.meta.dirname, '../..');
const PROGRAM = join(ROOT, '.github/scripts/submitter-pool.jq');
const WORKFLOW = join(ROOT, '.github/workflows/submitter-pool.yml');

function run(body) {
  const dir = mkdtempSync(join(tmpdir(), 'submitter-pool-'));
  const file = join(dir, 'health.json');
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  try {
    return execFileSync('jq', ['-r', '-f', PROGRAM, file], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    return `jq failed ${String(error.status)}`;
  }
}

const chain = (over = {}) => ({
  chainId: 84532,
  available: true,
  gasBalance: '50900000000000000',
  queueDepth: 0,
  gas: 'ok',
  faucet: 'ok',
  ...over,
});
const LINE =
  /^(pool: ok|alert chain [0-9]+: (not available|gas [a-z]+|faucet [a-z]+)|alert: [a-z ]+)$/;

describe('the pool alert program (M1-10b-e)', () => {
  it('is quiet when every chain is available with gas and faucet ok', () => {
    expect(run({ ok: true, chains: [chain()] })).toBe('pool: ok');
    // A chain without a faucet (faucet null) is fine.
    expect(run({ ok: true, chains: [chain(), chain({ chainId: 10200, faucet: null })] })).toBe(
      'pool: ok',
    );
  });

  it('alerts on gas low, faucet low or paused, and an unavailable chain', () => {
    expect(run({ ok: true, chains: [chain({ gas: 'low' })] })).toBe('alert chain 84532: gas low');
    expect(run({ ok: true, chains: [chain({ faucet: 'low' })] })).toBe(
      'alert chain 84532: faucet low',
    );
    expect(run({ ok: true, chains: [chain({ faucet: 'paused' })] })).toBe(
      'alert chain 84532: faucet paused',
    );
    expect(
      run({ ok: false, chains: [chain({ available: false, gas: null, gasBalance: null })] }),
    ).toBe('alert chain 84532: not available\nalert chain 84532: gas unknown');
  });

  it('fails closed on an older or malformed answer, and never prints a string from it', () => {
    const odd = `0x${'ab'.repeat(20)}`;
    const answers = [
      { ok: true, chains: [] },
      { ok: true },
      { ok: true, chains: [chain({ gas: undefined, faucet: undefined })] },
      { ok: true, chains: [chain({ gas: odd })] },
      { ok: true, chains: [chain({ faucet: odd })] },
      { ok: true, chains: [chain({ chainId: odd })] },
      'not json',
      '[]',
    ];
    for (const body of answers) {
      const output = run(body);
      expect(output).not.toBe('pool: ok');
      expect(output).not.toContain(odd);
      expect(output).not.toContain('50900000000000000');
      if (!output.startsWith('jq failed')) {
        for (const line of output.split('\n')) expect(line).toMatch(LINE);
      }
    }
  });
});

describe('the pool alert workflow (M1-10b-e)', () => {
  const source = readFileSync(WORKFLOW, 'utf8');

  it('runs on a schedule and by dispatch, never for a pull request, with no permissions or secrets', () => {
    expect(source).toMatch(/\n {2}schedule:\n(?: {4}#.*\n)* {4}- cron: "[0-9*/ ,-]+"\n/);
    expect(source).toContain('workflow_dispatch:');
    expect(source).not.toMatch(/pull_request/);
    expect(source).toMatch(/\npermissions: \{\}\n/);
    expect(source).not.toContain('secrets.');
    expect(source).toContain("github.repository == '4thtech/agentlink'");
  });

  it('pins every action to a full commit SHA and keeps no credentials', () => {
    for (const [, ref] of source.matchAll(/uses: [^@\s]+@(\S+)/g)) {
      expect(ref).toMatch(/^[0-9a-f]{40}$/);
    }
    expect(source).toContain('persist-credentials: false');
  });

  it('runs the shared jq program over the production health answer and never prints the answer', () => {
    const scripts = runScripts(source).map((s) => s.script);
    const check = scripts.find((s) => s.includes('/v1/health'));
    expect(check).toBeDefined();
    expect(check).toContain('.github/scripts/submitter-pool.jq');
    expect(check).toContain('https://submit.agentlink.4thtech.io');
    expect(check).not.toMatch(/\bcat\b/);
    expect(check).not.toMatch(/jq[^\n|]*'\.'/);
  });
});
