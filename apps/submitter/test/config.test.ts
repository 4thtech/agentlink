// M1-10a: the submitter's settings (07 §7, 05 §3.3; FA-1). Defaults are the spec's; each override is
// bounded; anything invalid makes readConfig return null, and the Worker fails closed. Runs in Node.
import { describe, expect, it } from 'vitest';
import type { Hex } from '@4thtech-io/chain';
import {
  DEFAULTS,
  FAUCET_DEFAULTS,
  pinnedFaucet,
  readConfig,
  readFaucetAddress,
  readFaucetConfig,
} from '../src/config.js';
import { FakeFaucet } from './fake-faucet.js';

// A synthetic IP-bucket key (32 bytes of 0x5a, base64url), only to run the parser.
const IP_KEY = 'WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo';

describe('readConfig', () => {
  it('uses the spec defaults: solo code-bearing signers, 1 h cooling-off, a small fixed gas margin', () => {
    const config = readConfig({ SUBMITTER_CHAINS: '84532', SUBMITTER_IP_KEY: IP_KEY });
    expect(config).not.toBeNull();
    expect(config?.chains).toEqual([84532]);
    expect(config?.settings.codeSignerMode).toBe('solo');
    expect(config?.settings.soloAfterRevertSeconds).toBe(3_600);
    expect(config?.settings.gasMargin).toBe(DEFAULTS.gasMargin);
    expect(DEFAULTS.gasMargin).toBeLessThanOrEqual(50_000n);
    expect(config?.settings.maxBatch).toBe(20);
    expect(config?.ipKey).toHaveLength(32);
    expect(config?.settings.maxItemGas).toBe(700_000n);
    expect(config?.settings.stuckAfterSeconds).toBe(180);
    expect(config?.settings.maxReplacements).toBe(3);
    expect(config?.limits.ipReadsPerHour).toBe(600);
    expect(config?.maxFeePerGasWei).toBeNull();
  });

  it('takes bounded overrides', () => {
    const config = readConfig({
      SUBMITTER_CHAINS: '84532',
      SUBMITTER_IP_KEY: IP_KEY,
      SUBMITTER_GAS_MARGIN: '40000',
      SUBMITTER_SOLO_AFTER_REVERT_SECONDS: '600',
      SUBMITTER_CODE_SIGNER_MODE: 'one-per-batch',
      SUBMITTER_MAX_BATCH: '5',
      SUBMITTER_IP_ITEMS_PER_HOUR: '12',
      SUBMITTER_SIGNER_ITEMS_PER_HOUR: '3',
      SUBMITTER_IP_READS_PER_HOUR: '30',
      SUBMITTER_MAX_ITEM_GAS: '400000',
      SUBMITTER_STUCK_AFTER_SECONDS: '60',
      SUBMITTER_MAX_REPLACEMENTS: '2',
      SUBMITTER_MAX_FEE_PER_GAS_WEI: '50000000000',
    });
    expect(config?.maxFeePerGasWei).toBe(50_000_000_000n);
    expect(config?.settings).toMatchObject({
      gasMargin: 40_000n,
      soloAfterRevertSeconds: 600,
      codeSignerMode: 'one-per-batch',
      maxBatch: 5,
    });
    expect(config?.settings).toMatchObject({
      maxItemGas: 400_000n,
      stuckAfterSeconds: 60,
      maxReplacements: 2,
    });
    expect(config?.limits).toEqual({
      ipItemsPerHour: 12,
      signerItemsPerHour: 3,
      ipReadsPerHour: 30,
    });
  });

  it('fails closed on anything invalid', () => {
    const base = { SUBMITTER_CHAINS: '84532', SUBMITTER_IP_KEY: IP_KEY };
    const bad: Record<string, string>[] = [
      { SUBMITTER_IP_KEY: IP_KEY },
      { ...base, SUBMITTER_CHAINS: '' },
      { ...base, SUBMITTER_CHAINS: '84532,abc' },
      { ...base, SUBMITTER_CHAINS: '1' }, // not a supported testnet
      { SUBMITTER_CHAINS: '84532' },
      { ...base, SUBMITTER_IP_KEY: 'short' },
      { ...base, SUBMITTER_GAS_MARGIN: '5000000' },
      { ...base, SUBMITTER_GAS_MARGIN: '-1' },
      { ...base, SUBMITTER_CODE_SIGNER_MODE: 'batch' },
      { ...base, SUBMITTER_MAX_BATCH: '21' },
      { ...base, SUBMITTER_SOLO_AFTER_REVERT_SECONDS: '0' },
      { ...base, SUBMITTER_SIGNER_ITEMS_PER_HOUR: '1.5' },
      { ...base, SUBMITTER_MAX_ITEM_GAS: '50000000' },
      { ...base, SUBMITTER_MAX_REPLACEMENTS: '11' },
      { ...base, SUBMITTER_STUCK_AFTER_SECONDS: '5' },
      { ...base, SUBMITTER_MAX_FEE_PER_GAS_WEI: '0' },
      { ...base, SUBMITTER_MAX_FEE_PER_GAS_WEI: '1e9' },
    ];
    for (const env of bad) expect(readConfig(env), JSON.stringify(env)).toBeNull();
  });
});

