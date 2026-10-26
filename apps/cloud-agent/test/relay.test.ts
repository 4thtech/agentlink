// M2-3a: the Worker relay connector (07 §4.2) and the per-run socket budget (D-131 (f), spike S-5),
// in workerd. The upgrade `fetch` is a stand-in that answers 101 with one end of a WebSocketPair, so
// the test plays the relay on the other end.
import { describe, expect, it } from 'vitest';
import {
  MAX_SOCKETS_PER_RUN,
  RunSocketBudget,
  WorkerRelayConnector,
} from '../src/relay-connector.js';
import { syncIntervalSeconds } from '../src/config.js';

const target = (url = 'wss://relay.example/ws') => ({
  url,
  host: 'relay.example',
  port: 443,
  address: undefined,
});

function recorder() {
  const events: string[] = [];
  return {
    events,
    handlers: {
      onOpen: () => events.push('open'),
      onMessage: (data: unknown) => events.push(`msg:${String(data)}`),
      onClose: () => events.push('close'),
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('WorkerRelayConnector', () => {
  it('upgrades with https + Upgrade: websocket, never follows a redirect, and relays text frames', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let server: WebSocket | undefined;
    const connector = new WorkerRelayConnector({
      fetch: (url, init) => {
        calls.push({ url, init });
        const pair = new WebSocketPair();
        server = pair[1];
        server.accept();
        server.addEventListener('message', (e: MessageEvent) =>
          server?.send(`echo:${String(e.data)}`),
        );
        return Promise.resolve(new Response(null, { status: 101, webSocket: pair[0] }));
      },
    });
    const { events, handlers } = recorder();
    const socket = connector.open(target(), handlers);
    socket.send('["REQ","s",{}]');
    await tick();
    expect(calls[0]?.url).toBe('https://relay.example/ws');
    expect(calls[0]?.init.redirect).toBe('manual');
    expect(new Headers(calls[0]?.init.headers).get('upgrade')).toBe('websocket');
    expect(events).toEqual(['open', 'msg:echo:["REQ","s",{}]']);
    socket.close();
    await tick();
    expect(events.at(-1)).toBe('close');
  });

  it('closes on a redirect or any answer without a socket, and on a non-wss URL', async () => {
    const connector = new WorkerRelayConnector({
      fetch: () =>
        Promise.resolve(new Response(null, { status: 301, headers: { location: 'wss://x' } })),
    });
    const a = recorder();
    connector.open(target(), a.handlers);
    const b = recorder();
    connector.open(target('ws://relay.example'), b.handlers);
    await tick();
    expect(a.events).toEqual(['close']);
    expect(b.events).toEqual(['close']);
  });

  it('closes on a text frame over 128 KiB and drops binary frames', async () => {
    let server: WebSocket | undefined;
    const connector = new WorkerRelayConnector({
      fetch: () => {
        const pair = new WebSocketPair();
        server = pair[1];
        server.accept();
        return Promise.resolve(new Response(null, { status: 101, webSocket: pair[0] }));
      },
    });
    const { events, handlers } = recorder();
    connector.open(target(), handlers);
    await tick();
    server?.send(new Uint8Array([1, 2, 3]));
    server?.send('x'.repeat(131_073));
    await tick();
    expect(events).toEqual(['open', 'close']);
  });
});

describe('RunSocketBudget', () => {
  it('opens at most 5 sockets per run, refuses the rest at once, and closeAll closes every one', async () => {
    let open = 0;
    const inner = {
      open: (_t: unknown, h: { onOpen(): void; onClose(): void }) => {
        open += 1;
        queueMicrotask(() => h.onOpen());
        return {
          send: () => undefined,
          close: () => {
            open -= 1;
            h.onClose();
          },
        };
      },
    };
    const budget = new RunSocketBudget(inner as never);
    expect(MAX_SOCKETS_PER_RUN).toBe(5);
    const refused = recorder();
    for (let i = 0; i < 7; i += 1)
      budget.open(target(), i < 5 ? recorder().handlers : refused.handlers);
    await tick();
    expect(budget.opened).toBe(5);
    expect(open).toBe(5);
    expect(refused.events).toEqual(['close', 'close']);
    budget.closeAll();
    expect(open).toBe(0);
    expect(budget.openCount).toBe(0);
    budget.open(target(), refused.handlers);
    expect(budget.opened).toBe(5);
  });
});

describe('sync interval (config)', () => {
  it('is 60 s by default and only takes a decimal within 30..3600', () => {
    expect(syncIntervalSeconds(undefined)).toBe(60);
    expect(syncIntervalSeconds('120')).toBe(120);
    for (const bad of ['10', '0060', '7200', '60s', '-60', ''])
      expect(syncIntervalSeconds(bad)).toBe(60);
  });
});
