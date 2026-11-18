// SEC-INVITE-CAPS (D-156; 06 §3 `contacts.aiInvites`; 11 §5): the owner's caps on invites the AI
// makes, under "More rules". Absent from an older server reads as the defaults (3, 5, 24 h); a change
// patches the whole object; a value out of bounds is not sent. Saving is the page's ordinary signed
// policy edit (presence), never an MCP tool.
import { describe, expect, it } from 'vitest';
import { checkDraft, draftOf, parseRules, toCap, AI_INVITES_BOUNDS } from './data.js';
import { RULES_STRINGS as S } from './strings.js';

const rules = (contacts: Record<string, unknown>): Record<string, unknown> => ({
  status: 'ok',
  version: 3,
  rules: {
    proofs: {
      notarize: 'allow',
      dailyBudgetUSD: '5',
      perActionMaxUSD: '1',
      allowKeyDisclosure: 'approval',
    },
    contacts: {
      acceptInvites: 'approval',
      unknownSenders: 'queue',
      allowed: 'paired',
      listed: 0,
      ...contacts,
    },
    files: { maxSendSizeMB: 100, maxReceiveSizeMB: 200, allowedFolders: 0 },
    receipts: { autoDelivered: false },
    commitments: {
      accept: 'approval',
      autoAcceptDirection: 'buy',
      autoAcceptMaxUSD: '0',
      autoAcceptMinUSD: null,
      autoAcceptContacts: 0,
    },
    contactRules: 0,
  },
});

describe('contacts.aiInvites in the Rules data', () => {
  it('reads the defaults when the server leaves it out, and refuses a value out of bounds', () => {
    const absent = parseRules(rules({}));
    if (absent.kind !== 'ok') throw new Error('test: not parsed');
    expect(absent.rules.contacts.aiInvites).toEqual({ maxOpen: 3, perDay: 5, expiryHours: 24 });
    const own = parseRules(rules({ aiInvites: { maxOpen: 1, perDay: 2, expiryHours: 4 } }));
    if (own.kind !== 'ok') throw new Error('test: not parsed');
    expect(own.rules.contacts.aiInvites).toEqual({ maxOpen: 1, perDay: 2, expiryHours: 4 });
    expect(parseRules(rules({ aiInvites: { maxOpen: 99, perDay: 2, expiryHours: 4 } })).kind).toBe(
      'unavailable',
    );
  });

  it('a change patches the whole object once; an invalid entry is marked and not sent', () => {
    const parsed = parseRules(rules({}));
    if (parsed.kind !== 'ok') throw new Error('test: not parsed');
    const draft = draftOf(parsed.rules);
    expect(checkDraft(parsed.rules, draft).changes).toBe(0);
    const lower = checkDraft(parsed.rules, { ...draft, aiMaxOpen: '1' });
    expect(lower.changes).toBe(1);
    expect(lower.patch).toEqual({
      contacts: { aiInvites: { maxOpen: 1, perDay: 5, expiryHours: 24 } },
    });
    const bad = checkDraft(parsed.rules, { ...draft, aiExpiryHours: '0' });
    expect(bad.invalid.has('aiExpiryHours')).toBe(true);
    expect(bad.patch).toEqual({});
  });

  it('caps parse as whole numbers within bounds (0 turns AI invites off)', () => {
    expect(toCap('0', AI_INVITES_BOUNDS.maxOpen)).toBe(0);
    expect(toCap(' 20 ', AI_INVITES_BOUNDS.maxOpen)).toBe(20);
    expect(toCap('21', AI_INVITES_BOUNDS.maxOpen)).toBeUndefined();
    expect(toCap('1.5', AI_INVITES_BOUNDS.perDay)).toBeUndefined();
    expect(toCap('0', AI_INVITES_BOUNDS.expiryHours)).toBeUndefined();
  });

  it('the copy is plain (11 §5)', () => {
    expect(S.aiInvitesSummary(3, 5, 24)).toBe('At most 3 open, 5 a day, each for 24 hours.');
    expect(S.aiInvitesSummary(0, 5, 24)).toBe('Your AI can’t create invites.');
    expect(`${S.aiInvitesTitle} ${S.aiInvitesHelp}`).not.toMatch(
      /wallet|gas|seed phrase|transaction/i,
    );
  });
});
