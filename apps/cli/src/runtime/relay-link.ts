// RELAY-SHARED-CONN L4 (D-159 (1), (8); 07 §4.2 "One relay link per computer"): the start and close
// of this process's shared relay link for the long-running programs (`agentlink mcp`, the desktop
// host). One-shot commands never start it, so they keep their own connections. On or off follows
// AGENTLINK_SHARED_RELAYS only (off by default in 0.5.18); nothing here is an owner operation (I-4).
import { homedir } from 'node:os';
import type { Logger } from '@4thtech-io/log';
import { closeProcessRelayLink, startProcessRelayLink } from '@4thtech-io/node';
import { cliVersion } from './cli-version.js';

/** Start and close of a process's shared relay link (@4thtech-io/node startProcessRelayLink). */
export interface ProcessRelayLink {
  start(): Promise<void>;
  close(): Promise<void>;
}

/** The production link for `agentlink mcp` and the desktop host (AGENTLINK_SHARED_RELAYS). */
export function nodeProcessRelayLink(options: {
  readonly logger?: Logger;
  readonly takeOver?: boolean;
}): ProcessRelayLink {
  return Object.freeze<ProcessRelayLink>({
    start: async () => {
      await startProcessRelayLink({
        home: homedir(),
        cliVersion: cliVersion(),
        ...(options.logger === undefined ? {} : { logger: options.logger }),
        ...(options.takeOver === true ? { takeOver: true } : {}),
      });
    },
    close: () => closeProcessRelayLink(),
  });
}
