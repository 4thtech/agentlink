// WP-D12b: runs the real macOS presence helper. Nothing here shows a Touch ID sheet:
//  - argv and stdin refusals happen before any key is touched;
//  - `check` runs ECDH with interaction NOT allowed, so the only way to exit 0 is the Secure Enclave
//    refusing with LAError.notInteractive (the key really needs a gesture);
//  - keys made by `create` are Secure Enclave handles held only in this test's memory: no keychain
//    item is created, read or deleted (AgentLink's real keychain items are never touched).
// Gesture paths (Touch ID OK, cancel, lockout, new finger) are the manual list in the Swift header.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { URL, fileURLToPath } from 'node:url';
import { EXIT, buildMacHelper, parseMacRecord } from '../../build/native.mjs';

const onMac = process.platform === 'darwin';
// Built at load time: the skip conditions below run the helper while the tests are declared.
const dir = onMac ? mkdtempSync(join(tmpdir(), 'al-presence-')) : undefined;
const helper = onMac
  ? buildMacHelper({ arch: process.arch === 'arm64' ? 'arm64' : 'x64', outDir: dir })
  : undefined;
const bin = helper?.executable;

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function runHelper(args, input = '') {
  const r = spawnSync(bin, args, { input, encoding: 'utf8', timeout: 20_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function refused(args, input, code) {
  const r = runHelper(args, input);
  assert.equal(r.code, code, `${JSON.stringify(args)} -> ${r.code}`);
  assert.equal(r.out, '', 'stdout stays empty on refusal');
  // DESK-NATIVE-DEBUG: one fixed diagnostic line, nothing else.
  assert.match(r.err, DIAG, 'stderr is one fixed diagnostic line');
  return r.err;
}

const DIAG =
  /^(args|input|create|verify|gate|sensor|sheet|output|signal) (none|la|os|ck) -?\d{1,7}\n$/;

// Needs a Secure Enclave, enrolled Touch ID and an unlocked Mac (a locked Mac makes create exit 12).
const seAvailable = () =>
  onMac && runHelper(['available']).code === EXIT.ok && runHelper(['create']).code === EXIT.ok;

test('argv: only the fixed commands, with exactly their fixed arguments', { skip: !onMac }, () => {
  for (const args of [
    [],
    ['help'],
    ['--help'],
    ['create', 'x'],
    ['available', 'x'],
    ['version', 'x'],
    ['check', 'x'],
    ['ecdh'],
    ['ecdh', 'bogus'],
    ['ecdh', 'APPROVE'],
    ['ecdh', 'approve', 'x'],
    ['ecdh', '--reason', 'approve'],
    ['ecdh', 'Approve this payment of $1000'],
    ['sign', 'approve'],
    ['delete'],
  ]) {
    refused(args, '', EXIT.usage);
  }
});

test('version prints the record version as hex and nothing else', { skip: !onMac }, () => {
  const r = runHelper(['version']);
  assert.equal(r.code, 0);
  assert.equal(r.out, '01\n');
  assert.equal(r.err, '');
});

test('available exits 0 or 69 and prints nothing', { skip: !onMac }, () => {
  const r = runHelper(['available']);
  assert.ok([EXIT.ok, EXIT.unavailable].includes(r.code));
  assert.equal(r.out, '');
  if (r.code === EXIT.ok) assert.equal(r.err, '');
  else assert.match(r.err, /^sensor (none|la) -?\d{1,7}\n$/);
});

test('malformed stdin is refused before any key is used', { skip: !onMac }, () => {
  const good = '01' + '0004' + 'aabbccdd' + '04' + '11'.repeat(64) + '04' + '22'.repeat(64);
  for (const input of [
    '',
    '\n',
    'zz',
    good.toUpperCase(),
    good.slice(0, -1),
    good.slice(0, -2),
    good + '00',
    '02' + good.slice(2),
    '01' + '0000' + good.slice(14),
    '01' + 'ffff' + good.slice(6),
    good + '\n\n',
    ' ' + good,
    'a'.repeat(9000),
  ]) {
    refused(['ecdh', 'approve'], input, EXIT.badInput);
    refused(['check'], input, EXIT.badInput);
  }
});

test(
  'create: a fresh SE key and a fresh random peer key each time, as one hex record',
  { skip: !seAvailable() },
  () => {
    const a = runHelper(['create']);
    const b = runHelper(['create']);
    for (const r of [a, b]) {
      assert.equal(r.code, 0);
      assert.equal(r.err, '');
      assert.match(r.out, /^01[0-9a-f]+\n$/);
    }
    const ra = parseMacRecord(a.out);
    const rb = parseMacRecord(b.out);
    assert.equal(ra.sePub[0], 0x04);
    assert.equal(ra.peerPub[0], 0x04);
    assert.notDeepEqual(ra.sePub, ra.peerPub);
    assert.notDeepEqual(ra.sePub, rb.sePub);
    assert.notDeepEqual(ra.peerPub, rb.peerPub);
    assert.notDeepEqual(ra.handle, rb.handle);
  },
);

test(
  'check: ECDH without a gesture is refused by the Secure Enclave (LAError.notInteractive)',
  { skip: !seAvailable() },
  () => {
    const rec = runHelper(['create']).out;
    const r = runHelper(['check'], rec);
    assert.equal(r.code, EXIT.ok, 'only an LAError.notInteractive refusal exits 0');
    assert.equal(r.out, '');
    assert.equal(r.err, '');
  },
);

test(
  'a record whose public key does not match its key handle is refused',
  { skip: !seAvailable() },
  () => {
    const a = runHelper(['create']).out.trim();
    const b = runHelper(['create']).out.trim();
    // keep a's handle and peer, put b's SE public key in
    const peerHex = a.slice(-130);
    const seB = b.slice(-260, -130);
    const swapped = a.slice(0, -260) + seB + peerHex + '\n';
    assert.match(refused(['check'], swapped, EXIT.keyUnusable), /^verify /);
    assert.match(refused(['ecdh', 'approve'], swapped, EXIT.keyUnusable), /^verify /);
  },
);

test('a corrupted key handle is refused without a sheet', { skip: !seAvailable() }, () => {
  const a = runHelper(['create']).out.trim();
  const flip = a[10] === '0' ? '1' : '0';
  const bad = a.slice(0, 10) + flip + a.slice(11) + '\n';
  refused(['check'], bad, EXIT.keyUnusable);
});

test('a peer key that is not on the curve is refused', { skip: !seAvailable() }, () => {
  const a = runHelper(['create']).out.trim();
  const bad = a.slice(0, -128) + '00'.repeat(64) + '\n';
  refused(['check'], bad, EXIT.badInput);
  refused(['ecdh', 'approve'], bad, EXIT.badInput);
});

test(
  'a Secure Enclave key without a biometry gate is refused by check and ecdh, with no sheet',
  { skip: !seAvailable() },
  () => {
    const tool = join(dir, 'ungated-key');
    const src = fileURLToPath(new URL('./fixtures/ungated-key.swift', import.meta.url));
    const c = spawnSync('swiftc', ['-O', src, '-o', tool], { encoding: 'utf8' });
    assert.equal(c.status, 0, c.stderr);
    const rec = spawnSync(tool, [], { encoding: 'utf8' }).stdout;
    assert.match(rec, /^01[0-9a-f]+\n$/);
    parseMacRecord(rec);
    assert.equal(refused(['check'], rec, EXIT.keyUnusable), 'gate none 0\n');
    for (const reason of ['setup', 'approve', 'pay'])
      assert.equal(refused(['ecdh', reason], rec, EXIT.keyUnusable), 'gate none 0\n');
  },
);

test(
  'the helper carries the fixed identifier and the hardened runtime flag',
  { skip: !onMac },
  () => {
    const r = spawnSync('codesign', ['-dv', bin], { encoding: 'utf8' });
    assert.match(r.stderr, /^Identifier=io\.4thtech\.agentlink\.presence$/m);
    assert.match(r.stderr, /flags=0x10002\(adhoc,runtime\)/);
  },
);

// DESK051-C3: the Touch ID sheet takes its name and icon from the helper's app bundle.
test(
  'the helper is a signed app bundle with its Info.plist and the AgentLink icon sealed',
  { skip: !onMac },
  () => {
    const r = spawnSync('codesign', ['-dv', helper.bundle], { encoding: 'utf8' });
    assert.match(r.stderr, /^Identifier=io\.4thtech\.agentlink\.presence$/m);
    assert.match(r.stderr, /^Format=app bundle with Mach-O/m);
    assert.match(r.stderr, /^Info\.plist entries=\d+$/m);
    assert.match(r.stderr, /flags=0x10002\(adhoc,runtime\)/);
    const v = spawnSync('codesign', ['--verify', '--strict', '--deep', helper.bundle], {
      encoding: 'utf8',
    });
    assert.equal(v.status, 0, v.stderr);
    const icon = readFileSync(helper.icon);
    const brand = readFileSync(new URL('../../assets/AgentLink.icns', import.meta.url));
    assert.ok(icon.equals(brand), 'the AgentLink icon from apps/desktop/assets');
    assert.equal(bin, join(helper.bundle, 'Contents', 'MacOS', 'agentlink-presence'));
  },
);

// DESK-NATIVE-DEBUG: with no reachable sensor (lid closed, a keyboard without Touch ID) a
// `.biometryCurrentSet` sheet could only be cancelled. `ecdh` checks Touch ID can be used right now
// after the no-gesture proof and before the interactive context: exit 69 (14 on lockout), no sheet.
// A sensor that disappears is `unavailable`, never `key unusable` (which would say "fingers changed").
test('ecdh checks the sensor before any sheet; a missing sensor is unavailable', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../macos/agentlink-presence.swift', import.meta.url)),
    'utf8',
  );
  const ecdh = src.slice(src.indexOf('func cmdEcdh('));
  const gated = ecdh.indexOf('requireGated(verifiedKey(rec), rec.peer)');
  const sensor = ecdh.indexOf('requireSensorNow()');
  const sheet = ecdh.indexOf('let ctx = LAContext()');
  assert.ok(gated > 0 && sensor > gated && sheet > sensor, 'gate proof, then sensor, then sheet');
  const fn = src.slice(src.indexOf('func requireSensorNow()'), src.indexOf('func cmdEcdh('));
  assert.match(fn, /canEvaluatePolicy\(\.deviceOwnerAuthenticationWithBiometrics/);
  assert.match(fn, /finish\(\.lockout\)/);
  assert.match(fn, /finish\(\.unavailable\)/);
  assert.match(src, /case -11, -12, -13:\s*\n\s*return \.unavailable/);
});

// DESK-TOUCHID-FIX: a killed or cancelled helper never leaves a Touch ID sheet behind. SIGTERM and
// SIGINT are handled on a dispatch queue: the handler invalidates the live LAContext (the sheet goes
// away), then the helper exits 10 (cancelled) with the fixed line `signal none <n>`. Checked with no
// finger and no sheet: the helper is stopped while it still waits for its stdin.
function stopWhileWaiting(args, sig) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const killer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.on('close', (code, signal) => {
      clearTimeout(killer);
      resolve({ code, signal, out, err });
    });
    setTimeout(() => child.kill(sig), 400);
  });
}

