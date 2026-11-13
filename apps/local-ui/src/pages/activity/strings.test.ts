// M1-11c-a1: the Activity page copy follows 11 §5.1 (never say / say instead) in the default view.
// A local check until the shared `lintVocabulary` (M1-35c-b) is exported; then this test calls it.
import { describe, expect, it } from 'vitest';
import { ACTIVITY_COPY, ACTIVITY_STRINGS, APP_NAMES } from './strings.js';

// 11 §5.1 "Never say" (default UI), as whole words, case-insensitive.
const NEVER = [
  'wallet',
  'address',
  'private key',
  'seed phrase',
  'transaction',
  'tx',
  'gas',
  'mint',
  'notarize',
  'smart contract',
  'on-chain',
  'blockchain',
  'chain',
  'base',
  'gnosis',
  'usdc',
  'usdt',
  'token',
  'deposit',
  'faucet',
  'hash',
  'nostr',
  'relay',
  'encryption key',
  'decrypt',
  'policy',
  'harness',
  'envelope',
  'agent card',
  'mcp',
  'owner key',
  'signature',
  'keystore',
  'contract',
  'legally binding',
  'commitment',
  'unverified',
  'password',
];

const flat = (o: Record<string, unknown>): [string, string][] =>
  Object.entries(o).flatMap(([k, v]): [string, string][] =>
    Array.isArray(v) ? (v as string[]).map((x, i) => [`${k}[${String(i)}]`, x]) : [[k, String(v)]],
  );

describe('Activity copy (11 §5.1)', () => {
  it('uses none of the never-say words', () => {
    const all = [...flat(ACTIVITY_COPY), ...flat(ACTIVITY_STRINGS), ...flat(APP_NAMES)];
    for (const [key, value] of all) {
      for (const word of NEVER) {
        const re = new RegExp(`\\b${word.replace(/[\\-]/g, '\\$&')}\\b`, 'i');
        expect(re.test(value), `${key}: "${value}" says "${word}"`).toBe(false);
      }
    }
  });

  it('has no dash placeholder, no backtick command and no placeholder-looking leftovers', () => {
    for (const [key, value] of flat(ACTIVITY_COPY)) {
      expect(value.trim(), key).not.toBe('—');
      expect(value, key).not.toMatch(/`|\bagentlink \w+/);
    }
  });

  it("keeps Home's short labels as they were", () => {
    expect(ACTIVITY_STRINGS.approvedByRules).toBe('Approved by your rules');
  });

  it('suggests what makes rows appear when there is nothing yet', () => {
    expect(ACTIVITY_COPY.emptyPrompt).toMatch(/your AI asks for something/);
  });
});

describe("UX-LEFT-1 (R1-UI-25): rule rows say what happens next", () => {
  it("the rules row says the new rules apply and where to see them", () => {
    expect(ACTIVITY_COPY.rulesChangedLine).toContain("apply from now on");
    expect(ACTIVITY_COPY.rulesChangedLine).toContain("Rules");
  });
});
