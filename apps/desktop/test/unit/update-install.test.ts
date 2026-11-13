// UPD-4: the Mac in-app install (download the zip → re-check → unpack with ditto → verify the bundle
// → detached watchdog swaps, relaunches and rolls back). Everything runs in temp folders with fake
// bundles; codesign, ditto, xattr/find are stubbed (the one darwin-only case runs the real ditto on a
// fake bundle). No packaged app is launched: the watchdog's "launcher" is a fake script.
import { execFileSync, spawn } from 'node:child_process';
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createSha256, encodeHex } from '@4thtech-io/crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bundleFilePaths } from '../../src/main/bundle-check.js';
import type { UpdateAsset } from '../../src/main/updater/manifest.js';
import {
  INSTALL_COPY,
  InstallRefusal,
  type InstallRefusalCode,
} from '../../src/main/updater/install-refusal.js';
import { downloadZip, installUpdate, ZIP_FILE } from '../../src/main/updater/install.js';
import {
  DITTO,
  checkZipEntries,
  inspectTree,
  plistString,
  recheckZip,
  unpackZip,
  verifyStagedApp,
  type RunProgram,
} from '../../src/main/updater/stage.js';
import {
  HEALTH_TIMEOUT_MS,
  WATCHDOG_SOURCE,
  appBundleOf,
  preflightSwap,
  watchdogArgs,
} from '../../src/main/updater/swap-mac.js';
import {
  HEALTH_FILE,
  STARTING_FILE,
  readHealth,
  writeHealth,
  writeStarting,
} from '../../src/main/updater/health.js';
import { FAILED_FILE, loadFailedVersion } from '../../src/main/updater/state.js';

const sha = (b: Uint8Array | string): string =>
  encodeHex(
    createSha256()
      .update(typeof b === 'string' ? new TextEncoder().encode(b) : b)
      .digest(),
  );
const ZIP_URL =
  'https://github.com/4thtech/agentlink/releases/download/v0.5.3/AgentLink-0.5.3-mac-arm64.zip';
const NODE_TEAM = 'HX7739G8FX';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'upd4-test-'));
});
afterEach(async () => {
  await chmod(root, 0o700).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

const codeOf = async (p: Promise<unknown>): Promise<InstallRefusalCode | 'ok'> => {
  try {
    await p;
    return 'ok';
  } catch (error) {
    if (error instanceof InstallRefusal) return error.code;
    throw error;
  }
};

function plist(version: string, id = 'io.4thtech.agentlink'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>AgentLink</string>
  <key>CFBundleIdentifier</key>
  <string>${id}</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${version}</string>
  <key>CFBundleURLTypes</key>
  <array><dict><key>CFBundleURLName</key><string>AgentLink invite</string></dict></array>
  <key>ElectronAsarIntegrity</key>
  <dict><key>Resources/app.asar</key><dict><key>hash</key><string>${'a'.repeat(64)}</string></dict></dict>
</dict>
</plist>
`;
}

/** A fake AgentLink.app under `dir` (with an Electron-style relative framework symlink). */
async function fakeApp(dir: string, version: string, id?: string): Promise<string> {
  const app = join(dir, 'AgentLink.app');
  const contents = join(app, 'Contents');
  const resources = join(contents, 'Resources');
  await mkdir(join(contents, 'MacOS'), { recursive: true });
  await writeFile(join(contents, 'Info.plist'), plist(version, id));
  await writeFile(join(contents, 'MacOS', 'AgentLink'), `#!/bin/sh\n# ${version}\n`, {
    mode: 0o755,
  });
  await writeFile(join(app, 'version.txt'), version);
  const paths = bundleFilePaths(resources, 'darwin');
  for (const key of ['node', 'host', 'helper'] as const) {
    const p = paths[key]!;
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, `${key} ${version}`, { mode: 0o755 });
  }
  await writeFile(join(resources, 'app.asar'), 'asar');
  const fw = join(contents, 'Frameworks', 'Electron Framework.framework');
  await mkdir(join(fw, 'Versions', 'A'), { recursive: true });
  await writeFile(join(fw, 'Versions', 'A', 'Electron Framework'), 'fw');
  await symlink('A', join(fw, 'Versions', 'Current'));
  await symlink('Versions/Current/Electron Framework', join(fw, 'Electron Framework'));
  return app;
}

