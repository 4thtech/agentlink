// U3-invite (S2; 08 §4 "An app host already running"): the 0600 handoff record and the one
// loopback handoff request `agentlink join` sends.
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { JOIN_HANDOFF_PATH } from '@4thtech-io/types/ui-contract/join';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  APP_HOST_FILE,
  HANDOFF_PATH,
  HOST_SHOW_PATH,
  HOST_YIELD_PATH,
  parseAppHostRecord,
  pidAlive,
  readAppHostRecord,
  removeAppHostRecord,
  desktopHostAppears,
  sendHandoff,
  showRunningApp,
  takeOverAppHost,
  writeAppHostRecord,
} from './app-host-record.js';

const POSIX = process.platform !== 'win32';
const TOKEN = 'T'.repeat(43);
const LINK = `https://agentlink.4thtech.io/i#${'Ab_-'.repeat(30)}`;
let home = '';

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agentlink-u3-invite-record-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const path = (): string => join(home, '.agentlink', APP_HOST_FILE);

describe('the handoff record', () => {
  it('round-trips with mode 0600 and holds only pid, port and the token', async () => {
    await writeAppHostRecord(home, { pid: process.pid, port: 50123, handoffToken: TOKEN });
    if (POSIX) expect((await stat(path())).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path(), 'utf8'))).toEqual({
      v: 1,
      pid: process.pid,
      port: 50123,
      handoffToken: TOKEN,
    });
    expect(await readAppHostRecord(home)).toEqual({
      pid: process.pid,
      port: 50123,
      handoffToken: TOKEN,
    });
  });

  it('ignores a missing, malformed, oversized, linked or non-private record', async () => {
    expect(await readAppHostRecord(home)).toBeUndefined();
    await mkdir(join(home, '.agentlink'), { recursive: true });
    for (const text of [
      'not json',
      '[]',
      JSON.stringify({ v: 1, pid: 1, port: 1 }),
      JSON.stringify({ v: 2, pid: 1, port: 1, handoffToken: TOKEN }),
      JSON.stringify({ v: 1, pid: 1, port: 70_000, handoffToken: TOKEN }),
      JSON.stringify({ v: 1, pid: 1, port: 1, handoffToken: 'short' }),
      JSON.stringify({ v: 1, pid: 1, port: 1, handoffToken: TOKEN, invite: LINK }),
      ' '.repeat(600),
    ]) {
      await writeFile(path(), text, { mode: 0o600 });
      expect(await readAppHostRecord(home), text.slice(0, 40)).toBeUndefined();
    }
    if (POSIX) {
      await writeFile(path(), JSON.stringify({ v: 1, pid: 1, port: 1, handoffToken: TOKEN }));
      await chmod(path(), 0o644);
      expect(await readAppHostRecord(home)).toBeUndefined();
      await rm(path());
      const other = join(home, 'other.json');
      await writeFile(other, JSON.stringify({ v: 1, pid: 1, port: 1, handoffToken: TOKEN }), {
        mode: 0o600,
      });
      await symlink(other, path());
      expect(await readAppHostRecord(home)).toBeUndefined();
    }
  });

  it('is removed only by the process that wrote it', async () => {
    await writeAppHostRecord(home, { pid: 999_999, port: 50123, handoffToken: TOKEN });
    await removeAppHostRecord(home, process.pid);
    expect(await readAppHostRecord(home)).toBeDefined();
    await removeAppHostRecord(home, 999_999);
    expect(await readAppHostRecord(home)).toBeUndefined();
  });

  it('parses strictly', () => {
    expect(
      parseAppHostRecord(JSON.stringify({ v: 1, pid: 3, port: 4, handoffToken: TOKEN })),
    ).toEqual({ pid: 3, port: 4, handoffToken: TOKEN });
    expect(
      parseAppHostRecord(JSON.stringify({ v: 1, pid: -3, port: 4, handoffToken: TOKEN })),
    ).toBeUndefined();
  });

  it('pidAlive is true for this process and false for a pid that does not exist', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2 ** 22 + 12_345)).toBe(false);
  });
});

