import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// REL-MANIFEST-DL: SHA256SUMS-desktop-app.txt lists 8 files (Mac zips and DMGs, the stable-name Mac
// DMGs, the Windows setup and its stable-name copy). Every job that runs `sha256sum --check --strict`
// on it must download all of them (no --ignore-missing), or the check fails on the missing ones.

const root = resolve(import.meta.dirname, '../..');
const listed = (v) =>
  [
    `AgentLink-${v}-mac-arm64.zip`,
    `AgentLink-${v}-mac-x64.zip`,
    `AgentLink-${v}-mac-arm64.dmg`,
    `AgentLink-${v}-mac-x64.dmg`,
    'AgentLink-mac-arm64.dmg',
    'AgentLink-mac-x64.dmg',
    `AgentLink-${v}-win-x64-setup.exe`,
    'AgentLink-win-x64-setup.exe',
  ].sort();

/** Every `gh release download` command (continuations joined) that also fetches the sums file. */
function sumsDownloads(file) {
  const text = readFileSync(join(root, file), 'utf8').replace(/\\\n\s*/g, ' ');
  return text
    .split('\n')
    .filter((l) => /gh release download/.test(l) && /--pattern "?SHA256SUMS-desktop-app\.txt/.test(l));
}

function patterns(cmd) {
  return [...cmd.matchAll(/--pattern\s+("([^"]*)"|(\S+))/g)]
    .map((m) => (m[2] ?? m[3]).replaceAll('$VERSION', '0.0.0'))
    .filter((p) => p !== 'SHA256SUMS-desktop-app.txt')
    .sort();
}

describe('downloads cover every file in SHA256SUMS-desktop-app.txt', () => {
  for (const [file, minimum] of [
    ['.github/workflows/release.yml', 2],
    ['.github/workflows/desktop-update-renew.yml', 1],
  ]) {
    it(`${file} downloads all 8 listed files`, () => {
      const cmds = sumsDownloads(file);
      expect(cmds.length).toBeGreaterThanOrEqual(minimum);
      for (const cmd of cmds) expect(patterns(cmd)).toEqual(listed('0.0.0'));
    });

    it(`${file} never uses --ignore-missing`, () => {
      expect(readFileSync(join(root, file), 'utf8')).not.toMatch(/--ignore-missing/);
    });
  }
});