for (const [sig, n] of [
  ['SIGTERM', 15],
  ['SIGINT', 2],
]) {
  test(
    `${sig}: the helper exits cancelled (10) with one fixed line, no output`,
    { skip: !onMac },
    async () => {
      for (const args of [['ecdh', 'approve'], ['check']]) {
        const r = await stopWhileWaiting(args, sig);
        assert.equal(r.signal, null, 'it exits by itself, not by the signal');
        assert.equal(r.code, EXIT.cancelled);
        assert.equal(r.out, '');
        assert.equal(r.err, `signal none ${n}\n`);
      }
    },
  );
}

test('the signal handler invalidates the live Touch ID context before exiting', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../macos/agentlink-presence.swift', import.meta.url)),
    'utf8',
  );
  const handler = src.slice(src.indexOf('func stopOnSignal('));
  assert.ok(handler.length > 0 && src.includes('func stopOnSignal('));
  const body = handler.slice(0, handler.indexOf('\n}\n'));
  assert.match(body, /\.invalidate\(\)/);
  assert.match(
    src,
    /DispatchSource\.makeSignalSource\(signal: SIGTERM|for sig in \[SIGTERM, SIGINT\]/,
  );
  // The interactive context is published for the handler before the sheet can appear.
  const ecdh = src.slice(src.indexOf('func cmdEcdh('));
  assert.ok(ecdh.indexOf('setActiveContext(ctx)') > 0);
  assert.ok(ecdh.indexOf('setActiveContext(ctx)') < ecdh.indexOf('diagStage = "sheet"'));
});

