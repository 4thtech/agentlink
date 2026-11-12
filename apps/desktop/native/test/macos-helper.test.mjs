// WP-D12b: runs the real macOS presence helper. Nothing here shows a Touch ID sheet:
//  - argv and stdin refusals happen before any key is touched;
//  - `check` runs ECDH with interaction NOT allowed, so the only way to exit 0 is the Secure Enclave
//    refusing with LAError.notInteractive (the key really needs a gesture);
//  - keys made by `create` are Secure Enclave handles held only in this test's memory: no keychain
//    item is created, read or deleted (AgentLink's real keychain items are never touched).
// Gesture paths (Touch ID OK, cancel, lockout, new finger) are the manual list in the Swift header.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
import { EXIT, buildMacHelper, parseMacRecord } from '../../build/native.mjs';

const onMac = process.platform === 'darwin';
// Built at load time: the skip conditions below run the helper while the tests are declared.
const dir = onMac ? mkdtempSync(join(tmpdir(), 'al-presence-')) : undefined;
const bin = onMac
  ? buildMacHelper({ arch: process.arch === 'arm64' ? 'arm64' : 'x64', outDir: dir })
  : undefined;

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
  assert.equal(r.err, '', 'stderr stays empty');
}

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
  assert.equal(r.err, '');
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
    refused(['check'], swapped, EXIT.keyUnusable);
    refused(['ecdh', 'approve'], swapped, EXIT.keyUnusable);
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
    refused(['check'], rec, EXIT.keyUnusable);
    for (const reason of ['setup', 'approve', 'pay'])
      refused(['ecdh', reason], rec, EXIT.keyUnusable);
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
