// The agent directory under `~/.agentlink` (M1-9k; 06 §6, 07 §9.1). One folder per local agent:
//
//   ~/.agentlink/agents/<name>/config.json   { "v": 1, "name", "agentId", "keyStore", "label"?, "removing"? }
//   ~/.agentlink/agents/<name>/store.sqlite  the agent's shared SQLite store (07 §3.7; D-73 (3))
//   ~/.agentlink/agents/<name>/open.lock     the shared folder lock while the agent is open (06 §6)
//   ~/.agentlink/app.json                    { "v": 1, "current" }: the agent the app opens first
//
// U3-c (D-138; 07 §9.1): `label` is the owner's display text (06 §6 label rule), written only after
// the server verified an `agent.label` owner action (card U3-d); `removing: true` is written before
// anything of the agent is deleted (card U3-e). Neither is signed in the file: a same-user process
// that changes them can mislabel an agent or hide it as "Removal not finished", nothing more (G-1).
// Configs written by older versions (the four keys only) read exactly as before: no agent is lost or
// renamed. `app.json` is not signed either and is trusted for nothing but which agent opens first;
// a name in it that fails the rule or names no agent is ignored. The app host reaches all of this
// only through `agentDirectory` below (the node AgentDirectory seam).
//
// `init` (M1-9a) writes the config through `writeAgentConfig`; every other command and every
// `agentlink mcp` process reads it through `readAgentConfig`, so all of them open the same store
// file (06 §6). The config is not owner-signed: changing it can only make the agent fail to open
// (07 §9.1).
//
// Folder rules (IR-M1-9k-1 F02; the same as the keystore folder, 04 §2.8, and the realpath rule,
// 04 §4). On POSIX: `~/.agentlink`, `agents` and the agent folder are each a real directory (never a
// link) with mode 0700 owned by this user; the config and any store file (`store.sqlite`, `-wal`,
// `-shm`) are regular files (never a link, a FIFO or a folder) with mode 0600 owned by this user;
// the agent folder's realpath is exactly `<realpath(home)>/.agentlink/agents/<name>`. Anything else
// fails closed with fixed text that names the fix (`agentlink doctor`), never a path. Existing
// folders are never loosened or tightened here. On Windows the mode and owner checks do not apply
// (no POSIX modes); the link, type and containment checks do.
//
// Same-user processes can change all of this (G-1, D-67): these checks keep mistakes and other
// users out; they are not a boundary against the agent.
import { encodeHex, randomBytes } from '@4thtech-io/crypto';
import { constants, type Stats } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import {
  AGENT_OPEN_LOCK_FILE,
  assertAgentId,
  createOsKeychainAgent,
  discardNewOsKeychainAgent,
  peekAgentStore,
  type AgentDirectory,
  type AgentDirectoryEntry,
  type KeyStoreBackendKind,
} from '@4thtech-io/node';
import { createAgentFolder, discardNewAgentFolder } from './agent-create.js';
import { isAgentLabel, isAgentName } from './agent-name.js';
import { RuntimeError } from './errors.js';

/** The recorded per-agent config (07 §9.1). */
export interface AgentConfig {
  readonly v: 1;
  /** The local agent name (06 §6). Must equal the folder it is in. */
  readonly name: string;
  /** `0x` + 40 lowercase hex (04 §2.9). */
  readonly agentId: string;
  /** The recorded KeyStore backend; every start uses only this one (07 §9.1). */
  readonly keyStore: KeyStoreBackendKind;
  /** U3-c (07 §9.1): the owner's display text; absent: the name is shown. Never authorises. */
  readonly label?: string;
  /** U3-c (07 §9.1): the agent is being removed ("Removal not finished"); never opened as usable. */
  readonly removing?: true;
}

export const CONFIG_FILE = 'config.json';
export const STORE_FILE = 'store.sqlite';
/** The store and the files SQLite keeps beside it in WAL mode. */
const STORE_FILES = [STORE_FILE, `${STORE_FILE}-wal`, `${STORE_FILE}-shm`];
/** A config is a few hundred bytes; anything larger is refused unread. */
export const MAX_CONFIG_BYTES = 4_096;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const POSIX = process.platform !== 'win32';

