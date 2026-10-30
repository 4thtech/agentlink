// M1-27a: the drop's limits and configuration (07 §5.4 Limits; 08 §7 CORS). Defaults are the
// spec's proposed values; overrides exist for staging and tests and are bounded; anything invalid
// makes the Worker fail closed (`unavailable`) rather than run with a guessed limit.
import { describe, expect, it } from 'vitest';
import { DEFAULTS, readConfig } from './config.js';

const KEY = 'WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo';
const MiB = 1024 * 1024;

describe('readConfig', () => {
  it('uses the proposed defaults', () => {
    const config = readConfig({ DROP_URL_KEY: KEY });
    expect(config).not.toBeNull();
    expect(config?.limits).toEqual(DEFAULTS);
    expect(DEFAULTS.maxSize).toBe(100 * MiB);
    expect(DEFAULTS.partSize).toBe(64 * MiB);
    expect(DEFAULTS.weeklyQuota).toBe(1024 * MiB);
    expect(DEFAULTS.downloadLimit).toBe(16);
    expect(DEFAULTS.maxExpirySeconds).toBe(7 * 86_400);
    expect(config?.corsOrigins).toEqual([]);
    expect(config?.urlKey).toHaveLength(32);
  });

  it('applies bounded overrides', () => {
    const config = readConfig({
      DROP_URL_KEY: KEY,
      DROP_MAX_SIZE: String(8 * MiB),
      DROP_PART_SIZE: String(5 * MiB),
      DROP_WEEKLY_QUOTA: String(20 * MiB),
      DROP_IP_NEW_KEYS_PER_DAY: '3',
      DROP_GLOBAL_BYTES_PER_DAY: String(MiB),
      DROP_CORS_ORIGINS: 'https://console.example, https://console.agentlink.4thtech.io',
    });
    expect(config?.limits.maxSize).toBe(8 * MiB);
    expect(config?.limits.partSize).toBe(5 * MiB);
    expect(config?.limits.weeklyQuota).toBe(20 * MiB);
    expect(config?.limits.ipNewKeysPerDay).toBe(3);
    expect(config?.limits.globalBytesPerDay).toBe(MiB);
    expect(config?.corsOrigins).toEqual([
      'https://console.example',
      'https://console.agentlink.4thtech.io',
    ]);
  });

  it('fails closed without a valid URL key', () => {
    expect(readConfig({})).toBeNull();
    expect(readConfig({ DROP_URL_KEY: 'short' })).toBeNull();
    expect(readConfig({ DROP_URL_KEY: `${KEY}=` })).toBeNull();
  });

  it('fails closed on an invalid or out-of-bounds limit', () => {
    for (const [name, value] of [
      ['DROP_MAX_SIZE', 'abc'],
      ['DROP_MAX_SIZE', '-1'],
      ['DROP_MAX_SIZE', String(200 * MiB)], // never above the spec's cap
      ['DROP_PART_SIZE', String(4 * MiB)], // R2 parts are at least 5 MiB
      ['DROP_PART_SIZE', String(65 * MiB)],
      ['DROP_DOWNLOAD_LIMIT', '0'],
      ['DROP_WEEKLY_QUOTA', '1.5'],
    ] as const) {
      expect(readConfig({ DROP_URL_KEY: KEY, [name]: value }), `${name}=${value}`).toBeNull();
    }
  });

  it('uses the spec invite limits and the invite host as the invite origin (W4-SHORT-INVITE)', () => {
    const config = readConfig({ DROP_URL_KEY: KEY });
    expect(DEFAULTS.inviteMaxSize).toBe(17_441);
    expect(DEFAULTS.inviteDownloadLimit).toBe(8);
    expect(DEFAULTS.inviteKeyUploadsPerHour).toBe(20);
    expect(DEFAULTS.inviteKeyUploadsPerDay).toBe(100);
    expect(DEFAULTS.inviteKeyLive).toBe(50);
    expect(DEFAULTS.inviteIpFetchesPerHour).toBe(30);
    expect(DEFAULTS.inviteFetchesPerHour).toBe(20_000);
    expect(config?.inviteOrigins).toEqual(['https://agentlink.4thtech.io']);
    // The size cap and the download limit are not configurable.
    const fixed = readConfig({
      DROP_URL_KEY: KEY,
      DROP_INVITE_MAX_SIZE: '99999',
      DROP_INVITE_DOWNLOAD_LIMIT: '99',
    });
    expect(fixed?.limits.inviteMaxSize).toBe(17_441);
    expect(fixed?.limits.inviteDownloadLimit).toBe(8);
    const overridden = readConfig({
      DROP_URL_KEY: KEY,
      DROP_INVITE_FETCHES_PER_HOUR: '40',
      DROP_INVITE_ORIGINS: 'https://invite.example',
    });
    expect(overridden?.limits.inviteFetchesPerHour).toBe(40);
    expect(overridden?.inviteOrigins).toEqual(['https://invite.example']);
    expect(readConfig({ DROP_URL_KEY: KEY, DROP_INVITE_ORIGINS: '' })?.inviteOrigins).toEqual([]);
    expect(readConfig({ DROP_URL_KEY: KEY, DROP_INVITE_ORIGINS: '*' })).toBeNull();
    expect(readConfig({ DROP_URL_KEY: KEY, DROP_INVITE_KEY_LIVE: '0' })).toBeNull();
  });

  it('refuses a wildcard or non-https CORS origin, or one with a path', () => {
    for (const origins of [
      '*',
      'http://console.example',
      'https://console.example/',
      'https://a.example/x',
      'null',
    ]) {
      expect(readConfig({ DROP_URL_KEY: KEY, DROP_CORS_ORIGINS: origins }), origins).toBeNull();
    }
  });
});
