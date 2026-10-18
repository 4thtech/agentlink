// The agent directory under `~/.agentlink` (M1-9k; 06 §6, 07 §9.1). One folder per local agent:
//
//   ~/.agentlink/agents/<name>/config.json   { "v": 1, "name", "agentId", "keyStore" }
//   ~/.agentlink/agents/<name>/store.sqlite  the agent's shared SQLite store (07 §3.7; D-73 (3))
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
  unlink,
} from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { assertAgentId, type KeyStoreBackendKind } from '@4thtech-io/node';
import { isAgentName } from './agent-name.js';
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

/** Strict parse: exactly the four keys, each of its exact type and form. */
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
  if (keys.join(',') !== 'agentId,keyStore,name,v') throw new RuntimeError('agent_config_invalid');
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
  return Object.freeze({ v: 1, name: expectedName, agentId: record['agentId'], keyStore });
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
  const uid = expectedUid(options);
  for (const dir of [paths.root, paths.agents, paths.dir]) await ensurePrivateDir(dir, uid);
  const dirReal = await checkContained(home, config.name);
  const target = join(dirReal, CONFIG_FILE);

  const text = `${JSON.stringify({ v: 1, name: config.name, agentId: config.agentId, keyStore: config.keyStore })}\n`;
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
