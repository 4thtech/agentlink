// M1-11c-a5, D-119: every warning code core's preparePolicyEdit can return has plain words for the
// confirm screen (11 §5). The server side checks this list against core's POLICY_EDIT_WARNING_CODES
// (packages/node/src/local-ui/api/rules.test.ts), so a new core code fails a test until it has text.
import { describe, expect, it } from 'vitest';
import { UNKNOWN_WARNING, WARNING_CODES, WARNING_TEXT, warningText } from './warnings.js';

/** 11 §5.1 "never say" words, outside Advanced. */
const NEVER_SAY =
  /\b(wallet|address|private key|seed phrase|transactions?|tx|gas|mint|notari[sz]e|smart contract|on-chain|blockchain|base|gnosis|chains?|usdc|usdt|tokens?|deposit|faucet|hash|nostr|relays?|encryption key|decrypt|polic(y|ies)|harness|envelopes?|agent card|mcp|owner key|signature|keystore|contract|legally binding|commitments?|password)\b/i;

describe('warning text (D-119; 11 §5)', () => {
  it('covers every code core returns, at least 15', () => {
    expect(WARNING_CODES.length).toBeGreaterThanOrEqual(15);
    expect(new Set(WARNING_CODES).size).toBe(WARNING_CODES.length);
    expect(Object.keys(WARNING_TEXT).sort()).toEqual([...WARNING_CODES].sort());
  });

  it.each(WARNING_CODES.map((c) => [c]))('%s has a plain sentence', (code) => {
    const text = warningText(code, { amount: '$50.00' });
    expect(text.length).toBeGreaterThan(20);
    expect(text).toMatch(/[.]$/);
    expect(text).not.toMatch(NEVER_SAY);
    expect(text).not.toContain('{');
  });

  it('the sell warning names the amount the owner set (06 §3)', () => {
    expect(warningText('sell_auto_accept', { amount: '$50.00' })).toContain('at least $50.00');
  });

  it('an unknown code still gets a plain warning, never the code itself', () => {
    expect(warningText('something_new')).toBe(UNKNOWN_WARNING);
    expect(UNKNOWN_WARNING).not.toMatch(NEVER_SAY);
    expect(warningText('__proto__')).toBe(UNKNOWN_WARNING);
  });
});
