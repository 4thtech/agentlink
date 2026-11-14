// WIN-BROKEN-ID (04 §2.5 "An ID whose key is missing"; 08 §1; 11 §5; proposed, owner confirms at
// merge): an ID folder whose identity key is gone from this computer's keychain (a leftover folder
// from a test, a keychain entry removed). It is told apart from every other start failure and is
// never a dead end:
// - `brokenIds(home)`: the names whose open failed with `identity_missing` in this process. The app
//   host's directory marks them (display only), so Home offers Restore from backup, Remove this ID
//   from this computer and Continue without it. No keychain item is read to list IDs (on macOS each
//   read of another ID's items may prompt); only an open that already failed marks one.
// - `setAsideBrokenAgent`: "Remove this ID from this computer". Checks again that the key is
//   missing, moves the folder whole to `~/.agentlink/set-aside/<name>.<stamp>` (agent-dir.ts
//   moveAgentFolderAside: never a delete), then erases the ID's leftover agent items (never an
//   owner item; node eraseOsBrokenAgentItems refuses while the seed is here). Folder first, then
//   keys; any failure is a fixed error the page shows.
//
// I-4: no MCP tool reaches any of this; the only caller is the app host's remove route, behind the
// owner's presence and the typed label. I-7: no name, path or agent ID is logged.
import { eraseOsBrokenAgentItems, osAgentSeedMissing } from '@4thtech-io/node';
import {
  SET_ASIDE_DIR,
  moveAgentFolderAside,
  readAgentConfig,
  type OwnerCheck,
} from './agent-dir.js';
import { isAgentName } from './agent-name.js';
import { brokenIds } from './broken-names.js';
import { RuntimeError } from './errors.js';

export { SET_ASIDE_DIR };
export { brokenIds, isIdentityMissing, type BrokenIds } from './broken-names.js';

export interface SetAsideDeps extends OwnerCheck {
  /**
   * True when the ID's SEED is missing (default: the OS keychain). r1 M1: an ID whose seed is here
   * (only its store key gone) is never set aside: its key can still sign, so it needs its signed
   * removal. Checked before the move.
   */
  readonly seedMissing?: (agentId: string) => Promise<boolean>;
  /**
   * Erases the ID's leftover agent items, keeping its store key so the set-aside store stays
   * readable (default: the OS keychain; refused while the seed is here, read again right before).
   */
  readonly eraseLeftovers?: (agentId: string) => Promise<void>;
  /** Milliseconds since the epoch, for the folder's date. */
  readonly now?: () => number;
}

/** `YYYYMMDD-HHMMSS` in UTC. */
function stampOf(ms: number): string {
  const d = new Date(ms);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}-${two(
    d.getUTCHours(),
  )}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}`;
}

/** WIN-BROKEN-ID: sets aside the ID folder `name` whose key is missing (see the file header). */
export async function setAsideBrokenAgent(
  home: string,
  name: string,
  deps: SetAsideDeps = {},
): Promise<void> {
  if (!isAgentName(name)) throw new RuntimeError('agent_name_invalid');
  const check: OwnerCheck = deps.uid === undefined ? {} : { uid: deps.uid };
  const found = await readAgentConfig(home, name, check);
  if (found === undefined) throw new RuntimeError('agent_config_invalid');
  const { agentId, keyStore } = found.config;
  // A file-KeyStore ID's key is its passphrase-protected file, never "missing" this way.
  if (keyStore !== 'keychain') throw new RuntimeError('agent_not_broken');
  // r2: a check that fails is its own answer (never "the key is here").
  let missing: boolean;
  try {
    missing = await (deps.seedMissing ?? osAgentSeedMissing)(agentId);
  } catch {
    throw new RuntimeError('agent_keys_unchecked');
  }
  if (!missing) throw new RuntimeError('agent_not_broken');
  // 1. The folder, whole, out of `agents`: the ID is no longer listed and can be moved back.
  await moveAgentFolderAside(home, name, stampOf((deps.now ?? Date.now)()), check);
  brokenIds(home).clear(name);
  // 2. Then the leftover items, so a later restore of this ID is not refused by them.
  try {
    await (deps.eraseLeftovers ?? eraseOsBrokenAgentItems)(agentId);
  } catch {
    throw new RuntimeError('agent_keys_left');
  }
}
