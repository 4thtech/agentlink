// UI-REFRESH-g: the Home copy follows 11 §5.1 (never say / say instead) in the default view.
import { describe, expect, it } from 'vitest';
import { HOME_STRINGS, creditsLine, minutesLeft, routesLine, waitingCount } from './strings.js';

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

describe('Home copy (11 §5.1)', () => {
  it('uses none of the never-say words', () => {
    const all: [string, string][] = [
      ...Object.entries(HOME_STRINGS),
      ['minutesLeft', minutesLeft(9)],
      ['creditsLine', creditsLine('$4.80', 48)],
      ['waitingCount', waitingCount(2)],
      ['routesLine', routesLine(2, 3)],
    ];
    for (const [key, value] of all) {
      for (const word of NEVER) {
        const re = new RegExp(`\\b${word.replace(/[\\-]/g, '\\$&')}\\b`, 'i');
        expect(re.test(value), `${key}: "${value}" says "${word}"`).toBe(false);
      }
    }
  });

  it('has the briefed sentences', () => {
    expect(HOME_STRINGS.agentRunningLine).toBe('Ready to send and receive.');
    expect(HOME_STRINGS.waitingNone).toBe('Nothing is waiting.');
    expect(HOME_STRINGS.agentNotRunningLine).toBe('Start your AI app to bring your agent online.');
    expect(HOME_STRINGS.errorLine).toBe("Couldn't read the latest. Trying again.");
    expect(creditsLine('$4.80', 48)).toBe('$4.80, about 48 proofs');
    expect(minutesLeft(9)).toBe('9 min left');
  });
});