export interface AgentPaths {
  readonly root: string;
  readonly agents: string;
  readonly dir: string;
  readonly config: string;
  readonly store: string;
}

/** Who must own the folder and files. Default: this process's user (POSIX). Tests pass another. */
export interface OwnerCheck {
  readonly uid?: number;
}

/** `~/.agentlink` and the agent's folder, config and store under it. `name` must already be valid. */
export function agentPaths(home: string, name: string): AgentPaths {
  if (!isAgentName(name)) throw new RuntimeError('agent_name_invalid');
  const root = join(home, '.agentlink');
  const agents = join(root, 'agents');
  const dir = join(agents, name);
  return { root, agents, dir, config: join(dir, CONFIG_FILE), store: join(dir, STORE_FILE) };
}

const codeOf = (error: unknown): unknown =>
  typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
const isMissing = (error: unknown): boolean => {
  const code = codeOf(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
};

const expectedUid = (options: OwnerCheck): number | undefined =>
  options.uid ?? (POSIX && typeof process.getuid === 'function' ? process.getuid() : undefined);

/** Mode and owner of an lstat result (POSIX only). */
function privateTo(info: Stats, uid: number | undefined): boolean {
  if (!POSIX) return true;
  if ((info.mode & 0o077) !== 0) return false;
  return uid === undefined || info.uid === uid;
}

/** lstat without throwing on a missing entry; any other failure is a fixed refusal. */
async function lstatOrMissing(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new RuntimeError('agent_path_invalid');
  }
}

/** A real, private directory; undefined when it does not exist. */
async function checkDir(path: string, uid: number | undefined): Promise<'ok' | undefined> {
  const info = await lstatOrMissing(path);
  if (info === undefined) return undefined;
  if (info.isSymbolicLink() || !info.isDirectory() || !privateTo(info, uid)) {
    throw new RuntimeError('agent_path_invalid');
  }
  return 'ok';
}

/** A regular, private file (never a link, FIFO, socket, device or folder). */
function checkFileInfo(info: Stats, uid: number | undefined): void {
  // nlink 1: no second name elsewhere can read or replace it (IR-M1-9k-1 F08).
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || !privateTo(info, uid)) {
    throw new RuntimeError('agent_path_invalid');
  }
}

/** The agent folder's realpath must be exactly where it is expected (04 §4). */
async function checkContained(home: string, name: string): Promise<string> {
  try {
    const homeReal = await realpath(home);
    const expected = join(homeReal, '.agentlink', 'agents', name);
    const dirReal = await realpath(join(home, '.agentlink', 'agents', name));
    if (dirReal !== expected) throw new RuntimeError('agent_path_invalid');
    return dirReal;
  } catch {
    throw new RuntimeError('agent_path_invalid');
  }
}

const REQUIRED_KEYS = ['agentId', 'keyStore', 'name', 'v'];
const OPTIONAL_KEYS: ReadonlySet<string> = new Set(['label', 'removing']);

/**
 * Strict parse: the four keys, each of its exact type and form, plus optionally `label` (the label
 * rule) and `removing` (exactly `true`); no other key.
 */
export function parseAgentConfig(text: string, expectedName: string): AgentConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RuntimeError('agent_config_invalid');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RuntimeError('agent_config_invalid');
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const required = keys.filter((key) => !OPTIONAL_KEYS.has(key));
  if (required.join(',') !== REQUIRED_KEYS.join(','))
    throw new RuntimeError('agent_config_invalid');
  if ('label' in record && !isAgentLabel(record['label'])) {
    throw new RuntimeError('agent_config_invalid');
  }
  if ('removing' in record && record['removing'] !== true) {
    throw new RuntimeError('agent_config_invalid');
  }
  if (record['v'] !== 1) throw new RuntimeError('agent_config_invalid');
  // 06 §6: a recorded name that does not match is refused with a fixed error, never shown.
  if (!isAgentName(record['name'])) throw new RuntimeError('agent_name_invalid');
  if (record['name'] !== expectedName) throw new RuntimeError('agent_config_invalid');
  try {
    assertAgentId(record['agentId']);
  } catch {
    throw new RuntimeError('agent_config_invalid');
  }
  const keyStore = record['keyStore'];
  if (keyStore !== 'keychain' && keyStore !== 'file') {
    throw new RuntimeError('agent_config_invalid');
  }
  return Object.freeze({
    v: 1,
    name: expectedName,
    agentId: record['agentId'],
    keyStore,
    ...(typeof record['label'] === 'string' ? { label: record['label'] } : {}),
    ...(record['removing'] === true ? { removing: true as const } : {}),
  });
}

