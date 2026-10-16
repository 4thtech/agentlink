// M1-9b: one-shot commands exit on their own once they are done. The built CLI (`dist/cli.js`)
// runs `doctor`, `status`, `contacts` and `requests` against an agent that has a real signed card
// and real relays; the process must end within a bound instead of staying alive on open relay
// connections (a pooled relay connection lives 5 minutes idle).
//
// Opt-in like two-process.keychain.test.ts: it needs the real OS keychain and the network, so it
// runs only with AGENTLINK_REQUIRE_KEYCHAIN=1 (a missing keychain or build then FAILS the run).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeHex, encodeUtf8, randomBytes, type OwnerPresence } from '@agentlink/crypto';
import { MemoryOwnerKeyStore } from '@agentlink/crypto/testing';
import { createOsKeychainAgent, probeOsKeychain } from '@agentlink/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeAgentConfig } from '../src/runtime/agent-dir.js';
import { openAgent } from '../src/runtime/open-agent.js';

const required = process.env['AGENTLINK_REQUIRE_KEYCHAIN'] === '1';
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const RELAYS = ['wss://nos.lol', 'wss://relay.primal.net'];
/** Budget 3 s plus connecting; far below the 5 minute idle close of a pooled connection. */
const EXIT_WITHIN_MS = 30_000;

function run(home: string, args: string[]): Promise<{ code: number | null; ms: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`agentlink ${args[0] ?? ''} did not exit within ${EXIT_WITHIN_MS} ms`));
    }, EXIT_WITHIN_MS);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, ms: Date.now() - started });
    });
  });
}

describe.skipIf(!required)('one-shot commands exit promptly (real keychain, real relays)', () => {
  let home: string;

  beforeAll(async () => {
    expect(existsSync(CLI), 'build apps/cli first (dist/cli.js)').toBe(true);
    expect(await probeOsKeychain({ timeoutMs: 10_000 })).toEqual({ ok: true });
    home = await realpath(await mkdtemp(join(tmpdir(), 'agentlink-exit-')));
    const agentId = await createOsKeychainAgent();
    await writeAgentConfig(home, { v: 1, name: 'default', agentId, keyStore: 'keychain' });
    const code = encodeHex(randomBytes(16));
    const presence = (): OwnerPresence => ({ kind: 'passphrase', secret: encodeUtf8(code) });
    const owner = new MemoryOwnerKeyStore(randomBytes(32), presence());
    const ownerKeys = await owner.getPublicKeys();
    const opened = await openAgent({ home });
    if (opened.status !== 'ok') throw new Error('not opened');
    const session = await owner.unlock(presence());
    try {
      await opened.agent.client.identity.init({
        owner: session,
        ownerKeys,
        name: 'Agent',
        relays: RELAYS,
      });
    } finally {
      await session.close();
      await opened.agent.close();
    }
  }, 60_000);
  afterAll(async () => {
    if (home !== undefined) await rm(home, { recursive: true, force: true });
  });

  it.each([['doctor'], ['status'], ['contacts'], ['requests']])(
    '`agentlink %s` ends by itself within the bound',
    async (command) => {
      const result = await run(home, [command]);
      expect(result.ms).toBeLessThan(EXIT_WITHIN_MS);
      expect(result.code).not.toBeNull();
    },
    EXIT_WITHIN_MS + 5_000,
  );
});
