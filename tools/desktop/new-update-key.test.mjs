// UPD-KEYTOOL (D-151): the owner's one-time tool that creates the ONE desktop update key. It writes
// only the private key (64 hex) to a new 0600 file, never overwrites, refuses to run in CI, and prints
// only the public key and the exact next steps. All crypto through @4thtech-io/crypto.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeHex, encodeHex } from '@4thtech-io/crypto';
import { bip340PublicKey } from '@4thtech-io/crypto/keystore';
import { NEXT_STEPS, ToolError, createUpdateKey, main } from './new-update-key.mjs';

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'agentlink-upd-keytool-'));
  dirs.push(d);
  return d;
};

const run = async (argv, env = {}) => {
  const lines = [];
  let error;
  try {
    await main(argv, { env, out: (l) => lines.push(l) });
  } catch (e) {
    error = e;
  }
  return { text: lines.join('\n'), error };
};

describe('new-update-key.mjs', () => {
  it('refuses to run when CI or GITHUB_ACTIONS is set, and writes nothing', async () => {
    for (const env of [
      { CI: 'true' },
      { GITHUB_ACTIONS: 'true' },
      { CI: '1', GITHUB_ACTIONS: '' },
    ]) {
      const out = join(tempDir(), 'update.key');
      const r = await run(['--out', out], env);
      expect(r.error).toBeInstanceOf(ToolError);
      expect(r.error.message).toMatch(/does not run in CI/);
      expect(() => statSync(out)).toThrow();
    }
  });

  it('writes only the private key hex to a new 0600 file and prints only the public key and the next steps', async () => {
    const out = join(tempDir(), 'update.key');
    const r = await run(['--out', out]);
    expect(r.error).toBeUndefined();
    const text = readFileSync(out, 'utf8');
    expect(text).toMatch(/^[0-9a-f]{64}\n$/);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const secretHex = text.trim();
    const publicHex = encodeHex(bip340PublicKey(decodeHex(secretHex)));
    expect(r.text).toContain(publicHex);
    expect(r.text).not.toContain(secretHex);
    // The exact next steps: the environment secret, the pin PR, then delete or keep offline.
    expect(r.text).toContain('DESKTOP_UPDATE_KEY');
    expect(r.text).toContain('desktop-update');
    expect(r.text).toContain('apps/desktop/src/main/updater/root-key.json');
    expect(r.text).toMatch(/delete/i);
    for (const step of NEXT_STEPS) expect(r.text).toContain(step.split('{')[0]);
  });

  it('never overwrites an existing file', async () => {
    const out = join(tempDir(), 'update.key');
    writeFileSync(out, 'keep me\n');
    const r = await run(['--out', out]);
    expect(r.error).toBeInstanceOf(ToolError);
    expect(r.error.message).toMatch(/already exists/);
    expect(readFileSync(out, 'utf8')).toBe('keep me\n');
  });

  it('needs --out and refuses other arguments', async () => {
    expect((await run([])).error).toBeInstanceOf(ToolError);
    expect((await run(['--out'])).error).toBeDefined();
    expect((await run(['--out', join(tempDir(), 'k'), '--print-secret'])).error).toBeDefined();
  });

  it('two keys are different and each public key matches its file', async () => {
    const d = tempDir();
    const a = await createUpdateKey({ out: join(d, 'a.key') });
    const b = await createUpdateKey({ out: join(d, 'b.key') });
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.publicKey).toMatch(/^[0-9a-f]{64}$/);
    for (const [k, f] of [
      [a, 'a.key'],
      [b, 'b.key'],
    ]) {
      const secret = decodeHex(readFileSync(join(d, f), 'utf8').trim());
      expect(encodeHex(bip340PublicKey(secret))).toBe(k.publicKey);
    }
    expect(Object.keys(a).sort()).toEqual(['keyId', 'publicKey']);
    expect(a.keyId).toBe(a.publicKey.slice(0, 16));
  });

  it('imports no network module and uses @4thtech-io/crypto only', () => {
    const src = readFileSync(new URL('./new-update-key.mjs', import.meta.url), 'utf8');
    expect(src).not.toMatch(/from 'node:(https?|net|tls|dgram|dns)'/);
    expect(src).not.toMatch(/from 'node:crypto'|require\(/);
    expect(src).toMatch(/from '@4thtech-io\/crypto/);
  });
});
