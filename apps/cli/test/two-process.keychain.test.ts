// M1-9k acceptance (IR-M1-9k-1 F01): two OS processes open one agent and share one real SQLite store
// and one real KeyStore; a row edited to `approved` without a signed object authorises nothing,
// checked by the other process's M1a channel and its own core (the core scenario re-run end to end).
//
// Opt-in, like @agentlink/node's keychain-native.test.ts: it runs only with
// AGENTLINK_REQUIRE_KEYCHAIN=1 (the keychain CI jobs), so a plain `pnpm test` never writes to a
// developer's keychain. With the flag set, a missing keychain or a missing build FAILS the run
// instead of skipping it. It goes through the public @agentlink/node entry, which uses the
// `agentlink` keychain service: the agent's two items (`<agentId>`, `<agentId>:store-key`) stay on
// the ephemeral runner (the entry has no delete, by design: IR-M1-8a-1 M-2).
//
// Needs the built CLI (`dist/`): the child processes run the code as installed, not the sources.
//
// Limit: the agent has no identity (identity.init needs an owner session, which only an owner prompt
// at a TTY can unlock, D-67), so core's use() refuses before it reaches the stored decision. That
// still shows the edited status column grants nothing across processes; the decision checks
// themselves are covered with an identity by core's approvals.test.ts.
import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeBase64url, encodeHex, randomBytes } from '@agentlink/crypto';
import { createOsKeychainAgent, probeOsKeychain } from '@agentlink/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeAgentConfig } from '../src/runtime/agent-dir.js';

const required = process.env['AGENTLINK_REQUIRE_KEYCHAIN'] === '1';
const FIXTURE = fileURLToPath(new URL('./fixtures/agent-process.mjs', import.meta.url));
const BUILT = fileURLToPath(new URL('../dist/runtime/index.js', import.meta.url));

type Message = Record<string, unknown> & { step: string };

/** A child process with a message queue. */
function spawnAgentProcess() {
  const child = fork(FIXTURE, [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const queue: Message[] = [];
  const waiting: ((m: Message) => void)[] = [];
  child.on('message', (m) => {
    const next = waiting.shift();
    if (next) next(m as Message);
    else queue.push(m as Message);
  });
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return {
    pid: child.pid,
    send: (m: unknown) => child.send(m as never),
    next: (): Promise<Message> =>
      new Promise((resolve, reject) => {
        const queued = queue.shift();
        if (queued) return resolve(queued);
        const timer = setTimeout(() => reject(new Error('child timed out')), 30_000);
        waiting.push((m) => {
          clearTimeout(timer);
          resolve(m);
        });
      }),
    exited,
  };
}

/** A valid action of the approval tool `agentlink_export_proof_pack` (as in core's approvals.test.ts). */
const exportAction = () => ({
  tool: 'agentlink_export_proof_pack',
  args: { recordId: '0x01', includeKey: true, note: 'x' },
  context: {
    triggers: ['proofs.allowKeyDisclosure'],
    recordId: `0x${encodeHex(randomBytes(32))}`,
    envelopeHash: `0x${encodeHex(randomBytes(32))}`,
  },
});

describe.skipIf(!required)('two processes, one agent store (real keychain and SQLite)', () => {
  let home: string;

  beforeAll(async () => {
    expect(existsSync(BUILT), 'build apps/cli first (dist/runtime/index.js)').toBe(true);
    expect(await probeOsKeychain({ timeoutMs: 10_000 })).toEqual({ ok: true });
    home = await realpath(await mkdtemp(join(tmpdir(), 'agentlink-2p-')));
  });
  afterAll(async () => {
    if (home !== undefined) await rm(home, { recursive: true, force: true });
  });

  it('shares one store; an edited `approved` row stays pending and is refused by core', async () => {
    const agentId = await createOsKeychainAgent();
    await writeAgentConfig(home, { v: 1, name: 'default', agentId, keyStore: 'keychain' });
    const approvalId = `apr_${encodeBase64url(randomBytes(16))}`;
    const action = exportAction();
    const now = Math.floor(Date.now() / 1000);
    const task = { home, name: 'default', approvalId, action, now };

    const writer = spawnAgentProcess();
    writer.send({ ...task, role: 'writer' });
    const written = await writer.next();
    expect(written.step).toBe('written');

    // The writer still holds the store open while the reader opens the same agent.
    const reader = spawnAgentProcess();
    reader.send({ ...task, role: 'reader' });
    const read = await reader.next();
    expect(read).toMatchObject({ step: 'read', opened: 'ok' });
    expect(read['pid']).not.toBe(written['pid']);
    expect(read['storePath']).toBe(written['storePath']);
    // The M1a channel never reports a decision: the status column is a cache.
    expect(read['channel']).toEqual({ state: 'pending' });
    // The reader's core does not let the action proceed.
    const use = read['use'] as { status: string };
    expect(use.status).not.toBe('used');
    expect(use.status).toBe('refused');
    expect(await reader.exited).toBe(0);

    writer.send({ step: 'continue' });
    const final = await writer.next();
    // Not consumed: still the edited cache value, never `void`, and still no signed decision.
    expect(final).toMatchObject({ step: 'final', status: 'approved', signedDecision: null });
    expect(await writer.exited).toBe(0);
  });
});
