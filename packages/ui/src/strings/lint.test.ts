// M1-35c-b: lintVocabulary applies the 11 §5.1 never-say list. One test per banned term, the
// Advanced exemptions, and the package root export.
import { describe, expect, it } from 'vitest';
import * as root from '../index.js';
import { en, type StringKey } from './index.js';
import { NEVER_SAY, isExemptKey, lintVocabulary } from './lint.js';

const SAMPLES: Record<string, string> = {
  wallet: 'Open your wallet',
  'seed phrase': 'Write down the seed phrase',
  'private key': 'Your private key',
  transaction: 'The transaction failed',
  gas: 'Pay the gas',
  mint: 'We mint a proof',
  notarize: 'Notarize this',
  blockchain: 'Stored on the blockchain',
  chain: 'Pick a chain',
  'network names': 'Sent on Base',
  tokens: 'Send USDC',
  hash: 'The hash matches',
  'nostr/relay': 'Connected to a relay',
  'policy/harness': 'Edit the policy',
  mcp: 'Add the MCP',
  'owner key / signature': 'Check the signature',
  keystore: 'Open the keystore',
  password: 'Enter a password',
  contract: 'A legally binding contract',
  'commitment label': 'A new commitment',
  unverified: 'Unverified sender',
  'encryption key': 'Decrypt the file',
  'loopback address': 'Open 127.0.0.1',
  address: 'Your address',
};

describe('lintVocabulary (11 §5.1)', () => {
  it('covers every banned term with a sample', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(NEVER_SAY.map(([name]) => name).sort());
  });

  it.each(Object.entries(SAMPLES))('flags %s', (name, text) => {
    expect(lintVocabulary(text)).toContain(name);
  });

  it('passes clean copy', () => {
    expect(lintVocabulary('Approve with your passkey')).toEqual([]);
  });

  it('exempts every term in Advanced mode', () => {
    for (const text of Object.values(SAMPLES)) {
      expect(lintVocabulary(text, { advanced: true })).toEqual([]);
    }
  });

  it('allows named reviewed terms only', () => {
    expect(lintVocabulary('Enter a password', { allow: ['password'] })).toEqual([]);
    expect(lintVocabulary('Enter a password for the wallet', { allow: ['password'] })).toEqual([
      'wallet',
    ]);
  });

  it('exempts advanced.* and devconfig.* keys', () => {
    expect(isExemptKey('advanced.network')).toBe(true);
    expect(isExemptKey('devconfig.x')).toBe(true);
    expect(isExemptKey('common.footer.endorsement')).toBe(false);
  });

  it('passes every shipped default-view string', () => {
    for (const [key, value] of Object.entries(en)) {
      if (isExemptKey(key)) continue;
      if (key === 'invite.noPasswords' || key === 'chat.status.needs_setup.keychain') continue;
      expect(lintVocabulary(value), key).toEqual([]);
    }
  });
});

describe('package root', () => {
  it('exports the strings API', () => {
    expect(root.lintVocabulary).toBe(lintVocabulary);
    expect(typeof root.t).toBe('function');
    const k: StringKey = 'common.approval.deny';
    expect(root.t(k)).toBe('Deny');
  });
});
