// SEC-INVITE-CAPS (S2; D-156; 06 §2.1, §2.2; I-4, I-5): what the AI sees.
// - `agentlink_create_invite` makes an AI invite (core `createAiInvite`, capped); over a cap the
//   result is `rejected`, code INVITE_LIMIT, in plain words, with when it frees up.
// - A contact the AI connected waits for the owner: `agentlink_list_contacts` says so
//   (`waitingForOwner: true`) and `agentlink_send` refuses it before anything is attached or sent
//   (CONTACT_WAITING_OWNER); a core refusal maps to the same result.
// - No MCP tool keeps a contact or changes the caps (I-4): Keep is an owner action in the app only.
import { CoreError, InviteLimitError, type ContactView } from '@4thtech-io/core';
import { createLogger } from '@4thtech-io/log';
import { describe, expect, it } from 'vitest';
import type { ToolContext } from './context.js';
import { createInviteHandler } from './create-invite.js';
import { INVITE_TEXT } from './invite-common.js';
import { listContactsHandler } from './list-contacts.js';
import { ADVANCED_TOOLS, TOOLS } from './registry.js';
import { SEND_TEXT, sendHandler } from './send.js';

const A = `0x${'a'.repeat(40)}`;
const B = `0x${'b'.repeat(40)}`;
const logger = createLogger({ name: 'test', level: 'error', sink: () => undefined });

function contact(id: string, waiting: boolean): ContactView {
  return {
    id,
    name: { value: 'Ana', source: 'counterparty', selfDeclared: true },
    display: { name: 'Ana', label: 'self-declared', nameSource: 'counterparty' },
    ownerFingerprint: { short: '7F3A·19C2', long: 'F'.repeat(64) },
    status: 'active',
    pairing: 'complete',
    safetyCodeChecked: false,
    keyEpoch: 0,
    createdAt: 1_760_000_000,
    updatedAt: 1_760_500_000,
    ...(waiting ? { waitingForOwner: true } : {}),
  } as unknown as ContactView;
}

function context(client: Record<string, unknown>): ToolContext {
  return { client, logger } as unknown as ToolContext;
}

describe('agentlink_create_invite over a cap', () => {
  it('open cap: rejected, INVITE_LIMIT, the fixed plain sentence', async () => {
    const out = await createInviteHandler(
      {},
      context({
        invites: { create: () => Promise.reject(new InviteLimitError('open', 3)) },
      }),
    );
    expect(out.result).toMatchObject({ status: 'rejected', code: 'INVITE_LIMIT' });
    expect(out.result.summary).toBe(
      'You have 3 open invites. Ask your owner to create more in the app, or wait for one to be used or expire.',
    );
    expect(out.result.nextStep).toBe(INVITE_TEXT.limitNextStep);
  });

  it('daily cap: rejected, INVITE_LIMIT, says how many and that it frees up', async () => {
    const out = await createInviteHandler(
      {},
      context({
        invites: {
          create: () => Promise.reject(new InviteLimitError('daily', 5, 1_800_086_400)),
        },
      }),
    );
    expect(out.result).toMatchObject({ status: 'rejected', code: 'INVITE_LIMIT' });
    expect(out.result.summary).toMatch(/^You made 5 invites in the last 24 hours\./);
    expect(out.result.summary).toContain('Ask your owner to create more in the app');
  });

  it('a cap of 0 says the owner turned AI invites off', async () => {
    const out = await createInviteHandler(
      {},
      context({ invites: { create: () => Promise.reject(new InviteLimitError('open', 0)) } }),
    );
    expect(out.result.summary).toBe(
      "Your owner hasn't allowed you to create invites. Ask them to create one in the app.",
    );
  });
});

describe('a contact the AI connected (waiting for the owner)', () => {
  it('list_contacts marks it waitingForOwner, and only it', async () => {
    const out = await listContactsHandler(
      {},
      context({
        contacts: () => Promise.resolve([contact(A, true), contact(B, false)]),
        storedCounts: () => Promise.resolve({ inbox: [], requests: 0 }),
      }),
    );
    const rows = out.result['contacts'] as Record<string, unknown>[];
    expect(rows[0]?.['waitingForOwner']).toBe(true);
    expect('waitingForOwner' in (rows[1] ?? {})).toBe(false);
  });

  it('send refuses it before the core is called', async () => {
    const calls: string[] = [];
    const out = await sendHandler(
      { to: A, text: 'hi' },
      context({
        self: () => Promise.resolve({ agentId: B }),
        contacts: () => Promise.resolve([contact(A, true)]),
        send: () => (calls.push('send'), Promise.reject(new Error('not reached'))),
      }),
    );
    expect(calls).toEqual([]);
    expect(out.result).toMatchObject({ status: 'rejected', code: 'CONTACT_WAITING_OWNER' });
    expect(out.result.summary).toBe(SEND_TEXT.waitingOwner);
  });

  it('a core contact_waiting_owner maps to the same result', async () => {
    const out = await sendHandler(
      { to: A, text: 'hi' },
      context({
        self: () => Promise.resolve({ agentId: B }),
        contacts: () => Promise.resolve([contact(A, false)]),
        send: () =>
          Promise.reject(new CoreError('contact_waiting_owner', 'Waiting for the owner.')),
      }),
    );
    expect(out.result).toMatchObject({ status: 'rejected', code: 'CONTACT_WAITING_OWNER' });
  });
});

describe('no MCP tool keeps a contact or changes the invite caps (I-4)', () => {
  it('no tool is named for it, and no input names keep, aiInvites or waiting', () => {
    for (const tool of [...TOOLS, ...ADVANCED_TOOLS]) {
      expect(tool.name).not.toMatch(/keep/i);
      const schema = JSON.stringify(tool.inputSchema);
      expect(schema, tool.name).not.toMatch(/keep|aiInvites|waitingForOwner|waiting_owner/i);
    }
  });
});
