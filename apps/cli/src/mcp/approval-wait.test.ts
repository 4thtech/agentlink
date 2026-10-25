// M1-36j (D4): the per-harness wait budget, picked by the MCP client's `clientInfo.name`, and the
// wait over a real SDK client: a known harness waits for the owner's decision, an unknown one does
// not, and a client cancel stops the wait.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ApprovalState, CommitmentCard, RespondToTermsResult } from '@4thtech-io/core';
import { createLogger } from '@4thtech-io/log';
import type { ContactDisplayName, RestrictedName, Terms } from '@4thtech-io/types';
import { describe, expect, it } from 'vitest';
import type { TermsTools } from '@4thtech-io/mcp-tools/context.js';
import type { ToolClient, ToolContext } from '@4thtech-io/mcp-tools';
import {
  APPROVAL_WAIT_MAX_MS,
  APPROVAL_WAIT_MS_BY_CLIENT,
  approvalWaitMsFor,
} from './approval-wait.js';
import { createMcpServer } from './server.js';

const B = `0x${'b'.repeat(40)}`;
const ENVELOPE = 'Q2xhaW1zQ2xhaW1zQ2xhaQ';
const HASH = 'ab'.repeat(32);
const APPROVAL = 'apr_AAAAAAAAAAAAAAAAAAAAAA';
const VALID_UNTIL = 1_761_206_400;
const ORIGIN = 'http://localhost:47321';
const silent = createLogger({ sink: () => undefined });

describe('the per-harness wait budget (M1-36j)', () => {
  it('stays at or under 45 s and well under each known tool-call timeout', () => {
    for (const [name, ms] of Object.entries(APPROVAL_WAIT_MS_BY_CLIENT)) {
      expect(ms, name).toBeGreaterThanOrEqual(0);
      expect(ms, name).toBeLessThanOrEqual(APPROVAL_WAIT_MAX_MS);
    }
    expect(APPROVAL_WAIT_MAX_MS).toBeLessThanOrEqual(45_000);
    // Codex: 60 s default `tool_timeout_sec`, so at most half of it.
    expect(approvalWaitMsFor('codex-mcp-client')).toBeLessThanOrEqual(30_000);
    expect(approvalWaitMsFor('claude-code')).toBe(45_000);
    expect(approvalWaitMsFor('gemini-cli-mcp-client')).toBe(45_000);
  });

  it('gives no wait to an unknown, missing or odd client name', () => {
    for (const name of [
      undefined,
      '',
      'cursor-vscode',
      'windsurf',
      'opencode',
      'Claude-Code',
      'claude-code ',
      'claude-codex',
      42,
      null,
      {},
      'toString',
      '__proto__',
      'constructor',
    ]) {
      expect(approvalWaitMsFor(name as unknown), String(name)).toBe(0);
    }
  });

  it('the table is frozen', () => {
    expect(Object.isFrozen(APPROVAL_WAIT_MS_BY_CLIENT)).toBe(true);
  });
});

// ---- Over a real SDK client ---------------------------------------------------------------------

const display = (name: string): ContactDisplayName =>
  ({
    name: name as RestrictedName,
    label: 'self-declared',
    nameSource: 'counterparty',
  }) as ContactDisplayName;

function setup(states: readonly string[]): { context: ToolContext; reads: () => number } {
  let reads = 0;
  const terms: TermsTools = {
    propose: () => Promise.reject(new Error('not used')),
    respond: () =>
      Promise.resolve({
        status: 'pending_approval',
        approvalId: APPROVAL,
        actionDigest: HASH,
        summary: 'core text',
        expiresAt: VALID_UNTIL,
        card: {
          decision: 'accept',
          counterparty: { agentId: B, display: display('Marko'), shown: '“Marko” (self-declared)' },
          version: 3,
          terms: { termsId: ENVELOPE, version: 3 } as unknown as Terms,
          changes: null,
          parts: ['accept_envelope', 'accepted_receipt'],
          autoAccept: 'contact_not_listed',
          lateAccept: null,
          validUntil: VALID_UNTIL,
          expiresAt: VALID_UNTIL,
          fee: null,
          fingerprint: HASH,
        } as CommitmentCard,
      } as RespondToTermsResult),
    senderOf: () => Promise.resolve({ id: B, display: display('Marko') }),
  };
  const client = {
    approvalState: () => {
      const status = states[Math.min(reads, states.length - 1)] ?? 'pending';
      reads += 1;
      return Promise.resolve({
        status,
        actionDigest: HASH,
        expiresAt: VALID_UNTIL,
      } as ApprovalState);
    },
    self: () =>
      Promise.resolve({
        agentId: `0x${'a'.repeat(40)}`,
        agentFingerprint: '1111·2222',
        ownerFingerprint: '3333·4444',
      }),
    contacts: () => Promise.resolve([]),
    terms,
  } as unknown as ToolClient;
  const context: ToolContext = {
    client,
    clock: () => 1_760_600_000,
    logger: silent,
    agentName: 'default',
    approvalNextStep: (id) => `Tell the user: Approval needed. Run agentlink approve ${id}.`,
    urlOrigins: [],
    approvalLink: (id) =>
      Promise.resolve({
        url: `${ORIGIN}/approve/${id}`,
        origin: ORIGIN,
        nextStep: `Never open or fetch this link yourself. Approve here: ${ORIGIN}/approve/${id}`,
      }),
  };
  return { context, reads: () => reads };
}

async function connect(context: ToolContext, clientName: string): Promise<Client> {
  const server = createMcpServer(context, '0.0.0-test', {
    approvalWaitMs: (name) => (name === 'claude-code' ? 2_000 : approvalWaitMsFor(name)),
    approvalWaitIntervalMs: 5,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: clientName, version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

const ARGS = {
  name: 'agentlink_respond_to_terms',
  arguments: { envelopeId: ENVELOPE, decision: 'accept' },
};

describe('the wait over MCP (M1-36j)', () => {
  it('a known harness gets the decision inside the same call', async () => {
    const { context } = setup(['pending', 'approved']);
    const client = await connect(context, 'claude-code');
    const result = await client.callTool(ARGS);
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured['status']).toBe('pending_approval');
    expect(structured['url']).toBeUndefined();
    expect(String(structured['summary'])).toMatch(/approved/i);
    await client.close();
  });

  it('an unknown harness gets the pending_approval result at once, with no read', async () => {
    const { context, reads } = setup(['approved']);
    const client = await connect(context, 'some-new-harness');
    const result = await client.callTool(ARGS);
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured['status']).toBe('pending_approval');
    expect(structured['url']).toBe(`${ORIGIN}/approve/${APPROVAL}`);
    expect(reads()).toBe(0);
    await client.close();
  });

  it('a client cancel stops the wait', async () => {
    const { context, reads } = setup(['pending']);
    const client = await connect(context, 'claude-code');
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 30);
    await expect(client.callTool(ARGS, undefined, { signal: controller.signal })).rejects.toThrow();
    const at = reads();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(reads()).toBe(at);
    expect(Date.now() - started).toBeLessThan(1_000);
    await client.close();
  });
});