/**
 * Reads and checks an agent's recorded config and the folder rules above. Returns undefined when the
 * agent does not exist (no folder or no config): the caller answers `needs_setup`, never by
 * creating one.
 */
export async function readAgentConfig(
  home: string,
  name: string,
  options: OwnerCheck = {},
): Promise<{ config: AgentConfig; paths: AgentPaths } | undefined> {
  const paths = agentPaths(home, name);
  const uid = expectedUid(options);
  for (const dir of [paths.root, paths.agents, paths.dir]) {
    if ((await checkDir(dir, uid)) === undefined) return undefined;
  }
  const dirReal = await checkContained(home, name);
  const configPath = join(dirReal, CONFIG_FILE);

  // lstat first, so a FIFO or a link is refused without being opened.
  const before = await lstatOrMissing(configPath);
  if (before === undefined) return undefined;
  checkFileInfo(before, uid);
  for (const file of STORE_FILES) {
    const info = await lstatOrMissing(join(dirReal, file));
    if (info !== undefined) checkFileInfo(info, uid);
  }

  let handle;
  try {
    handle = await open(
      configPath,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new RuntimeError('agent_path_invalid');
  }
  try {
    const info = await handle.stat();
    // The file opened is the one checked (not swapped in between).
    if (!info.isFile() || info.ino !== before.ino || info.dev !== before.dev) {
      throw new RuntimeError('agent_path_invalid');
    }
    if (info.size > MAX_CONFIG_BYTES) throw new RuntimeError('agent_config_invalid');
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_CONFIG_BYTES) throw new RuntimeError('agent_config_invalid');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } catch {
      throw new RuntimeError('agent_config_invalid');
    }
    const config = parseAgentConfig(text, name);
    return {
      config,
      paths: { ...paths, dir: dirReal, config: configPath, store: join(dirReal, STORE_FILE) },
    };
  } finally {
    await handle.close();
  }
}

/** Creates a missing folder with mode 0700 (explicitly, not through the umask), then checks it. */
async function ensurePrivateDir(path: string, uid: number | undefined): Promise<void> {
  if ((await checkDir(path, uid)) === 'ok') return;
  try {
    await mkdir(path, { mode: DIR_MODE });
    if (POSIX) await chmod(path, DIR_MODE);
  } catch (error) {
    if (codeOf(error) !== 'EEXIST') throw new RuntimeError('agent_path_invalid');
  }
  if ((await checkDir(path, uid)) !== 'ok') throw new RuntimeError('agent_path_invalid');
}

export interface WriteAgentConfigOptions extends OwnerCheck {
  /** Replace an existing config. Default false: an existing agent is never replaced (IR-M1-9k-1 F03). */
  readonly replace?: boolean;
}

/**
 * Writes an agent's config for `init` (M1-9a): missing folders with mode 0700, the file with mode
 * 0600, written to a fresh temporary name and then linked into place, so an existing config is never
 * replaced unless `replace` is set (`agent_exists`). Refuses an invalid name or agent ID and a
 * folder that breaks the rules above (never loosened or tightened).
 */
