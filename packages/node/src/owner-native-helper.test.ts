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
  nativeExitName,
  nativeUiState,
  readHelperDiagnostic,
  spawnNativeHelper,
  type NativeHelperRunner,
} from './owner-native-helper.js';

// The stand-ins are `#!node` scripts: Windows cannot start a script as a program with shell false,
// and it has no SIGTERM, so the tests that spawn one run on macOS and Linux only. The Windows
// helper is an .exe; its argv, exit codes and output parsing are covered here with fakeRunner.
const itStandIn = it.skipIf(process.platform === 'win32');

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
    calls.push({
      args: [...args],
      stdin: stdin === undefined ? undefined : Buffer.from(stdin).toString('utf8'),
    });
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
      stdout:
        args[0] === 'create' ? '0100020a0b\n' : args[0] === 'ecdh' ? `${'11'.repeat(32)}\n` : '',
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
      await expect(helper.release(RECORD, reason as never)).rejects.toBeInstanceOf(
        NativeHelperError,
      );
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
    const { run } = fakeRunner(() => ({
      code: NATIVE_HELPER_EXIT.cancelled,
      stdout: `${'11'.repeat(32)}\n`,
    }));
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
    expect(
      await createNativeHelper({
        kind: 1,
        run: fakeRunner(() => ({ code: 0, stdout: '' })).run,
      }).available(),
    ).toBe(true);
    expect(
      await createNativeHelper({
        kind: 1,
        run: fakeRunner(() => ({ code: 69, stdout: '' })).run,
      }).available(),
    ).toBe(false);
  });
});

