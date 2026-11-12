// DESK-D12c (S2; D-145 phase 2; 04 §2.3.4, §2.5 "Desktop app owner presence"): how core runs the
// DESK-D12b presence helper. Fixed argv only (the reason is one of three fixed ids, never text), the
// record on stdin as lowercase hex, stdout hex only, every exit code mapped to one fixed UI state, no
// shell and no inherited environment. The real helper is never run here: a stand-in script prints
// what the helper would, and no Touch ID or Windows Hello prompt is ever shown.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  NATIVE_HELPER_EXIT,
  NativeHelperError,
  createNativeHelper,
  desktopHelperPath,
  nativeUiState,
  spawnNativeHelper,
  type NativeHelperRunner,
} from './owner-native-helper.js';

const root = mkdtempSync(join(tmpdir(), 'agentlink-d12c-helper-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

interface Call {
  readonly args: readonly string[];
  readonly stdin: string | undefined;
}

/** A runner that records each call and answers with `answer`. */
function fakeRunner(answer: (args: readonly string[]) => { code: number | null; stdout: string }) {
  const calls: Call[] = [];
  const run: NativeHelperRunner = (args, stdin) => {
    calls.push({ args: [...args], stdin: stdin === undefined ? undefined : Buffer.from(stdin).toString('utf8') });
    const out = answer(args);
    return Promise.resolve({ code: out.code, stdout: new TextEncoder().encode(out.stdout) });
  };
  return { calls, run };
}

const RECORD = new Uint8Array([1, 0, 2, 0xab, 0xcd]);

describe('fixed argv, hex stdin, hex-only stdout (DESK-D12b contract)', () => {
  it('macOS: create, check and ecdh <reason>; the record goes on stdin as hex and one newline', async () => {
    const { calls, run } = fakeRunner((args) => ({
      code: 0,
      stdout: args[0] === 'create' ? '0100020a0b\n' : args[0] === 'ecdh' ? `${'11'.repeat(32)}\n` : '',
    }));
    const helper = createNativeHelper({ kind: 1, run });
    expect(Array.from(await helper.create())).toEqual([1, 0, 2, 10, 11]);
    await helper.check(RECORD);
    const secret = await helper.release(RECORD, 'approve');
    expect(secret.length).toBe(32);
    expect(calls).toEqual([
      { args: ['create'], stdin: undefined },
      { args: ['check'], stdin: '010002abcd\n' },
      { args: ['ecdh', 'approve'], stdin: '010002abcd\n' },
    ]);
  });

  it('Windows: sign <reason>, and delete on removal; never ecdh', async () => {
    const { calls, run } = fakeRunner((args) => ({
      code: 0,
      stdout: args[0] === 'sign' ? `${'22'.repeat(256)}\n` : '',
    }));
    const helper = createNativeHelper({ kind: 2, run });
    expect((await helper.release(RECORD, 'pay')).length).toBe(256);
    await helper.remove(RECORD);
    expect(calls.map((c) => c.args)).toEqual([['sign', 'pay'], ['delete']]);
  });

  it('refuses any reason other than setup, approve or pay before running anything', async () => {
    const { calls, run } = fakeRunner(() => ({ code: 0, stdout: '' }));
    const helper = createNativeHelper({ kind: 1, run });
    for (const reason of ['Approve', 'approve this $5 payment', '', 'setup ', 'pay\n']) {
      await expect(helper.release(RECORD, reason as never)).rejects.toBeInstanceOf(NativeHelperError);
    }
    expect(calls).toEqual([]);
  });

  it('refuses stdout that is not lowercase hex, has odd length or extra lines', async () => {
    for (const stdout of ['AB\n', 'abc\n', 'ab\n\n', 'ab cd\n', 'ok', `${'11'.repeat(31)}\n`]) {
      const { run } = fakeRunner(() => ({ code: 0, stdout }));
      const helper = createNativeHelper({ kind: 1, run });
      const error = await helper.release(RECORD, 'approve').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NativeHelperError);
      expect((error as NativeHelperError).state).toBe('error');
      // The error carries a fixed state only: never the output.
      expect(String((error as Error).message)).not.toContain(stdout.trim() || '<none>');
    }
  });
});

describe('exit codes map to fixed UI states', () => {
  it('cancel, lockout, biometry changed (re-register), not available (fallback), retry later', () => {
    expect(nativeUiState(NATIVE_HELPER_EXIT.cancelled)).toBe('cancelled');
    expect(nativeUiState(NATIVE_HELPER_EXIT.failed)).toBe('failed');
    expect(nativeUiState(NATIVE_HELPER_EXIT.notInteractive)).toBe('cancelled');
    expect(nativeUiState(NATIVE_HELPER_EXIT.keyUnusable)).toBe('reregister');
    expect(nativeUiState(NATIVE_HELPER_EXIT.lockout)).toBe('lockout');
    expect(nativeUiState(NATIVE_HELPER_EXIT.notHardware)).toBe('unavailable');
    expect(nativeUiState(NATIVE_HELPER_EXIT.weakKey)).toBe('unavailable');
    expect(nativeUiState(NATIVE_HELPER_EXIT.unavailable)).toBe('unavailable');
    expect(nativeUiState(NATIVE_HELPER_EXIT.attestationRetry)).toBe('retry_later');
    for (const code of [0, 1, 15, 64, 65, 70, 99, null]) expect(nativeUiState(code)).toBe('error');
  });

  it('a refused gesture gives no bytes, only the state', async () => {
    const { run } = fakeRunner(() => ({ code: NATIVE_HELPER_EXIT.cancelled, stdout: `${'11'.repeat(32)}\n` }));
    const error = await createNativeHelper({ kind: 1, run })
      .release(RECORD, 'approve')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NativeHelperError);
    expect((error as NativeHelperError).state).toBe('cancelled');
  });

  it('check passes only on exit 0 (a key that works without a gesture exits 13)', async () => {
    const { run } = fakeRunner(() => ({ code: NATIVE_HELPER_EXIT.keyUnusable, stdout: '' }));
    await expect(createNativeHelper({ kind: 1, run }).check(RECORD)).rejects.toMatchObject({
      state: 'reregister',
    });
  });

  it('available is exit 0 only', async () => {
    expect(await createNativeHelper({ kind: 1, run: fakeRunner(() => ({ code: 0, stdout: '' })).run }).available()).toBe(true);
    expect(await createNativeHelper({ kind: 1, run: fakeRunner(() => ({ code: 69, stdout: '' })).run }).available()).toBe(false);
  });
});