// M1-10b: the faucet's settings (05 §9; SUB-7). Off unless SUBMITTER_FAUCET_CHAINS names chains, and
// only chains on the hard-coded testnet allowlist of @4thtech-io/chain; anything invalid turns the
// faucet off (null), never on with a guessed setting.
describe('readFaucetConfig', () => {
  it('is off without SUBMITTER_FAUCET_CHAINS', () => {
    expect(readFaucetConfig({})).toBeNull();
    expect(readFaucetConfig({ SUBMITTER_FAUCET_CHAINS: '' })).toBeNull();
  });

  it('uses bounded defaults: one claim per agent per day, a per-IP and a global daily cap', () => {
    const config = readFaucetConfig({ SUBMITTER_FAUCET_CHAINS: '84532' });
    expect(config).toEqual({
      chains: [84532],
      usdCents: FAUCET_DEFAULTS.usdCents,
      agentWindowSeconds: 86_400,
      ipClaimsPerDay: FAUCET_DEFAULTS.ipClaimsPerDay,
      dailyCap: FAUCET_DEFAULTS.dailyCap,
      ipRequestsPerHour: FAUCET_DEFAULTS.ipRequestsPerHour,
    });
    expect(FAUCET_DEFAULTS.usdCents).toBeLessThanOrEqual(1_000);
    expect(FAUCET_DEFAULTS.dailyCap).toBeLessThanOrEqual(10_000);
  });

  it('takes bounded overrides', () => {
    expect(
      readFaucetConfig({
        SUBMITTER_FAUCET_CHAINS: '84532',
        SUBMITTER_FAUCET_USD_CENTS: '500',
        SUBMITTER_FAUCET_AGENT_WINDOW_SECONDS: '3600',
        SUBMITTER_FAUCET_IP_CLAIMS_PER_DAY: '2',
        SUBMITTER_FAUCET_DAILY_CAP: '12',
        SUBMITTER_FAUCET_IP_REQUESTS_PER_HOUR: '20',
      }),
    ).toEqual({
      chains: [84532],
      usdCents: 500,
      agentWindowSeconds: 3_600,
      ipClaimsPerDay: 2,
      dailyCap: 12,
      ipRequestsPerHour: 20,
    });
  });

  it('refuses every mainnet chain ID and Chiado until it is deployed (SUB-7)', () => {
    for (const chains of ['1', '8453', '100', '42161', '10', '137', '10200', '84532,8453']) {
      expect(readFaucetConfig({ SUBMITTER_FAUCET_CHAINS: chains }), chains).toBeNull();
    }
  });

  it('turns off on anything invalid', () => {
    const base = { SUBMITTER_FAUCET_CHAINS: '84532' };
    const bad: Record<string, string>[] = [
      { SUBMITTER_FAUCET_CHAINS: '84532,84532' },
      { SUBMITTER_FAUCET_CHAINS: '84532,abc' },
      { ...base, SUBMITTER_FAUCET_USD_CENTS: '0' },
      { ...base, SUBMITTER_FAUCET_USD_CENTS: '1001' },
      { ...base, SUBMITTER_FAUCET_AGENT_WINDOW_SECONDS: '60' },
      { ...base, SUBMITTER_FAUCET_IP_CLAIMS_PER_DAY: '0' },
      { ...base, SUBMITTER_FAUCET_DAILY_CAP: '0' },
      { ...base, SUBMITTER_FAUCET_DAILY_CAP: '100001' },
      { ...base, SUBMITTER_FAUCET_IP_REQUESTS_PER_HOUR: '1.5' },
    ];
    for (const env of bad) expect(readFaucetConfig(env), JSON.stringify(env)).toBeNull();
  });
});

// M1-10b-b: faucet key separation across environments. Each environment pins its own faucet
// wallet's public address in wrangler.toml (SUBMITTER_FAUCET_ADDRESS_<chainId>), and the Worker
// serves the faucet only from a key of that address. test/smoke-config.test.ts asserts that staging
// and production pin different addresses, so the two configs cannot share a faucet key.
describe('the pinned faucet wallet', () => {
  const PINNED = `0x${'fa'.repeat(20)}` as Hex;

  it('reads a lowercase address per chain; anything else is no pin', () => {
    expect(readFaucetAddress({ SUBMITTER_FAUCET_ADDRESS_84532: PINNED }, 84532)).toBe(PINNED);
    expect(readFaucetAddress({}, 84532)).toBeNull();
    for (const bad of [
      '',
      PINNED.toUpperCase(),
      `0x${'FA'.repeat(20)}`,
      `0x${'fa'.repeat(19)}`,
      `0x${'fa'.repeat(32)}`,
      `0x${'0'.repeat(40)}`,
      PINNED.slice(2),
      ` ${PINNED}`,
    ]) {
      expect(readFaucetAddress({ SUBMITTER_FAUCET_ADDRESS_84532: bad }, 84532), bad).toBeNull();
    }
    expect(readFaucetAddress({ SUBMITTER_FAUCET_ADDRESS_84532: 42 }, 84532)).toBeNull();
  });

  it('serves a faucet wallet only when its address is the pinned one', () => {
    const env = { SUBMITTER_FAUCET_ADDRESS_84532: PINNED };
    const right = new FakeFaucet(84532, PINNED);
    expect(pinnedFaucet(env, 84532, right)).toBe(right);
    const wrong = new FakeFaucet(84532, `0x${'fb'.repeat(20)}` as Hex);
    expect(pinnedFaucet(env, 84532, wrong)).toBeNull();
    expect(pinnedFaucet({}, 84532, right)).toBeNull();
    expect(pinnedFaucet(env, 84532, null)).toBeNull();
    // A pin for another chain does not count.
    expect(pinnedFaucet({ SUBMITTER_FAUCET_ADDRESS_10200: PINNED }, 84532, right)).toBeNull();
  });
});
