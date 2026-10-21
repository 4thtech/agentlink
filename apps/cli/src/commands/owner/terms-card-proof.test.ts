// M1-9d-3: the owner's card for a firm offer and for an accept with proof (04 §3.4.2 "What the owner
// sees"; 11 §5.6, §6.10, §14 Q1 A). The card shows the stored terms the approval is bound to, never
// the agent's call text (`args.terms`), with the commitment line, what the one approval does, the
// exact cost and the proof disclosure.
import type { AgentLinkClient, CommitmentCard } from '@4thtech-io/core';
import { termsHash } from '@4thtech-io/crypto';
import { termsFromInput, type RestrictedName, type Terms } from '@4thtech-io/types';
import { describe, expect, it } from 'vitest';
import { copy } from '../../tools/strings/index.js';
import type { PendingRequest } from './pending.js';
import { cardFacts, cardLines } from './render.js';
import { TERMS_CARD_TEXT } from './terms-card.js';

const SELF = `0x${'11'.repeat(20)}`;
const OTHER = `0x${'22'.repeat(20)}`;
const NOW = 1_800_000_000;
const TERMS_ID = 'VGVybXNUZXJtc1Rlcm1zVA';
const THREAD = 'VGhyZWFkVGhyZWFkVGhyZQ';
const ENVELOPE = 'Q2xhaW1zQ2xhaW1zQ2xhaQ';
const FEE = { token: `0x${'3d'.repeat(20)}`, amount: '100000', usd: '0.1' };
const display = {
  name: 'Bob' as RestrictedName,
  label: 'self-declared' as const,
  nameSource: 'counterparty' as const,
};
const WHO = '“Bob” (self-declared)';

function stored(subject: string, self = SELF, other = OTHER): Terms {
  const r = termsFromInput(
    {
      subject,
      deliverables: [{ description: 'Three logo drafts', by: 'me' }],
      price: { amount: '120.00', currency: 'USD', payer: 'them' },
    },
    {
      termsId: TERMS_ID,
      version: 1,
      previousTermsHash: null,
      self,
      counterparty: other,
      now: NOW,
    },
  );
  if (!r.success) throw new Error('test: terms');
  return r.data;
}

function scopeOf(terms: Terms, decision: 'offer' | 'accept') {
  return {
    v: 1,
    kind: 'agentlink/commitment',
    agentId: SELF,
    decision,
    counterparty: { agentId: OTHER, ownerKey: 'cd'.repeat(32) },
    thread: THREAD,
    termsId: TERMS_ID,
    version: 1,
    termsHash: termsHash(terms),
    answers:
      decision === 'offer' ? null : { envelopeId: ENVELOPE, envelopeHash: `0x${'ab'.repeat(32)}` },
    notarize: true,
    maxFeeUsd: '0.1',
    createdAt: NOW,
    expiresAt: NOW + 86_400,
  };
}

function client(card: CommitmentCard): AgentLinkClient {
  return {
    contacts: { get: () => Promise.resolve({ id: OTHER, display }) },
    terms: { commitmentCard: () => Promise.resolve(card) },
  } as unknown as AgentLinkClient;
}

function cardOf(
  terms: Terms,
  scope: ReturnType<typeof scopeOf>,
  parts: CommitmentCard['parts'],
): CommitmentCard {
  return {
    decision: scope.decision,
    counterparty: { agentId: OTHER, display, shown: WHO },
    version: 1,
    terms,
    changes: null,
    parts,
    autoAccept: 'firm_offer',
    lateAccept: null,
    validUntil: terms.validUntil,
    expiresAt: scope.expiresAt,
    fee: FEE,
    fingerprint: scope.termsHash,
  } as CommitmentCard;
}

const request = (action: unknown): PendingRequest =>
  ({
    kind: 'ok',
    approvalId: 'apr_AAAAAAAAAAAAAAAAAAAAAA',
    action,
    commitment: true,
    expiresAt: NOW + 3_600,
  }) as unknown as PendingRequest;

