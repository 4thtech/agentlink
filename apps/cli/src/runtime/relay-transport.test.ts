// RELAY-SHARED-CONN L4 (D-159 (1), (2); 07 §4.2 "Seam"): every agent a CLI process opens builds its
// RelayPool on the process's relay connector: the shared link with a direct fallback when the
// process started one (the MCP process, the desktop host) and AGENTLINK_SHARED_RELAYS is on, the
// direct connector otherwise. The pool's connector carries that agent's own `mayAuthenticate`.
import type { EnvelopeKeys } from '@4thtech-io/crypto';
import type { RelayConnector } from '@4thtech-io/transport-nostr';
import { describe, expect, it } from 'vitest';
import { nodeRuntimeDeps, nodeTransport } from './open-agent.js';

const deps = (mayAuthenticate: (url: string) => boolean) => ({
  keys: {} as EnvelopeKeys,
  now: () => 1_800_000_000,
  mayAuthenticate,
});

describe('the runtime transport and the shared relay link', () => {
  it("asks the process for each pool's connector with that agent's own mayAuthenticate", () => {
    const asked: ((url: string) => boolean)[] = [];
    const connector: RelayConnector = {
      open: () => {
        throw new Error('not opened in this test');
      },
    };
    const factory = nodeTransport((mayAuthenticate) => {
      asked.push(mayAuthenticate);
      return connector;
    });
    const a = (url: string): boolean => url.length > 0;
    const b = (): boolean => false;
    factory(deps(a)).close?.();
    factory(deps(b)).close?.();
    expect(asked).toHaveLength(2);
    expect(asked[0]?.('wss://x.example')).toBe(true);
    expect(asked[1]?.('wss://x.example')).toBe(false);
  });

  it('the production runtime uses it', () => {
    expect(typeof nodeRuntimeDeps.transport).toBe('function');
    const transport = nodeRuntimeDeps.transport();
    const opened = transport(deps(() => false));
    expect(typeof opened.publish).toBe('function');
    opened.close?.();
  });
});
