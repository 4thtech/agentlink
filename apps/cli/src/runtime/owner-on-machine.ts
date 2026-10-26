// M1-36a-b: is this machine known to have no owner, so the no-owner text can name `owner init`
// instead of `owner add-agent` (M1-36a `noOwnerCard`; 04 §2.8, D-78)?
//
// `owner init` signs the first agent's card in the same step (M1-8h), so an owner on this machine
// means some agent here has a card. The caller's agent has none, so with no other agent folder and no
// file-KeyStore owner file there is no owner. Only that positive answer counts: another agent, an
// owner file, or any error (an unreadable or unsafe folder) keeps the add-agent step, which tells
// the user what to run first. Reads folder names and file presence only: never a key, a keychain
// item or a file's content.
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { listAgentNames, type OwnerCheck } from './agent-dir.js';

/**
 * The file-KeyStore owner files (04 §2.2, §2.8): the same paths as @4thtech-io/node's
 * `defaultOwnerFiles` (owner-setup.ts), which that package does not export.
 */
const OWNER_FILES = ['owner.alko', 'owner.alkp'] as const;

async function missing(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return (error as { code?: unknown } | null)?.code === 'ENOENT';
  }
}

/** True only when `home` positively has no owner besides (at most) the agent `name` itself. */
export async function ownerKnownAbsent(
  home: string,
  name: string,
  options: OwnerCheck = {},
): Promise<boolean> {
  try {
    const others = (await listAgentNames(home, options)).filter((n) => n !== name);
    if (others.length > 0) return false;
    for (const file of OWNER_FILES) {
      if (!(await missing(join(home, '.agentlink', 'keystore', file)))) return false;
    }
    return true;
  } catch {
    return false;
  }
}
