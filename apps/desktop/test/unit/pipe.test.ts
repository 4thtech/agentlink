// The strict pipe client (src/main/pipe.ts): framing, size before parse, UTF-8, unknown messages.
import { describe, expect, it } from 'vitest';
import { PipeClient, type PipeViolation } from '../../src/main/pipe.js';
import { MAX_LINE_BYTES, type CoreMessage } from '../../src/shared/protocol.js';
import { FakeStream, SESSION_URL, readyLine } from './fakes.js';

function setup(): {
  stream: FakeStream;
  client: PipeClient;
  messages: CoreMessage[];
  violations: PipeViolation[];
  closes: number[];
} {
  const stream = new FakeStream();
  const messages: CoreMessage[] = [];
  const violations: PipeViolation[] = [];
  const closes: number[] = [];
  const client = new PipeClient(stream, {
    onMessage: (m) => messages.push(m),
    onViolation: (v) => violations.push(v),
    onClose: () => closes.push(1),
  });
  return { stream, client, messages, violations, closes };
}

const waiting = (n: number): string =>
  `${JSON.stringify({ v: 1, type: 'approval-waiting', count: n })}\n`;

describe('PipeClient', () => {
  it('delivers whole lines, split or batched across chunks', () => {
    const { stream, messages } = setup();
    const text = readyLine() + waiting(2);
    stream.push(text.slice(0, 10));
    stream.push(text.slice(10, 70));
    expect(messages).toEqual([]);
    stream.push(text.slice(70));
    expect(messages).toEqual([
      { v: 1, type: 'ready', sessionUrl: SESSION_URL },
      { v: 1, type: 'approval-waiting', count: 2 },
    ]);
  });

  it.each([
    ['unknown type', `${JSON.stringify({ v: 1, type: 'eval', code: '1' })}\n`],
    ['extra key', `${JSON.stringify({ v: 1, type: 'approval-waiting', count: 1, x: 1 })}\n`],
    ['empty line', '\n'],
    ['CRLF', `${waiting(1).slice(0, -1)}\r\n`],
    ['garbage', 'hello\n'],
  ])('closes the pipe on %s', (_name, text) => {
    const { stream, client, messages, violations, closes } = setup();
    stream.push(waiting(1));
    stream.push(text);
    stream.push(waiting(3));
    expect(messages).toEqual([{ v: 1, type: 'approval-waiting', count: 1 }]);
    expect(violations).toEqual(['message']);
    expect(closes).toEqual([1]);
    expect(client.closed).toBe(true);
    expect(stream.destroyed).toBe(true);
  });

  it('stops at the first violation inside one chunk', () => {
    const { stream, messages, violations } = setup();
    stream.push(`${waiting(1)}nope\n${waiting(2)}`);
    expect(messages).toHaveLength(1);
    expect(violations).toEqual(['message']);
  });

  it('refuses invalid UTF-8', () => {
    const { stream, violations } = setup();
    stream.push(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d, 0x0a]));
    expect(violations).toEqual(['encoding']);
  });

  it('refuses an oversize line before it ends (no newline needed)', () => {
    const { stream, violations, messages } = setup();
    const big = 'a'.repeat(MAX_LINE_BYTES / 2);
    stream.push(big);
    expect(violations).toEqual([]);
    stream.push(big);
    expect(violations).toEqual([]);
    stream.push('a');
    expect(violations).toEqual(['oversize']);
    stream.push('\n');
    expect(messages).toEqual([]);
  });

  it('refuses an oversize line that ends in the same chunk', () => {
    const { stream, violations } = setup();
    stream.push(`${'a'.repeat(MAX_LINE_BYTES + 1)}\n`);
    expect(violations).toEqual(['oversize']);
  });

  it('sends encoded messages and refuses after close', () => {
    const { stream, client } = setup();
    expect(client.send({ v: 1, type: 'show', route: 'home' })).toBe(true);
    expect(stream.written).toEqual(['{"v":1,"type":"show","route":"home"}\n']);
    client.close();
    expect(client.send({ v: 1, type: 'shutdown' })).toBe(false);
    expect(stream.written).toHaveLength(1);
  });

  it('reports a close by the other side once', () => {
    const { stream, closes, client } = setup();
    stream.emit('close');
    stream.emit('error', new Error('x'));
    expect(closes).toEqual([1]);
    expect(client.closed).toBe(true);
  });
});