export async function writeAgentConfig(
  home: string,
  config: AgentConfig,
  options: WriteAgentConfigOptions = {},
): Promise<AgentPaths> {
  const paths = agentPaths(home, config.name);
  assertAgentId(config.agentId);
  if (config.keyStore !== 'keychain' && config.keyStore !== 'file') {
    throw new RuntimeError('agent_config_invalid');
  }
  if (config.label !== undefined && !isAgentLabel(config.label)) {
    throw new RuntimeError('agent_label_invalid');
  }
  if (config.removing !== undefined && config.removing !== true) {
    throw new RuntimeError('agent_config_invalid');
  }
  const uid = expectedUid(options);
  for (const dir of [paths.root, paths.agents, paths.dir]) await ensurePrivateDir(dir, uid);
  const dirReal = await checkContained(home, config.name);
  const target = join(dirReal, CONFIG_FILE);

  const text = `${JSON.stringify({
    v: 1,
    name: config.name,
    agentId: config.agentId,
    keyStore: config.keyStore,
    ...(config.label === undefined ? {} : { label: config.label }),
    ...(config.removing === true ? { removing: true } : {}),
  })}\n`;
  const temp = join(dirReal, `.${CONFIG_FILE}.${encodeHex(randomBytes(8))}.tmp`);
  const handle = await open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    FILE_MODE,
  );
  try {
    if (POSIX) await handle.chmod(FILE_MODE);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (options.replace === true) {
      await rename(temp, target);
      return { ...paths, dir: dirReal, config: target, store: join(dirReal, STORE_FILE) };
    }
    try {
      await link(temp, target);
    } catch (error) {
      if (codeOf(error) === 'EEXIST') throw new RuntimeError('agent_exists');
      throw new RuntimeError('agent_path_invalid');
    }
  } finally {
    await unlink(temp).catch(() => undefined);
  }
  return { ...paths, dir: dirReal, config: target, store: join(dirReal, STORE_FILE) };
}

/**
 * The local agents that have a folder with a valid name, sorted. Entries whose name fails the
 * pattern are skipped, never listed or shown (06 §6). `~/.agentlink` and `agents` must follow the
 * folder rules; each agent folder is checked when it is opened.
 */
export async function listAgentNames(home: string, options: OwnerCheck = {}): Promise<string[]> {
  const uid = expectedUid(options);
  const root = join(home, '.agentlink');
  const agents = join(root, 'agents');
  if ((await checkDir(root, uid)) === undefined) return [];
  if ((await checkDir(agents, uid)) === undefined) return [];
  let entries;
  try {
    entries = await readdir(agents, { withFileTypes: true });
  } catch {
    throw new RuntimeError('agent_path_invalid');
  }
  return entries
    .filter((entry) => entry.isDirectory() && isAgentName(entry.name))
    .map((entry) => entry.name)
    .sort();
}

// --- U3-c: the app host's AgentDirectory (D-138; 08 §1; 07 §9.1) ---------------------------------

/** `~/.agentlink/app.json`: the agent the app opens first (07 §9.1). */
export const APP_FILE = 'app.json';
/** A valid app.json is about 50 bytes; anything larger is ignored unread. */
const MAX_APP_FILE_BYTES = 256;
/** The owner's revoked list (04 §2.5 "Removing an agent"; card U3-e writes and verifies it). */
const REVOKED_DIR = 'revoked';

/**
 * Writes `label` into the agent's config.json (card U3-d calls this only after the server verified an
 * `agent.label` owner action). Every other field stays; the folder name never changes.
 */
export async function writeAgentLabel(
  home: string,
  name: string,
  label: string,
  options: OwnerCheck = {},
): Promise<void> {
  if (!isAgentLabel(label)) throw new RuntimeError('agent_label_invalid');
  const found = await readAgentConfig(home, name, options);
  if (found === undefined) throw new RuntimeError('agent_config_invalid');
  await writeAgentConfig(home, { ...found.config, label }, { ...options, replace: true });
}

/** Writes `removing: true` into the agent's config.json (card U3-e, before anything is deleted). */
export async function markAgentRemoving(
  home: string,
  name: string,
  options: OwnerCheck = {},
): Promise<void> {
  const found = await readAgentConfig(home, name, options);
  if (found === undefined) throw new RuntimeError('agent_config_invalid');
  await writeAgentConfig(home, { ...found.config, removing: true }, { ...options, replace: true });
}

/**
 * Deletes an agent folder (card U3-e, its last step): after the folder rules (realpath, no links,
 * regular private files), only the files AgentLink puts there are unlinked (store and WAL files, the
 * locks, the free-credits marker, the config last), then the folder itself with a plain rmdir. There
 * is no recursive delete: a folder that still holds anything else is refused (`agent_path_invalid`)
 * and left as it is.
 */
