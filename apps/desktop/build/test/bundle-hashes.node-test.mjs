import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bundleHashesJson, BUNDLE_HASHES_FILE } from '../lib/bundle-hashes.mjs';

// D15-07 (DESK051-C5): the build records the SHA-256 of Resources/node, the core's desktop host and
// the presence helper in app.asar, so the shell can compare them at start (src/main/bundle-check.ts).

const HEX = 'a'.repeat(64);

test('the record is { v: 1, files } with lowercase hex only', () => {
  assert.equal(BUNDLE_HASHES_FILE, 'bundle-hashes.json');
  assert.deepEqual(JSON.parse(bundleHashesJson({ node: HEX, host: HEX, helper: HEX })), {
    v: 1,
    files: { node: HEX, host: HEX, helper: HEX },
  });
  assert.deepEqual(JSON.parse(bundleHashesJson({ node: HEX, host: HEX })), {
    v: 1,
    files: { node: HEX, host: HEX },
  });
  assert.throws(() => bundleHashesJson({ node: 'XYZ', host: HEX }));
  assert.throws(() => bundleHashesJson({ node: HEX, host: HEX, other: HEX }));
});

test('build-mac packs app.asar only after node, core and the signed helper are in place', () => {
  const src = readFileSync(new URL('../build-mac.mjs', import.meta.url), 'utf8');
  const pack = src.indexOf('await packAsar(');
  assert.ok(pack > src.indexOf('installCore({'), 'ASAR after the core');
  assert.ok(pack > src.indexOf('buildMacHelper({'), 'ASAR after the helper');
  assert.ok(pack > src.indexOf('signHelper('), 'ASAR after the helper is signed');
  assert.ok(pack > src.indexOf('bundleHashesJson('), 'the record goes into the payload');
  // The helper is not re-signed later (its hash is in the ASAR); the build re-checks it after signing.
  assert.match(src, /signApp\(app, process\.env, entitlements, \{ skip: helperTargets \}\)/);
  assert.match(src, /The presence helper changed after its hash was recorded/);
});

// D15-09: "Read me first.txt" matches what macOS shows and names the integrity anchors.
test('Read me first: macOS 15 order, Trash and Bin, no "no security setting" claim, sums', () => {
  const text = readFileSync(new URL('../../assets/dmg/read-me-first.txt', import.meta.url), 'utf8');
  assert.match(text, /"Move to Trash"/);
  assert.match(text, /"Move to Bin"/);
  assert.doesNotMatch(text, /You do not need to turn off any Mac security setting/);
  assert.match(text, /Open Anyway[\s\S]{0,200}Open Anyway[\s\S]{0,200}(password|Touch ID)/);
  assert.match(text, /SHA256SUMS-desktop-app\.txt/);
  assert.match(text, /shasum -a 256/);
});