/** The record the build puts into app.asar, for a fake app. */
async function recordFor(app: string): Promise<string> {
  const paths = bundleFilePaths(join(app, 'Contents', 'Resources'), 'darwin');
  const files: Record<string, string> = {};
  for (const key of ['node', 'host', 'helper'] as const)
    files[key] = sha(await readFile(paths[key]!));
  return JSON.stringify({ v: 1, files });
}

interface FakeTools {
  run: RunProgram;
  calls: { cmd: string; args: readonly string[] }[];
}

/** Stubbed codesign / ditto / find: ditto copies `source` (a folder holding the archive's top). */
function fakeTools(opts: {
  source?: string;
  codesignOk?: boolean;
  helperId?: string;
  nodeTeam?: string;
  quarantined?: boolean;
  dittoFails?: boolean;
  entries?: string[];
}): FakeTools {
  const calls: { cmd: string; args: readonly string[] }[] = [];
  const run: RunProgram = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === DITTO) {
      if (opts.dittoFails === true || opts.source === undefined)
        return { code: 1, stdout: '', stderr: '' };
      const dest = args[args.length - 1]!;
      for (const name of await readdir(opts.source))
        await cp(join(opts.source, name), join(dest, name), {
          recursive: true,
          verbatimSymlinks: true,
        });
      return { code: 0, stdout: '', stderr: '' };
    }
    if (cmd === '/usr/bin/zipinfo')
      return opts.dittoFails === true
        ? { code: 9, stdout: '', stderr: '' }
        : {
            code: 0,
            stdout: (opts.entries ?? ['AgentLink.app/', 'AgentLink.app/Contents/Info.plist']).join(
              '\n',
            ),
            stderr: '',
          };
    if (cmd === '/usr/bin/codesign' && args[0] === '--verify')
      return { code: opts.codesignOk === false ? 1 : 0, stdout: '', stderr: '' };
    if (cmd === '/usr/bin/codesign' && args[0] === '-dvv') {
      const target = args[1]!;
      if (target.endsWith('agentlink-presence') || target.endsWith('Helpers/AgentLink.app'))
        return {
          code: 0,
          stdout: '',
          stderr: `Identifier=${opts.helperId ?? 'io.4thtech.agentlink.presence'}\nTeamIdentifier=not set\n`,
        };
      return {
        code: 0,
        stdout: '',
        stderr: `Identifier=node\nAuthority=Developer ID Application: Node.js Foundation (${opts.nodeTeam ?? NODE_TEAM})\nTeamIdentifier=${opts.nodeTeam ?? NODE_TEAM}\n`,
      };
    }
    if (cmd === '/usr/bin/find')
      return { code: 0, stdout: opts.quarantined === true ? `${args[0]}\n` : '', stderr: '' };
    return { code: 127, stdout: '', stderr: '' };
  };
  return { run, calls };
}

function zipAsset(bytes: Uint8Array): UpdateAsset {
  return {
    platform: 'darwin',
    arch: 'arm64',
    kind: 'zip',
    url: ZIP_URL,
    sha256: sha(bytes),
    size: bytes.length,
  };
}

const fetchBytes =
  (bytes: Uint8Array, seen?: string[]) =>
  async (url: string): Promise<Response> => {
    seen?.push(url);
    return new Response(bytes, {
      status: 200,
      headers: { 'content-length': String(bytes.length) },
    });
  };

// --- download ---------------------------------------------------------------------------------