export async function removeAgentFolder(
  home: string,
  name: string,
  options: OwnerCheck = {},
): Promise<void> {
  const found = await readAgentConfig(home, name, options);
  if (found === undefined) throw new RuntimeError('agent_config_invalid');
  const uid = expectedUid(options);
  const dir = found.paths.dir;
  const files = [
    ...STORE_FILES,
    `${STORE_FILE}.lock`,
    AGENT_OPEN_LOCK_FILE,
    'free-credits.json',
    CONFIG_FILE,
  ];
  // Anything else in the folder refuses the removal before a single file is deleted.
  let present: string[];
  try {
    present = await readdir(dir);
  } catch {
    throw new RuntimeError('agent_path_invalid');
  }
  if (present.some((entry) => !files.includes(entry))) throw new RuntimeError('agent_path_invalid');
  let lockLeft = false;
  for (const file of files) {
    const path = join(dir, file);
    const info = await lstatOrMissing(path);
    if (info === undefined) continue;
    checkFileInfo(info, uid);
    try {
      await unlink(path);
    } catch (error) {
      // U3-e: on Windows the lock file the removal itself holds open cannot be unlinked; it and the
      // folder go once the lock is released (removeAgentFolderLock). The config is gone already.
      if (!POSIX && file === AGENT_OPEN_LOCK_FILE) {
        lockLeft = true;
        continue;
      }
      if (!isMissing(error)) throw new RuntimeError('agent_path_invalid');
    }
  }
  if (lockLeft) return;
  try {
    await rmdir(dir);
  } catch (error) {
    if (!isMissing(error)) throw new RuntimeError('agent_path_invalid');
  }
}

/**
 * U3-e: after a removal released the folder lock, deletes a lock file left behind (Windows, where the
 * held file could not be unlinked) and the empty folder. Only when the config is gone and nothing
 * but the lock file is there; anything else is left as it is. Best effort, never throws.
 */
export async function removeAgentFolderLock(
  home: string,
  name: string,
  options: OwnerCheck = {},
): Promise<void> {
  try {
    const paths = agentPaths(home, name);
    const uid = expectedUid(options);
    if ((await checkDir(paths.dir, uid)) === undefined) return;
    const dir = await checkContained(home, name);
    const present = await readdir(dir);
    if (present.length !== 1 || present[0] !== AGENT_OPEN_LOCK_FILE) return;
    const info = await lstatOrMissing(join(dir, AGENT_OPEN_LOCK_FILE));
    if (info === undefined) return;
    checkFileInfo(info, uid);
    await unlink(join(dir, AGENT_OPEN_LOCK_FILE));
    await rmdir(dir);
  } catch {
    // Left for the next removal attempt or `doctor`.
  }
}

/** True when the owner's revoked list has an entry for `agentId` (presence only; U3-e verifies). */
export async function inRevokedList(home: string, agentId: string): Promise<boolean> {
  // `agentId` passed assertAgentId in parseAgentConfig: `0x` + 40 hex, safe as a file name.
  const info = await lstatOrMissing(join(home, '.agentlink', REVOKED_DIR, `${agentId}.json`));
  // Anything at that name counts: a revoked agent must never open as usable (fail closed).
  return info !== undefined;
}

/** A revoked-list entry is one signed `agent.revoke` (about 400 bytes); larger is damaged. */
const MAX_REVOKED_BYTES = 4_096;

/** One entry of the owner's revoked list, as read (U3-e; the caller re-verifies `text`). */
export type RevokedFile =
  | { readonly kind: 'none' }
  | { readonly kind: 'entry'; readonly text: string }
  | { readonly kind: 'damaged' };

/**
 * U3-e (04 §2.5 step 2, §2.5.1 "The owner's revoked list"): reads `~/.agentlink/revoked/<agentId>.json`
 * under the folder rules: the folders real and private, the file a regular private file with one
 * name, opened without following a link. Anything at that name that breaks a rule, is too large or
 * is not UTF-8 is `damaged` (the agent still counts as revoked: fail closed). The text is returned
 * exactly as stored; it is the signed object itself, and the caller verifies it.
 */
