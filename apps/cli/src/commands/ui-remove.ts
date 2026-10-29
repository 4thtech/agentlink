// U3-e: the CLI side of removing an agent from the app (08 §1 `POST /api/ui/agents/remove`; 04 §2.5
// "Removing an agent"; 06 §6 "Open agents and removal"; D-138; I-1, I-2, I-4, I-7).
//
// The node remove gate reaches the agent folders, the folder lock and the owner's revoked list only
// through this seam, over runtime/agent-dir.ts (the one place of the folder rules) and the M1-9k
// openAgent path:
// - `exclusive` takes the agent folder's lock EXCLUSIVE (node withAgentFolderExclusive) for as long as
//   the removal runs: `in_use` at once while any process (every `agentlink mcp` server, the app host,
//   a CLI command) has the agent open.
// - `open` opens the agent for its removal, ONLY inside this port's own exclusive hold of that agent
//   (it holds no shared lock itself, which the exclusive hold would refuse); anything else refuses.
// - `readRevoked` / `recordRevoked`: the owner's revoked list, `~/.agentlink/revoked/<agentId>.json`,
//   the exact signed `agent.revoke` (agent-dir.ts), never replaced once written.
//
// I-4: nothing here takes presence, holds an owner key or adds an MCP tool. I-7: failures are fixed
// codes; no name, path or ID is logged.
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentLinkClient } from '@4thtech-io/core';
import { decodeHex0x } from '@4thtech-io/crypto';
import {
  withAgentFolderExclusive,
  type AgentRemovalPort,
  type RemovalAgent,
} from '@4thtech-io/node';
import {
  checkAgentLockJournal,
  readAgentConfig,
  removeStaleAgentLockJournal,
  readRevokedEntry,
  recordRevokedEntry,
  removeAgentFolderLock,
  type OwnerCheck,
} from '../runtime/agent-dir.js';
import { isAgentName } from '../runtime/agent-name.js';
import { RuntimeError } from '../runtime/errors.js';
import { nodeRuntimeDeps, openAgent, type RuntimeDeps } from '../runtime/open-agent.js';

export interface UiRemovalOptions extends OwnerCheck {
  /** The home that holds `.agentlink`. Default the OS user's home. */
  readonly home?: string;
  /** Test seam: the runtime the removal opens the agent with. */
  readonly runtime?: RuntimeDeps;
  /** Test seam: the keystore folder of file-KeyStore agents. Default `<home>/.agentlink/keystore`. */
  readonly keystoreDir?: string;
}

/** The owner context of the agent's own card (as the owner commands read it). */
async function contextOf(client: AgentLinkClient) {
  const view = await client.identity.get();
  if (view === undefined || view.revoked) return undefined;
  return {
    agent: view.agentId,
    owner: {
      ownerEvm: decodeHex0x(view.card.ownerEvm),
      ownerNostr: decodeHex0x(view.card.ownerNostr),
      ownerEnc: decodeHex0x(view.card.ownerEnc),
    },
  };
}

/** The removal seam of the app host (node AgentRemovalPort). */
export function uiRemovalPort(options: UiRemovalOptions = {}): AgentRemovalPort {
  const home = options.home ?? homedir();
  const check: OwnerCheck = options.uid === undefined ? {} : { uid: options.uid };
  const runtime = options.runtime ?? nodeRuntimeDeps;
  const keystoreDir = options.keystoreDir ?? join(home, '.agentlink', 'keystore');
  /** The agents this port holds exclusive right now: `open` works only for these. */
  const held = new Set<string>();

  const configOf = async (name: string) => {
    if (!isAgentName(name)) throw new RuntimeError('agent_name_invalid');
    const found = await readAgentConfig(home, name, check);
    if (found === undefined) throw new RuntimeError('agent_config_invalid');
    return found;
  };

  return Object.freeze<AgentRemovalPort>({
    exclusive: async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
      const found = await configOf(name);
      if (held.has(name)) throw new RuntimeError('agent_open_failed');
      // HOTFIX-045-REMOVE: a link or anything odd at `open.lock-journal` refuses before SQLite
      // opens the lock (SQLite would unlink or read it itself).
      await checkAgentLockJournal(home, name, check);
      try {
        return await withAgentFolderExclusive(found.paths.dir, async () => {
          // HOTFIX-045-REMOVE: only under the exclusive hold, a journal 0.4.4 left behind goes.
          await removeStaleAgentLockJournal(home, name, check);
          held.add(name);
          try {
            return await fn();
          } finally {
            held.delete(name);
          }
        });
      } finally {
        // Windows: the lock file the hold kept open, once the folder's other files are gone.
        await removeAgentFolderLock(home, name, check);
      }
    },

    open: async (name: string): Promise<RemovalAgent | undefined> => {
      if (!isAgentName(name) || !held.has(name)) return undefined;
      const result = await openAgent({
        home,
        agent: name,
        deps: runtime,
        // Inside this port's own exclusive hold (above): no shared lock of its own.
        folderLock: () => Object.freeze({ release: () => undefined }),
      }).catch(() => undefined);
      if (result?.status !== 'ok') return undefined;
      const { agent } = result;
      return Object.freeze<RemovalAgent>({
        client: agent.client,
        context: () => contextOf(agent.client),
        close: () => agent.close(),
      });
    },

    keys: async (name: string) => {
      try {
        const { config } = await configOf(name);
        return Object.freeze({ agentId: config.agentId, backend: config.keyStore, keystoreDir });
      } catch {
        return undefined;
      }
    },

    readRevoked: (agentId: string) => readRevokedEntry(home, agentId, check),
    recordRevoked: (agentId: string, text: string) =>
      recordRevokedEntry(home, agentId, text, check),
  });
}
