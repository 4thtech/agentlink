// M1-10c: assertions on the submitter's deploy configuration (release-and-deployment.md §1, §1.1,
// §4.5, §6; D-28, D-88; 07 §7 Logging). Runs in Node on every `pnpm test`: wrangler.toml, read
// through Wrangler's own config reader for each environment (names, Durable Object bindings and
// migration, logging off, hostnames, the served chains) and as text (no secret values). The deploy
// workflow's contract, including its required Worker-secret list against these vars, is tested in
// tools/release/deploy-submitter.test.mjs.
import { unstable_readConfig } from 'wrangler';
import { describe, expect, it } from 'vitest';
import { readConfig, readFaucetConfig } from '../src/config.js';
import wranglerToml from '../wrangler.toml?raw';

const ENVIRONMENTS = {
  staging: { name: 'agentlink-submitter-staging' },
  production: { name: 'agentlink-submitter' },
} as const;

type EnvName = keyof typeof ENVIRONMENTS;

// A synthetic IP key (32 bytes of 0x5a), only to run the Worker's own config parser on the vars.
const TEST_IP_KEY = 'WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo';

const DURABLE_OBJECTS = [
  { name: 'SUBMITTER_QUEUE', class_name: 'SubmitterQueue' },
  { name: 'SUBMITTER_LIMITS', class_name: 'SubmitterLimits' },
  { name: 'SUBMITTER_FAUCET', class_name: 'SubmitterFaucet' },
];

function read(env?: EnvName) {
  return unstable_readConfig(env ? { config: 'wrangler.toml', env } : { config: 'wrangler.toml' }, {
    hideWarnings: true,
  });
}

/** The chain IDs of a comma-separated var. */
const chainList = (raw: unknown): number[] =>
  String(raw)
    .split(',')
    .filter((x) => x !== '')
    .map(Number);

describe('wrangler.toml', () => {
  for (const env of Object.keys(ENVIRONMENTS) as EnvName[]) {
    describe(`env ${env}`, () => {
      const expected = ENVIRONMENTS[env];

      it('names its own Worker and deploys the submitter source', () => {
        const config = read(env);
        expect(config.name).toBe(expected.name);
        expect(config.main?.replaceAll('\\', '/').endsWith('src/index.ts')).toBe(true);
        expect(config.compatibility_date).toBe('2026-08-01');
      });

      it('binds the three Durable Objects with their migration', () => {
        const config = read(env);
        expect(config.durable_objects.bindings).toEqual(
          DURABLE_OBJECTS.map((binding) => expect.objectContaining(binding)),
        );
        for (const binding of config.durable_objects.bindings) {
          expect(binding.script_name).toBeUndefined();
        }
        expect(config.migrations).toEqual([
          expect.objectContaining({
            tag: 'v1',
            new_sqlite_classes: ['SubmitterQueue', 'SubmitterLimits', 'SubmitterFaucet'],
          }),
        ]);
      });

      it('keeps observability, request logging, Logpush and Tail Workers off (07 §7, I-7)', () => {
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

      it('serves testnets only, with the faucet on the hard-coded allowlist (SUB-7)', () => {
        const vars = read(env).vars;
        expect(Object.keys(vars).sort()).toEqual(['SUBMITTER_CHAINS', 'SUBMITTER_FAUCET_CHAINS']);
        expect(chainList(vars.SUBMITTER_CHAINS)).toEqual([84532]);
        expect(chainList(vars.SUBMITTER_FAUCET_CHAINS)).toEqual([84532]);
        // The Worker's own parsers accept the values (an invalid one would make it answer 503).
        const parsed = readConfig({ ...vars, SUBMITTER_IP_KEY: TEST_IP_KEY });
        expect(parsed?.chains).toEqual([84532]);
        expect(readFaucetConfig(vars)?.chains).toEqual([84532]);
      });
    });
  }

  it('staging runs on workers.dev only', () => {
    const config = read('staging');
    expect(config.workers_dev).toBe(true);
    expect(config.preview_urls).toBe(false);
    expect(config.routes ?? []).toEqual([]);
  });

  it('production runs on its Custom Domain only, with no workers.dev or preview URLs', () => {
    const config = read('production');
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config.routes).toEqual([
      { pattern: 'submit.agentlink.4thtech.io', custom_domain: true },
    ]);
  });

  it('the top level deploys nowhere by accident', () => {
    const config = read();
    expect(config.name).toBe('agentlink-submitter-local');
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config.routes ?? []).toEqual([]);
  });

  it('contains no account ID, token or key material', () => {
    const lines = wranglerToml
      .split('\n')
      .map((line) => line.replace(/#.*$/, ''))
      .join('\n');
    expect(lines).not.toMatch(/account_id/);
    expect(lines).not.toMatch(/SUBMITTER_(IP|GAS|FAUCET)_KEY|SUBMITTER_RPC_URLS/);
    expect(lines).not.toMatch(/0x[0-9a-f]{40,}/i);
    // No base64url or hex blob long enough to be a key or token.
    expect(lines).not.toMatch(/[A-Za-z0-9_-]{40,}/);
    expect(lines).not.toMatch(/[0-9a-f]{32,}/i);
  });
});
