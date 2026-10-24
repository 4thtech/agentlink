// M1-11b-6: what the CLI wires into the local approval server's app (local-ui-wiring.ts). Owner
// setup (D-120 (1)) is wired only for a keychain agent and only while no owner exists anywhere,
// the file-KeyStore owner files included (IR-M1-11s-c-1 L-6); every doubt leaves it out.
import type { AgentLinkClient } from '@4thtech-io/core';
import type { Logger } from '@4thtech-io/log';
import type { ApprovalServerEvent, LocalUiAssets } from '@4thtech-io/node';
import { describe, expect, it, vi } from 'vitest';
import {
  localUiOptions,
  logOwnerSetupEvent,
  ownerSetupDone,
  type LocalUiWiringDeps,
} from './local-ui-wiring.js';

const AGENT_ID = `0x${'cd'.repeat(20)}`;
const identity = { get: vi.fn(), init: vi.fn() };
const client = { agentId: AGENT_ID, identity } as unknown as AgentLinkClient;
const assets: LocalUiAssets = { files: new Map([['index.html', new Uint8Array([60])]]) };
const RELAYS = ['wss://relay.one.example', 'wss://relay.two.example'];

function deps(overrides: Partial<LocalUiWiringDeps> = {}): LocalUiWiringDeps & {
  readonly checked: unknown[];
} {
  const checked: unknown[] = [];
  return {
    keyStoreOf: () => Promise.resolve('keychain'),
    ownerSetupAvailable: (first) => {
      checked.push(first);
      return Promise.resolve(true);
    },
    cardRelays: () => RELAYS,
    assets: () => assets,
    ...overrides,
    checked,
  };
}

describe('localUiOptions (M1-11b-6)', () => {
  it('wires owner setup for a keychain agent when no owner exists anywhere', async () => {
    const d = deps();
    const options = await localUiOptions({ name: 'work', client }, d);
    expect(options.assets).toBe(assets);
    expect(options.client).toBe(client);
    expect(options.ownerSetup).toEqual({
      firstCard: { agent: AGENT_ID, name: 'work', relays: RELAYS, identity },
    });
    // The check ran on exactly the card the setup would sign.
    expect(d.checked).toEqual([options.ownerSetup?.firstCard]);
    // The default owner files (the real home) are kept: no override is passed.
    expect(options.ownerSetup).not.toHaveProperty('ownerFiles');
  });

  it('never wires owner setup when an owner exists (card, keychain item or owner.alko)', async () => {
    const options = await localUiOptions(
      { name: 'default', client },
      deps({ ownerSetupAvailable: () => Promise.resolve(false) }),
    );
    expect(options.ownerSetup).toBeUndefined();
    expect(options.assets).toBe(assets);
    expect(options.client).toBe(client);
  });

  it('never wires owner setup for a file-KeyStore agent, without even checking', async () => {
    const d = deps({ keyStoreOf: () => Promise.resolve('file') });
    const options = await localUiOptions({ name: 'default', client }, d);
    expect(options.ownerSetup).toBeUndefined();
    expect(d.checked).toEqual([]);
  });

  it('fails closed: an unknown agent, a config error or a failed check wires nothing', async () => {
    for (const d of [
      deps({ keyStoreOf: () => Promise.resolve(undefined) }),
      deps({ keyStoreOf: () => Promise.reject(new Error('config unreadable')) }),
      deps({ ownerSetupAvailable: () => Promise.reject(new Error('keychain locked')) }),
    ]) {
      const options = await localUiOptions({ name: 'default', client }, d);
      expect(options.ownerSetup).toBeUndefined();
    }
  });
});

describe('owner setup events (IR-M1-11s-c-1 L-2)', () => {
  const done: ApprovalServerEvent = {
    kind: 'owner_setup',
    outcome: 'done',
    fingerprint: 'ABCD-EFGH',
  } as ApprovalServerEvent;
  const unconfirmed = { ...done, outcome: 'done_unconfirmed' } as ApprovalServerEvent;
  const failed = { kind: 'owner_setup', outcome: 'failed' } as unknown as ApprovalServerEvent;
  const other = { kind: 'closed' } as ApprovalServerEvent;

  it('ownerSetupDone is true only for a finished setup', () => {
    expect(ownerSetupDone(done)).toBe(true);
    expect(ownerSetupDone(unconfirmed)).toBe(true);
    expect(ownerSetupDone(failed)).toBe(false);
    expect(ownerSetupDone(other)).toBe(false);
  });

  it('logs one fixed line with the public fingerprint, and nothing else', () => {
    const info = vi.fn();
    const logger = { info, debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
    logOwnerSetupEvent(logger, done);
    logOwnerSetupEvent(logger, failed);
    logOwnerSetupEvent(logger, other);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[1]).toEqual({ fingerprint: 'ABCD-EFGH' });
  });
});