export async function readRevokedEntry(
  home: string,
  agentId: string,
  options: OwnerCheck = {},
): Promise<RevokedFile> {
  assertAgentId(agentId);
  const uid = expectedUid(options);
  const root = join(home, '.agentlink');
  const dir = join(root, REVOKED_DIR);
  const path = join(dir, `${agentId}.json`);
  try {
    const before = await lstatOrMissing(path);
    if (before === undefined) return { kind: 'none' };
    if ((await checkDir(root, uid)) === undefined) return { kind: 'damaged' };
    if ((await checkDir(dir, uid)) === undefined) return { kind: 'damaged' };
    checkFileInfo(before, uid);
    const handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.ino !== before.ino || info.dev !== before.dev) {
        return { kind: 'damaged' };
      }
      if (info.size > MAX_REVOKED_BYTES) return { kind: 'damaged' };
      const buffer = Buffer.alloc(MAX_REVOKED_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_REVOKED_BYTES) return { kind: 'damaged' };
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
      return { kind: 'entry', text };
    } finally {
      await handle.close();
    }
  } catch {
    return { kind: 'damaged' };
  }
}

/**
 * U3-e (04 §2.5 step 2): records `text` (the exact signed `agent.revoke`, nothing else) as the
 * owner's revoked-list entry for `agentId`: folder 0700, file 0600, written to a fresh temporary
 * name (created exclusively, never through a link), synced, then linked into place, so an existing
 * entry is never replaced (revocation is permanent; AgentLink never removes one). An existing entry
 * is left as it is and is not an error; the caller reads it back.
 */
export async function recordRevokedEntry(
  home: string,
  agentId: string,
  text: string,
  options: OwnerCheck = {},
): Promise<void> {
  assertAgentId(agentId);
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_REVOKED_BYTES) {
    throw new RuntimeError('agent_config_invalid');
  }
  const uid = expectedUid(options);
  const root = join(home, '.agentlink');
  const dir = join(root, REVOKED_DIR);
  await ensurePrivateDir(root, uid);
  await ensurePrivateDir(dir, uid);
  const target = join(dir, `${agentId}.json`);
  if ((await lstatOrMissing(target)) !== undefined) return;
  const temp = join(dir, `.${agentId}.${encodeHex(randomBytes(8))}.tmp`);
  const handle = await open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    FILE_MODE,
  );
  try {
    if (POSIX) await handle.chmod(FILE_MODE);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temp, target);
  } catch (error) {
    if (codeOf(error) !== 'EEXIST') throw new RuntimeError('agent_path_invalid');
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

/**
 * The last used agent from `~/.agentlink/app.json`, or undefined. Not signed: it only picks which
 * agent opens first. A link, a non-private file, a malformed or oversized file, or a name that fails
 * the agent-name rule is ignored, never an error.
 */
export async function readAppCurrent(
  home: string,
  options: OwnerCheck = {},
): Promise<string | undefined> {
  const uid = expectedUid(options);
  try {
    const root = join(home, '.agentlink');
    if ((await checkDir(root, uid)) === undefined) return undefined;
    const path = join(root, APP_FILE);
    const before = await lstatOrMissing(path);
    if (before === undefined) return undefined;
    checkFileInfo(before, uid);
    const handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.ino !== before.ino || info.dev !== before.dev) return undefined;
      if (info.size > MAX_APP_FILE_BYTES) return undefined;
      const buffer = Buffer.alloc(MAX_APP_FILE_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_APP_FILE_BYTES) return undefined;
      const parsed: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)),
      );
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
      const record = parsed as Record<string, unknown>;
      if (Object.keys(record).sort().join(',') !== 'current,v' || record['v'] !== 1) {
        return undefined;
      }
      return isAgentName(record['current']) ? record['current'] : undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/**
 * Writes `{"v":1,"current":<name>}` to `~/.agentlink/app.json` with mode 0600: a fresh temporary file
 * (created exclusively, never following a link) renamed into place. Only the switch writes it.
 */
