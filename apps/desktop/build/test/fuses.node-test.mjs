import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FUSES, FUSE_NAMES, diffFuses } from '../lib/fuses.mjs';

test('the release fuse set matches Decision 3 (H1)', () => {
  assert.deepEqual(FUSES, {
    RunAsNode: false,
    EnableCookieEncryption: true,
    EnableNodeOptionsEnvironmentVariable: false,
    EnableNodeCliInspectArguments: false,
    EnableEmbeddedAsarIntegrityValidation: true,
    OnlyLoadAppFromAsar: true,
    LoadBrowserProcessSpecificV8Snapshot: false,
    GrantFileProtocolExtraPrivileges: false,
  });
});

test('diffFuses is empty when the read-back equals the expected set', () => {
  assert.deepEqual(diffFuses({ ...FUSES }), []);
});

test('diffFuses names every fuse that differs, is missing or is unknown (WasmTrapHandlers is not pinned)', () => {
  assert.deepEqual(diffFuses({ ...FUSES, WasmTrapHandlers: true }), []);
  const actual = { ...FUSES, RunAsNode: true };
  delete actual.OnlyLoadAppFromAsar;
  actual.SomethingNew = true;
  const d = diffFuses(actual);
  assert.equal(d.length, 3);
  assert.ok(d.some((x) => x.includes('RunAsNode')));
  assert.ok(d.some((x) => x.includes('OnlyLoadAppFromAsar')));
  assert.ok(d.some((x) => x.includes('SomethingNew')));
});

test('numeric fuse indices map to names', () => {
  assert.equal(FUSE_NAMES[0], 'RunAsNode');
  assert.equal(FUSE_NAMES[5], 'OnlyLoadAppFromAsar');
});
