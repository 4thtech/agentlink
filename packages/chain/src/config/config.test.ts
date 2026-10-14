import { describe, expect, it } from 'vitest';
import {
  BASE_SEPOLIA,
  ChainConfigError,
  FEE_SCHEDULE_USD_MICROS,
  GNOSIS_CHIADO,
  INTEGRATOR_FEE_CAP_MULTIPLE,
  MIN_DEPOSIT_USD_MICROS,
  TESTNET_NETWORKS,
  feeInTokenUnits,
  isKeylessHttpsUrl,
  usdMicrosToTokenUnits,
  validateChainNetwork,
  type ChainNetwork,
  type FeeToken,
} from './index.js';

/** A mutable deep copy of a committed entry. */
function copy(n: ChainNetwork): ChainNetwork {
  return JSON.parse(JSON.stringify(n)) as ChainNetwork;
}

function firstToken(n: ChainNetwork): FeeToken {
  const t = n.feeTokens[0];
  if (t === undefined) throw new Error('no token');
  return t;
}

function expectCode(n: ChainNetwork, code: string): void {
  let thrown: unknown;
  try {
    validateChainNetwork(n);
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(ChainConfigError);
  expect((thrown as ChainConfigError).code).toBe(code);
}

describe('committed testnet config (M1-14)', () => {
  it('passes the config check', () => {
    for (const n of TESTNET_NETWORKS) expect(() => validateChainNetwork(n)).not.toThrow();
  });

  it('lists Base Sepolia first, then Gnosis Chiado', () => {
    expect(TESTNET_NETWORKS.map((n) => n.chainId)).toEqual([84532, 10200]);
  });

  it('Base Sepolia: Circle USDC with EIP-3009, no USDT', () => {
    expect(BASE_SEPOLIA.feeTokens).toHaveLength(1);
    const usdc = firstToken(BASE_SEPOLIA);
    expect(usdc.symbol).toBe('USDC');
    expect(usdc.address).toBe('0x036cbd53842c5426634e7929541ec2318f3dcf7e');
    expect(usdc.decimals).toBe(6);
    expect(usdc.eip3009).toBe(true);
    expect(usdc.source.url).toBe(
      'https://developers.circle.com/stablecoins/usdc-contract-addresses',
    );
  });

  it('Gnosis Chiado: native xDAI only', () => {
    expect(GNOSIS_CHIADO.feeTokens).toEqual([
      expect.objectContaining({ symbol: 'NATIVE', address: null, decimals: 18, eip3009: false }),
    ]);
  });

  it('ships keyless public RPC URLs only (07 §6.1)', () => {
    for (const n of TESTNET_NETWORKS) {
      expect(n.rpcUrls.length).toBeGreaterThanOrEqual(2);
      for (const url of n.rpcUrls) expect(isKeylessHttpsUrl(url)).toBe(true);
    }
  });

  it('is frozen, so no caller can redirect a payment', () => {
    expect(Object.isFrozen(BASE_SEPOLIA)).toBe(true);
    expect(Object.isFrozen(BASE_SEPOLIA.feeTokens)).toBe(true);
    expect(Object.isFrozen(firstToken(BASE_SEPOLIA))).toBe(true);
    expect(Object.isFrozen(BASE_SEPOLIA.rpcUrls)).toBe(true);
    expect(Object.isFrozen(TESTNET_NETWORKS)).toBe(true);
  });
});

describe('fee schedule (12 §2, D-45)', () => {
  it('is the USD price list', () => {
    expect(FEE_SCHEDULE_USD_MICROS.NOTARIZE).toEqual({ fee: 100_000n, cap: 500_000n });
    expect(FEE_SCHEDULE_USD_MICROS.REGISTER).toEqual({ fee: 5_000_000n, cap: 25_000_000n });
    expect(MIN_DEPOSIT_USD_MICROS).toBe(5_000_000n);
    expect(INTEGRATOR_FEE_CAP_MULTIPLE).toBe(4);
  });

  it('gives the same USD value in every token (USD × 10^decimals)', () => {
    expect(feeInTokenUnits('NOTARIZE', 6)).toEqual({ fee: 100_000n, cap: 500_000n });
    expect(feeInTokenUnits('REGISTER', 6)).toEqual({ fee: 5_000_000n, cap: 25_000_000n });
    expect(feeInTokenUnits('NOTARIZE', 18)).toEqual({ fee: 10n ** 17n, cap: 5n * 10n ** 17n });
    expect(feeInTokenUnits('REGISTER', 18)).toEqual({
      fee: 5n * 10n ** 18n,
      cap: 25n * 10n ** 18n,
    });
    expect(usdMicrosToTokenUnits(MIN_DEPOSIT_USD_MICROS, 18)).toBe(5n * 10n ** 18n);
  });

  it('every committed fee token has a nonzero NOTARIZE and REGISTER fee and cap', () => {
    for (const n of TESTNET_NETWORKS) {
      for (const t of n.feeTokens) {
        for (const ft of ['NOTARIZE', 'REGISTER'] as const) {
          const { fee, cap } = feeInTokenUnits(ft, t.decimals);
          expect(fee).toBeGreaterThan(0n);
          expect(cap).toBeGreaterThanOrEqual(fee);
        }
      }
    }
  });

  it('rejects decimals it cannot represent exactly', () => {
    expect(() => usdMicrosToTokenUnits(1n, 2)).toThrow(RangeError);
    expect(() => usdMicrosToTokenUnits(1n, 19)).toThrow(RangeError);
    expect(() => usdMicrosToTokenUnits(1n, 6.5)).toThrow(RangeError);
  });
});

describe('config check rejects', () => {
  it('a token outside the stablecoin allowlist', () => {
    const n = copy(BASE_SEPOLIA);
    (firstToken(n) as { symbol: string }).symbol = 'WETH';
    expectCode(n, 'token_not_allowlisted');
  });

  it('a volatile native coin (native on Base)', () => {
    const n = copy(BASE_SEPOLIA);
    n.feeTokens = [
      {
        symbol: 'NATIVE',
        address: null,
        decimals: 18,
        source: { url: 'https://docs.base.org', verifiedOn: '2026-10-14' },
      },
    ];
    expectCode(n, 'native_outside_gnosis');
  });

  it('a stablecoin symbol with a null address outside Gnosis', () => {
    const n = copy(BASE_SEPOLIA);
    firstToken(n).address = null;
    expectCode(n, 'native_outside_gnosis');
  });

  it('an inconsistent native entry on Gnosis', () => {
    const n = copy(GNOSIS_CHIADO);
    firstToken(n).eip3009 = true;
    expectCode(n, 'native_mismatch');
    const m = copy(GNOSIS_CHIADO);
    firstToken(m).decimals = 6;
    expectCode(m, 'native_mismatch');
  });

  it('a token without an issuer source or date', () => {
    const n = copy(BASE_SEPOLIA);
    firstToken(n).source.url = '';
    expectCode(n, 'missing_issuer_source');
    const m = copy(BASE_SEPOLIA);
    firstToken(m).source.verifiedOn = 'recently';
    expectCode(m, 'missing_issuer_source');
  });

  it('a chain without a source', () => {
    const n = copy(GNOSIS_CHIADO);
    n.source.url = 'http://docs.gnosischain.com';
    expectCode(n, 'missing_source');
  });

  it('a non-canonical token address', () => {
    const n = copy(BASE_SEPOLIA);
    firstToken(n).address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
    expectCode(n, 'bad_address');
  });

  it('bad decimals', () => {
    const n = copy(BASE_SEPOLIA);
    firstToken(n).decimals = 2;
    expectCode(n, 'bad_decimals');
  });

  it('duplicate tokens', () => {
    const n = copy(BASE_SEPOLIA);
    n.feeTokens = [firstToken(n), { ...firstToken(n) }];
    expectCode(n, 'duplicate_token');
  });

  it('no fee tokens', () => {
    const n = copy(BASE_SEPOLIA);
    n.feeTokens = [];
    expectCode(n, 'no_fee_tokens');
  });

  it('an unsupported chain (mainnets are M3-2a)', () => {
    const n = copy(BASE_SEPOLIA);
    n.chainId = 8453;
    expectCode(n, 'unsupported_chain');
  });

  it('a non-testnet entry', () => {
    const n = copy(BASE_SEPOLIA);
    n.testnet = false;
    expectCode(n, 'not_testnet');
  });

  it('RPC URLs that could carry an API key, or too few of them', () => {
    for (const url of [
      'http://sepolia.base.org',
      'https://rpc.example/v2?apikey=abc',
      'https://user:secret@rpc.example',
      'https://rpc.example/${RPC_KEY}',
      'https://rpc.example/#key',
      'https://',
    ]) {
      const n = copy(BASE_SEPOLIA);
      n.rpcUrls = [...n.rpcUrls.slice(0, 1), url];
      expectCode(n, 'bad_rpc_url');
    }
    const n = copy(BASE_SEPOLIA);
    n.rpcUrls = n.rpcUrls.slice(0, 1);
    expectCode(n, 'too_few_rpc_urls');
  });

  it('a bad explorer or confirmations', () => {
    const n = copy(BASE_SEPOLIA);
    n.explorer = 'sepolia.basescan.org';
    expectCode(n, 'bad_explorer');
    const m = copy(BASE_SEPOLIA);
    m.confirmations = 0;
    expectCode(m, 'bad_confirmations');
  });
});