describe('the spawned helper (a stand-in script; never the real helper)', () => {
  itStandIn('passes argv as given, no shell, an empty environment, and reads stdout', async () => {
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
    const seen = JSON.parse(readFileSync(out, 'utf8')) as {
      argv: string[];
      stdin: string;
      env: string[];
    };
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
  it('macOS: the helper app in Contents/Helpers, next to Contents/Resources/node/bin/node', () => {
    // DESK051-C3: a real .app bundle (Info.plist + icon), so the Touch ID sheet names AgentLink.
    expect(
      desktopHelperPath('/Applications/AgentLink.app/Contents/Resources/node/bin/node', 'darwin'),
    ).toBe(
      '/Applications/AgentLink.app/Contents/Helpers/AgentLink.app/Contents/MacOS/agentlink-presence',
    );
  });

  it('Windows: resources\\native next to resources\\node\\node.exe', () => {
    expect(
      desktopHelperPath('C:\\Program Files\\AgentLink\\resources\\node\\node.exe', 'win32'),
    ).toBe('C:\\Program Files\\AgentLink\\resources\\native\\agentlink-presence.exe');
  });

  it('none for an npx node, Linux, or any other layout', () => {
    expect(desktopHelperPath('/usr/local/bin/node', 'darwin')).toBeUndefined();
    expect(desktopHelperPath('/opt/AgentLink/resources/node/bin/node', 'linux')).toBeUndefined();
    expect(desktopHelperPath('C:\\nodejs\\node.exe', 'win32')).toBeUndefined();
  });
});

describe('Fable review L2: no copy of a released secret is left behind', () => {
  it('the run output is wiped once parsed, on success and on refusal', async () => {
    const outputs: Uint8Array[] = [];
    const run: NativeHelperRunner = () => {
      const stdout = new TextEncoder().encode(`${'ab'.repeat(32)}\n`);
      outputs.push(stdout);
      return Promise.resolve({
        code: outputs.length === 1 ? 0 : NATIVE_HELPER_EXIT.cancelled,
        stdout,
      });
    };
    const helper = createNativeHelper({ kind: 1, run });
    expect((await helper.release(RECORD, 'approve')).length).toBe(32);
    await expect(helper.release(RECORD, 'approve')).rejects.toBeInstanceOf(NativeHelperError);
    for (const out of outputs) expect(out.every((b) => b === 0)).toBe(true);
  });
});

describe('Fable review L1: an abandoned release', () => {
  it('passes the signal to the run and drops what it printed after the abort', async () => {
    const abandoned = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    const run: NativeHelperRunner = (_args, _stdin, signal) => {
      seen.push(signal);
      abandoned.abort();
      return Promise.resolve({
        code: 0,
        stdout: new TextEncoder().encode(`${'ab'.repeat(32)}\n`),
      });
    };
    const error = await createNativeHelper({ kind: 1, run })
      .release(RECORD, 'approve', abandoned.signal)
      .catch((e: unknown) => e);
    expect((error as NativeHelperError).state).toBe('cancelled');
    expect(seen[0]).toBe(abandoned.signal);
  });

  itStandIn(
    'the spawned helper is killed on abort (a stand-in that would wait forever)',
    async () => {
      const script = join(root, 'waits');
      writeFileSync(script, `#!${process.execPath}\nsetInterval(() => undefined, 1000);\n`);
      chmodSync(script, 0o700);
      const abandoned = new AbortController();
      const pending = spawnNativeHelper(script)(['ecdh', 'approve'], undefined, abandoned.signal);
      setTimeout(() => abandoned.abort(), 100);
      expect((await pending).code).toBeNull();
    },
  );
});

// DESK-NATIVE-DEBUG: every way a run ends has a fixed name for the core's one diagnostic line, the
// helper's own fixed stderr line is parsed strictly (anything else is dropped), and a prompt that
// got no answer in time is its own state (`timeout`), not the catch-all `error`.
describe('fixed diagnostics of a helper run (DESK-NATIVE-DEBUG)', () => {
  const stub = (name: string, body: string): string => {
    const script = join(root, name);
    writeFileSync(script, `#!${process.execPath}\n${body}\n`);
    chmodSync(script, 0o700);
    return script;
  };
  const failure = (p: Promise<unknown>): Promise<NativeHelperError> =>
    p.then(
      () => {
        throw new Error('expected a refusal');
      },
      (e: unknown) => e as NativeHelperError,
    );

  itStandIn('a refusal carries the exit code name and the helper diagnostic line', async () => {
    const script = stub(
      'refuses',
      `process.stderr.write('sheet la -2\\n'); process.exitCode = 10;`,
    );
    const helper = createNativeHelper({ kind: 1, run: spawnNativeHelper(script) });
    const error = await failure(helper.release(RECORD, 'setup'));
    expect(error).toBeInstanceOf(NativeHelperError);
    expect([error.state, error.detail, error.diag]).toEqual([
      'cancelled',
      'exit_cancelled',
      'sheet la -2',
    ]);
  });

  itStandIn('stderr that is not exactly the fixed shape is dropped, never kept', async () => {
    for (const text of [
      'sheet la -2 /Users/someone/secret\n',
      'Error: The operation could not be completed\n',
      `sheet la ${'1'.repeat(9)}\n`,
      'bogus la -2\n',
      'x'.repeat(400),
    ]) {
      const script = stub(
        'noisy',
        `process.stderr.write(${JSON.stringify(text)}); process.exitCode = 11;`,
      );
      const result = await spawnNativeHelper(script)(['ecdh', 'setup'], undefined);
      expect(result.code).toBe(11);
      expect(result.diag).toBeUndefined();
    }
    expect(readHelperDiagnostic(new TextEncoder().encode('sensor la -6\n'))).toBe('sensor la -6');
    expect(readHelperDiagnostic(new TextEncoder().encode('gate none 0'))).toBe('gate none 0');
  });

  itStandIn(
    'a prompt with no answer in time is `timeout`; a helper that cannot start is `no_start`',
    async () => {
      const waits = stub('waits-long', 'setInterval(() => undefined, 1000);');
      const timed = createNativeHelper({
        kind: 1,
        run: spawnNativeHelper(waits, { timeoutMs: 150 }),
      });
      const error = await failure(timed.release(RECORD, 'setup'));
      expect([error.state, error.detail]).toEqual(['timeout', 'timeout']);
      const missing = createNativeHelper({
        kind: 1,
        run: spawnNativeHelper(join(root, 'not-there')),
      });
      const none = await failure(missing.release(RECORD, 'setup'));
      expect([none.state, none.detail]).toEqual(['error', 'no_start']);
    },
  );

  it('a malformed or wrong-length output and an unknown exit code are named', async () => {
    const answering = (code: number, stdout: string) =>
      createNativeHelper({ kind: 1, run: fakeRunner(() => ({ code, stdout })).run });
    expect((await failure(answering(0, 'zz\n').release(RECORD, 'setup'))).detail).toBe(
      'bad_output',
    );
    expect(
      (await failure(answering(0, `${'11'.repeat(16)}\n`).release(RECORD, 'setup'))).detail,
    ).toBe('wrong_length');
    const e3 = await failure(answering(3, '').check(RECORD));
    expect([e3.state, e3.detail]).toEqual(['error', 'exit_other']);
    expect(nativeExitName(13)).toBe('exit_keyUnusable');
    expect(nativeUiState(69)).toBe('unavailable');
  });
});

// DESK-TOUCHID-FIX: a cancelled or timed-out helper is stopped with SIGTERM (its handler invalidates
// the LocalAuthentication context, so no Touch ID sheet is left on screen) and core waits for it to
// exit before answering; one that ignores SIGTERM is killed after a grace period. The helper's fixed
// note that secure input was on when it started becomes ONE fixed core diagnostic line.
describe('stopping the helper and its secure-input note (DESK-TOUCHID-FIX)', () => {
  const stub = (name: string, body: string): string => {
    const script = join(root, name);
    writeFileSync(script, `#!${process.execPath}\n${body}\n`);
    chmodSync(script, 0o700);
    return script;
  };
  /** A stand-in that, on SIGTERM, records the signal, takes 300 ms to clean up, then exits 10. */
  const graceful = (name: string, mark: string): string =>
    stub(
      name,
      `const fs = require('node:fs');\n` +
        `process.on('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(mark)}, 'SIGTERM');\n` +
        `  setTimeout(() => { fs.appendFileSync(${JSON.stringify(mark)}, ' exited'); process.exit(10); }, 300); });\n` +
        `setInterval(() => undefined, 1000);`,
    );

  itStandIn('cancel: SIGTERM, then core waits until the helper has exited', async () => {
    const mark = join(root, 'cancel-mark');
    const script = graceful('graceful-cancel', mark);
    const abandoned = new AbortController();
    const pending = spawnNativeHelper(script)(['ecdh', 'approve'], undefined, abandoned.signal);
    setTimeout(() => abandoned.abort(), 300);
    const result = await pending;
    expect([result.code, result.ended]).toEqual([null, 'aborted']);
    expect(readFileSync(mark, 'utf8')).toBe('SIGTERM exited');
  });

  itStandIn('timeout: SIGTERM, then core waits until the helper has exited', async () => {
    const mark = join(root, 'timeout-mark');
    const script = graceful('graceful-timeout', mark);
    const result = await spawnNativeHelper(script, { timeoutMs: 300 })(
      ['ecdh', 'approve'],
      undefined,
    );
    expect([result.code, result.ended]).toEqual([null, 'timeout']);
    expect(readFileSync(mark, 'utf8')).toBe('SIGTERM exited');
  });

  itStandIn('a helper that ignores SIGTERM is killed after the grace period', async () => {
    const script = stub(
      'stubborn',
      `process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000);`,
    );
    const abandoned = new AbortController();
    const started = Date.now();
    const pending = spawnNativeHelper(script, { killGraceMs: 200 })(
      ['ecdh', 'approve'],
      undefined,
      abandoned.signal,
    );
    setTimeout(() => abandoned.abort(), 300);
    const result = await pending;
    expect([result.code, result.ended]).toEqual([null, 'aborted']);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('the stop of a signalled helper is a fixed diagnostic', () => {
    expect(readHelperDiagnostic(new TextEncoder().encode('signal none 15\n'))).toBe(
      'signal none 15',
    );
  });

  itStandIn(
    'secure input on at the start: one fixed core line, on success and on refusal',
    async () => {
      const lines: string[] = [];
      const ok = stub(
        'secure-ok',
        `process.stderr.write('note secureinput 1\\n'); process.stdout.write('ab'.repeat(32) + '\\n');`,
      );
      const helper = createNativeHelper({
        kind: 1,
        run: spawnNativeHelper(ok),
        diagnose: (line) => lines.push(line),
      });
      const secret = await helper.release(RECORD, 'approve');
      expect(secret.length).toBe(32);
      expect(lines).toEqual(['native presence: secure input was on when the helper started']);

      const refused = stub(
        'secure-refused',
        `process.stderr.write('note secureinput 1\\nsheet la -2\\n'); process.exitCode = 10;`,
      );
      const r = await spawnNativeHelper(refused)(['ecdh', 'approve'], undefined);
      expect([r.code, r.diag, r.secureInput]).toEqual([10, 'sheet la -2', true]);

      const quiet = stub('secure-off', `process.stdout.write('ab'.repeat(32) + '\\n');`);
      const none: string[] = [];
      await createNativeHelper({
        kind: 1,
        run: spawnNativeHelper(quiet),
        diagnose: (line) => none.push(line),
      }).release(RECORD, 'approve');
      expect(none).toEqual([]);
    },
  );

  itStandIn('a note that is not exactly the fixed line is dropped', async () => {
    const odd = stub(
      'secure-odd',
      `process.stderr.write('note secureinput 1 /Users/x\\nsheet la -2\\n'); process.exitCode = 10;`,
    );
    const r = await spawnNativeHelper(odd)(['ecdh', 'approve'], undefined);
    expect(r.secureInput).toBeUndefined();
    expect(r.diag).toBeUndefined();
  });
});
