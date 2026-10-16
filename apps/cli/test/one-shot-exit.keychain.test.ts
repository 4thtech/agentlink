// M1-9b: one-shot commands exit on their own once they are done. The built CLI (`dist/cli.js`)
// runs `doctor`, `status`, `contacts` and `requests` against an agent that has a real signed card
// and real relays; the process must end within a bound instead of staying alive on open relay
// connections (a pooled relay connection lives 5 minutes idle).
//
// Opt-in like two-process.keychain.test.ts: it needs the real OS keychain and the network, so it
// runs only with AGENTLINK_REQUIRE_KEYCHAIN=1 (a missing keychain or build then FAILS the run).
//
// Each opt-in run leaves up to three keychain items (service `agentlink`, accounts `<agentId>`,
// `<agentId>:store-key`, `<agentId>:policy-version`) and publishes
// a throwaway agent card to the public relays below. Cleanup on a Mac, per account:
//   security dump-keychain | grep -B8 agentlink   (find the accounts)
//   security delete-generic-password -s agentlink -a <account>
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { realpath, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
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

function run(args: string[]): Promise<{ code: number | null; ms: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [CLI, ...args], {
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
  // The macOS keychain is found through the real home, so the agent lives under it with a name of
  // its own; afterAll removes the folder (the keychain items stay, as in the two-process test).
  const name = `exit-test-${encodeHex(randomBytes(4))}`;
  let home: string;

  beforeAll(async () => {
    // Set first, so afterAll removes the folder even when the set-up below fails half way.
    home = await realpath(homedir());
    try {
      expect(existsSync(CLI), 'build apps/cli first (dist/cli.js)').toBe(true);
      expect(await probeOsKeychain({ timeoutMs: 10_000 })).toEqual({ ok: true });
      const agentId = await createOsKeychainAgent();
      await writeAgentConfig(home, { v: 1, name, agentId, keyStore: 'keychain' });
      const code = encodeHex(randomBytes(16));
      const presence = (): OwnerPresence => ({ kind: 'passphrase', secret: encodeUtf8(code) });
      const owner = new MemoryOwnerKeyStore(randomBytes(32), presence());
      const ownerKeys = await owner.getPublicKeys();
      const opened = await openAgent({ home, agent: name });
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
    } catch (error) {
      await rm(join(home, '.agentlink', 'agents', name), { recursive: true, force: true });
      throw error;
    }
  }, 60_000);
  afterAll(async () => {
    await rm(join(home, '.agentlink', 'agents', name), { recursive: true, force: true });
  });

  it.each([['doctor'], ['status'], ['contacts'], ['requests']])(
    '`agentlink %s` ends by itself within the bound',
    async (command) => {
      const result = await run([command, '--agent', name]);
      expect(result.ms).toBeLessThan(EXIT_WITHIN_MS);
      expect(result.code).not.toBeNull();
    },
    EXIT_WITHIN_MS + 5_000,
  );
});
