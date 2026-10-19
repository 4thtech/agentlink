// M1-10a: the submitter's settings (07 §7, 05 §3.3; FA-1). Defaults are the spec's; each override is
// bounded; anything invalid makes readConfig return null, and the Worker fails closed. Runs in Node.
import { describe, expect, it } from 'vitest';
import { DEFAULTS, readConfig } from '../src/config.js';

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
