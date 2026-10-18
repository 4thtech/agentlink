// M1-5b acceptance: an inbound relay frame of 131 073 bytes is dropped before JSON.parse and one of
// 131 072 bytes is parsed (04 §3.1.1, G-2). Spy test: neither the strict parser the pool uses nor the
// global JSON.parse ever sees an oversized frame. The limit is on UTF-8 bytes of the raw message.
import { encodeUtf8 } from '@4thtech-io/crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_FRAME_BYTES, RelayPool } from './relay-pool.js';
import { MockNetwork, makeWrapEvent, relayUrls } from './testing/mock-network.js';

const parsed = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock('@4thtech-io/crypto', async (importOriginal) => {
  const original = await importOriginal<typeof import('@4thtech-io/crypto')>();
  return {
    ...original,
    parseJson: (text: string, options?: Parameters<typeof original.parseJson>[1]) => {
      parsed.calls.push(text);
      return original.parseJson(text, options);
    },
  };
});

beforeEach(() => {
  parsed.calls.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
});

const bytes = (text: string): number => encodeUtf8(text).length;

/** A NOTICE frame of exactly `size` UTF-8 bytes, padded with `fill` (one or more bytes per char). */
function frameOfSize(size: number, fill = 'a'): string {
  const head = '["NOTICE","';
  const tail = '"]';
  const fillBytes = bytes(fill);
  const room = size - bytes(head) - bytes(tail);
  const count = Math.floor(room / fillBytes);
  const pad = 'a'.repeat(room - count * fillBytes);
  return head + fill.repeat(count) + pad + tail;
}

async function connected() {
  const net = new MockNetwork();
  const pool = new RelayPool({ connector: net, addressCheck: 'platform' });
  const [url] = relayUrls('frame', 1) as [string];
  net.configure(url);
  const frames: unknown[][] = [];
  pool.onFrame((_relay, frame) => frames.push([...frame]));
  // Open a connection by publishing once (the OK frame is small and parsed too).
  await pool.publish(makeWrapEvent(), [url]);
  const socket = net.socket(url);
  if (socket === undefined) throw new Error('no socket');
  parsed.calls.length = 0;
  return { socket, frames };
}

describe('inbound relay frame size (04 §3.1.1)', () => {
  it('parses a frame of exactly 131 072 bytes', async () => {
    const { socket, frames } = await connected();
    const frame = frameOfSize(MAX_FRAME_BYTES);
    expect(bytes(frame)).toBe(131_072);
    socket.push(frame);
    await Promise.resolve();
    await Promise.resolve();
    expect(parsed.calls).toEqual([frame]);
    expect(frames).toHaveLength(1);
  });

  it('drops a frame of 131 073 bytes before any JSON parse', async () => {
    const { socket, frames } = await connected();
    const jsonParse = vi.spyOn(JSON, 'parse');
    const frame = frameOfSize(MAX_FRAME_BYTES + 1);
    expect(bytes(frame)).toBe(131_073);
    socket.push(frame);
    await Promise.resolve();
    await Promise.resolve();
    expect(parsed.calls).toEqual([]);
    expect(jsonParse.mock.calls.some(([text]) => text === frame)).toBe(false);
    expect(frames).toHaveLength(0);
  });

  it('counts UTF-8 bytes, not characters', async () => {
    const { socket, frames } = await connected();
    // Few enough characters to be well under the limit as a string length, yet over it in bytes.
    const over = frameOfSize(MAX_FRAME_BYTES + 1, 'é');
    expect(over.length).toBeLessThan(MAX_FRAME_BYTES);
    expect(bytes(over)).toBe(MAX_FRAME_BYTES + 1);
    socket.push(over);
    const exact = frameOfSize(MAX_FRAME_BYTES, 'é');
    expect(bytes(exact)).toBe(MAX_FRAME_BYTES);
    socket.push(exact);
    await Promise.resolve();
    await Promise.resolve();
    expect(parsed.calls).toEqual([exact]);
    expect(frames).toHaveLength(1);
  });

  it('drops a much larger frame and a binary frame, and keeps working', async () => {
    const { socket, frames } = await connected();
    socket.push('x'.repeat(5_000_000));
    socket.handlers.onMessage(new Uint8Array([91, 93]));
    socket.push('["NOTICE","still alive"]');
    await Promise.resolve();
    await Promise.resolve();
    expect(parsed.calls).toEqual(['["NOTICE","still alive"]']);
    expect(frames).toEqual([['NOTICE', 'still alive']]);
  });

  it('does not let a throwing subscriber stop the pool', async () => {
    const net = new MockNetwork();
    const pool = new RelayPool({ connector: net, addressCheck: 'platform' });
    const [url] = relayUrls('thrower', 1) as [string];
    net.configure(url);
    pool.onFrame(() => {
      throw new Error('subscriber fault');
    });
    const seen: string[] = [];
    pool.onFrame((_relay, frame) => seen.push(String(frame[0])));
    await pool.publish(makeWrapEvent(), [url]);
    net.socket(url)?.push('["NOTICE","x"]');
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual(['NOTICE']);
  });
});
