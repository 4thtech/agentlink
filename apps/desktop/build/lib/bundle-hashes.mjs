// D15-07 (DESK051-C5): the record of the bundled files outside app.asar, written into the ASAR
// payload by build-mac.mjs and read by the shell at start (src/main/bundle-check.ts, same format).
// A tamper tripwire, not a security boundary against a same-user process (see bundle-check.ts).

export const BUNDLE_HASHES_FILE = 'bundle-hashes.json';
const KEYS = ['node', 'host', 'helper'];
const HEX64 = /^[0-9a-f]{64}$/;

/** `{ v: 1, files }` as JSON; `files` holds lowercase SHA-256 hex for node, host and (macOS) helper. */
export function bundleHashesJson(files) {
  const out = {};
  for (const [key, hash] of Object.entries(files)) {
    if (!KEYS.includes(key)) throw new Error(`Unknown bundle file: ${key}`);
    if (typeof hash !== 'string' || !HEX64.test(hash)) throw new Error(`Bad SHA-256 for ${key}`);
    out[key] = hash;
  }
  return `${JSON.stringify({ v: 1, files: out }, null, 2)}\n`;
}
