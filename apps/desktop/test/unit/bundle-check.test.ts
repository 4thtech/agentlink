// D15-07 (DESK051-C5): a startup tripwire for the files outside app.asar. The build records the
// SHA-256 of Resources/node, the core's desktop host and the presence helper in app.asar (covered by
// ASAR integrity); the shell compares them before it starts the core. Not a security boundary against
// a same-user process (it can replace the whole app), only a check that catches a changed file.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUNDLE_FILE_KEYS,
  bundleFilePaths,
  parseBundleHashes,
  sha256File,
  verifyBundle,
} from '../../src/main/bundle-check.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// SHA-256 of the ASCII bytes "abc".
const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('bundle tripwire', () => {
  it('knows where the three files are inside the installed app', () => {
    const mac = bundleFilePaths('/A/AgentLink.app/Contents/Resources', 'darwin');
    expect(mac.node).toBe('/A/AgentLink.app/Contents/Resources/node/bin/node');
    expect(mac.host).toBe(
      '/A/AgentLink.app/Contents/Resources/core/node_modules/@4thtech-io/agentlink/dist/desktop-host.js',
    );
    expect(mac.helper).toBe(
      '/A/AgentLink.app/Contents/Helpers/AgentLink.app/Contents/MacOS/agentlink-presence',
    );
    expect([...BUNDLE_FILE_KEYS]).toEqual(['node', 'host', 'helper']);
  });

  it('parses only { v: 1, files: { node|host|helper: hex } }', () => {
    const good = JSON.stringify({ v: 1, files: { node: ABC, host: ABC } });
    expect(parseBundleHashes(good)).toEqual({ node: ABC, host: ABC });
    expect(parseBundleHashes(JSON.stringify({ v: 1, files: { other: ABC } }))).toBeNull();
    expect(parseBundleHashes(JSON.stringify({ v: 1, files: { node: 'xyz' } }))).toBeNull();
    expect(parseBundleHashes(JSON.stringify({ v: 2, files: { node: ABC } }))).toBeNull();
    expect(parseBundleHashes('nope')).toBeNull();
  });

  it('hashes a file through @4thtech-io/crypto', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'al-bundle-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'f'), 'abc');
    expect(await sha256File(join(dir, 'f'))).toBe(ABC);
  });

  it('ok when every recorded file matches; changed on any difference or a missing file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'al-bundle-'));
    dirs.push(dir);
    const node = join(dir, 'node');
    const host = join(dir, 'host');
    writeFileSync(node, 'abc');
    writeFileSync(host, 'abc');
    const paths = { node, host, helper: join(dir, 'missing') };
    const manifest = JSON.stringify({ v: 1, files: { node: ABC, host: ABC } });
    expect(await verifyBundle(manifest, paths)).toBe('ok');
    writeFileSync(host, 'abd');
    expect(await verifyBundle(manifest, paths)).toBe('changed');
    const withHelper = JSON.stringify({ v: 1, files: { node: ABC, helper: ABC } });
    expect(await verifyBundle(withHelper, paths)).toBe('changed');
  });

  it('no record (a development run, or a build without one) → unchecked; a broken record → changed', async () => {
    const paths = { node: '/x', host: '/y', helper: null };
    expect(await verifyBundle(null, paths)).toBe('unchecked');
    expect(await verifyBundle('{"v":1,"files":{"node":"zz"}}', paths)).toBe('changed');
  });
});

// WIN-DESK-2 (R-WIN §6 item 3): Windows builds carry the record too; the helper is
// resources\native\agentlink-presence.exe.
describe('bundle tripwire on Windows', () => {
  it('knows where the three files are inside the installed Windows app', () => {
    const win = bundleFilePaths(join('C:', 'AgentLink', 'resources'), 'win32');
    expect(win.node).toBe(join('C:', 'AgentLink', 'resources', 'node', 'node.exe'));
    expect(win.helper).toBe(join('C:', 'AgentLink', 'resources', 'native', 'agentlink-presence.exe'));
  });

  it('a changed Windows helper is caught', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'al-bundle-win-'));
    dirs.push(dir);
    const paths = bundleFilePaths(join(dir, 'resources'), 'win32');
    for (const p of [paths.node, paths.host, paths.helper as string]) {
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, 'abc');
    }
    const record = JSON.stringify({ v: 1, files: { node: ABC, host: ABC, helper: ABC } });
    expect(await verifyBundle(record, paths)).toBe('ok');
    writeFileSync(paths.helper as string, 'abd');
    expect(await verifyBundle(record, paths)).toBe('changed');
  });
});
