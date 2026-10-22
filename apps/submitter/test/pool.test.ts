// M1-10b-e: the faucet and gas pool states that `/v1/health` reports and the faucet acts on, and
// their per-chain thresholds (config.ts). Runs in Node.
import { describe, expect, it } from 'vitest';
import { FAUCET_DEFAULTS, POOL_THRESHOLDS, poolThresholds } from '../src/config.js';
import { faucetPoolState, gasPoolState } from '../src/pool.js';

const BASE_SEPOLIA = poolThresholds(84532);
if (!BASE_SEPOLIA) throw new Error('test setup: no Base Sepolia thresholds');

describe('the pool thresholds (measured 2026-10-22)', () => {
  it('one grant is 50 cents by default (5 proofs at the beta price)', () => {
    expect(FAUCET_DEFAULTS.usdCents).toBe(50);
  });

  it('Base Sepolia: the faucet is low under $20 of its stablecoin; gas is low under 1 000 proofs', () => {
    expect(BASE_SEPOLIA).toEqual({
      faucetLowUsdCents: 2_000,
      // About 1.1e-6 ETH per proof, measured; 1 000 proofs.
      gasLowWei: 1_100_000_000_000_000n,
      measured: true,
    });
  });

  it('Chiado has the same thresholds in xDAI, marked unmeasured', () => {
    expect(poolThresholds(10200)).toEqual({ ...BASE_SEPOLIA, measured: false });
  });

  it('no thresholds for any other chain, and the table is frozen', () => {
    for (const id of [1, 8453, 100, 31337, 0]) expect(poolThresholds(id)).toBeNull();
    expect(Object.isFrozen(POOL_THRESHOLDS)).toBe(true);
    expect(Object.isFrozen(BASE_SEPOLIA)).toBe(true);
  });
});

describe('faucetPoolState', () => {
  const grant = 50;
  const enoughGas = BASE_SEPOLIA.gasLowWei;
  const at = (cents: bigint, wei = enoughGas) =>
    faucetPoolState({ tokenUsdCents: cents, nativeWei: wei }, grant, BASE_SEPOLIA);

  it('ok at $20 or more of the stablecoin and enough gas of its own', () => {
    expect(at(2_000n)).toBe('ok');
    expect(at(1_000_000n)).toBe('ok');
  });

  it('low under $20, while it still covers one grant', () => {
    expect(at(1_999n)).toBe('low');
    expect(at(50n)).toBe('low');
  });

  it('low when its own gas is under the gas threshold', () => {
    expect(at(2_000n, enoughGas - 1n)).toBe('low');
  });

  it('paused when it cannot cover one grant, or its balances cannot be read', () => {
    expect(at(49n)).toBe('paused');
    expect(at(0n)).toBe('paused');
    expect(faucetPoolState(null, grant, BASE_SEPOLIA)).toBe('paused');
  });

  it('without thresholds: ok or paused only', () => {
    expect(faucetPoolState({ tokenUsdCents: 50n, nativeWei: 0n }, grant, null)).toBe('ok');
    expect(faucetPoolState({ tokenUsdCents: 49n, nativeWei: 0n }, grant, null)).toBe('paused');
  });
});

describe('gasPoolState', () => {
  it('ok at the threshold or above, low under it', () => {
    expect(gasPoolState('1100000000000000', BASE_SEPOLIA)).toBe('ok');
    expect(gasPoolState('50900000000000000', BASE_SEPOLIA)).toBe('ok');
    expect(gasPoolState('1099999999999999', BASE_SEPOLIA)).toBe('low');
    expect(gasPoolState('0', BASE_SEPOLIA)).toBe('low');
  });

  it('null when the balance is unknown or the chain has no thresholds', () => {
    expect(gasPoolState(null, BASE_SEPOLIA)).toBeNull();
    expect(gasPoolState('1', null)).toBeNull();
  });
});
