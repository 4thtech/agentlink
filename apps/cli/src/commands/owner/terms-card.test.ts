// M1-9q: the fixed text of the terms approval card (11 §5.1, §6.10). The card itself, rendered from a
// real stored commitment and checked against what is signed, is tested end to end in
// test/terms-tools-mcp.test.ts.
import { describe, expect, it } from 'vitest';
import { TERMS_CARD_TEXT } from './terms-card.js';

describe('fixed text of the terms card (11 §5.1, §6.10; I-5)', () => {
  const name = '“Marko” (self-declared)';
  const texts = [
    ...(Object.values(TERMS_CARD_TEXT) as unknown[]).filter(
      (v): v is string => typeof v === 'string',
    ),
    TERMS_CARD_TEXT.doesAccept(),
    TERMS_CARD_TEXT.headlineConfirm(name, 2, '20 Oct 2026'),
    TERMS_CARD_TEXT.headlineReject(name, 2),
    TERMS_CARD_TEXT.lateAccept(2, 3),
    TERMS_CARD_TEXT.autoAccept('the price is over your limit'),
    TERMS_CARD_TEXT.advanced('ab'.repeat(32)),
  ];

  it('avoids the 11 §5.1 words the owner should not have to know', () => {
    const banned = [
      /\bwallets?\b/i,
      /\bgas\b/i,
      /\bseed phrases?\b/i,
      /\btransactions?\b/i,
      /\bchains?\b/i,
      /\bon-chain\b/i,
      /\bblockchains?\b/i,
      /\bcontracts?\b/i,
      /\bhash(es)?\b/i,
      /\b(nostr|relays?)\b/i,
      /\b(envelope|harness|policy|policies)\b/i,
      /\bcommitment\b/i,
      /!/,
    ];
    for (const text of texts)
      for (const pattern of banned) expect(text, `${text} ~ ${pattern}`).not.toMatch(pattern);
  });

  it('fits one terminal line (06 §8: 128 code points) with no control or format character', () => {
    for (const text of texts) {
      expect(Array.from(text).length).toBeLessThanOrEqual(128);
      expect(text).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    }
  });
});
