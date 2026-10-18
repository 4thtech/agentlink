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
