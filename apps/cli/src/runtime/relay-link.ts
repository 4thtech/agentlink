// RELAY-SHARED-CONN L4 (D-159 (1), (8); 07 §4.2 "One relay link per computer"): the start and close
// of this process's shared relay link for the long-running programs (`agentlink mcp`, `agentlink ui`
// and the desktop host; 08 §1). One-shot commands never start it, so they keep their own connections. On or off follows
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

/** The production link for `agentlink mcp`, `agentlink ui` and the desktop host. */
export function nodeProcessRelayLink(options: {
  readonly logger?: Logger;
  readonly takeOver?: boolean;
  /** Test seams: the home folder (default: the OS user's) and the environment (process.env). */
  readonly home?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): ProcessRelayLink {
  return Object.freeze<ProcessRelayLink>({
    start: async () => {
      await startProcessRelayLink({
        home: options.home ?? homedir(),
        cliVersion: cliVersion(),
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.logger === undefined ? {} : { logger: options.logger }),
        ...(options.takeOver === true ? { takeOver: true } : {}),
      });
    },
    close: () => closeProcessRelayLink(),
  });
}
