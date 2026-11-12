import { test } from 'node:test';
import assert from 'node:assert/strict';
import { infoPlist, entitlementsPlist } from '../lib/plist.mjs';

test('Info.plist registers agentlink:// and sets the identity', () => {
  const p = infoPlist({ version: '0.5.0', asarHash: 'ab'.repeat(32) });
  assert.match(p, /<key>CFBundleIdentifier<\/key>\s*<string>io\.4thtech\.agentlink<\/string>/);
  assert.match(p, /<key>CFBundleURLTypes<\/key>/);
  assert.match(p, /<string>agentlink<\/string>/);
  assert.match(p, /<key>CFBundleShortVersionString<\/key>\s*<string>0\.5\.0<\/string>/);
  assert.match(p, /<key>ElectronAsarIntegrity<\/key>/);
  assert.match(p, new RegExp('ab'.repeat(32)));
  assert.match(p, /Resources\/app\.asar/);
});

test('assets/entitlements.mac.plist is the generated text', async () => {
  const { readFileSync } = await import('node:fs');
  const file = readFileSync(
    new URL('../../assets/entitlements.mac.plist', import.meta.url),
    'utf8',
  );
  assert.equal(file, entitlementsPlist());
});

test('Info.plist rejects a bad version or hash', () => {
  assert.throws(() => infoPlist({ version: '1.0<x>', asarHash: 'ab'.repeat(32) }));
  assert.throws(() => infoPlist({ version: '1.0.0', asarHash: 'zz' }));
});

test('entitlements are prepared but minimal: no keychain group, no library-validation bypass', () => {
  const e = entitlementsPlist();
  assert.match(e, /com\.apple\.security\.cs\.allow-jit/);
  assert.doesNotMatch(e, /keychain-access-groups/);
  assert.doesNotMatch(e, /disable-library-validation/);
});