describe('download of the zip (UPD-4 §1)', () => {
  it('streams into a private folder under updates/, with progress, and adds no quarantine', async () => {
    const bytes = new Uint8Array(200_000).fill(7);
    const progress: [number, number][] = [];
    const updatesDir = join(root, 'updates');
    const got = await downloadZip(zipAsset(bytes), {
      fetch: fetchBytes(bytes),
      updatesDir,
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect(dirname(got.dir)).toBe(updatesDir);
    expect(got.zipPath).toBe(join(got.dir, ZIP_FILE));
    expect((await stat(got.dir)).mode & 0o777).toBe(0o700);
    expect((await stat(got.zipPath)).mode & 0o777).toBe(0o600);
    expect(sha(await readFile(got.zipPath))).toBe(sha(bytes));
    expect(progress.at(-1)).toEqual([bytes.length, bytes.length]);
    expect(progress.every(([d, t]) => d <= t && t === bytes.length)).toBe(true);
  });

  it('refuses a body larger than the signed size, and a wrong hash; removes the folder', async () => {
    const bytes = new Uint8Array(1000).fill(1);
    const updatesDir = join(root, 'updates');
    const small = { ...zipAsset(bytes), size: 10 };
    expect(await codeOf(downloadZip(small, { fetch: fetchBytes(bytes), updatesDir }))).toBe(
      'size_mismatch',
    );
    const wrong = { ...zipAsset(bytes), sha256: 'cd'.repeat(32) };
    expect(await codeOf(downloadZip(wrong, { fetch: fetchBytes(bytes), updatesDir }))).toBe(
      'hash_mismatch',
    );
    expect(await readdir(updatesDir)).toEqual([]);
  });

  it('refuses an asset that is not a zip', async () => {
    const bytes = new Uint8Array(4);
    const dmg = { ...zipAsset(bytes), kind: 'dmg' as const };
    expect(
      await codeOf(downloadZip(dmg, { fetch: fetchBytes(bytes), updatesDir: join(root, 'u') })),
    ).toBe('not_zip');
  });
});

// --- re-check and unpack ---------------------------------------------------------------------

describe('re-check before unpacking and the unpacked tree (UPD-4 §2)', () => {
  it('re-hashes the zip right before unpacking: a changed file is refused', async () => {
    const bytes = new Uint8Array(64).fill(3);
    const zip = join(root, 'a.zip');
    await writeFile(zip, bytes);
    await expect(recheckZip(zip, zipAsset(bytes))).resolves.toBeUndefined();
    await writeFile(zip, new Uint8Array(64).fill(4));
    expect(await codeOf(recheckZip(zip, zipAsset(bytes)))).toBe('hash_mismatch');
    await writeFile(zip, new Uint8Array(65).fill(3));
    expect(await codeOf(recheckZip(zip, zipAsset(bytes)))).toBe('size_mismatch');
  });

  it('runs /usr/bin/ditto -x -k with fixed arguments and returns the one AgentLink.app', async () => {
    const src = join(root, 'src');
    await fakeApp(src, '0.5.3');
    const dest = join(root, 'unpacked');
    const tools = fakeTools({ source: src });
    const app = await unpackZip(join(root, 'a.zip'), dest, tools.run);
    expect(tools.calls[0]).toEqual({ cmd: '/usr/bin/zipinfo', args: ['-1', join(root, 'a.zip')] });
    expect(tools.calls[1]).toEqual({
      cmd: '/usr/bin/ditto',
      args: ['-x', '-k', join(root, 'a.zip'), dest],
    });
    expect(app).toBe(join(dest, 'AgentLink.app'));
  });

  it('checks every entry name before unpacking: no absolute, .. or foreign top-level entry', async () => {
    const zip = join(root, 'a.zip');
    for (const bad of [
      '../evil',
      '/etc/passwd',
      'AgentLink.app/../../evil',
      'AgentLink.app/Contents/./x',
      'Other.app/x',
      'AgentLink.app\\..\\x',
    ]) {
      const tools = fakeTools({ source: join(root, 'none'), entries: ['AgentLink.app/', bad] });
      expect(await codeOf(unpackZip(zip, join(root, `d${Math.random()}`), tools.run))).toBe(
        'path_escape',
      );
      expect(tools.calls.some((c) => c.cmd === DITTO)).toBe(false);
    }
    const ok = fakeTools({
      entries: [
        'AgentLink.app/',
        '__MACOSX/AgentLink.app/._Info.plist',
        '__MACOSX/._AgentLink.app',
      ],
    });
    await expect(checkZipEntries(zip, ok.run)).resolves.toBeUndefined();
  });

  it('a failing ditto is unpack_failed', async () => {
    const tools = fakeTools({ dittoFails: true });
    expect(await codeOf(unpackZip(join(root, 'a.zip'), join(root, 'd'), tools.run))).toBe(
      'unpack_failed',
    );
  });

  it('refuses extra top-level entries, a wrong name and an empty archive', async () => {
    const src = join(root, 'src');
    await fakeApp(src, '0.5.3');
    await writeFile(join(src, 'extra.txt'), 'x');
    expect(await codeOf(inspectTree(src))).toBe('bad_archive');
    const other = join(root, 'other');
    await mkdir(join(other, 'Other.app'), { recursive: true });
    expect(await codeOf(inspectTree(other))).toBe('bad_archive');
    const empty = join(root, 'empty');
    await mkdir(empty);
    expect(await codeOf(inspectTree(empty))).toBe('bad_archive');
  });

  it('accepts relative symlinks inside the bundle; refuses one that escapes', async () => {
    const src = join(root, 'src');
    const app = await fakeApp(src, '0.5.3');
    expect(await inspectTree(src)).toBe(join(src, 'AgentLink.app'));
    await symlink('../../../../outside', join(app, 'Contents', 'Resources', 'escape'));
    expect(await codeOf(inspectTree(src))).toBe('path_escape');
  });

  it('refuses an absolute symlink out of the bundle and a dangling one', async () => {
    const a = join(root, 'a');
    const appA = await fakeApp(a, '0.5.3');
    await symlink('/etc', join(appA, 'Contents', 'etc'));
    expect(await codeOf(inspectTree(a))).toBe('path_escape');
    const b = join(root, 'b');
    const appB = await fakeApp(b, '0.5.3');
    await symlink('nowhere', join(appB, 'Contents', 'dangling'));
    expect(await codeOf(inspectTree(b))).toBe('path_escape');
  });

  it('refuses the app itself as a symlink, setuid files and world-writable entries', async () => {
    const real = join(root, 'real');
    await fakeApp(real, '0.5.3');
    const linked = join(root, 'linked');
    await mkdir(linked);
    await symlink(join(real, 'AgentLink.app'), join(linked, 'AgentLink.app'));
    expect(await codeOf(inspectTree(linked))).toBe('path_escape');

    const suid = join(root, 'suid');
    const appS = await fakeApp(suid, '0.5.3');
    await chmod(join(appS, 'Contents', 'MacOS', 'AgentLink'), 0o4755);
    expect(await codeOf(inspectTree(suid))).toBe('bad_archive');

    const ww = join(root, 'ww');
    const appW = await fakeApp(ww, '0.5.3');
    await chmod(join(appW, 'Contents', 'Info.plist'), 0o666);
    expect(await codeOf(inspectTree(ww))).toBe('bad_archive');
  });

  it.skipIf(process.platform !== 'darwin')(
    'darwin: the real ditto round trip keeps the framework symlinks and passes the tree check',
    async () => {
      const src = join(root, 'src');
      const app = await fakeApp(src, '0.5.3');
      const zip = join(root, 'real.zip');
      execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);
      const run: RunProgram = async (cmd, args) => {
        try {
          const stdout = execFileSync(cmd, [...args], { encoding: 'utf8' });
          return { code: 0, stdout, stderr: '' };
        } catch {
          return { code: 1, stdout: '', stderr: '' };
        }
      };
      const dest = join(root, 'out');
      const out = await unpackZip(zip, dest, run);
      expect(out).toBe(join(dest, 'AgentLink.app'));
    },
  );
});

// --- verify the unpacked app ----------------------------------------------------------------

describe('verify the unpacked app before the swap (UPD-4 §3)', () => {
  const ctx = async (
    app: string,
    tools: FakeTools,
    over: { record?: string | null; version?: string } = {},
  ) => ({
    version: over.version ?? '0.5.3',
    run: tools.run,
    installedNode: '/Applications/AgentLink.app/Contents/Resources/node/bin/node',
    readRecord: async () => (over.record !== undefined ? over.record : await recordFor(app)),
  });

  it('reads plist strings strictly (one top-level key, no duplicates)', () => {
    const xml = plist('0.5.3');
    expect(plistString(xml, 'CFBundleIdentifier')).toBe('io.4thtech.agentlink');
    expect(plistString(xml, 'CFBundleShortVersionString')).toBe('0.5.3');
    expect(plistString(xml, 'Missing')).toBeNull();
    const dup = xml.replace(
      '<key>CFBundleVersion</key>',
      '<key>CFBundleIdentifier</key>\n  <string>evil</string>\n  <key>CFBundleVersion</key>',
    );
    expect(plistString(dup, 'CFBundleIdentifier')).toBeNull();
  });

  it('accepts a good bundle and runs codesign with fixed arguments', async () => {
    const app = await fakeApp(join(root, 's'), '0.5.3');
    const tools = fakeTools({});
    await expect(verifyStagedApp(app, await ctx(app, tools))).resolves.toBeUndefined();
    expect(tools.calls).toContainEqual({
      cmd: '/usr/bin/codesign',
      args: ['--verify', '--deep', '--strict', app],
    });
    expect(tools.calls.some((c) => c.cmd === '/usr/bin/find')).toBe(true);
  });

  it('refuses a wrong bundle id and a version other than the manifest version', async () => {
    const bad = await fakeApp(join(root, 'id'), '0.5.3', 'com.example.evil');
    expect(await codeOf(verifyStagedApp(bad, await ctx(bad, fakeTools({}))))).toBe(
      'wrong_bundle_id',
    );
    const old = await fakeApp(join(root, 'v'), '0.5.2');
    expect(await codeOf(verifyStagedApp(old, await ctx(old, fakeTools({}))))).toBe('wrong_version');
  });

  it('refuses a failing codesign, a wrong helper id and a node without the upstream signature', async () => {
    const app = await fakeApp(join(root, 's'), '0.5.3');
    expect(
      await codeOf(verifyStagedApp(app, await ctx(app, fakeTools({ codesignOk: false })))),
    ).toBe('code_signature');
    expect(
      await codeOf(verifyStagedApp(app, await ctx(app, fakeTools({ helperId: 'x.y.z' })))),
    ).toBe('helper_identity');
    expect(
      await codeOf(verifyStagedApp(app, await ctx(app, fakeTools({ nodeTeam: 'not set' })))),
    ).toBe('node_signature');
  });

  it('refuses when the node team differs from the installed node', async () => {
    const app = await fakeApp(join(root, 's'), '0.5.3');
    const base = fakeTools({});
    const run: RunProgram = async (cmd, args) => {
      if (cmd === '/usr/bin/codesign' && args[0] === '-dvv' && args[1]!.startsWith(app))
        if (args[1]!.endsWith('/node'))
          return { code: 0, stdout: '', stderr: 'Identifier=node\nTeamIdentifier=ABCDE12345\n' };
      return base.run(cmd, args);
    };
    expect(await codeOf(verifyStagedApp(app, { ...(await ctx(app, base)), run }))).toBe(
      'node_signature',
    );
  });

  it('refuses a missing or mismatching bundle-hashes.json', async () => {
    const app = await fakeApp(join(root, 's'), '0.5.3');
    expect(
      await codeOf(verifyStagedApp(app, await ctx(app, fakeTools({}), { record: null }))),
    ).toBe('bundle_hashes');
    const record = await recordFor(app);
    await writeFile(
      bundleFilePaths(join(app, 'Contents', 'Resources'), 'darwin').node!,
      'tampered',
    );
    expect(await codeOf(verifyStagedApp(app, await ctx(app, fakeTools({}), { record })))).toBe(
      'bundle_hashes',
    );
  });

  it('refuses a bundle that carries com.apple.quarantine', async () => {
    const app = await fakeApp(join(root, 's'), '0.5.3');
    expect(
      await codeOf(verifyStagedApp(app, await ctx(app, fakeTools({ quarantined: true })))),
    ).toBe('quarantined');
  });
});

// --- swap preflight --------------------------------------------------------------------------

describe('swap preflight (UPD-4 §4–§5)', () => {
  it('derives the bundle from the executable path, only for AgentLink.app', () => {
    expect(appBundleOf('/Applications/AgentLink.app/Contents/MacOS/AgentLink')).toBe(
      '/Applications/AgentLink.app',
    );
    expect(appBundleOf('/usr/local/bin/node')).toBeNull();
    expect(appBundleOf('/Applications/Other.app/Contents/MacOS/AgentLink')).toBeNull();
  });

  it('accepts a writable folder on the same volume', async () => {
    const apps = join(root, 'Applications');
    const app = await fakeApp(apps, '0.5.2');
    const updates = join(root, 'support', 'updates');
    await mkdir(updates, { recursive: true });
    await expect(preflightSwap(app, updates)).resolves.toBeUndefined();
  });

  it.skipIf(process.getuid?.() === 0)(
    'a non-writable Applications folder (standard user) is refused cleanly: not_writable',
    async () => {
      const apps = join(root, 'Applications');
      const app = await fakeApp(apps, '0.5.2');
      const updates = join(root, 'updates');
      await mkdir(updates);
      await chmod(apps, 0o555);
      try {
        expect(await codeOf(preflightSwap(app, updates))).toBe('not_writable');
      } finally {
        await chmod(apps, 0o755);
      }
    },
  );

  it('refuses a location that is not an installed AgentLink.app', async () => {
    expect(await codeOf(preflightSwap(join(root, 'nope', 'AgentLink.app'), root))).toBe(
      'not_in_place',
    );
  });

  it('installUpdate refuses a non-writable target before downloading anything', async () => {
    const apps = join(root, 'Applications');
    const app = await fakeApp(apps, '0.5.2');
    const seen: string[] = [];
    const bytes = new Uint8Array(8);
    const outcome = await installUpdate({
      accepted: { version: '0.5.3', required: false, asset: zipAsset(bytes) },
      stateDir: join(root, 'state'),
      currentApp: app,
      pid: 1,
      fetch: fetchBytes(bytes, seen),
      run: fakeTools({}).run,
      readRecord: async () => null,
      spawnDetached: () => undefined,
      preflight: async () => {
        throw new InstallRefusal('not_writable');
      },
    });
    expect(outcome).toEqual({ kind: 'fallback', code: 'not_writable' });
    expect(seen).toEqual([]);
  });
});

// --- the whole in-process path ----------------------------------------------------------------

describe('installUpdate end to end, up to the watchdog (UPD-4)', () => {
  it('downloads, unpacks, verifies and starts the watchdog with fixed arguments', async () => {
    const apps = join(root, 'Applications');
    const current = await fakeApp(apps, '0.5.2');
    const src = join(root, 'src');
    const next = await fakeApp(src, '0.5.3');
    const bytes = new Uint8Array(32).fill(9);
    const spawned: { cmd: string; args: readonly string[] }[] = [];
    const outcome = await installUpdate({
      accepted: { version: '0.5.3', required: false, asset: zipAsset(bytes) },
      stateDir: join(root, 'state'),
      currentApp: current,
      pid: 4242,
      fetch: fetchBytes(bytes),
      run: fakeTools({ source: src }).run,
      readRecord: async () => recordFor(next),
      spawnDetached: (cmd, args) => spawned.push({ cmd, args }),
    });
    expect(outcome).toEqual({ kind: 'restarting', version: '0.5.3' });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.cmd).toBe(
      bundleFilePaths(join(current, 'Contents', 'Resources'), 'darwin').node,
    );
    expect(spawned[0]!.args.slice(0, 2)).toEqual(['-e', WATCHDOG_SOURCE]);
    const args = spawned[0]!.args.slice(3);
    expect(args[0]).toBe('4242');
    expect(args[1]).toBe(current);
    expect(args[4]).toBe('0.5.3');
    expect(args[5]).toBe('/usr/bin/open');
    expect(args[6]).toBe(String(HEALTH_TIMEOUT_MS));
    expect(HEALTH_TIMEOUT_MS).toBe(90_000);
  });

  it('every refusal is a fixed code with fixed words: no URL or path in what the person sees', async () => {
    const apps = join(root, 'Applications');
    const current = await fakeApp(apps, '0.5.2');
    const bytes = new Uint8Array(32).fill(9);
    const outcome = await installUpdate({
      accepted: {
        version: '0.5.3',
        required: false,
        asset: { ...zipAsset(bytes), sha256: 'ee'.repeat(32) },
      },
      stateDir: join(root, 'state'),
      currentApp: current,
      pid: 1,
      fetch: fetchBytes(bytes),
      run: fakeTools({}).run,
      readRecord: async () => null,
      spawnDetached: () => undefined,
    });
    expect(outcome).toEqual({ kind: 'fallback', code: 'hash_mismatch' });
    expect(await readdir(join(root, 'state', 'updates'))).toEqual([]);
    const err = new InstallRefusal('path_escape');
    expect(err.message).not.toMatch(/\/|https?:/);
    expect(INSTALL_COPY.failed).not.toMatch(/\/|https?:|manifest|signature|key/i);
  });
});

