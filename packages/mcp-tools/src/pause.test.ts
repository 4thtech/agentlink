// W4-PAUSE (S2; D-143 (5); 06 §6 "Paused agents"; I-4, I-5): while the owner has paused the agent,
// every tool that sends or fetches is refused before any effect with `rejected` / `AGENT_PAUSED` and
// the fixed nextStep; the refusal is not kept under `clientRequestId`, so the same call works after
// resume. Read tools answer from the store with no relay fetch, and `agentlink_status` adds the fixed
// paused line. Fail closed: a pause state that cannot be read counts as paused. No tool pauses or
// resumes (the tool surface is unchanged).
import { createLogger } from '@4thtech-io/log';
import { describe, expect, it } from 'vitest';
import type { Counts, ToolClient, ToolContext } from './context.js';
import { callTool, TOOLS } from './index.js';

const A = `0x${'a'.repeat(40)}`;
const ENVELOPE = 'A'.repeat(22);
const PAUSED_LINE = 'This agent is paused. The owner can resume it in the AgentLink app.';

/** One valid input per sending or fetching tool (06 §6 "Paused agents" list). */
const REFUSED: Record<string, Record<string, unknown>> = {
  agentlink_send: { to: 'Marko', text: 'hello', clientRequestId: 'req-1' },
  agentlink_acknowledge: { envelopeId: ENVELOPE, type: 'delivered' },
  agentlink_propose_terms: {
    to: 'Marko',
    terms: { subject: 'Logo', deliverables: [{ description: 'Drafts', by: 'them' }] },
  },
  agentlink_respond_to_terms: { envelopeId: ENVELOPE, decision: 'reject' },
  agentlink_notarize: { envelopeId: ENVELOPE },
  agentlink_create_invite: { expiresInDays: 3 },
  agentlink_accept_invite: { inviteUrl: 'https://agentlink.4thtech.io/i/x' },
  agentlink_fetch_file: { envelopeId: ENVELOPE },
};

function fake(paused: 'yes' | 'no' | 'throws'): ToolClient & { calls: string[] } {
  const calls: string[] = [];
  const counts: Counts = { inbox: [], requests: 0 };
  const record =
    <T>(name: string, value: T) =>
    (): Promise<T> => {
      calls.push(name);
      return Promise.resolve(value);
    };
  const refuse = (name: string) => (): Promise<never> => {
    calls.push(name);
    return Promise.reject(new Error('must not run while paused'));
  };
  return {
    calls,
    paused: () => {
      calls.push('paused');
      return paused === 'throws'
        ? Promise.reject(new Error('SQLITE_CORRUPT'))
        : Promise.resolve(paused === 'yes');
    },
    self: record('self', {
      agentId: A,
      agentFingerprint: '1111·2222',
      ownerFingerprint: '3333·4444',
    }),
    catchUp: refuse('catchUp'),
    storedCounts: record('storedCounts', counts),
    contacts: record('contacts', []),
    storageMode: record('storageMode', 'drop' as const),
    send: refuse('send'),
    syncInbox: refuse('syncInbox'),
    inboxPage: record('inboxPage', { status: 'ok', items: [], requests: 0 } as never),
    pendingApprovals: record('pendingApprovals', 0),
    approvalState: record('approvalState', { status: 'unknown', reason: 'not_found' } as never),
  } as ToolClient & { calls: string[] };
}

function context(client: ToolClient): ToolContext {
  return {
    client,
    clock: () => 1_760_600_000,
    logger: createLogger({ level: 'debug', sink: () => undefined }),
    agentName: 'default',
    approvalNextStep: (id) => `Run agentlink approve ${id} in your own terminal.`,
    urlOrigins: [],
  };
}

describe('W4-PAUSE: sending and fetching tools refuse while paused (06 §6)', () => {
  for (const [name, input] of Object.entries(REFUSED)) {
    it(`${name}: rejected / AGENT_PAUSED before any effect`, async () => {
      const client = fake('yes');
      const result = await callTool(name, input, context(client));
      expect(result.structured).toMatchObject({
        status: 'rejected',
        code: 'AGENT_PAUSED',
        nextStep: PAUSED_LINE,
      });
      // Only the pause read ran: nothing resolved, sent, fetched or kept under clientRequestId.
      expect(client.calls).toEqual(['paused']);
    });

    it(`${name}: fails closed when the pause state cannot be read`, async () => {
      const client = fake('throws');
      const result = await callTool(name, input, context(client));
      expect(result.structured).toMatchObject({ status: 'rejected', code: 'AGENT_PAUSED' });
      expect(client.calls).toEqual(['paused']);
    });
  }

  it('the same send works when the agent is not paused (no refusal was kept)', async () => {
    const client = fake('no');
    const result = await callTool('agentlink_send', REFUSED['agentlink_send'], context(client));
    expect(result.structured['code']).not.toBe('AGENT_PAUSED');
    expect(client.calls).toContain('paused');
  });

  it('agentlink_status answers from the store with no relay fetch and adds the paused line', async () => {
    const client = fake('yes');
    const result = await callTool('agentlink_status', {}, context(client));
    expect(result.structured.status).toBe('ok');
    expect(result.structured.nextStep).toBe(PAUSED_LINE);
    expect(result.text).toContain(PAUSED_LINE);
    expect(client.calls).not.toContain('catchUp');
    expect(client.calls).toContain('storedCounts');
  });

  it('agentlink_inbox answers from the store with no relay fetch while paused', async () => {
    const client = fake('yes');
    const result = await callTool('agentlink_inbox', { limit: 5 }, context(client));
    expect(result.structured.status).toBe('ok');
    expect(client.calls).not.toContain('syncInbox');
    expect(client.calls).toContain('inboxPage');
  });

  it('read tools are not refused', async () => {
    const client = fake('yes');
    for (const name of ['agentlink_list_contacts', 'agentlink_get_approval']) {
      const input =
        name === 'agentlink_get_approval' ? { approvalId: `apr_${'A'.repeat(22)}` } : {};
      const result = await callTool(name, input, context(client));
      expect(result.structured['code'], name).not.toBe('AGENT_PAUSED');
    }
  });

  it('I-4: no tool pauses or resumes, and no tool text mentions it', () => {
    for (const tool of TOOLS) {
      expect(tool.name).not.toMatch(/pause|resume/);
      expect(JSON.stringify(tool)).not.toMatch(/agent\.resume|agent_pause/);
    }
  });
});
