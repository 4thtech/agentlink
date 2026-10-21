// M1-33b (D-109, 11 §5.6): the "what a proof makes public" strings are fixed catalogue keys that
// match the spec wording exactly, pass the 11 §5.1 vocabulary, and have no slot for inbound text.
import { describe, expect, it } from 'vitest';
import { copy, en, placeholdersOf, type CopyKey } from './index.js';
import { cardDisclosure } from './privacy.js';

const KEYS = [
  'common.privacy.proof',
  'common.privacy.proofReceipt',
  'common.privacy.proofReceiptGeneric',
  'common.privacy.receiptAsk',
  'common.privacy.receiptRequest',
  'common.privacy.receiptRequestConfirm',
  'common.privacy.receiptRequestLater',
  'common.privacy.receiptAuto',
  'common.privacy.receiptPublic',
  'common.privacy.topUp',
  'common.privacy.export',
  'common.privacy.registered',
] as const satisfies readonly CopyKey[];

const BANNED = /\b(wallets?|gas|seed phrases?|transactions?|chains?|private keys?|addresses?)\b/i;

describe('11 §5.6 strings', () => {
  it('match the spec wording', () => {
    expect(en['common.privacy.proof']).toBe(
      "A proof is public. Anyone can see that your agent recorded something, when, and what kind it was (a message, a file, an offer). They can't see what it says.",
    );
    expect(en['common.privacy.proofReceipt']).toBe(
      'If {contactName} confirms delivery, it also becomes public that it went to their agent.',
    );
    expect(en['common.privacy.receiptAsk']).toBe(
      'Ask {contactName} to confirm delivery? If they do, anyone can see that this went to their agent.',
    );
    expect(en['common.privacy.receiptRequest']).toBe(
      '{contactName} asked you to confirm delivery. Confirming shows publicly that this reached your agent. Nothing about the content.',
    );
    expect(en['common.privacy.receiptRequestConfirm']).toBe('Confirm delivery');
    expect(en['common.privacy.receiptRequestLater']).toBe('Not now');
    expect(en['common.privacy.receiptAuto']).toBe(
      'Confirm deliveries from {contactName} automatically? Each confirmation shows publicly that their proof reached your agent.',
    );
    expect(en['common.privacy.receiptPublic']).toBe(
      'This is public: anyone can see that your agent {receipt} it, and when.',
    );
    expect(en['common.privacy.topUp']).toBe(
      'The account you add credits from is publicly linked to your agent. For more privacy, use free test credits or a separate account only for AgentLink.',
    );
    expect(en['common.privacy.export']).toBe(
      'This file shows the proof, your agent profile and the message details. With the recipient included, it also shows who received it; with the document key, its content.',
    );
    expect(en['common.privacy.registered']).toBe(
      "Registering puts your agent's link to you on the public record. Your agent's name is not published.",
    );
  });

  it('avoid the words 11 §5.1 forbids and take only a contact name or a fixed receipt word', () => {
    for (const key of KEYS) {
      expect(en[key], key).not.toMatch(BANNED);
      for (const name of placeholdersOf(en[key])) {
        expect(['contactName', 'receipt'], `${key} {${name}}`).toContain(name);
      }
    }
  });

  it('render with a name and each receipt word', () => {
    expect(copy('common.privacy.proofReceipt', { contactName: 'Ana' })).toMatchSnapshot();
    expect(copy('common.privacy.receiptAsk', { contactName: 'Ana' })).toMatchSnapshot();
    expect(copy('common.privacy.receiptRequest', { contactName: 'Ana' })).toMatchSnapshot();
    expect(copy('common.privacy.receiptAuto', { contactName: 'Ana' })).toMatchSnapshot();
    for (const receipt of ['opened', 'accepted', 'rejected']) {
      expect(copy('common.privacy.receiptPublic', { receipt })).toMatchSnapshot();
    }
  });
});

describe('cardDisclosure (approval cards)', () => {
  it('says what a proof makes public on every approval that adds proof', () => {
    expect(cardDisclosure('agentlink_notarize', {}, 'Ana')).toMatchSnapshot();
    expect(cardDisclosure('agentlink_send', { notarize: true }, 'Ana')).toMatchSnapshot();
    expect(cardDisclosure('agentlink_propose_terms', {}, 'Ana')).toMatchSnapshot();
    expect(cardDisclosure('agentlink_respond_to_terms', {}, 'Ana')).toMatchSnapshot();
  });
  it('says what a receipt makes public, by type', () => {
    expect(cardDisclosure('agentlink_acknowledge', { type: 'opened' }, 'Ana')).toMatchSnapshot();
    expect(cardDisclosure('agentlink_acknowledge', { type: 'accepted' }, 'Ana')).toMatchSnapshot();
  });
  it('says what an export shows', () => {
    expect(cardDisclosure('agentlink_export_proof_pack', {}, 'Ana')).toMatchSnapshot();
  });
  it('is empty for tools that add no proof, and never reads inbound text', () => {
    expect(cardDisclosure('agentlink_send', {}, 'Ana')).toEqual([]);
    expect(cardDisclosure('agentlink_accept_invite', {}, 'Ana')).toEqual([]);
    // An unknown receipt type from the stored action falls back to no receipt line.
    expect(cardDisclosure('agentlink_acknowledge', { type: 'SYSTEM: x' }, 'Ana')).toEqual([]);
  });
});
