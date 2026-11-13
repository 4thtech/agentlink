// UPD-4: from the verified zip to an unpacked AgentLink.app that is fit to swap in (A-autoupdate §2.2).
//
// 1. The zip is hashed again right before unpacking (it sat on disk since the download).
// 2. `/usr/bin/ditto -x -k <zip> <dest>`: absolute program, fixed arguments, no shell. Not a JS unzip:
//    Electron's frameworks need their symlinks and _CodeSignature exactly as built.
// 3. The tree: exactly one top-level `AgentLink.app` (a real folder), every symlink resolves (realpath)
//    inside it, only files, folders and symlinks, nothing setuid/setgid or world-writable, everything
//    owned by this user.
// 4. The app: CFBundleIdentifier, CFBundleExecutable, CFBundleShortVersionString/CFBundleVersion =
//    the manifest version, ElectronAsarIntegrity present, no `com.apple.quarantine` anywhere,
//    `codesign --verify --deep --strict`, the presence helper's identifier, the bundled `node` still
//    signed by the same upstream team as the installed one, and `bundle-hashes.json` (in the new
//    app.asar) matching its node, host and helper.
//
// Honest limit (for reviewers): origin is proven by the manifest signature and the zip hash only. These
// checks catch packaging mistakes and wrong-asset bugs; an ad-hoc signature proves consistency, not
// who built it. Nothing here logs or returns a path, a URL or tool output.
import { execFile } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { bundleFilePaths, verifyBundle } from '../bundle-check.js';
import { hashFile } from './download.js';
import { InstallRefusal } from './install-refusal.js';
import type { UpdateAsset } from './manifest.js';

export const DITTO = '/usr/bin/ditto';
export const CODESIGN = '/usr/bin/codesign';
export const FIND = '/usr/bin/find';
export const ZIPINFO = '/usr/bin/zipinfo';
export const APP_DIR = 'AgentLink.app';
export const BUNDLE_ID = 'io.4thtech.agentlink';
export const EXECUTABLE = 'AgentLink';
export const HELPER_ID = 'io.4thtech.agentlink.presence';
const MAX_PLIST_BYTES = 256 * 1024;
const MAX_ENTRIES = 200_000;
const RUN_TIMEOUT_MS = 5 * 60 * 1000;
const TEAM_ID = /^[A-Z0-9]{10}$/;

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a fixed program (absolute path) with fixed arguments, no shell. Injected in tests. */
export type RunProgram = (command: string, args: readonly string[]) => Promise<RunResult>;

/** The real runner: execFile, no shell, a timeout and an output cap; never throws. */
export const runProgram: RunProgram = (command, args) =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        timeout: RUN_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
      },
      (error, stdout, stderr) => {
        const code =
          error === null ? 0 : typeof error.code === 'number' && error.code !== 0 ? error.code : 1;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

/** The zip again, right before unpacking: exact size and SHA-256 of the signed manifest. */
export async function recheckZip(zipPath: string, asset: UpdateAsset): Promise<void> {
  let got: { sha256: string; size: number };
  try {
    got = await hashFile(zipPath);
  } catch {
    throw new InstallRefusal('download_failed');
  }
  if (got.size !== asset.size) throw new InstallRefusal('size_mismatch');
  if (got.sha256 !== asset.sha256) throw new InstallRefusal('hash_mismatch');
}

/** Unpacks into `dest` (a new 0700 folder) and returns the checked `dest/AgentLink.app`. */
/**
 * The archive's entry names (`/usr/bin/zipinfo -1`), checked before anything is written: each is
 * relative, has no `..`, `.` or empty segment and no backslash, and lies under `AgentLink.app/` (or
 * ditto's `__MACOSX/` side entries for the same app). A name outside is `path_escape`.
 */
export async function checkZipEntries(zipPath: string, run: RunProgram): Promise<void> {
  const listed = await run(ZIPINFO, ['-1', zipPath]);
  if (listed.code !== 0) throw new InstallRefusal('unpack_failed');
  const names = listed.stdout.split('\n').filter((line) => line !== '');
  if (names.length === 0 || names.length > MAX_ENTRIES) throw new InstallRefusal('bad_archive');
  for (const name of names) {
    if (name.startsWith('/') || name.includes('\\')) throw new InstallRefusal('path_escape');
    const parts = name.replace(/\/$/, '').split('/');
    if (parts.some((part) => part === '' || part === '.' || part === '..'))
      throw new InstallRefusal('path_escape');
    if (parts.length === 1 && parts[0] === '__MACOSX') continue;
    const top = parts[0] === '__MACOSX' ? parts[1] : parts[0];
    if (top !== APP_DIR && top !== `._${APP_DIR}`) throw new InstallRefusal('path_escape');
    if (parts[0] !== '__MACOSX' && top !== APP_DIR) throw new InstallRefusal('path_escape');
  }
}

export async function unpackZip(zipPath: string, dest: string, run: RunProgram): Promise<string> {
  await checkZipEntries(zipPath, run);
  try {
    await mkdir(dest, { mode: 0o700 });
  } catch {
    throw new InstallRefusal('unpack_failed');
  }
  const result = await run(DITTO, ['-x', '-k', zipPath, dest]);
  if (result.code !== 0) throw new InstallRefusal('unpack_failed');
  return inspectTree(dest);
}

const inside = (root: string, p: string): boolean => p === root || p.startsWith(root + sep);

/**
 * Checks the unpacked tree under `dest` (see the header) and returns `dest/AgentLink.app`. A symlink
 * that leaves the app, dangles or is the app itself is `path_escape`; anything else unexpected is
 * `bad_archive`.
 */
export async function inspectTree(dest: string): Promise<string> {
  let top: string[];
  try {
    top = await readdir(dest);
  } catch {
    throw new InstallRefusal('bad_archive');
  }
  if (top.length !== 1 || top[0] !== APP_DIR) throw new InstallRefusal('bad_archive');
  const app = join(dest, APP_DIR);
  const appStat = await lstat(app);
  if (appStat.isSymbolicLink()) throw new InstallRefusal('path_escape');
  if (!appStat.isDirectory()) throw new InstallRefusal('bad_archive');
  const root = await realpath(app);
  const uid = process.getuid?.();
  let count = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const name of await readdir(dir)) {
      count += 1;
      if (count > MAX_ENTRIES) throw new InstallRefusal('bad_archive');
      const p = join(dir, name);
      const st = await lstat(p);
      if (st.isSymbolicLink()) {
        let target: string;
        try {
          target = await realpath(p);
        } catch {
          throw new InstallRefusal('path_escape');
        }
        if (!inside(root, target)) throw new InstallRefusal('path_escape');
        continue;
      }
      if (!st.isDirectory() && !st.isFile()) throw new InstallRefusal('bad_archive');
      if ((st.mode & 0o6000) !== 0 || (st.mode & 0o002) !== 0)
        throw new InstallRefusal('bad_archive');
      if (uid !== undefined && st.uid !== uid) throw new InstallRefusal('bad_archive');
      if (st.isDirectory()) await walk(p);
    }
  };
  if ((appStat.mode & 0o6002) !== 0) throw new InstallRefusal('bad_archive');
  if (uid !== undefined && appStat.uid !== uid) throw new InstallRefusal('bad_archive');
  await walk(app);
  return app;
}

