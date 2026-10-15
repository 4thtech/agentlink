// M1-9k acceptance (IR-M1-9k-1 F01): two OS processes open one agent and share one real SQLite store
// and the agent's real keychain KeyStore. The agent has a genuine owner-signed card, so core reaches
// the stored decision: a request whose status column was edited to `approved` with no signed object
// stays `pending` (channel and core), while a request the owner really signed is used once.
//
// Opt-in, like @agentlink/node's keychain-native.test.ts: it runs only with
// AGENTLINK_REQUIRE_KEYCHAIN=1 (the keychain CI jobs), so a plain `pnpm test` never writes to a
// developer's keychain. With the flag set, a missing keychain or a missing build FAILS the run
// instead of skipping it. It goes through the public @agentlink/node entry, which uses the
// `agentlink` keychain service: the agent's two items stay on the ephemeral runner (the entry has
// no delete, by design: IR-M1-8a-1 M-2).
//
// The owner is the crypto test seam's MemoryOwnerKeyStore with a code generated here (no owner
// prompt exists without a TTY, D-67); only `apps/cli/test/**/*.test.ts` may import it
// (tools/deps-check/policy.mjs `testDirs`). The AGENT key is the real keychain KeyStore throughout.
// The child processes run the built CLI (`dist/`), as installed. Keep this file to ONE test: the CI
// check counts exactly one passed test here.
import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeActionDigest } from '@agentlink/core';
import {
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  randomBytes,
  type JsonObject,
  type OwnerPresence,
} from '@agentlink/crypto';
import { MemoryOwnerKeyStore } from '@agentlink/crypto/testing';
import { createOsKeychainAgent, probeOsKeychain } from '@agentlink/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeAgentConfig } from '../src/runtime/agent-dir.js';
import { openAgent } from '../src/runtime/open-agent.js';

const required = process.env['AGENTLINK_REQUIRE_KEYCHAIN'] === '1';
const FIXTURE = fileURLToPath(new URL('./fixtures/agent-process.mjs', import.meta.url));
const BUILT = fileURLToPath(new URL('../dist/runtime/index.js', import.meta.url));
const RELAYS = ['wss://relay.agentlink.dev', 'wss://nos.lol'];

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
const exportAction = (note: string): JsonObject => ({
  tool: 'agentlink_export_proof_pack',
  args: { recordId: '0x01', includeKey: true, note },
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

  it('an edited `approved` row stays pending in both processes; a genuinely signed one is used once', async () => {
    // The agent: real keychain items and the recorded config.
    const agentId = await createOsKeychainAgent();
    await writeAgentConfig(home, { v: 1, name: 'default', agentId, keyStore: 'keychain' });

    // The owner: a test owner store under a code generated here (each unlock gets a fresh presence,
    // because the store wipes what it is given).
    const code = encodeHex(randomBytes(16));
    const presence = (): OwnerPresence => ({ kind: 'passphrase', secret: encodeUtf8(code) });
    const owner = new MemoryOwnerKeyStore(randomBytes(32), presence());
    const ownerKeys = await owner.getPublicKeys();

    // Set-up in this process: the owner-signed card and two pending requests, through real core.
    const opened = await openAgent({ home });
    if (opened.status !== 'ok') throw new Error(`not opened: ${opened.reason}`);
    const { client } = opened.agent;
    const session = await owner.unlock(presence());
    let signedText: string;
    const edited = { action: exportAction('edited'), approvalId: '' };
    const decided = { action: exportAction('decided'), approvalId: '' };
    try {
      await client.identity.init({ owner: session, ownerKeys, name: 'Agent', relays: RELAYS });
      edited.approvalId = (
        await client.approvalService.request({ action: edited.action, summary: 'Export with key' })
      ).approvalId;
      decided.approvalId = (
        await client.approvalService.request({ action: decided.action, summary: 'Export with key' })
      ).approvalId;
      const now = Math.floor(Date.now() / 1000);
      const body: JsonObject = {
        v: 1,
        agent: client.agentId,
        owner: encodeHex(ownerKeys.ownerNostr),
        op: 'approval.decide',
        params: {
          approvalId: decided.approvalId,
          actionDigest: computeActionDigest(decided.action),
          decision: 'approve',
        },
        nonce: encodeBase64url(randomBytes(16)),
        issuedAt: now,
        expiresAt: now + 600,
      };
      signedText = JSON.stringify({ body, sig: await session.signOwnerAction(body) });
    } finally {
      await session.close();
      await opened.agent.close();
    }
    const task = {
      home,
      name: 'default',
      edited,
      decided: { ...decided, signedText },
    };

    // Process 1, the owner's CLI: applies the signed decision and tampers with the other row.
    const cli = spawnAgentProcess();
    cli.send({ ...task, role: 'cli' });
    const prepared = await cli.next();
    expect(prepared).toMatchObject({
      step: 'prepared',
      applied: { status: 'applied', op: 'approval.decide' },
    });

    // Process 2, the MCP side, while process 1 still holds the store open.
    const server = spawnAgentProcess();
    server.send({ ...task, role: 'server' });
    const used = await server.next();
    expect(used['step']).toBe('used');
    expect(used['pid']).not.toBe(prepared['pid']);
    expect(used['storePath']).toBe(prepared['storePath']);
    // The edited row: the M1a channel reports `pending`, and core does not let the action proceed.
    expect(used['editedChannel']).toEqual({ state: 'pending' });
    expect(used['editedUse']).toEqual({ status: 'pending' });
    // Positive control: the genuinely owner-signed request is used, once.
    expect(used['decidedChannel']).toEqual({ state: 'unknown' });
    expect(used['decidedUse']).toEqual({ status: 'used' });
    expect(await server.exited).toBe(0);

    cli.send({ step: 'continue' });
    const final = await cli.next();
    expect(final).toEqual({
      step: 'final',
      // Still the edited cache value, unsigned, not consumed.
      edited: { status: 'approved', signedDecision: false },
      // Used exactly once: void, with the owner's signed decision kept.
      decided: { status: 'void', signedDecision: true },
    });
    expect(await cli.exited).toBe(0);
  });
});