export async function writeAppCurrent(
  home: string,
  name: string,
  options: OwnerCheck = {},
): Promise<void> {
  if (!isAgentName(name)) throw new RuntimeError('agent_name_invalid');
  const uid = expectedUid(options);
  const root = join(home, '.agentlink');
  await ensurePrivateDir(root, uid);
  const target = join(root, APP_FILE);
  const existing = await lstatOrMissing(target);
  if (existing !== undefined) checkFileInfo(existing, uid);
  const temp = join(root, `.${APP_FILE}.${encodeHex(randomBytes(8))}.tmp`);
  const handle = await open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    FILE_MODE,
  );
  try {
    if (POSIX) await handle.chmod(FILE_MODE);
    await handle.writeFile(`${JSON.stringify({ v: 1, current: name })}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, target);
  } catch {
    await unlink(temp).catch(() => undefined);
    throw new RuntimeError('agent_path_invalid');
  }
}

/** One agent folder as the app host lists it: never a path or an agent ID. */
async function directoryEntry(
  home: string,
  name: string,
  options: OwnerCheck,
): Promise<AgentDirectoryEntry> {
  try {
    const found = await readAgentConfig(home, name, options);
    if (found === undefined) {
      return Object.freeze({ name, label: name, available: false, removing: false });
    }
    const { config } = found;
    const removing = config.removing === true || (await inRevokedList(home, config.agentId));
    return Object.freeze({ name, label: config.label ?? name, available: true, removing });
  } catch {
    // A folder that breaks the rules is still listed (never lost), and never opened.
    return Object.freeze({ name, label: name, available: false, removing: false });
  }
}

/**
 * The node AgentDirectory seam over this file (U3-c; 08 §1), so the folder and name rules stay here.
 * `now` (Unix seconds) is the clock of the Running check.
 */
export function agentDirectory(
  home: string,
  options: OwnerCheck & {
    readonly now?: () => number;
    /** U3-d: the keychain side of a new agent (tests pass doubles; default the OS keychain). */
    readonly createAgent?: () => Promise<string>;
    readonly discardKeys?: (agentId: string) => Promise<void>;
  } = {},
): AgentDirectory {
  const now = options.now ?? ((): number => Math.floor(Date.now() / 1000));
  const createAgent = options.createAgent ?? (() => createOsKeychainAgent());
  const discardKeys =
    options.discardKeys ?? ((agentId: string) => discardNewOsKeychainAgent(agentId));
  /** U3-d: the folders this directory created and has not discarded (discardNew refuses others). */
  const created = new Set<string>();
  const check: OwnerCheck = options.uid === undefined ? {} : { uid: options.uid };
  return Object.freeze<AgentDirectory>({
    list: async () => {
      const names = await listAgentNames(home, check);
      const entries: AgentDirectoryEntry[] = [];
      for (const name of names) entries.push(await directoryEntry(home, name, check));
      return Object.freeze(entries);
    },
    read: async (name) => {
      if (!isAgentName(name)) return undefined;
      const names = await listAgentNames(home, check);
      if (!names.includes(name)) return undefined;
      return directoryEntry(home, name, check);
    },
    stats: async (name) => {
      if (!isAgentName(name)) return undefined;
      try {
        const found = await readAgentConfig(home, name, check);
        if (found === undefined) return undefined;
        return peekAgentStore(found.paths.store, now());
      } catch {
        return undefined;
      }
    },
    writeLabel: (name, label) => writeAgentLabel(home, name, label, check),
    // U3-d: a new keychain agent in a folder named from the label, and its removal when the app
    // could not complete it (all or nothing; only for an agent the app just created).
    // U3-g-b: `options.name` (first run's first agent, `default`) names the folder instead.
    create: async (label, options) => {
      const name = await createAgentFolder(
        home,
        label,
        { ...check, createAgent, discardKeys },
        options?.name,
      );
      created.add(name);
      return name;
    },
    discardNew: async (name) => {
      // Only an agent this directory created in this process: never an existing agent's keys.
      if (!created.delete(name)) throw new RuntimeError('agent_config_invalid');
      await discardNewAgentFolder(home, name, { ...check, discardKeys });
    },
    markRemoving: (name) => markAgentRemoving(home, name, check),
    removeFolder: (name) => removeAgentFolder(home, name, check),
    readCurrent: () => readAppCurrent(home, check),
    writeCurrent: (name) => writeAppCurrent(home, name, check),
  });
}
