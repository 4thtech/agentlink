import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const script = join(dirname(fileURLToPath(import.meta.url)), 'wait-for-keyring.sh');
const dirs = [];

// A fake `secret-tool` that fails its first `failures` calls to `store`, then behaves like a store.
function fake(failures) {
  const dir = mkdtempSync(join(tmpdir(), 'keyring-'));
  dirs.push(dir);
  const bin = join(dir, 'secret-tool');
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
d="${dir}"
case "$1" in
  store)
    n=$(cat "$d/n" 2>/dev/null || echo 0); echo $((n + 1)) > "$d/n"
    [ "$n" -lt ${failures} ] && exit 1
    cat > "$d/v";;
  lookup) cat "$d/v";;
  clear) rm -f "$d/v";;
esac
`,
  );
  chmodSync(bin, 0o755);
  return dir;
}

const run = (dir, attempts) =>
  spawnSync('bash', [script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      KEYRING_WAIT_ATTEMPTS: String(attempts),
      KEYRING_WAIT_INTERVAL: '0',
    },
  });

describe('wait-for-keyring.sh', () => {
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('succeeds at once when the keyring is ready', () => {
    const r = run(fake(0), 3);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('after 1 attempt');
  });

  it('retries until the keyring answers', () => {
    const dir = fake(2);
    const r = run(dir, 5);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('after 3 attempt');
    expect(readFileSync(join(dir, 'n'), 'utf8').trim()).toBe('3');
  });

  it('fails with an ::error:: when it never becomes ready', () => {
    const dir = fake(99);
    const r = run(dir, 3);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('::error::');
    expect(readFileSync(join(dir, 'n'), 'utf8').trim()).toBe('3');
  });
});