describe('the one loopback handoff (08 §4)', () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  async function listen(
    status: number,
    body: unknown,
  ): Promise<{
    port: number;
    seen: {
      headers: IncomingHttpHeaders;
      url: string;
      body: string;
      method: string;
      remote: string;
    }[];
  }> {
    const seen: {
      headers: IncomingHttpHeaders;
      url: string;
      body: string;
      method: string;
      remote: string;
    }[] = [];
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen.push({
          headers: req.headers,
          url: req.url ?? '',
          method: req.method ?? '',
          body: Buffer.concat(chunks).toString('utf8'),
          remote: req.socket.remoteAddress ?? '',
        });
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    return { port: (server?.address() as AddressInfo).port, seen };
  }

  it('the path is the node handoff path (the shared samples)', () => {
    expect(HANDOFF_PATH).toBe(JOIN_HANDOFF_PATH);
  });

  it('sends exactly one POST to 127.0.0.1 with Host localhost:<port>, the token, no Origin or cookie', async () => {
    const { port, seen } = await listen(200, { status: 'waiting', opened: true });
    expect(await sendHandoff({ pid: 1, port, handoffToken: TOKEN }, LINK)).toBe('waiting');
    expect(seen).toHaveLength(1);
    const [req] = seen;
    expect(req?.method).toBe('POST');
    expect(req?.url).toBe('/api/ui/join/handoff');
    expect(req?.remote).toMatch(/127\.0\.0\.1/);
    expect(req?.headers['host']).toBe(`localhost:${String(port)}`);
    expect(req?.headers['x-agentlink-handoff']).toBe(TOKEN);
    expect(req?.headers['content-type']).toBe('application/octet-stream');
    expect(req?.headers['origin']).toBeUndefined();
    expect(req?.headers['cookie']).toBeUndefined();
    expect(Object.keys(req?.headers ?? {}).filter((h) => h.startsWith('sec-fetch-'))).toEqual([]);
    // The invite only in the body: never in the URL or a header.
    expect(JSON.parse(req?.body ?? '')).toEqual({ invite: LINK });
    expect(req?.url).not.toContain('Ab_-');
    expect(JSON.stringify(req?.headers)).not.toContain('Ab_-');
  });

  it('maps the answers: invite_waiting, and anything else is failed', async () => {
    const waiting = await listen(409, { error: 'invite_waiting' });
    expect(await sendHandoff({ pid: 1, port: waiting.port, handoffToken: TOKEN }, LINK)).toBe(
      'invite_waiting',
    );
    server?.close();
    const refused = await listen(401, { error: 'refused' });
    expect(await sendHandoff({ pid: 1, port: refused.port, handoffToken: TOKEN }, LINK)).toBe(
      'failed',
    );
    server?.close();
    server = undefined;
    // Nothing listening.
    expect(await sendHandoff({ pid: 1, port: refused.port, handoffToken: TOKEN }, LINK, 500)).toBe(
      'failed',
    );
  });
});

