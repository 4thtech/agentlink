// M2-3a: the template's wrangler.toml (08 §3.1 Logs, I-7; D-131 (f)). Read as text in Node: logging
// off everywhere, preview URLs off, one SQLite-backed AgentDO, the R2 bucket, and no secret value.
import { describe, expect, it } from 'vitest';
import wranglerToml from '../wrangler.toml?raw';

const lines = (wranglerToml as string)
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'));

/** The value of `key` inside `[section]` ('' for the top level), as written. */
function valueOf(section: string, key: string): string | undefined {
  let current = '';
  for (const line of lines) {
    const header = /^\[{1,2}([^\]]+)\]{1,2}$/.exec(line);
    if (header !== null) {
      current = header[1] as string;
      continue;
    }
    const kv = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (kv !== null && current === section && kv[1] === key) return kv[2];
  }
  return undefined;
}

describe('apps/cloud-agent/wrangler.toml', () => {
  it('turns every Cloudflare log, trace and Logpush off, with no Tail consumer', () => {
    expect(valueOf('', 'logpush')).toBe('false');
    expect(valueOf('observability', 'enabled')).toBe('false');
    expect(valueOf('observability.logs', 'enabled')).toBe('false');
    expect(valueOf('observability.logs', 'invocation_logs')).toBe('false');
    expect(valueOf('observability.traces', 'enabled')).toBe('false');
    expect(wranglerToml).not.toMatch(/tail_consumers/);
    expect(valueOf('', 'preview_urls')).toBe('false');
  });

  it('binds one SQLite-backed AgentDO and the R2 bucket, from src/index.ts', () => {
    expect(valueOf('', 'main')).toBe('"src/index.ts"');
    expect(valueOf('durable_objects.bindings', 'name')).toBe('"AGENT"');
    expect(valueOf('durable_objects.bindings', 'class_name')).toBe('"AgentDO"');
    expect(valueOf('migrations', 'new_sqlite_classes')).toBe('["AgentDO"]');
    expect(valueOf('r2_buckets', 'binding')).toBe('"FILES"');
    expect(valueOf('vars', 'SYNC_INTERVAL_SECONDS')).toBe('"60"');
  });

  it('holds no secret: no AGENT_SEED, SEED_WRAP_KEY or SETUP_CODE value and no account ID', () => {
    for (const name of ['AGENT_SEED', 'SEED_WRAP_KEY', 'SETUP_CODE', 'account_id']) {
      expect(lines.some((line) => line.startsWith(name))).toBe(false);
    }
  });
});