// --- health file -----------------------------------------------------------------------------

describe('health file (UPD-4 §4)', () => {
  it('is written by the new app after core ready and read back strictly', async () => {
    const dir = join(root, 'state');
    expect(await readHealth(dir)).toBeNull();
    await writeHealth(dir, '0.5.3', 123);
    expect(await readHealth(dir)).toEqual({ version: '0.5.3', pid: 123 });
    await writeFile(join(dir, HEALTH_FILE), '{"version":"0.5.3","pid":1,"x":1}');
    expect(await readHealth(dir)).toBeNull();
    await writeStarting(dir, '0.5.3', 77);
    expect(JSON.parse(await readFile(join(dir, STARTING_FILE), 'utf8'))).toEqual({
      version: '0.5.3',
      pid: 77,
    });
  });
});

// --- the detached watchdog, run for real against fake bundles ---------------------------------

describe('watchdog: swap, relaunch, health or rollback (UPD-4 §4)', () => {
  /** A fake `open`: records the app and, when its version.txt equals HEALTHY, writes health. */
  async function fakeLauncher(dir: string): Promise<string> {
    const p = join(dir, 'fake-open.sh');
    await writeFile(
      p,
      `#!/bin/sh
app="$2"
v=$(cat "$app/version.txt")
echo "$v" >> "$FAKE_LOG"
if [ "$v" = "$HEALTHY" ]; then
  printf '{"version":"%s","pid":%s}' "$v" "$$" > "$FAKE_STATE/${HEALTH_FILE}"
fi
`,
      { mode: 0o755 },
    );
    return p;
  }

  async function deadPid(): Promise<number> {
    const child = spawn(process.execPath, ['-e', '']);
    await new Promise((r) => child.on('exit', r));
    return child.pid!;
  }

  async function setup(): Promise<{
    current: string;
    staging: string;
    state: string;
    launcher: string;
    log: string;
  }> {
    const apps = join(root, 'Applications');
    const current = await fakeApp(apps, '0.5.2');
    const state = join(root, 'state');
    const staging = join(state, 'updates', 'abc123');
    await fakeApp(join(staging, 'unpacked'), '0.5.3');
    const tools = join(root, 'tools');
    await mkdir(tools);
    return {
      current,
      staging,
      state,
      launcher: await fakeLauncher(tools),
      log: join(tools, 'log'),
    };
  }

  function runWatchdog(
    args: readonly string[],
    env: Record<string, string>,
  ): Promise<number | null> {
    const child = spawn(process.execPath, ['-e', WATCHDOG_SOURCE, '--', ...args], {
      env: { ...process.env, ...env },
      stdio: 'ignore',
    });
    return new Promise((r) => child.on('exit', (code) => r(code)));
  }

  it('success: swaps the bundles, launches the new one, removes the old copy', async () => {
    const s = await setup();
    const args = watchdogArgs({
      pid: await deadPid(),
      currentApp: s.current,
      stagingDir: s.staging,
      stateDir: s.state,
      version: '0.5.3',
      launcher: s.launcher,
      timeoutMs: 5000,
    });
    const code = await runWatchdog(args, {
      FAKE_LOG: s.log,
      FAKE_STATE: s.state,
      HEALTHY: '0.5.3',
    });
    expect(code).toBe(0);
    expect(await readFile(join(s.current, 'version.txt'), 'utf8')).toBe('0.5.3');
    expect((await readFile(s.log, 'utf8')).trim()).toBe('0.5.3');
    await expect(stat(s.staging)).rejects.toThrow();
    expect(await loadFailedVersion(s.state)).toBeNull();
  });

  it('health timeout: restores the old bundle, relaunches it and records failedVersion', async () => {
    const s = await setup();
    const args = watchdogArgs({
      pid: await deadPid(),
      currentApp: s.current,
      stagingDir: s.staging,
      stateDir: s.state,
      version: '0.5.3',
      launcher: s.launcher,
      timeoutMs: 1500,
    });
    const code = await runWatchdog(args, {
      FAKE_LOG: s.log,
      FAKE_STATE: s.state,
      HEALTHY: 'never',
    });
    expect(code).toBe(2);
    expect(await readFile(join(s.current, 'version.txt'), 'utf8')).toBe('0.5.2');
    expect((await readFile(s.log, 'utf8')).trim().split('\n')).toEqual(['0.5.3', '0.5.2']);
    expect(await loadFailedVersion(s.state)).toBe('0.5.3');
    expect((await stat(join(s.state, FAILED_FILE))).mode & 0o777).toBe(0o600);
  });

  it('refuses bad arguments without touching anything', async () => {
    const s = await setup();
    const code = await runWatchdog(
      ['1', join(root, 'Elsewhere', 'Evil.app'), s.staging, s.state, '0.5.3', s.launcher, '1000'],
      { FAKE_LOG: s.log, FAKE_STATE: s.state, HEALTHY: '0.5.3' },
    );
    expect(code).toBe(64);
    expect(await readFile(join(s.current, 'version.txt'), 'utf8')).toBe('0.5.2');
    await expect(stat(s.log)).rejects.toThrow();
  });
});
