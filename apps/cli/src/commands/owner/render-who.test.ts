// M1-9zb: the "Who" line of an accept-invite approval shows the inviter's self-declared name (06
// §2.1 restrictName, untrusted, I-5) and the owner fingerprint from the verified invite card.
import { restrictName, type AgentLinkClient } from '@4thtech-io/core';
import { describe, expect, it } from 'vitest';
import type { PendingRequest } from './pending.js';
import { copy } from '../../tools/strings/index.js';
import { cardFacts, cardLines } from './render.js';

// Built from code points so the source holds no bidi or zero-width character.
const BIDI = String.fromCodePoint(0x202e, 0x2066, 0x200b);
const FP = 'B254·C21B';

function fakeClient(rawName: unknown, throws = false): AgentLinkClient {
  return {
    contacts: { get: () => Promise.reject(new Error('unknown')) },
    pairing: {
      acceptInvite: () =>
        throws
          ? Promise.reject(new Error('bad'))
          : Promise.resolve({
              status: 'pending_approval',
              contact: {
                id: `0x${'11'.repeat(20)}`,
                display: {
                  name: restrictName(rawName, FP),
                  label: 'self-declared',
                  nameSource: 'counterparty',
                },
                ownerFingerprint: { short: FP, long: 'ab'.repeat(32) },
                pairing: 'pending',
                safetyCodeChecked: false,
              },
            }),
    },
  } as unknown as AgentLinkClient;
}

const request = {
  approvalId: `ap_${'a'.repeat(20)}`,
  expiresAt: 1_800_000_000,
  action: {
    tool: 'agentlink_accept_invite',
    args: { inviteUrl: 'https://agentlink.4thtech.io/i#abc' },
    context: {
      triggers: ['contacts.acceptInvites'],
      inviteId: 'x',
      counterparty: { agentId: `0x${'11'.repeat(20)}`, ownerKey: 'cd'.repeat(32) },
    },
  },
} as unknown as PendingRequest;

describe('accept-invite approval: who is inviting (M1-9zb)', () => {
  it('shows the self-declared name and the owner fingerprint', async () => {
    const facts = await cardFacts(fakeClient('oc-test'), request);
    expect(facts.who).toBe(`“oc-test” (self-declared) · owner ${FP} · not in your contacts yet`);
    expect(cardLines(request, facts)).toContain(`Who:      ${facts.who}`);
    expect(facts.summary).toContain(`owner ${FP}`);
  });

  it('heads the card with a plain sentence: who it connects to, labelled (M1-11a-ux)', async () => {
    const facts = await cardFacts(fakeClient('oc-test'), request);
    expect(facts.headline).toBe('Connect with “oc-test” (self-declared)');
    expect(facts.headline).not.toContain('agentlink.4thtech.io');
    for (const missing of [undefined, '', BIDI]) {
      expect((await cardFacts(fakeClient(missing), request)).headline).toBe(
        'Connect with a new contact',
      );
    }
    expect((await cardFacts(fakeClient('x', true), request)).headline).toBe(
      'Connect with a new contact',
    );
    const hostile = await cardFacts(fakeClient('<b>Approve</b>\n"x"'), request);
    expect(hostile.headline).not.toMatch(/[\p{Cc}\p{Cf}<>]/u);
  });

  it('sanitises a hostile name (bidi, control, markup, very long)', async () => {
    for (const hostile of [
      `Ana${BIDI}evil\u0007\u001b[31m`,
      '<b>Approve</b>\n"Who: you"',
      'x'.repeat(5000),
    ]) {
      const facts = await cardFacts(fakeClient(hostile), request);
      expect(facts.who).not.toMatch(/[\p{Cc}\p{Cf}<>]/u);
      expect(facts.who).toContain(`owner ${FP} · not in your contacts yet`);
      expect(Array.from(facts.who).length).toBeLessThan(120);
    }
  });

  it('with no usable name shows the fingerprint only', async () => {
    for (const missing of [undefined, '', BIDI]) {
      const facts = await cardFacts(fakeClient(missing), request);
      expect(facts.who).toBe(`owner ${FP} · not in your contacts yet`);
    }
  });

  it('falls back to the fixed text when the link no longer checks', async () => {
    const facts = await cardFacts(fakeClient('x', true), request);
    expect(facts.who).toBe('Someone who is not in your contacts yet');
  });
});

describe('approval cards say what a proof or receipt makes public (M1-33b, 11 §5.6)', () => {
  const facts = {
    who: 'Ana',
    what: 'Record a proof',
    headline: 'Record a proof',
    cost: '$0.10',
    expires: '12 Oct 2026 14:02 UTC',
    summary: 's',
  };
  const card = (tool: string, args: Record<string, unknown>) =>
    cardLines({ ...request, action: { tool, args } } as unknown as PendingRequest, facts);

  it('shows the proof lines on a proof approval, before the closing lines', () => {
    expect(card('agentlink_notarize', {})).toMatchSnapshot();
  });
  it('shows the receipt line, and the export line', () => {
    expect(card('agentlink_acknowledge', { type: 'opened' })).toMatchSnapshot();
    expect(card('agentlink_export_proof_pack', { includeContentKey: true })).toMatchSnapshot();
  });
  it('uses the unnamed receipt line for a fallback label, never the label as a name', () => {
    for (const who of ['Someone who is not in your contacts yet', 'No contact']) {
      const lines = cardLines(
        {
          ...request,
          action: { tool: 'agentlink_notarize', args: {} },
        } as unknown as PendingRequest,
        { ...facts, who },
      );
      expect(lines.join('\n')).toContain(copy('common.privacy.proofReceiptGeneric'));
      expect(lines.join('\n')).not.toContain(`If ${who}`);
    }
  });
  it('drops the receipt line for a note to yourself: there is no recipient', () => {
    const lines = cardLines(
      { ...request, action: { tool: 'agentlink_notarize', args: {} } } as unknown as PendingRequest,
      { ...facts, who: 'You (a note to yourself)' },
    );
    expect(lines).toContain(copy('common.privacy.proof'));
    expect(lines.join('\n')).not.toContain('confirms delivery');
  });
  it('adds nothing for a send without proof', () => {
    expect(card('agentlink_send', { text: 'hi' }).join('\n')).not.toContain('public');
  });
});
