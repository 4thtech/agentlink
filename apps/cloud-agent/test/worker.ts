// The Worker entry of the Miniflare tests (vitest.config.ts `main`): the real Worker handler and a
// TestAgentDO that differs from AgentDO only in its seams. Its relay connector is the in-memory relay
// (fake-relay.ts), its clock is settable, and `testStore()` hands the store to the test inside the
// object (runInDurableObject), so a test can create the agent's identity the way `/setup` will
// (M2-3f-1) with a test owner. Never built or deployed (tsconfig.json includes only src/).
import type { RelayConnector } from '@4thtech-io/transport-nostr';
import worker, { AgentDO } from '../src/index.js';
import type { DurableObjectStore } from '../src/do-store.js';
import { relay } from './fake-relay.js';

export default worker;

export class TestAgentDO extends AgentDO {
  /** Unix seconds used by the next runs; undefined means the real clock. */
  clockSeconds: number | undefined;
  /** Connectors handed out to runs (for the socket budget assertions). */
  connectors = 0;
  /** When set, a run fails inside its body (after the alarm re-armed). */
  failRuns = false;

  protected override createRelayConnector(): RelayConnector {
    if (this.failRuns) throw new Error('injected run failure');
    this.connectors += 1;
    return relay;
  }

  setFailRuns(value: boolean): void {
    this.failRuns = value;
  }

  protected override now(): number {
    return this.clockSeconds ?? super.now();
  }

  testStore(): DurableObjectStore {
    return this.store;
  }

  testClock(): number {
    return this.now();
  }
}
