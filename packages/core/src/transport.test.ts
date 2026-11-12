// M1-7k: the Transport adapter over transport-nostr (07 §4.1, §4.2). No network: the connector
// records what it is asked to open and never connects.
import { TransportError, type RelayConnector } from '@4thtech-io/transport-nostr';
import { describe, expect, it } from 'vitest';
import { nostrTransport } from './transport.js';
import { MemoryKeyStore } from '@4thtech-io/crypto/testing';
import { seed } from './testing/fixtures.js';

const opened: string[] = [];
const connector: RelayConnector = {
  open(target, handlers) {
    opened.push(target.url);
    void Promise.resolve().then(() => handlers.onClose());
    return { send: () => {}, close: () => {} };
  },
};

describe('nostrTransport (07 §4.1)', () => {
  it('builds a transport whose publish goes only to the listed relays and refuses an empty list', async () => {
    const keys = new MemoryKeyStore(seed(1));
    const transport = nostrTransport({ connector, addressCheck: 'platform' })({
      keys,
      now: () => 1_800_000_000,
      mayAuthenticate: () => false,
    });
    expect(typeof transport.wrap).toBe('function');
    await expect(
      transport.publish(
        { id: 'x', pubkey: 'y', created_at: 0, kind: 1059, tags: [], content: '', sig: 'z' },
        [],
      ),
    ).rejects.toBeInstanceOf(TransportError);
    const outcome = await transport.publish(
      { id: 'x', pubkey: 'y', created_at: 0, kind: 1059, tags: [], content: '', sig: 'z' },
      ['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net'],
    );
    expect(outcome.sent).toBe(false);
    expect(new Set(opened)).toEqual(
      new Set(['wss://one.relay-alpha.net', 'wss://two.relay-alpha.net']),
    );
    await keys.close();
  });

  it('close() closes every open relay socket and ends a publish that is waiting on one', async () => {
    const sockets: { closed: boolean }[] = [];
    const live: RelayConnector = {
      open(_target, handlers) {
        const socket = { closed: false };
        sockets.push(socket);
        void Promise.resolve().then(() => handlers.onOpen());
        return {
          send: () => {},
          close: () => {
            socket.closed = true;
          },
        };
      },
    };
    const keys = new MemoryKeyStore(seed(2));
    const transport = nostrTransport({ connector: live, addressCheck: 'platform' })({
      keys,
      now: () => 1_800_000_000,
      mayAuthenticate: () => false,
    });
    const waiting = transport.publish(
      { id: 'x', pubkey: 'y', created_at: 0, kind: 1059, tags: [], content: '', sig: 'z' },
      ['wss://one.relay-alpha.net'],
    );
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(sockets.length).toBe(1);
    expect(sockets[0]!.closed).toBe(false);
    transport.close?.();
    expect(typeof transport.close).toBe('function');
    expect(sockets[0]!.closed).toBe(true);
    await expect(waiting).resolves.toMatchObject({ sent: false });
    await keys.close();
  });
});

describe('nostrTransport relayStatus (REL051-CF2: relay health for the app)', () => {
  /** Opens `up` relays, refuses `refused` ones at once, and never answers the rest (black hole). */
  const switchable = (up: Set<string>, refused: Set<string>): RelayConnector => ({
    open(target, handlers) {
      if (up.has(target.url)) void Promise.resolve().then(() => handlers.onOpen());
      else if (refused.has(target.url)) void Promise.resolve().then(() => handlers.onClose());
      // anything else: a black hole, only the connect timeout ends it
      return { send: () => {}, close: () => {} };
    },
  });
  // The pool's timers, shortened so a black-holed connect gives up at once in the test.
  const quick = {
    setTimeout: (cb: () => void, ms: number) => setTimeout(cb, Math.min(ms, 5)),
    clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const RELAYS = [
    'wss://one.relay-alpha.net',
    'wss://two.relay-alpha.net',
    'wss://three.relay-alpha.net',
  ];

  it('counts the relays it can connect to: none while refused or black-holed, all once they are back', async () => {
    const up = new Set<string>();
    const refused = new Set<string>([RELAYS[0]!, RELAYS[1]!]);
    const keys = new MemoryKeyStore(seed(3));
    const transport = nostrTransport({
      connector: switchable(up, refused),
      addressCheck: 'platform',
      timers: quick,
    })({ keys, now: () => 1_800_000_000, mayAuthenticate: () => false });
    expect(typeof transport.relayStatus).toBe('function');
    await expect(transport.relayStatus!(RELAYS)).resolves.toEqual({ connected: 0, total: 3 });
    // Back: the next check reconnects on its own.
    for (const r of RELAYS) up.add(r);
    refused.clear();
    await expect(transport.relayStatus!(RELAYS)).resolves.toEqual({ connected: 3, total: 3 });
    // Duplicates count once; the answer is counts only.
    await expect(transport.relayStatus!([RELAYS[0]!, RELAYS[0]!])).resolves.toEqual({
      connected: 1,
      total: 1,
    });
    transport.close?.();
    await keys.close();
  });
});
