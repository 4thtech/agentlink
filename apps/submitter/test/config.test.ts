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
    });
    expect(config?.settings).toMatchObject({
      gasMargin: 40_000n,
      soloAfterRevertSeconds: 600,
      codeSignerMode: 'one-per-batch',
      maxBatch: 5,
    });
    expect(config?.limits).toEqual({ ipItemsPerHour: 12, signerItemsPerHour: 3 });
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
    ];
    for (const env of bad) expect(readConfig(env), JSON.stringify(env)).toBeNull();
  });
});
