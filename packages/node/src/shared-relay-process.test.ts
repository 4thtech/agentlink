// RELAY-SHARED-CONN L4 (D-159 (1), (8), (9), (11); 07 §4.2 "One relay link per computer"; 08 §1;
// 11 §5.15): one shared relay link per process. A long-running program (the MCP process, the
// desktop host) starts it once; each agent's RelayPool gets its own client connector on it (its own
// `mayAuthenticate`, its own check batches), or the direct connector when sharing is off; the host
// asks an MCP holder to hand over; `doctor` and the network view read counts only. Temporary homes
// and an in-memory relay: no network, never the real ~/.agentlink.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FallbackConnector,
  type AddressCheck,
  type RelayConnector,
  type RelaySocket,
  type RelaySocketHandlers,
  type RelayTarget,
} from '@4thtech-io/transport-nostr';
import { afterEach, describe, expect, it } from 'vitest';
import { SharedRelayLink, createRelayConnectorWith } from './shared-relay-link.js';
import {
  closeProcessRelayLink,
  probeSharedRelayLink,
  processCheckServed,
  processPoolConnector,
  processSharedLinkView,
  startProcessRelayLink,
} from './shared-relay-process.js';

const POSIX = process.platform !== 'win32';
const CLI = '0.5.18';
const ON = { AGENTLINK_SHARED_RELAYS: '1' };
const addressCheck: AddressCheck = {
  resolver: { resolve: () => Promise.resolve(['93.184.216.34']) },
};

const homes: string[] = [];
const others: SharedRelayLink[] = [];

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'al-l4-'));
  homes.push(home);
  return home;
}

afterEach(async () => {
  await closeProcessRelayLink();
  for (const link of others.splice(0)) await link.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fakeRelay(): RelayConnector {
  return {
    open(_target: RelayTarget, handlers: RelaySocketHandlers): RelaySocket {
      let closed = false;
      setTimeout(() => {
        if (!closed) handlers.onOpen();
      }, 1);
      return {
        send: () => undefined,
        close() {
          closed = true;
        },
      };
    },
  };
}

async function waitFor(check: () => boolean, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('the process relay link, off (the 0.5.18 default)', () => {
  it('pools get the direct connector; the view and doctor say off; no check lane', async () => {
    const home = tempHome();
    const direct = fakeRelay();
    const choice = await startProcessRelayLink({
      home,
      cliVersion: CLI,
      env: {},
      direct,
      addressCheck,
    });
    expect(choice.link).toBeUndefined();
    expect(processPoolConnector(() => true)).toBe(direct);
    expect(processCheckServed()).toBeUndefined();
    expect(await processSharedLinkView()).toEqual({ on: false, programs: 0 });
    expect(await probeSharedRelayLink({ home, cliVersion: CLI, env: {} })).toEqual({ on: false });
  });

  it('before any start (a one-shot command): the direct connector and off', async () => {
    expect(processPoolConnector(() => true)).not.toBeInstanceOf(FallbackConnector);
    expect(await processSharedLinkView()).toEqual({ on: false, programs: 0 });
  });
});

describe.runIf(POSIX)('the process relay link, on', () => {
  it('starts once per process; each pool gets its own shared connector with direct fallback', async () => {
    const home = tempHome();
    const options = { home, cliVersion: CLI, env: ON, direct: fakeRelay(), addressCheck };
    const first = await startProcessRelayLink(options);
    const again = await startProcessRelayLink(options);
    expect(again).toBe(first);
    expect(first.link).toBeInstanceOf(SharedRelayLink);
    const a = processPoolConnector(() => true);
    const b = processPoolConnector(() => false);
    expect(a).toBeInstanceOf(FallbackConnector);
    expect(b).toBeInstanceOf(FallbackConnector);
    expect(a).not.toBe(b); // own policy and own check batches per pool (D-159 owner decision 1)
    expect(typeof processCheckServed()).toBe('function');
    expect((await processSharedLinkView()).on).toBe(true);
  });

  it('close ends the link (process exit) and the process falls back to direct', async () => {
    const home = tempHome();
    const choice = await startProcessRelayLink({
      home,
      cliVersion: CLI,
      env: ON,
      direct: fakeRelay(),
      addressCheck,
    });
    await waitFor(() => choice.link?.role === 'winner');
    await closeProcessRelayLink();
    expect(choice.link?.role).toBe('closed');
    expect(processPoolConnector(() => true)).not.toBeInstanceOf(FallbackConnector);
    expect(await processSharedLinkView()).toEqual({ on: false, programs: 0 });
  });

  it('the desktop host takes over from an MCP winner (takeOver asks it to yield)', async () => {
    const home = tempHome();
    const mcp = await createRelayConnectorWith({
      home,
      cliVersion: CLI,
      env: ON,
      direct: fakeRelay(),
      addressCheck,
    });
    if (mcp.link !== undefined) others.push(mcp.link);
    await waitFor(() => mcp.link?.role === 'winner');
    const host = await startProcessRelayLink({
      home,
      cliVersion: CLI,
      env: ON,
      direct: fakeRelay(),
      addressCheck,
      takeOver: true,
    });
    expect(host.link?.role).toBe('winner');
    await waitFor(() => mcp.link?.role === 'client');
  });

  it('doctor probes without joining: on with a count while a program holds the link', async () => {
    const home = tempHome();
    expect(await probeSharedRelayLink({ home, cliVersion: CLI, env: ON })).toEqual({
      on: true,
      programs: 0,
    });
    const choice = await startProcessRelayLink({
      home,
      cliVersion: CLI,
      env: ON,
      direct: fakeRelay(),
      addressCheck,
    });
    await waitFor(() => choice.link?.role === 'winner');
    const probed = await probeSharedRelayLink({ home, cliVersion: CLI, env: ON });
    expect(probed.on).toBe(true);
    expect(typeof probed.programs).toBe('number');
  });
});
