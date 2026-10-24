// M1-27b: assertions on the drop's deploy configuration (release-and-deployment.md §1.1, §4.5, §6;
// 04 §4 Logging; IR-M1-27a-1). Runs in Node on every `pnpm test`: wrangler.toml, read through
// Wrangler's own config reader for each environment (names, bindings, the Durable Object migration,
// the CPU limit, logging off, the hostname) and as text (no secret values). The deploy workflow's
// contract is tested in tools/release/deploy-drop.test.mjs.
import { unstable_readConfig } from 'wrangler';
import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/config.js';
import wranglerToml from '../wrangler.toml?raw';

const ENVIRONMENTS = {
  staging: { name: 'agentlink-drop-staging', bucket: 'agentlink-drop-staging', cors: [] },
  production: {
    name: 'agentlink-drop',
    bucket: 'agentlink-drop-prod',
    cors: ['https://console.agentlink.4thtech.io'],
  },
} as const;

// A synthetic URL key (32 bytes of 0x5a), only to run the Worker's own config parser on the vars.
const TEST_URL_KEY = 'WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo';

type EnvName = keyof typeof ENVIRONMENTS;

function read(env: EnvName) {
  return unstable_readConfig({ config: 'wrangler.toml', env }, { hideWarnings: true });
}

describe('wrangler.toml', () => {
  for (const env of Object.keys(ENVIRONMENTS) as EnvName[]) {
    describe(`env ${env}`, () => {
      const expected = ENVIRONMENTS[env];

      it('names its own Worker and deploys the drop source', () => {
        const config = read(env);
        expect(config.name).toBe(expected.name);
        expect(config.main?.replaceAll('\\', '/').endsWith('src/index.ts')).toBe(true);
        expect(config.compatibility_date).toBe('2026-08-01');
      });

      it('binds its own R2 bucket as DROP_BUCKET', () => {
        const config = read(env);
        expect(config.r2_buckets).toEqual([
          expect.objectContaining({ binding: 'DROP_BUCKET', bucket_name: expected.bucket }),
        ]);
      });

      it('binds the DropState Durable Object with its migration', () => {
        const config = read(env);
        expect(config.durable_objects.bindings).toEqual([
          expect.objectContaining({ name: 'DROP_STATE', class_name: 'DropState' }),
        ]);
        expect(config.durable_objects.bindings[0]?.script_name).toBeUndefined();
        expect(config.migrations).toEqual([
          expect.objectContaining({ tag: 'v1', new_sqlite_classes: ['DropState'] }),
        ]);
      });

      // M1-27b-b: the measured need (about 0.42 s of CPU to hash 100 MiB) plus a wide margin
      // for slower edge hardware and a cold isolate; tighter than the paid plan's 30 s default.
      it('sets the CPU limit for large commits to the measured need plus margin (IR-M1-27a-1 L-3)', () => {
        expect(read(env).limits?.cpu_ms).toBe(5_000);
      });

      it('keeps observability, request logging, Logpush and Tail Workers off (04 §4)', () => {
        const config = read(env);
        expect(config.observability?.enabled).toBe(false);
        expect(config.observability?.logs?.enabled).toBe(false);
        expect(config.observability?.logs?.invocation_logs).toBe(false);
        expect(config.observability?.traces?.enabled).toBe(false);
        expect(config.logpush).toBe(false);
        expect(config.tail_consumers ?? []).toEqual([]);
        expect(config.streaming_tail_consumers ?? []).toEqual([]);
        expect(config.upload_source_maps ?? false).toBe(false);
      });

      it('holds no secret: DROP_URL_KEY is a Worker secret, the only var is DROP_CORS_ORIGINS', () => {
        const vars = read(env).vars;
        expect(Object.keys(vars)).toEqual(['DROP_CORS_ORIGINS']);
      });

      it('allows CORS only for the reviewed console origins (08 §7)', () => {
        const raw = read(env).vars.DROP_CORS_ORIGINS;
        expect(typeof raw).toBe('string');
        const origins = String(raw)
          .split(',')
          .map((origin) => origin.trim())
          .filter((origin) => origin !== '');
        expect(origins).toEqual(expected.cors);
        for (const origin of origins) {
          expect(origin).toMatch(/^https:\/\/[a-z0-9.-]+$/);
          expect(origin).not.toContain('*');
        }
        // The Worker's own parser accepts the value (an invalid one would make it answer 503).
        const config = readConfig({ DROP_URL_KEY: TEST_URL_KEY, DROP_CORS_ORIGINS: raw });
        expect(config?.corsOrigins).toEqual(expected.cors);
      });
    });
  }

  it('staging runs on workers.dev only', () => {
    const config = read('staging');
    expect(config.workers_dev).toBe(true);
    expect(config.routes ?? []).toEqual([]);
  });

  it('production runs on its Custom Domain only, with no workers.dev or preview URLs', () => {
    const config = read('production');
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config.routes).toEqual([{ pattern: 'drop.agentlink.4thtech.io', custom_domain: true }]);
  });

  it('the top level deploys nowhere by accident', () => {
    const config = unstable_readConfig({ config: 'wrangler.toml' }, { hideWarnings: true });
    expect(config.name).toBe('agentlink-drop-local');
    expect(config.workers_dev).toBe(false);
    expect(config.routes ?? []).toEqual([]);
    expect(config.r2_buckets).toEqual([
      expect.objectContaining({ binding: 'DROP_BUCKET', bucket_name: 'agentlink-drop-local' }),
    ]);
  });

  it('contains no account ID, token or key material', () => {
    const lines = wranglerToml
      .split('\n')
      .map((line) => line.replace(/#.*$/, ''))
      .join('\n');
    expect(lines).not.toMatch(/account_id/);
    expect(lines).not.toMatch(/DROP_URL_KEY/);
    // No base64url or hex blob long enough to be a key or token.
    expect(lines).not.toMatch(/[A-Za-z0-9_-]{40,}/);
    expect(lines).not.toMatch(/[0-9a-f]{32,}/i);
  });
});
