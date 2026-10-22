// M1-11c-a1: the Activity page copy follows 11 §5.1 (never say / say instead) in the default view.
// A local check until the shared `lintVocabulary` (M1-35c-b) is exported; then this test calls it.
import { describe, expect, it } from 'vitest';
import { ACTIVITY_STRINGS } from './strings.js';

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

describe('Activity copy (11 §5.1)', () => {
  it('uses none of the never-say words', () => {
    for (const [key, value] of Object.entries(ACTIVITY_STRINGS)) {
      for (const word of NEVER) {
        const re = new RegExp(`\\b${word.replace(/[-]/g, '\\-')}\\b`, 'i');
        expect(re.test(value), `${key}: "${value}" says "${word}"`).toBe(false);
      }
    }
  });

  it('labels a rules grant in plain words', () => {
    expect(ACTIVITY_STRINGS.approvedByRules).toBe('Approved by your rules');
  });

  it('suggests a next step in the AI app when there is nothing yet', () => {
    expect(ACTIVITY_STRINGS.emptyPrompt).toMatch(/^ask your AI to /);
  });
});
