// U3-invite (S2; 08 §4 "An app host already running"): the 0600 handoff record and the one
// loopback handoff request `agentlink join` sends.
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
  parseAppHostRecord,
  pidAlive,
  readAppHostRecord,
  removeAppHostRecord,
  sendHandoff,
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
