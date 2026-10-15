// M1-13a: the canary scan itself (src/canary-scan.mjs), so a scan that silently finds nothing is
// caught in the ordinary unit tests (`pnpm test`), without Docker, a keychain or an LLM.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanForCanaries, spellings } from '../src/canary-scan.mjs';

const SCAN = fileURLToPath(new URL('../src/canary-scan.mjs', import.meta.url));
const run = promisify(execFile);

describe('canary scan', () => {
  let dir: string;
  const seed = new Uint8Array(32).fill(0xab);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agentlink-canary-'));
    await mkdir(join(dir, 'logs', 'nested'), { recursive: true });
    await writeFile(join(dir, 'logs', 'clean.log'), 'nothing to see\n');
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds every spelling of a byte canary, in nested files, and names only the canary', async () => {
    const hex = Buffer.from(seed).toString('hex');
    await writeFile(join(dir, 'logs', 'nested', 'a.log'), `x ${hex.toUpperCase()} y`);
    const { scanned, findings } = await scanForCanaries([dir], spellings('seed', seed));
    expect(scanned).toBe(2);
    expect(findings).toEqual([{ file: join('logs', 'nested', 'a.log'), name: 'seed (HEX)' }]);
  });

  it('allows an outside-transcripts canary in a transcript, and nowhere else', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentlink-canary-t-'));
    await writeFile(join(root, 'b.transcript.jsonl'), 'the plaintext-0123456789');
    await writeFile(join(root, 'b.log'), 'the plaintext-0123456789');
    const { findings } = await scanForCanaries(
      [root],
      [{ name: 'message', value: 'plaintext-0123456789', where: 'outside-transcripts' }],
    );
    expect(findings).toEqual([{ file: 'b.log', name: 'message' }]);
    await rm(root, { recursive: true, force: true });
  });

  it('the command fails on a leaked environment secret without printing its value', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentlink-canary-e-'));
    const secret = 'sk-test-not-a-real-key-0123456789';
    await writeFile(join(root, 'out.log'), `leaked ${secret}\n`);
    const canaries = join(root, '..', `canaries-${String(process.pid)}.json`);
    await writeFile(canaries, '[]');
    const result = await run(
      process.execPath,
      [SCAN, '--canaries', canaries, '--env-secret', 'E2E_TEST_SECRET', root],
      { env: { ...process.env, E2E_TEST_SECRET: secret } },
    ).catch((error: { code: number; stdout: string }) => error);
    expect('code' in result ? result.code : 0).toBe(1);
    expect(result.stdout).toContain('environment secret E2E_TEST_SECRET');
    expect(result.stdout).not.toContain(secret);
    await rm(root, { recursive: true, force: true });
    await rm(canaries, { force: true });
  });
});
