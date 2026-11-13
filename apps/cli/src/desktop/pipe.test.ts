// WP-D3: fd 3 must be a pipe or a socket (never a file or a terminal); lines are bounded, strict
// UTF-8, and only exact shell messages get through.
import { execFileSync } from 'node:child_process';
import { closeSync, constants, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { createLineReader, desktopPipeOver, probePipeFd, type PipeStream } from './pipe.js';
import type { ShellMessage } from './protocol.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('probePipeFd', () => {
  it('missing when nothing is open on the fd', () => {
    expect(probePipeFd(987_654)).toBe('missing');
  });

  it('refused for a regular file (the link would land on disk)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'al-d3-'));
    dirs.push(dir);
    const fd = openSync(join(dir, 'f'), 'w');
    try {
      expect(probePipeFd(fd)).toBe('refused');
    } finally {
      closeSync(fd);
    }
  });

  it.skipIf(process.platform === 'win32')('ok for a pipe (FIFO)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'al-d3-'));
    dirs.push(dir);
    const fifo = join(dir, 'p');
    execFileSync('mkfifo', [fifo]);
    const fd = openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK);
    try {
      expect(probePipeFd(fd)).toBe('ok');
    } finally {
      closeSync(fd);
    }
  });

  it('ok for a socket, refused for anything else', () => {
    const stat = (fifo: boolean, socket: boolean) => () => ({
      isFIFO: () => fifo,
      isSocket: () => socket,
    });
    expect(probePipeFd(3, stat(false, true))).toBe('ok');
    expect(probePipeFd(3, stat(true, false))).toBe('ok');
    expect(probePipeFd(3, stat(false, false))).toBe('refused');
  });

  // REL051-CID: on Windows the shell's fd 3 is a named pipe, and Node's fstat reports it with no
  // file type at all (isFIFO and isSocket both false), so the core refused every start there.
  it('on Windows, ok for a named pipe (no file type); a file, terminal or folder stays refused', () => {
    const stat = (mode: number) => () => ({ isFIFO: () => false, isSocket: () => false, mode });
    expect(probePipeFd(3, stat(0), 'win32')).toBe('ok');
    expect(probePipeFd(3, stat(constants.S_IFREG | 0o666), 'win32')).toBe('refused');
    expect(probePipeFd(3, stat(constants.S_IFCHR | 0o666), 'win32')).toBe('refused');
    expect(probePipeFd(3, stat(constants.S_IFDIR | 0o777), 'win32')).toBe('refused');
    // Elsewhere a pipe always says so: no type is refused.
    expect(probePipeFd(3, stat(0), 'darwin')).toBe('refused');
    expect(probePipeFd(3, stat(0), 'linux')).toBe('refused');
  });
});

describe('createLineReader', () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

  it('splits lines across chunks', () => {
    const lines: string[] = [];
    const read = createLineReader(
      (l) => lines.push(l),
      () => lines.push('!'),
      16,
    );
    read(enc('ab'));
    read(enc('c\nde\n'));
    read(enc('f'));
    expect(lines).toEqual(['abc', 'de']);
    read(enc('\n'));
    expect(lines).toEqual(['abc', 'de', 'f']);
  });

  it('drops an over-long line up to its newline, then reads on', () => {
    const lines: string[] = [];
    const read = createLineReader(
      (l) => lines.push(l),
      () => lines.push('!'),
      4,
    );
    read(enc('abcd\nabcde'));
    read(enc('fgh\nok\n'));
    expect(lines).toEqual(['abcd', '!', 'ok']);
  });

  it('rejects a line that is not UTF-8', () => {
    const lines: string[] = [];
    const read = createLineReader(
      (l) => lines.push(l),
      () => lines.push('!'),
      16,
    );
    read(new Uint8Array([0xff, 0xfe, 0x0a, 0x61, 0x0a]));
    expect(lines).toEqual(['!', 'a']);
  });
});

/** A duplex whose written side is collected. */
function pair(): { stream: PipeStream & Duplex; written: string[]; feed(s: string): void } {
  const written: string[] = [];
  const stream = new Duplex({
    read() {},
    write(chunk: Buffer, _enc, done) {
      written.push(chunk.toString('utf8'));
      done();
    },
  });
  return { stream, written, feed: (s) => stream.push(Buffer.from(s, 'utf8')) };
}

describe('desktopPipeOver', () => {
  it('delivers exact shell messages and rejects everything else without its content', async () => {
    const { stream, feed } = pair();
    const pipe = desktopPipeOver(stream);
    const got: ShellMessage[] = [];
    let rejected = 0;
    pipe.onMessage((m) => got.push(m));
    pipe.onReject(() => (rejected += 1));
    feed('{"v":1,"type":"show","route":"home"}\n{"v":1,"type":"eval","code":"x"}\n');
    feed('garbage\n{"v":1,"type":"shutdown"}\n');
    await new Promise((r) => setImmediate(r));
    expect(got).toEqual([
      { v: 1, type: 'show', route: 'home' },
      { v: 1, type: 'shutdown' },
    ]);
    expect(rejected).toBe(2);
  });

  it('writes valid core messages only, and nothing after close', async () => {
    const { stream, written } = pair();
    const pipe = desktopPipeOver(stream);
    expect(pipe.send({ v: 1, type: 'approval-waiting', count: 1 })).toBe(true);
    expect(pipe.send({ v: 1, type: 'ready', sessionUrl: 'file:///etc/passwd' })).toBe(false);
    let closed = 0;
    pipe.onClose(() => (closed += 1));
    await pipe.close();
    expect(pipe.send({ v: 1, type: 'approval-waiting', count: 2 })).toBe(false);
    expect(written).toEqual(['{"v":1,"type":"approval-waiting","count":1}\n']);
    expect(closed).toBe(1);
  });

  it('reports the shell closing its end once', async () => {
    const { stream } = pair();
    const pipe = desktopPipeOver(stream);
    let closed = 0;
    pipe.onClose(() => (closed += 1));
    stream.push(null);
    stream.resume();
    stream.destroy();
    await new Promise((r) => setImmediate(r));
    expect(closed).toBe(1);
  });
});
