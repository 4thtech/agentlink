// The agent directory under `~/.agentlink` (M1-9k; 06 §6, 07 §9.1). One folder per local agent:
//
//   ~/.agentlink/agents/<name>/config.json   { "v": 1, "name", "agentId", "keyStore" }
//   ~/.agentlink/agents/<name>/store.sqlite  the agent's shared SQLite store (07 §3.7; D-73 (3))
//
// `init` (M1-9a) writes the config through `writeAgentConfig`; every other command and every
// `agentlink mcp` process reads it through `readAgentConfig`, so all of them open the same store
// file (06 §6). The config is not owner-signed: changing it can only make the agent fail to open
// (07 §9.1). Paths follow the realpath rule (04 §4): the resolved agent folder must sit directly in
// the resolved `agents` folder, and neither the folder nor the config may be a link.
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { assertAgentId, type KeyStoreBackendKind } from '@agentlink/node';
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
/** A config is a few hundred bytes; anything larger is refused unread. */
export const MAX_CONFIG_BYTES = 4_096;

export interface AgentPaths {
  readonly root: string;
  readonly agents: string;
  readonly dir: string;
  readonly config: string;
  readonly store: string;
}

/** `~/.agentlink` and the agent's folder, config and store under it. `name` must already be valid. */
export function agentPaths(home: string, name: string): AgentPaths {
  if (!isAgentName(name)) throw new RuntimeError('agent_name_invalid');
  const root = join(home, '.agentlink');
  const agents = join(root, 'agents');
  const dir = join(agents, name);
  return { root, agents, dir, config: join(dir, CONFIG_FILE), store: join(dir, STORE_FILE) };
}

const isMissing = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  ((error as { code?: unknown }).code === 'ENOENT' ||
    (error as { code?: unknown }).code === 'ENOTDIR');

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
 * Resolves the agent folder under the realpath rule (04 §4): `agents` and the agent folder are real
 * folders (not links), and the folder's realpath sits directly in the realpath of `agents`.
 * Returns undefined when the folder does not exist.
 */
async function resolveAgentDir(paths: AgentPaths, name: string): Promise<string | undefined> {
  let agentsReal: string;
  try {
    agentsReal = await realpath(paths.agents);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new RuntimeError('agent_path_invalid');
  }
  let info;
  try {
    info = await lstat(paths.dir);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new RuntimeError('agent_path_invalid');
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new RuntimeError('agent_path_invalid');
  const dirReal = await realpath(paths.dir).catch(() => {
    throw new RuntimeError('agent_path_invalid');
  });
  if (dirReal !== join(agentsReal, name)) throw new RuntimeError('agent_path_invalid');
  return dirReal;
}

/**
 * Reads and checks an agent's recorded config. Returns undefined when the agent does not exist
 * (no folder or no config): the caller answers `needs_setup`, never by creating one.
 */
export async function readAgentConfig(
  home: string,
  name: string,
): Promise<{ config: AgentConfig; paths: AgentPaths } | undefined> {
  const paths = agentPaths(home, name);
  const dirReal = await resolveAgentDir(paths, name);
  if (dirReal === undefined) return undefined;
  const configPath = join(dirReal, CONFIG_FILE);
  let handle;
  try {
    // O_NOFOLLOW: a config that is a link is refused, not followed (04 §4).
    handle = await open(configPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw new RuntimeError('agent_path_invalid');
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new RuntimeError('agent_path_invalid');
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

/**
 * Writes an agent's config for `init` (M1-9a): the folders with mode 0700, the file with mode 0600,
 * written to a temporary name and renamed into place. Refuses an invalid name or agent ID.
 */
export async function writeAgentConfig(home: string, config: AgentConfig): Promise<AgentPaths> {
  const paths = agentPaths(home, config.name);
  assertAgentId(config.agentId);
  if (config.keyStore !== 'keychain' && config.keyStore !== 'file') {
    throw new RuntimeError('agent_config_invalid');
  }
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  if ((await resolveAgentDir(paths, config.name)) === undefined) {
    throw new RuntimeError('agent_path_invalid');
  }
  const text = `${JSON.stringify({ v: 1, name: config.name, agentId: config.agentId, keyStore: config.keyStore })}\n`;
  const temp = join(paths.dir, `.${CONFIG_FILE}.tmp`);
  const handle = await open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, paths.config);
  return paths;
}

/**
 * The local agents that have a folder with a valid name, sorted. Entries whose name fails the
 * pattern are skipped, never listed or shown (06 §6).
 */
export async function listAgentNames(home: string): Promise<string[]> {
  const agents = join(home, '.agentlink', 'agents');
  let entries;
  try {
    entries = await readdir(agents, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw new RuntimeError('agent_path_invalid');
  }
  return entries
    .filter((entry) => entry.isDirectory() && isAgentName(entry.name))
    .map((entry) => entry.name)
    .sort();
}