// Secure input on (a focused password field in some app) can keep the Touch ID sheet from becoming
// key. The helper notes it as one fixed stderr line before the sheet; core logs one fixed line.
test('ecdh notes secure input with one fixed line before the sheet', () => {
  const src = readFileSync(
    fileURLToPath(new URL('../macos/agentlink-presence.swift', import.meta.url)),
    'utf8',
  );
  assert.match(src, /IsSecureEventInputEnabled\(\)/);
  assert.match(src, /"note secureinput 1\\n"/);
  const ecdh = src.slice(src.indexOf('func cmdEcdh('));
  assert.ok(ecdh.indexOf('noteSecureInput()') > 0);
  assert.ok(ecdh.indexOf('noteSecureInput()') < ecdh.indexOf('diagStage = "sheet"'));
});

// Opt-in, shows a real Touch ID sheet for about a second (no finger needed): AGENTLINK_SHEET_CHECK=1.
test(
  'opt-in: SIGTERM while the sheet is up ends the helper as cancelled',
  { skip: process.env.AGENTLINK_SHEET_CHECK !== '1' || !seAvailable() },
  async () => {
    const rec = runHelper(['create']).out;
    const r = await new Promise((resolve) => {
      const child = spawn(bin, ['ecdh', 'approve'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('close', (code, signal) => resolve({ code, signal, out, err }));
      child.stdin.end(rec);
      setTimeout(() => child.kill('SIGTERM'), 1500);
    });
    assert.equal(r.code, EXIT.cancelled);
    assert.equal(r.out, '');
    // The invalidated context ends the sheet (appCancel, -9) or the handler's own line wins.
    assert.match(r.err, /^(note secureinput 1\n)?(sheet la -9|signal none 15)\n$/);
  },
);
