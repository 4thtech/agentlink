// SHARED-LINK-HARDEN: the production process link that `agentlink ui`, `agentlink mcp` and the
// desktop host start. On or off follows AGENTLINK_SHARED_RELAYS only (off by default); the network
// view's `sharedLink` then shows the true state. A temporary home only, never the real one.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processSharedLinkView } from '@4thtech-io/node';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeProcessRelayLink } from './relay-link.js';

const homes: string[] = [];
const temp = (): string => {
  const home = mkdtempSync(join(tmpdir(), 'al-ui-link-'));
  homes.push(home);
  return home;
};

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('nodeProcessRelayLink', () => {
  it('with sharing on: start makes the network view say on; close turns it off', async () => {
    const link = nodeProcessRelayLink({ home: temp(), env: { AGENTLINK_SHARED_RELAYS: '1' } });
    await link.start();
    try {
      expect((await processSharedLinkView()).on).toBe(true);
    } finally {
      await link.close();
    }
    expect(await processSharedLinkView()).toEqual({ on: false, programs: 0 });
  });

  it('off by default: start leaves the process on its own connections', async () => {
    const link = nodeProcessRelayLink({ home: temp(), env: {} });
    await link.start();
    try {
      expect(await processSharedLinkView()).toEqual({ on: false, programs: 0 });
    } finally {
      await link.close();
    }
  });
});