describe('the spawned helper (a stand-in script; never the real helper)', () => {
  it('passes argv as given, no shell, an empty environment, and reads stdout', async () => {
    const out = join(root, 'seen.json');
    const script = join(root, 'stand-in');
    writeFileSync(
      script,
      `#!${process.execPath}\n` +
        `const fs = require('node:fs');\n` +
        `const stdin = fs.readFileSync(0, 'utf8');\n` +
        `fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), stdin, env: Object.keys(process.env) }));\n` +
        `process.stdout.write('ab'.repeat(32) + '\\n');\n`,
    );
    chmodSync(script, 0o700);
    const run = spawnNativeHelper(script);
    const result = await run(['ecdh', 'approve'], new TextEncoder().encode('0102\n'));
    expect(result.code).toBe(0);
    expect(Buffer.from(result.stdout).toString('utf8')).toBe(`${'ab'.repeat(32)}\n`);
    const seen = JSON.parse(readFileSync(out, 'utf8')) as { argv: string[]; stdin: string; env: string[] };
    expect(seen.argv).toEqual(['ecdh', 'approve']);
    expect(seen.stdin).toBe('0102\n');
    // Nothing of ours is inherited (no HOME, no PATH, no AGENTLINK_*): a fixed, empty environment.
    expect(seen.env.filter((k) => k !== '__CF_USER_TEXT_ENCODING')).toEqual([]);
  });

  it('caps stdout and reports a helper that cannot start as an error state', async () => {
    const run = spawnNativeHelper(join(root, 'missing-helper'));
    const result = await run(['available'], undefined);
    expect(result.code).toBeNull();
  });
});

describe('where the desktop app keeps the helper (build-mac / build-win layout)', () => {
  it('macOS: Contents/Helpers next to Contents/Resources/node/bin/node', () => {
    expect(desktopHelperPath('/Applications/AgentLink.app/Contents/Resources/node/bin/node', 'darwin')).toBe(
      '/Applications/AgentLink.app/Contents/Helpers/agentlink-presence',
    );
  });

  it('Windows: resources\\native next to resources\\node\\node.exe', () => {
    expect(desktopHelperPath('C:\\Program Files\\AgentLink\\resources\\node\\node.exe', 'win32')).toBe(
      'C:\\Program Files\\AgentLink\\resources\\native\\agentlink-presence.exe',
    );
  });

  it('none for an npx node, Linux, or any other layout', () => {
    expect(desktopHelperPath('/usr/local/bin/node', 'darwin')).toBeUndefined();
    expect(desktopHelperPath('/opt/AgentLink/resources/node/bin/node', 'linux')).toBeUndefined();
    expect(desktopHelperPath('C:\\nodejs\\node.exe', 'win32')).toBeUndefined();
  });
});
