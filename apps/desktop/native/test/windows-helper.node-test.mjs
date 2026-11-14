// WIN-HELLO-NATIVE: runs the real Windows presence helper (mirrors macos-helper.node-test.mjs).
// Nothing here shows a Windows Hello prompt:
//  - argv and stdin refusals happen before any credential is touched;
//  - `available`, `check` and `delete` never prompt; `create` and `sign` run only where Windows Hello
//    is NOT available (they must say so, exit 69, before any prompt), never where it is;
//  - `check` / `delete` with a well-formed record name a random credential that does not exist, so
//    no AgentLink credential is ever read or removed.
// The helper comes from AGENTLINK_WIN_HELPER (CI: the exe the desktop workflow just built) or is built
// here when cl.exe is on PATH (a Developer PowerShell). Gesture paths are the manual list in the .cpp.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { encodeHex, randomBytes } from '@4thtech-io/crypto';
import { EXIT, buildWinHelper } from '../../build/native.mjs';

const onWin = process.platform === 'win32';
const fromEnv = process.env.AGENTLINK_WIN_HELPER;
const haveCl = onWin && spawnSync('where', ['cl.exe'], { encoding: 'utf8' }).status === 0;
const dir = onWin && !fromEnv && haveCl ? mkdtempSync(join(tmpdir(), 'al-presence-')) : undefined;
const bin = !onWin
  ? undefined
  : fromEnv && existsSync(fromEnv)
    ? fromEnv
    : dir
      ? buildWinHelper({ outDir: dir, arch: process.arch === 'arm64' ? 'arm64' : 'x64' })
      : undefined;
const skip = bin === undefined;
// In CI the helper must be there: a missing exe fails instead of skipping everything.
if (onWin && fromEnv && !existsSync(fromEnv)) throw new Error('AGENTLINK_WIN_HELPER: no such file');

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function runHelper(args, input = '') {
  const r = spawnSync(bin, args, { input, encoding: 'utf8', timeout: 20_000, env: {} });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const UNAVAILABLE_LINE = /^unavailable (not_set_up|no_secure_hardware)\n$/;

function refused(args, input, code) {
  const r = runHelper(args, input);
  assert.equal(r.code, code, `${JSON.stringify(args)} -> ${r.code}`);
  assert.equal(r.out, '', 'stdout stays empty on refusal');
  if (code === EXIT.unavailable) assert.match(r.err, UNAVAILABLE_LINE);
  else assert.equal(r.err, '', 'stderr is written only for unavailable');
  return r;
}

const available = () => !skip && runHelper(['available']).code === EXIT.ok;

/** A well-formed record v1 naming a credential that does not exist. */
function record({ spki = '30'.repeat(8) } = {}) {
  const name = Buffer.from(`AgentLink-owner-${encodeHex(randomBytes(16))}`, 'ascii');
  const s = Buffer.from(spki, 'hex');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(s.length);
  return Buffer.concat([
    Buffer.from([0x01, name.length]),
    name,
    len,
    s,
    Buffer.from(randomBytes(32)),
  ]).toString('hex');
}

test('argv: only the fixed commands, with exactly their fixed arguments', { skip }, () => {
  for (const args of [
    [],
    ['help'],
    ['--help'],
    ['create', 'x'],
    ['available', 'x'],
    ['version', 'x'],
    ['check', 'x'],
    ['delete', 'x'],
    ['sign'],
    ['sign', 'bogus'],
    ['sign', 'APPROVE'],
    ['sign', 'approve', 'x'],
    ['sign', '--reason', 'approve'],
    ['sign', 'Approve this payment of $1000'],
    ['ecdh', 'approve'],
  ]) {
    refused(args, '', EXIT.usage);
  }
});

test('version prints the record version as hex and nothing else', { skip }, () => {
  const r = runHelper(['version']);
  assert.equal(r.code, 0);
  assert.equal(r.out, '01\n');
  assert.equal(r.err, '');
});

test('available exits 0 with nothing printed, or 69 with one fixed reason line', { skip }, () => {
  const r = runHelper(['available']);
  assert.ok([EXIT.ok, EXIT.unavailable].includes(r.code), `exit ${r.code}`);
  assert.equal(r.out, '');
  if (r.code === EXIT.ok) assert.equal(r.err, '');
  else assert.match(r.err, UNAVAILABLE_LINE);
});

test('malformed stdin is refused before any credential is used', { skip }, () => {
  const good = record();
  for (const input of [
    '',
    '\n',
    'zz',
    good.toUpperCase(),
    good.slice(0, -1),
    good.slice(0, -2),
    good + '00',
    '02' + good.slice(2),
    '0100' + good.slice(4),
    good + '\n\n',
    ' ' + good,
    'a'.repeat(9000),
    // a name that is not AgentLink-owner-<32 hex>
    record().replace(
      Buffer.from('AgentLink').toString('hex'),
      Buffer.from('Microsoft').toString('hex'),
    ),
  ]) {
    for (const args of [['sign', 'approve'], ['check'], ['delete']]) {
      refused(args, input, EXIT.badInput);
    }
  }
});

test(
  'without Windows Hello every command says unavailable, with its reason, before any prompt',
  { skip: skip || available() },
  () => {
    const reason = runHelper(['available']).err;
    assert.match(reason, UNAVAILABLE_LINE);
    // create would prompt where Windows Hello is set up; here it must stop first.
    assert.equal(refused(['create'], '', EXIT.unavailable).err, reason);
    for (const args of [
      ['check'],
      ...['setup', 'approve', 'pay', 'code'].map((r) => ['sign', r]),
    ]) {
      assert.equal(refused(args, `${record()}\n`, EXIT.unavailable).err, reason);
    }
    // Fable r1 L2: delete has no gate (it never prompts), so it is not "unavailable": a credential
    // that does not exist is refused by Windows Hello itself, quietly.
    const del = runHelper(['delete'], `${record()}\n`);
    assert.notEqual(del.code, EXIT.unavailable);
    assert.notEqual(del.code, EXIT.ok);
    assert.equal(del.out, '');
    assert.equal(del.err, '');
  },
);

test(
  'with Windows Hello: a credential that does not exist is refused without a prompt',
  { skip: skip || !available() },
  () => {
    refused(['check'], `${record()}\n`, EXIT.keyUnusable);
    refused(['delete'], `${record()}\n`, EXIT.keyUnusable);
  },
);