describe('a firm offer with proof: the commitment card (M1-9d-3; 04 §3.4.2, 11 §14 Q1 A)', () => {
  const terms = stored('STORED-SUBJECT logo work');
  const scope = scopeOf(terms, 'offer');
  // The agent's call text differs from the stored terms: only the stored, bound copy is shown.
  const action = {
    tool: 'agentlink_propose_terms',
    args: {
      to: OTHER,
      terms: {
        subject: 'ARGS-ONLY text the owner must not be shown as the terms',
        deliverables: [{ description: 'ARGS-ONLY item', by: 'me' }],
      },
      notarize: true,
    },
    context: { triggers: ['commitments.accept'], scope, terms, fee: FEE },
  };

  it('shows the bound terms (not args.terms), the commitment line, the cost and the proof lines', async () => {
    const req = request(action);
    const facts = await cardFacts(
      client(cardOf(terms, scope, ['offer_envelope', 'offer_record'])),
      req,
    );
    expect(facts.terms).not.toBe('problem');
    expect(facts.terms).toBeDefined();
    const lines = cardLines(req, facts);
    const text = lines.join('\n');
    expect(text).not.toContain('ARGS-ONLY');
    expect(lines).toContain('| Subject: STORED-SUBJECT logo work');
    expect(lines).toContain('| Deliverable d1: Three logo drafts');
    expect(lines).toContain('|   Delivered by: you');
    expect(lines).toContain(`| Price: 120.00 USD, paid by ${WHO}`);
    expect(lines).toContain(TERMS_CARD_TEXT.ownTermsHeader);
    expect(
      lines.some((l) => l.startsWith(`Sending a firm offer with proof to ${WHO}, version 1`)),
    ).toBe(true);
    expect(lines).toContain(TERMS_CARD_TEXT.commitsOffer(WHO));
    expect(lines).toContain(TERMS_CARD_TEXT.doesOffer);
    expect(lines).toContain('Cost:     $0.10');
    expect(lines).toContain(copy('common.privacy.proof'));
    // The fixed lines the owner decides on come after the region (06 §8).
    const end = lines.lastIndexOf(lines.find((l) => l.startsWith('| Between:'))!);
    expect(lines.indexOf(TERMS_CARD_TEXT.commitsOffer(WHO))).toBeGreaterThan(end);
  });

  it('is a problem (never offered) when the stored terms do not hash to the signed scope', async () => {
    const other = stored('another subject');
    const bad = { ...action, context: { ...action.context, terms: other } };
    const facts = await cardFacts(
      client(cardOf(terms, scope, ['offer_envelope', 'offer_record'])),
      request(bad),
    );
    expect(facts.terms).toBe('problem');
  });
});

describe('an accept with proof says what the one approval does (M1-9d-3)', () => {
  it('three parts (accept, its proof, the Accepted receipt): the accept-with-proof line, not the generic one', async () => {
    const terms = stored('Offer from Bob', OTHER, SELF);
    const scope = scopeOf(terms, 'accept');
    const action = {
      tool: 'agentlink_respond_to_terms',
      args: { envelopeId: ENVELOPE, decision: 'accept', notarize: true },
      context: { triggers: ['commitments.accept'], scope, terms, fee: FEE },
    };
    const req = request(action);
    const facts = await cardFacts(
      client(cardOf(terms, scope, ['accept_envelope', 'accept_record', 'accepted_receipt'])),
      req,
    );
    const lines = cardLines(req, facts);
    expect(lines).toContain(TERMS_CARD_TEXT.doesAcceptProof);
    expect(lines).not.toContain(TERMS_CARD_TEXT.doesOther);
    expect(TERMS_CARD_TEXT.doesAcceptProof).toContain('commits you');
    expect(lines).toContain('Cost:     $0.10');
  });
});
