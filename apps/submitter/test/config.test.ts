// M1-10a: the submitter's settings (07 §7, 05 §3.3; FA-1). Defaults are the spec's; each override is
// bounded; anything invalid makes readConfig return null, and the Worker fails closed. Runs in Node.
import { describe, expect, it } from 'vitest';
import type { Hex } from '@4thtech-io/chain';
import {
  DEFAULTS,
  DEPOSIT_AUTH_DEFAULTS,
  FAUCET_DEFAULTS,
  pinnedFaucet,
  readConfig,
  readDepositAuthConfig,
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
    expect(config?.settings.maxHeldSeconds).toBe(86_400);
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
      SUBMITTER_MAX_HELD_SECONDS: '3600',
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
      maxHeldSeconds: 3_600,
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
      { ...base, SUBMITTER_MAX_HELD_SECONDS: '59' }, // M1-10a-c: bounded both ways
      { ...base, SUBMITTER_MAX_HELD_SECONDS: '604801' },
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

  it('refuses every mainnet chain ID, Gnosis 100 included (SUB-7)', () => {
    for (const chains of ['1', '8453', '100', '42161', '10', '137', '84532,8453', '10200,100']) {
      expect(readFaucetConfig({ SUBMITTER_FAUCET_CHAINS: chains }), chains).toBeNull();
    }
  });

  it('serves Gnosis Chiado beside Base Sepolia (M1-3j-c)', () => {
    expect(readFaucetConfig({ SUBMITTER_FAUCET_CHAINS: '10200' })?.chains).toEqual([10200]);
    expect(readFaucetConfig({ SUBMITTER_FAUCET_CHAINS: '84532,10200' })?.chains).toEqual([
      84532, 10200,
    ]);
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

describe('readDepositAuthConfig (M3-4b-t-3)', () => {
  it('is off by default: unset or empty', () => {
    expect(readDepositAuthConfig({})).toBeNull();
    expect(readDepositAuthConfig({ SUBMITTER_DEPOSIT_AUTH_CHAINS: '' })).toBeNull();
  });

  it('serves Base Sepolia with the owner limits: 5 per agent and 20 per IP per hour', () => {
    const config = readDepositAuthConfig({ SUBMITTER_DEPOSIT_AUTH_CHAINS: '84532' });
    expect(config?.chains).toEqual([84532]);
    expect(config?.agentRequestsPerHour).toBe(5);
    expect(config?.ipRequestsPerHour).toBe(20);
    expect(DEPOSIT_AUTH_DEFAULTS).toEqual({ agentRequestsPerHour: 5, ipRequestsPerHour: 20 });
  });

  it('turns off on a chain without the gasless capability, a mainnet or a malformed list', () => {
    for (const chains of ['10200', '84532,10200', '8453', '1', '84532,84532', ' 84532', '0x14a34', 'x']) {
      expect(readDepositAuthConfig({ SUBMITTER_DEPOSIT_AUTH_CHAINS: chains }), chains).toBeNull();
    }
  });

  it('bounds the limit overrides and turns off on an invalid one', () => {
    const base = { SUBMITTER_DEPOSIT_AUTH_CHAINS: '84532' };
    expect(
      readDepositAuthConfig({
        ...base,
        SUBMITTER_DEPOSIT_AUTH_AGENT_REQUESTS_PER_HOUR: '2',
        SUBMITTER_DEPOSIT_AUTH_IP_REQUESTS_PER_HOUR: '50',
      }),
    ).toMatchObject({ agentRequestsPerHour: 2, ipRequestsPerHour: 50 });
    for (const [name, value] of [
      ['SUBMITTER_DEPOSIT_AUTH_AGENT_REQUESTS_PER_HOUR', '0'],
      ['SUBMITTER_DEPOSIT_AUTH_AGENT_REQUESTS_PER_HOUR', '61'],
      ['SUBMITTER_DEPOSIT_AUTH_IP_REQUESTS_PER_HOUR', '0'],
      ['SUBMITTER_DEPOSIT_AUTH_IP_REQUESTS_PER_HOUR', '1001'],
      ['SUBMITTER_DEPOSIT_AUTH_IP_REQUESTS_PER_HOUR', 'many'],
    ] as const) {
      expect(readDepositAuthConfig({ ...base, [name]: value }), `${name}=${value}`).toBeNull();
    }
  });
});
