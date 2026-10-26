// M3-4b-t-S0-c: the gasless kill switch against the REAL registry (no mock of ./registry.js).
// While GASLESS_TOPUP_ENABLED is false, composeChainConfig clears `eip3009` on every token even
// where the shipped token flag and the vault capability are both true, so gaslessToken refuses.
import { describe, expect, it } from 'vitest';
import { BASE_SEPOLIA } from '../config/index.js';
import { gaslessToken } from '../fees/gasless.js';
import { loadOccV2Contracts } from '../occ-v2.js';
import { GASLESS_TOPUP_ENABLED, composeChainConfig, getChainConfig } from './registry.js';

describe('gasless kill switch at the registry (real registry)', () => {
  it('ships off', () => {
    expect(GASLESS_TOPUP_ENABLED).toBe(false);
  });

  it('composes eip3009 false on Base Sepolia though the token flag and the vault accept it', () => {
    const contracts = loadOccV2Contracts(84532);
    if (contracts === undefined) throw new Error('test setup: no Base Sepolia deployment');
    expect(contracts.depositWithAuthorization).toBe(true);
    expect(BASE_SEPOLIA.feeTokens.some((t) => t.eip3009 === true)).toBe(true);
    const composed = composeChainConfig(BASE_SEPOLIA, contracts);
    expect(composed.feeTokens.every((t) => t.eip3009 !== true)).toBe(true);
  });

  it('gaslessToken refuses on 84532 and 10200 with the real registry', () => {
    for (const chainId of [84532, 10200]) {
      const config = getChainConfig(chainId);
      if (config === undefined) throw new Error('test setup: chain missing from the registry');
      expect(() => gaslessToken(config, 'USDC'), String(chainId)).toThrow();
    }
  });

  it('gaslessToken on 84532 refuses as gasless_unavailable, not for another reason', () => {
    const config = getChainConfig(84532);
    if (config === undefined) throw new Error('test setup: no Base Sepolia config');
    let code: unknown;
    try {
      gaslessToken(config, 'USDC');
    } catch (error) {
      code = (error as { code?: unknown }).code;
    }
    expect(code).toBe('gasless_unavailable');
  });
});
