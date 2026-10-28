// U3-d (D-138; 08 §1 `POST /api/ui/agents`; 06 §6; 07 §9.1; proposed, owner confirms at merge): a new
// agent folder created from the local app, and removing exactly what that created when the agent
// could not be completed (all or nothing, 04 §2.8 "From the local app").
//
// - The folder name is a slug of the label under the agent-name rule (06 §6): lower case, ASCII
//   letters, digits and hyphens, starting with a letter, at most 32, made unique with a suffix
//   (`-2`, `-3`, ...). Letters with accents lose them; a label with nothing usable gives `agent`.
// - The new config names the keychain agent and holds no label: `label` is written only after the
//   server verified the signed `agent.label` (07 §9.1).
// - Discarding only ever runs for an agent this process just created: its keychain items (named
//   from its agentId alone) and its folder (removeAgentFolder: known files only, no recursive
//   delete). Nothing is logged; errors are fixed codes (I-7).
import {
  listAgentNames,
  readAgentConfig,
  removeAgentFolder,
  writeAgentConfig,
} from './agent-dir.js';
import type { OwnerCheck } from './agent-dir.js';
import { isAgentName } from './agent-name.js';
import { RuntimeError } from './errors.js';

/** 06 §6: at most 32 characters. */
const MAX_NAME = 32;
/** The fallback when the label has no usable letter or digit. */
const FALLBACK = 'agent';
/** At most this many suffixes are tried before giving up (fail closed). */
const MAX_SUFFIX = 999;

/** The slug of `label`, not in `taken`, under the agent-name rule (06 §6). */
export function agentSlug(label: string, taken: readonly string[]): string {
  const base =
    label
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/['’]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || FALLBACK;
  const lettered = /^[a-z]/.test(base) ? base : `${FALLBACK}-${base}`;
  const trimmed = (text: string, room: number): string =>
    text.slice(0, room).replace(/-+$/g, '') || FALLBACK;
  const first = trimmed(lettered, MAX_NAME);
  if (!taken.includes(first) && isAgentName(first)) return first;
  for (let n = 2; n <= MAX_SUFFIX; n += 1) {
    const suffix = `-${String(n)}`;
    const candidate = `${trimmed(lettered, MAX_NAME - suffix.length)}${suffix}`;
    if (!taken.includes(candidate) && isAgentName(candidate)) return candidate;
  }
  throw new RuntimeError('agent_name_invalid');
}

export interface CreateAgentDeps extends OwnerCheck {
  /** Creates a new agent in the OS keychain and returns its agentId (node createOsKeychainAgent). */
  readonly createAgent: () => Promise<string>;
  /** Removes a new agent's keychain items (node discardNewOsKeychainAgent). */
  readonly discardKeys?: (agentId: string) => Promise<void>;
}

/**
 * Creates a keychain agent in a new folder named from `label` and returns the folder name. When the
 * config cannot be written, the keychain agent just made is removed again.
 */
export async function createAgentFolder(
  home: string,
  label: string,
  deps: CreateAgentDeps,
): Promise<string> {
  const check: OwnerCheck = deps.uid === undefined ? {} : { uid: deps.uid };
  const taken = await listAgentNames(home, check).catch(() => [] as string[]);
  const name = agentSlug(label, taken);
  const agentId = await deps.createAgent();
  try {
    // Never replaces an existing folder's config (`agent_exists`).
    await writeAgentConfig(home, { v: 1, name, agentId, keyStore: 'keychain' }, check);
  } catch (error) {
    await deps.discardKeys?.(agentId).catch(() => undefined);
    throw error;
  }
  return name;
}

/**
 * Removes an agent that createAgentFolder made and that could not be completed: its keychain items
 * first, then its folder. Rejects when the folder is not a keychain agent's or cannot be removed.
 */
export async function discardNewAgentFolder(
  home: string,
  name: string,
  deps: OwnerCheck & { readonly discardKeys: (agentId: string) => Promise<void> },
): Promise<void> {
  const check: OwnerCheck = deps.uid === undefined ? {} : { uid: deps.uid };
  const found = await readAgentConfig(home, name, check);
  if (found === undefined || found.config.keyStore !== 'keychain') {
    throw new RuntimeError('agent_config_invalid');
  }
  await deps.discardKeys(found.config.agentId);
  await removeAgentFolder(home, name, check);
}