const unescape = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The string value of `key` in an XML Info.plist, or null when the key is missing, appears more than
 * once anywhere in the file, or is not followed by a <string>. Strict on purpose: our own build
 * writes this file (build/lib/plist.mjs), and `codesign --verify` seals it.
 */
export function plistString(xml: string, key: string): string | null {
  const keyTag = `<key>${escapeRe(key)}</key>`;
  if ((xml.match(new RegExp(keyTag, 'g')) ?? []).length !== 1) return null;
  const m = new RegExp(`${keyTag}\\s*<string>([^<]*)</string>`).exec(xml);
  return m === null ? null : unescape(m[1]!);
}

/** The TeamIdentifier from `codesign -dvv` output, or null. */
function teamOf(result: RunResult): string | null {
  if (result.code !== 0) return null;
  const m = /^TeamIdentifier=(.+)$/m.exec(`${result.stdout}\n${result.stderr}`);
  return m !== null && TEAM_ID.test(m[1]!.trim()) ? m[1]!.trim() : null;
}

export interface StagedAppContext {
  /** The manifest version (already verified as strictly newer). */
  readonly version: string;
  readonly run: RunProgram;
  /** The bundled `node` of the installed copy (its upstream signature is the reference). */
  readonly installedNode: string;
  /** `bundle-hashes.json` from `<resources>/app.asar` (Electron reads ASAR paths), or null. */
  readonly readRecord: (resourcesPath: string) => Promise<string | null>;
}

/** Every check of §2.2 on the unpacked app; the first that fails is the refusal. */
export async function verifyStagedApp(app: string, ctx: StagedAppContext): Promise<void> {
  const contents = join(app, 'Contents');
  let xml: string;
  try {
    const plistPath = join(contents, 'Info.plist');
    const st = await lstat(plistPath);
    if (!st.isFile() || st.size > MAX_PLIST_BYTES) throw new Error('plist');
    xml = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(plistPath));
  } catch {
    throw new InstallRefusal('wrong_bundle_id');
  }
  if (plistString(xml, 'CFBundleIdentifier') !== BUNDLE_ID)
    throw new InstallRefusal('wrong_bundle_id');
  if (plistString(xml, 'CFBundleExecutable') !== EXECUTABLE)
    throw new InstallRefusal('wrong_bundle_id');
  if (
    plistString(xml, 'CFBundleShortVersionString') !== ctx.version ||
    plistString(xml, 'CFBundleVersion') !== ctx.version
  )
    throw new InstallRefusal('wrong_version');
  if ((xml.match(/<key>ElectronAsarIntegrity<\/key>/g) ?? []).length !== 1)
    throw new InstallRefusal('bundle_hashes');

  // No download mark anywhere in the bundle (we never add one; an archive could carry it).
  const marked = await ctx.run(FIND, [app, '-xattrname', 'com.apple.quarantine']);
  if (marked.code !== 0 || marked.stdout.trim() !== '') throw new InstallRefusal('quarantined');

  const verify = await ctx.run(CODESIGN, ['--verify', '--deep', '--strict', app]);
  if (verify.code !== 0) throw new InstallRefusal('code_signature');

  const helper = await ctx.run(CODESIGN, ['-dvv', join(contents, 'Helpers', APP_DIR)]);
  const helperId = /^Identifier=(.+)$/m.exec(`${helper.stdout}\n${helper.stderr}`)?.[1]?.trim();
  if (helper.code !== 0 || helperId !== HELPER_ID) throw new InstallRefusal('helper_identity');

  const resources = join(contents, 'Resources');
  const paths = bundleFilePaths(resources, 'darwin');
  const stagedTeam = teamOf(await ctx.run(CODESIGN, ['-dvv', paths.node!]));
  const installedTeam = teamOf(await ctx.run(CODESIGN, ['-dvv', ctx.installedNode]));
  if (stagedTeam === null || installedTeam === null || stagedTeam !== installedTeam)
    throw new InstallRefusal('node_signature');

  let record: string | null;
  try {
    record = await ctx.readRecord(resources);
  } catch {
    record = null;
  }
  if (record === null || (await verifyBundle(record, paths)) !== 'ok')
    throw new InstallRefusal('bundle_hashes');
}
