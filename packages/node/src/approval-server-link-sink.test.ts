// WP-D3 (desktop host): startApprovalServerWithLinkSink hands every one-shot session link to the
// sink the caller gives (the desktop app's pipe) instead of the OS browser opener, and the link works
// once, exactly as the opener's would.
import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  startApprovalServerWithLinkSink,
  type ApprovalServer,
  type ApprovalServerSource,
} from './index.js';

const source: ApprovalServerSource = {
  context: () => Promise.resolve(undefined),
  list: () => Promise.resolve([]),
  get: () => Promise.resolve(undefined),
  apply: () => Promise.reject(new Error('not here')),
};

const servers: ApprovalServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

function get(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: { host: `localhost:${String(port)}` },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('startApprovalServerWithLinkSink (WP-D3)', () => {
  it('sends the Home, first-run and join links to the sink, and each works once', async () => {
    const links: string[] = [];
    const server = await startApprovalServerWithLinkSink({ source }, (url) => {
      links.push(url);
      return Promise.resolve(true);
    });
    servers.push(server);
    await expect(server.openHome()).resolves.toBe(true);
    await expect(server.openFirstRun()).resolves.toBe(true);
    await expect(server.open()).resolves.toBe(true);
    expect(links.map((l) => new URL(l).pathname)).toEqual(['/settings/home', '/first-run', '/']);
    for (const link of links) {
      expect(link).toMatch(/^http:\/\/localhost:\d+\/[a-z/-]*\?t=[A-Za-z0-9_-]{43}$/);
      expect(link.startsWith(`${server.origin}/`)).toBe(true);
    }
    const home = new URL(links[0] ?? '');
    expect(await get(server.port, `${home.pathname}${home.search}`)).toBe(303);
    expect(await get(server.port, `${home.pathname}${home.search}`)).toBe(401);
  });

  it('resolves false when the sink could not deliver the link', async () => {
    const server = await startApprovalServerWithLinkSink({ source }, () => Promise.resolve(false));
    servers.push(server);
    await expect(server.openHome()).resolves.toBe(false);
    const failing = await startApprovalServerWithLinkSink({ source }, () =>
      Promise.reject(new Error('pipe closed')),
    );
    servers.push(failing);
    await expect(failing.openHome()).resolves.toBe(false);
  });
});
