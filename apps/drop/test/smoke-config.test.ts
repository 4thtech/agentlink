// M1-27b: assertions on the drop's deploy configuration (release-and-deployment.md §1.1, §4.5, §6;
// 04 §4 Logging; IR-M1-27a-1). Runs in Node on every `pnpm test`: wrangler.toml, read through
// Wrangler's own config reader for each environment (names, bindings, the Durable Object migration,
// the CPU limit, logging off, the hostname) and as text (no secret values). The deploy workflow's
// contract is tested in tools/release/deploy-drop.test.mjs.
import { unstable_readConfig } from 'wrangler';
import { describe, expect, it } from 'vitest';
import wranglerToml from '../wrangler.toml?raw';

const ENVIRONMENTS = {
  staging: { name: 'agentlink-drop-staging', bucket: 'agentlink-drop-staging' },
  production: { name: 'agentlink-drop', bucket: 'agentlink-drop-prod' },
} as const;

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

      it('raises the CPU limit for large commits (IR-M1-27a-1 L-3)', () => {
        expect(read(env).limits?.cpu_ms).toBe(30_000);
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

      it('holds no secret: DROP_URL_KEY and DROP_CORS_ORIGINS are Worker secrets', () => {
        const vars = read(env).vars;
        expect(Object.keys(vars)).not.toContain('DROP_URL_KEY');
        expect(Object.keys(vars)).not.toContain('DROP_CORS_ORIGINS');
        for (const name of Object.keys(vars)) {
          expect(name).not.toMatch(/KEY|SECRET|TOKEN|PASSWORD/i);
        }
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