// APP-CONTINUITY (owner requirement 14 Nov; 08 §1 "One AgentLink, browser or app"; 08 §4): the
// desktop app takes over a running `agentlink ui` host cleanly (it asks it to close over the same
// loopback, with the record's token, and waits for it to end), a stale record (its process gone, a
// crash) is cleared, and terminal `agentlink ui` shows the running app's window instead of starting
// a second host. The desktop's record says `host: "desktop"`.
describe('APP-CONTINUITY: take over or show the running host', () => {
  let server: Server | undefined;
  let child: ChildProcess | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
    child?.kill('SIGKILL');
    child = undefined;
  });

  /** A host stand-in: answers `status`, then calls `onCall` (a yield ends the child process). */
  async function hostAt(
    status: number,
    body: unknown,
    onCall: (url: string) => void = () => undefined,
  ): Promise<{
    port: number;
    seen: { url: string; headers: IncomingHttpHeaders; body: string }[];
  }> {
    const seen: { url: string; headers: IncomingHttpHeaders; body: string }[] = [];
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const url = req.url ?? '';
        seen.push({ url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
        onCall(url);
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    return { port: (server?.address() as AddressInfo).port, seen };
  }
  const sleeper = (): ChildProcess => {
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    return child;
  };

  it('the desktop record carries host "desktop"; a ui record has no host; both parse', async () => {
    await writeAppHostRecord(home, { pid: 7, port: 8, handoffToken: TOKEN, host: 'desktop' });
    expect(JSON.parse(await readFile(path(), 'utf8'))).toEqual({
      v: 1,
      pid: 7,
      port: 8,
      handoffToken: TOKEN,
      host: 'desktop',
    });
    expect(await readAppHostRecord(home)).toEqual({
      pid: 7,
      port: 8,
      handoffToken: TOKEN,
      host: 'desktop',
    });
    expect(
      parseAppHostRecord(JSON.stringify({ v: 1, pid: 3, port: 4, handoffToken: TOKEN, host: 'x' })),
    ).toBeUndefined();
  });

  it('no record, or this process’s own: nothing to take over', async () => {
    expect(await takeOverAppHost(home)).toBe('none');
    await writeAppHostRecord(home, { pid: process.pid, port: 9, handoffToken: TOKEN });
    expect(await takeOverAppHost(home)).toBe('none');
  });

  it('a stale record (its process is gone, e.g. after a crash) is removed', async () => {
    await writeAppHostRecord(home, { pid: 2 ** 22 + 12_345, port: 9, handoffToken: TOKEN });
    expect(await takeOverAppHost(home)).toBe('stale');
    expect(await readAppHostRecord(home)).toBeUndefined();
  });

  it('a running `agentlink ui` host is asked to close (token, empty body) and is waited for', async () => {
    const proc = sleeper();
    const h = await hostAt(200, { status: 'yielding' }, () => proc.kill('SIGTERM'));
    await writeAppHostRecord(home, { pid: proc.pid ?? 0, port: h.port, handoffToken: TOKEN });
    expect(await takeOverAppHost(home, { waitMs: 5_000 })).toBe('yielded');
    expect(h.seen).toHaveLength(1);
    expect(h.seen[0]?.url).toBe(HOST_YIELD_PATH);
    expect(h.seen[0]?.headers['x-agentlink-handoff']).toBe(TOKEN);
    expect(h.seen[0]?.headers['origin']).toBeUndefined();
    expect(h.seen[0]?.body).toBe('');
    expect(pidAlive(proc.pid ?? 0)).toBe(false);
  });

  it('an older host without the takeover (404), or another desktop app: kept, both keep working', async () => {
    const proc = sleeper();
    const h = await hostAt(404, { error: 'not_found' });
    await writeAppHostRecord(home, { pid: proc.pid ?? 0, port: h.port, handoffToken: TOKEN });
    expect(await takeOverAppHost(home, { waitMs: 200 })).toBe('kept');
    await writeAppHostRecord(home, {
      pid: proc.pid ?? 0,
      port: h.port,
      handoffToken: TOKEN,
      host: 'desktop',
    });
    expect(await takeOverAppHost(home, { waitMs: 200 })).toBe('kept');
    // A desktop app is never asked to close.
    expect(h.seen.map((s) => s.url)).toEqual([HOST_YIELD_PATH]);
  });

  it('terminal `agentlink ui` shows a running desktop app instead of starting a second host', async () => {
    const proc = sleeper();
    const h = await hostAt(200, { status: 'shown' });
    await writeAppHostRecord(home, {
      pid: proc.pid ?? 0,
      port: h.port,
      handoffToken: TOKEN,
      host: 'desktop',
    });
    expect(await showRunningApp(home)).toBe('shown');
    expect(h.seen.map((s) => s.url)).toEqual([HOST_SHOW_PATH]);
    // A browser host (no `host`) or a stale desktop record: start as before.
    await writeAppHostRecord(home, { pid: proc.pid ?? 0, port: h.port, handoffToken: TOKEN });
    expect(await showRunningApp(home)).toBe('none');
    await writeAppHostRecord(home, {
      pid: 2 ** 22 + 12_345,
      port: h.port,
      handoffToken: TOKEN,
      host: 'desktop',
    });
    expect(await showRunningApp(home)).toBe('none');
    expect(h.seen).toHaveLength(1);
  });

  it('after a yield: the desktop host record appearing is seen; a terminal record is not', async () => {
    const proc = sleeper();
    await writeAppHostRecord(home, { pid: proc.pid ?? 0, port: 9, handoffToken: TOKEN });
    expect(await desktopHostAppears(home, 150)).toBe(false);
    setTimeout(() => {
      void writeAppHostRecord(home, {
        pid: proc.pid ?? 0,
        port: 9,
        handoffToken: TOKEN,
        host: 'desktop',
      });
    }, 100);
    expect(await desktopHostAppears(home, 3_000)).toBe(true);
  });
});
