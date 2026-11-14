// WP-D3 acceptance (desktop plan §4): the session link goes only to fd 3 (spies on stdout, stderr,
// console and the files under HOME); counts-only events; the invite is written nowhere; a terminal
// `agentlink join` hands off to a running desktop host; `show` is a fixed enum; clean shutdown.
import type {
  AppHostAgent,
  AppHostHandoffRecordValue,
  ApprovalServer,
  ApprovalServerOptions,
  ApprovalServerSource,
  PendingApprovalView,
} from '@4thtech-io/node';
import { INVITE_LINK_PREFIX } from '@4thtech-io/core';
import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { stderr, stdout } from 'node:process';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { joinStep, JOIN_TEXT, type JoinDeps } from '../commands/join.js';
import type { UiDeps, UiServer } from '../commands/ui.js';
import type { CommandContext } from '../dispatch.js';
import {
  APP_HOST_FILE,
  pidAlive,
  readAppHostRecord,
  removeAppHostRecord,
  sendHandoff,
  writeAppHostRecord,
} from '../runtime/app-host-record.js';
import { runDesktopHost, type DesktopHostDeps } from './host-core.js';
import type { DesktopPipe } from './pipe.js';
import type { HostMessage, ShellMessage } from './protocol.js';
import type { DesktopAlertState } from '@4thtech-io/node';
import { NOTIFY_DEFAULTS } from '@4thtech-io/types/ui-contract/notifications';

const INVITE = `${INVITE_LINK_PREFIX}SECRETinvitePAYLOAD_abc-123`;
const INVITE_MARK = 'SECRETinvitePAYLOAD';

/** Everything written to stdout, stderr and the console during a test. */
let printed: string[] = [];
let home = '';

beforeEach(async () => {
  printed = [];
  const keep = (chunk: unknown): boolean => {
    printed.push(String(chunk));
    return true;
  };
  // Spies only (they capture, nothing is written): every byte meant for stdout or stderr.
  vi.spyOn(stdout, 'write').mockImplementation(keep as never);
  vi.spyOn(stderr, 'write').mockImplementation(keep as never);
  for (const method of ['log', 'error', 'warn', 'info', 'debug'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(' '));
    });
  }
  home = await mkdtemp(join(tmpdir(), 'al-d3-home-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});

/** Every file's bytes under `dir`, as text. */
function filesUnder(dir: string): string {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return '';
  }
  let all = '';
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) all += filesUnder(path);
    else if (entry.isFile()) all += readFileSync(path, 'latin1');
  }
  return all;
}

/** A pipe double: what the core sent, and a way to send it shell messages. */
function fakePipe(): {
  pipe: DesktopPipe;
  sent: HostMessage[];
  shell(message: ShellMessage): void;
  closeFromShell(): void;
  closed: () => boolean;
} {
  const sent: HostMessage[] = [];
  const onMessage: ((m: ShellMessage) => void)[] = [];
  const onClose: (() => void)[] = [];
  let closed = false;
  return {
    sent,
    pipe: {
      send: (message) => {
        if (closed) return false;
        sent.push(message);
        return true;
      },
      onMessage: (l) => void onMessage.push(l),
      onReject: () => undefined,
      onClose: (l) => void onClose.push(l),
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    },
    shell: (m) => {
      for (const l of onMessage) l(m);
    },
    closeFromShell: () => {
      for (const l of onClose) l();
    },
    closed: () => closed,
  };
}

/** The approval server stand-in: real loopback handoff route, links minted like the real one. */
/** N7: what a test's server answers for the desktop alerts (undefined: no centre). */
interface FakeAlerts {
  state: () => DesktopAlertState | undefined;
  names?: ReadonlyMap<string, string>;
  /** The refs ownerNames was asked for. */
  asked?: string[][];
}

async function fakeServer(
  options: ApprovalServerOptions,
  sink: (url: string) => Promise<boolean>,
  log: string[],
  alerts?: FakeAlerts,
): Promise<ApprovalServer> {
  const token = 'H'.repeat(43);
  let joinInvite: string | undefined;
  let n = 0;
  const mint = (): string => `${'t'.repeat(40)}${String(100 + (n++ % 900))}`;
  const http: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.url !== '/api/ui/join/handoff' || req.headers['x-agentlink-handoff'] !== token) {
        res.writeHead(401).end('{"error":"refused"}');
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { invite: string };
      if (joinInvite !== undefined) {
        res.writeHead(409).end('{"error":"invite_waiting"}');
        return;
      }
      joinInvite = body.invite;
      log.push('handoff');
      void sink(`${origin}/settings/join?t=${mint()}`).then((opened) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'waiting', opened }));
      });
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as AddressInfo).port;
  const origin = `http://localhost:${String(port)}`;
  await options.host?.handoff?.write({ pid: process.pid, port, handoffToken: token });
  let current: AppHostAgent | undefined;
  const server = {
    origin,
    port,
    activity: { lastAt: () => 0, openStreams: () => 1, linksUsed: () => 0 },
    open: (approvalId?: string) =>
      sink(`${origin}${approvalId === undefined ? '/' : `/approve/${approvalId}`}?t=${mint()}`),
    openPerson: (contactId: string) => sink(`${origin}/?t=${mint()}#person=${contactId}`),
    openHome: () => sink(`${origin}/settings/home?t=${mint()}`),
    openFirstRun: () => sink(`${origin}/first-run?t=${mint()}`),
    openJoin: () => sink(`${origin}/settings/join?t=${mint()}`),
    openUpdates: () => sink(`${origin}/settings/updates?t=${mint()}`),
    desktopAlerts: () => Promise.resolve(alerts?.state()),
    ownerNames: (refs: readonly string[]) => {
      alerts?.asked?.push([...refs]);
      return Promise.resolve(alerts?.names ?? new Map<string, string>());
    },
    /** Test only: the app switches to `name` (D-138). */
    switchTo: async (name: string) => {
      await current?.close();
      current = await options.host?.open(name);
    },
    waitingInvite: () => joinInvite,
    close: async () => {
      log.push('server closed');
      await options.host?.handoff?.remove();
      await current?.close();
      await options.host?.initial?.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
  return server as unknown as ApprovalServer;
}

/** Pending approvals: a number (apr_0 …) or their IDs; a function is read on each list. */
type Pending = number | readonly string[];
function source(pending: Pending | (() => Pending)): ApprovalServerSource {
  const ids = (): readonly string[] => {
    const now = typeof pending === 'function' ? pending() : pending;
    return typeof now === 'number'
      ? Array.from({ length: now }, (_, i) => `apr_${String(i)}`)
      : now;
  };
  return {
    context: () => Promise.resolve(undefined),
    list: () =>
      Promise.resolve(
        ids().map((approvalId) => ({ approvalId }) as unknown as PendingApprovalView),
      ),
    get: () => Promise.resolve(undefined),
    apply: () => Promise.reject(new Error('x')),
  };
}

interface Setup {
  deps: DesktopHostDeps;
  pipe: ReturnType<typeof fakePipe>;
  log: string[];
  server(): ApprovalServer & {
    switchTo(name: string): Promise<void>;
    waitingInvite(): string | undefined;
  };
  handoffs: { record: AppHostHandoffRecordValue; link: string }[];
  stopSignal(): void;
  /** N7: the server options the host started the server with. */
  options(): ApprovalServerOptions | undefined;
}

function setup(
  over: {
    start?: UiDeps['start'];
    pending?: Pending | (() => Pending);
    /** The approvals of any other ID the app switches to (default 5). */
    other?: Pending | (() => Pending);
    failure?: 'no_owner';
    alerts?: FakeAlerts;
  } = {},
): Setup {
  const pipe = fakePipe();
  const log: string[] = [];
  let made: ApprovalServer | undefined;
  let startedWith: ApprovalServerOptions | undefined;
  const handoffs: Setup['handoffs'] = [];
  let signal: () => void = () => undefined;
  const deps: DesktopHostDeps = {
    pipe: pipe.pipe,
    uiDeps: (startServer) => ({
      waitMs: 1,
      interrupt: () => () => undefined,
      diagnose: () => Promise.resolve(over.failure ?? 'failed'),
      start:
        over.start ??
        (async (): Promise<UiServer | undefined> => {
          if (over.failure !== undefined) return undefined;
          const server = await startServer({
            source: source(over.pending ?? 0),
            host: {
              directory: {} as never,
              initial: {
                name: 'default',
                label: 'default',
                source: source(over.pending ?? 0),
                localUi: {} as never,
                close: () => Promise.resolve(),
              },
              open: (name) =>
                Promise.resolve({
                  name,
                  label: name,
                  source: source(over.other ?? 5),
                  localUi: {} as never,
                  close: () => Promise.resolve(),
                } as AppHostAgent),
              handoff: {
                write: (record) => writeAppHostRecord(home, record),
                remove: () => removeAppHostRecord(home),
              },
            },
          });
          return {
            page: 'home',
            activity: server.activity,
            open: () => server.openHome(),
            close: () => server.close(),
          };
        }),
    }),
    startServer: async (options, sink) => {
      startedWith = options;
      made = await fakeServer(options, sink, log, over.alerts);
      return made;
    },
    invite: {
      resolve: (link) => Promise.resolve(link),
      check: () => Promise.resolve({}),
      now: () => 1_700_000_000,
      handoff: (record, link) => {
        handoffs.push({ record, link });
        return sendHandoff(record, link);
      },
    },
    interrupt: (stop) => {
      signal = stop;
      return () => undefined;
    },
    statusEveryMs: 10,
  };
  return {
    deps,
    pipe,
    log,
    server: () => made as never,
    handoffs,
    stopSignal: () => signal(),
    options: () => startedWith,
  };
}

const until = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 300 && !check(); i += 1) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
};

const readies = (sent: HostMessage[]): string[] =>
  sent.flatMap((m) => (m.type === 'ready' ? [m.sessionUrl] : []));

describe('runDesktopHost (WP-D3)', () => {
  it('sends the session link only over the pipe: never stdout, stderr, the console or a file', async () => {
    const s = setup();
    const run = runDesktopHost(s.deps);
    await until(() => readies(s.pipe.sent).length === 1);
    const [link] = readies(s.pipe.sent);
    expect(link).toMatch(/^http:\/\/localhost:\d+\/settings\/home\?t=t{40}\d{3}$/);
    const token = new URL(link ?? '').searchParams.get('t') ?? '';
    // app-host.json is there (join's handoff) and holds no link.
    expect(await readAppHostRecord(home)).toBeDefined();
    const files = filesUnder(home);
    expect(files).not.toContain(token);
    expect(files).not.toContain('localhost');
    s.pipe.shell({ v: 1, type: 'shutdown' });
    await expect(run).resolves.toBe(0);
    const out = printed.join('\n');
    expect(out).not.toContain(token);
    expect(out).not.toContain('localhost');
    // Every message other than `ready` carries no link and no text.
    for (const m of s.pipe.sent.filter((x) => x.type !== 'ready')) {
      expect(JSON.stringify(m)).not.toMatch(/localhost|t{40}/);
    }
  });

  it('status and approval-waiting carry counts and states only', async () => {
    const s = setup({ pending: 2 });
    const run = runDesktopHost(s.deps);
    await until(() => s.pipe.sent.some((m) => m.type === 'approval-waiting'));
    expect(s.pipe.sent[0]).toEqual({
      v: 1,
      type: 'status',
      state: 'starting',
      counts: { openPages: 0, waitingApprovals: 0 },
    });
    expect(s.pipe.sent).toContainEqual({ v: 1, type: 'approval-waiting', count: 2 });
    expect(s.pipe.sent).toContainEqual({
      v: 1,
      type: 'status',
      state: 'running',
      counts: { openPages: 1, waitingApprovals: 2 },
    });
    // An agent switch (D-138): the counts follow the open agent.
    await s.server().switchTo('work');
    await until(() => s.pipe.sent.some((m) => m.type === 'approval-waiting' && m.count === 5));
    s.pipe.shell({ v: 1, type: 'shutdown' });
    await run;
    for (const m of s.pipe.sent) {
      if (m.type === 'status')
        expect(Object.keys(m.counts).sort()).toEqual(['openPages', 'waitingApprovals']);
      expect(JSON.stringify(m)).not.toMatch(/work|default/);
    }
  });

  it('show opens fixed pages only (a fresh one-shot link each time)', async () => {
    const s = setup();
    const run = runDesktopHost(s.deps);
    await until(() => readies(s.pipe.sent).length === 1);
    s.pipe.shell({ v: 1, type: 'show', route: 'approvals' });
    s.pipe.shell({ v: 1, type: 'show', route: 'join' });
    s.pipe.shell({ v: 1, type: 'show', route: 'home' });
    await until(() => readies(s.pipe.sent).length === 4);
    const urls = readies(s.pipe.sent);
    expect(urls.map((u) => new URL(u).pathname)).toEqual([
      '/settings/home',
      '/',
      '/settings/join',
      '/settings/home',
    ]);
    expect(new Set(urls).size).toBe(4);
    s.pipe.shell({ v: 1, type: 'shutdown' });
    await run;
  });

  it('an invite from the shell is checked, handed to its own server and written nowhere', async () => {
    const s = setup();
    const resolve = vi.fn((link: string) => Promise.resolve(link));
    s.deps = { ...s.deps, invite: { ...s.deps.invite, resolve } };
    const run = runDesktopHost(s.deps);
    await until(() => readies(s.pipe.sent).length === 1);
    s.pipe.shell({ v: 1, type: 'invite', link: INVITE });
    await until(() => s.pipe.sent.some((m) => m.type === 'invite-result'));
    expect(s.pipe.sent).toContainEqual({ v: 1, type: 'invite-result', outcome: 'waiting' });
    expect(resolve).toHaveBeenCalledWith(INVITE);
    // Handed to this host's own server with the record it wrote.
    expect(s.handoffs).toHaveLength(1);
    expect(s.handoffs[0]?.record).toEqual(await readAppHostRecord(home));
    expect(s.server().waitingInvite()).toBe(INVITE);
    // The join screen opens in the window.
    await until(() => readies(s.pipe.sent).length === 2);
    expect(new URL(readies(s.pipe.sent)[1] ?? '').pathname).toBe('/settings/join');
    // Never in a file, stdout, stderr, the console, or any message back to the shell.
    expect(filesUnder(home)).not.toContain(INVITE_MARK);
    s.pipe.shell({ v: 1, type: 'shutdown' });
    await run;
    expect(printed.join('\n')).not.toContain(INVITE_MARK);
    expect(JSON.stringify(s.pipe.sent)).not.toContain(INVITE_MARK);
  });

  it('a second invite while one waits, an expired or a bad one: a fixed outcome word', async () => {
    const s = setup();
    let expired = false;
    s.deps = {
      ...s.deps,
      invite: {
        ...s.deps.invite,
        check: () =>
          expired
            ? Promise.reject(Object.assign(new Error('x'), { code: 'invite_expired' }))
            : Promise.resolve({}),
      },
    };
    const run = runDesktopHost(s.deps);
    await until(() => readies(s.pipe.sent).length === 1);
    s.pipe.shell({ v: 1, type: 'invite', link: INVITE });
    s.pipe.shell({ v: 1, type: 'invite', link: INVITE });
    await until(() => s.pipe.sent.filter((m) => m.type === 'invite-result').length === 2);
    expired = true;
    s.pipe.shell({ v: 1, type: 'invite', link: INVITE });
    await until(() => s.pipe.sent.filter((m) => m.type === 'invite-result').length === 3);
    expect(s.pipe.sent.flatMap((m) => (m.type === 'invite-result' ? [m.outcome] : []))).toEqual([
      'waiting',
      'invite_waiting',
      'expired',
    ]);
    s.pipe.shell({ v: 1, type: 'shutdown' });
    await run;
  });

  it('a terminal `agentlink join` hands its invite to the running desktop host', async () => {
    const s = setup();
    const run = runDesktopHost(s.deps);
    await until(() => readies(s.pipe.sent).length === 1);
    const lines: string[] = [];
    const context = {
      parsed: { positionals: [INVITE] },
      // Run by an AI (no TTY): a running host still takes the invite.
      terminal: { stdinIsTTY: false, stdoutIsTTY: false, env: {} },
      output: {
        print: (l: string) => lines.push(l),
        printError: (l: string) => lines.push(l),
      },
    } as unknown as CommandContext;
    const joinDeps: JoinDeps = {
      resolve: (link) => Promise.resolve(link),
      check: () => Promise.resolve({}),
      now: () => 1_700_000_000,
      readRecord: () => readAppHostRecord(home),
      alive: pidAlive,
      handoff: (record, link) => sendHandoff(record, link),
      ui: {} as UiDeps,
    };
    await expect(joinStep(context, joinDeps, 'agentlink')).resolves.toBe(0);
    expect(lines).toEqual([JOIN_TEXT.handedOff]);
    expect(s.server().waitingInvite()).toBe(INVITE);
    // The page opens in the app window, over the pipe.
    await until(() => readies(s.pipe.sent).length === 2);
    expect(new URL(readies(s.pipe.sent)[1] ?? '').pathname).toBe('/settings/join');
    s.pipe.shell({ v: 1, type: 'shutdown' });
    await run;
  });

  it('shutdown: closes the server, removes app-host.json, sends stopped, closes the pipe, exits 0', async () => {
    const s = setup();
    const run = runDesktopHost(s.deps);
    await until(() => readies(s.pipe.sent).length === 1);
    expect(existsSync(join(home, '.agentlink', APP_HOST_FILE))).toBe(true);
    s.pipe.shell({ v: 1, type: 'shutdown' });
    await expect(run).resolves.toBe(0);
    expect(s.log).toContain('server closed');
    expect(existsSync(join(home, '.agentlink', APP_HOST_FILE))).toBe(false);
    expect(s.pipe.sent.at(-1)).toEqual({ v: 1, type: 'stopped', reason: 'shutdown' });
    expect(s.pipe.sent).toContainEqual(
      expect.objectContaining({ type: 'status', state: 'closing' }),
    );
    expect(s.pipe.closed()).toBe(true);
  });

  it('the shell going away or a stop signal ends the run cleanly', async () => {
    const a = setup();
    const runA = runDesktopHost(a.deps);
    await until(() => readies(a.pipe.sent).length === 1);
    a.pipe.closeFromShell();
    await expect(runA).resolves.toBe(0);
    expect(a.log).toContain('server closed');
    const b = setup();
    const runB = runDesktopHost(b.deps);
    await until(() => readies(b.pipe.sent).length === 1);
    b.stopSignal();
    await expect(runB).resolves.toBe(0);
    expect(b.pipe.sent.at(-1)).toEqual({ v: 1, type: 'stopped', reason: 'signal' });
  });

  it('when nothing can start: stopped with the reason, no link, exit 1', async () => {
    const s = setup({ failure: 'no_owner' });
    await expect(runDesktopHost(s.deps)).resolves.toBe(1);
    expect(readies(s.pipe.sent)).toEqual([]);
    expect(s.pipe.sent.at(-1)).toEqual({ v: 1, type: 'stopped', reason: 'no_owner' });
    expect(s.pipe.closed()).toBe(true);
  });

  it('DESK051-UPD: keeps the shell’s update state for Settings and asks the shell to check', async () => {
    const s = setup();
    let options: ApprovalServerOptions | undefined;
    const start = s.deps.startServer;
    const deps: DesktopHostDeps = {
      ...s.deps,
      startServer: (o, sink) => {
        options = o;
        return start(o, sink);
      },
    };
    const run = runDesktopHost(deps);
    await until(() => readies(s.pipe.sent).length === 1);
    const desk = options?.appUpdate;
    expect(desk).toBeDefined();
    // REL051-UPD2: the page shows the desktop app's own action (Download update).
    expect(desk?.install).toBe('desktop');
    // Nothing yet from the shell: no state, and a check asks nothing.
    expect(desk?.view()).toBeUndefined();
    expect(desk?.check()).toBeUndefined();
    expect(s.pipe.sent.some((m) => m.type === 'app-update-check')).toBe(false);
    const DMG =
      'https://github.com/4thtech/agentlink/releases/download/v0.5.2/AgentLink-0.5.2-mac-arm64.dmg';
    s.pipe.shell({
      v: 1,
      type: 'app-update',
      state: 'available',
      current: '0.5.1',
      latest: '0.5.2',
      download: DMG,
      installable: false,
      percent: 0,
    });
    expect(desk?.view()).toEqual({
      state: 'available',
      current: '0.5.1',
      latest: '0.5.2',
      download: DMG,
      installable: false,
      percent: 0,
    });
    // UPD-5: not installable here: Update now asks nothing.
    expect(desk?.startInstall?.()).toMatchObject({ state: 'available' });
    expect(s.pipe.sent.some((m) => m.type === 'app-update-install')).toBe(false);
    // A check: one message with no other key, and "checking" (no link) meanwhile.
    expect(desk?.check()).toEqual({
      state: 'checking',
      current: '0.5.1',
      latest: '',
      download: '',
      installable: false,
      percent: 0,
    });
    expect(s.pipe.sent.filter((m) => m.type === 'app-update-check')).toEqual([
      { v: 1, type: 'app-update-check' },
    ]);
    // Off (development build or policy): never asks.
    s.pipe.shell({
      v: 1,
      type: 'app-update',
      state: 'off',
      current: '0.5.1',
      latest: '',
      download: '',
      installable: false,
      percent: 0,
    });
    expect(desk?.check()).toEqual({
      state: 'off',
      current: '0.5.1',
      latest: '',
      download: '',
      installable: false,
      percent: 0,
    });
    expect(s.pipe.sent.filter((m) => m.type === 'app-update-check')).toHaveLength(1);
    s.pipe.shell({ v: 1, type: 'shutdown' });
    await expect(run).resolves.toBe(0);
  });

  it('UPD-5: Update now and Restart now go to the shell as bare messages, only in their state', async () => {
    const s = setup();
    let options: ApprovalServerOptions | undefined;
    const start = s.deps.startServer;
    const run = runDesktopHost({
      ...s.deps,
      startServer: (o, sink) => {
        options = o;
        return start(o, sink);
      },
    });
    await until(() => readies(s.pipe.sent).length === 1);
    const desk = options?.appUpdate;
    const DMG =
      'https://github.com/4thtech/agentlink/releases/download/v0.5.3/AgentLink-0.5.3-mac-arm64.dmg';
    const base = {
      v: 1,
      type: 'app-update',
      current: '0.5.2',
      latest: '0.5.3',
      download: DMG,
      installable: true,
      percent: 0,
    } as const;
    // Restart before anything is ready: nothing sent.
    s.pipe.shell({ ...base, state: 'available' });
    expect(desk?.restart?.()).toMatchObject({ state: 'available' });
    expect(desk?.startInstall?.()).toMatchObject({ state: 'downloading', percent: 0 });
    expect(desk?.startInstall?.()).toMatchObject({ state: 'downloading' });
    expect(s.pipe.sent.filter((m) => m.type === 'app-update-install')).toEqual([
      { v: 1, type: 'app-update-install' },
    ]);
    s.pipe.shell({ ...base, state: 'ready' });
    expect(desk?.restart?.()).toMatchObject({ state: 'restarting' });
    expect(desk?.restart?.()).toMatchObject({ state: 'restarting' });
    expect(s.pipe.sent.filter((m) => m.type === 'app-update-restart')).toEqual([
      { v: 1, type: 'app-update-restart' },
    ]);
    // The safe-to-stop signal: no request waiting for the owner here.
    expect(desk?.busy?.()).toBe(false);
    s.pipe.shell({ v: 1, type: 'shutdown' });
    await expect(run).resolves.toBe(0);
  });

  it('the sink refuses anything that is not a session link of its own server', async () => {
    const s = setup({
      start: () =>
        Promise.resolve({
          page: 'home',
          open: () => Promise.resolve(true),
          close: () => Promise.resolve(),
        }),
    });
    let sinkOf: ((url: string) => Promise<boolean>) | undefined;
    const uiDeps = s.deps.uiDeps;
    s.deps = {
      ...s.deps,
      uiDeps: (startServer) => {
        const ui = uiDeps(startServer);
        return {
          ...ui,
          start: async () => {
            await startServer({ source: source(0) });
            return {
              page: 'home',
              open: () => Promise.resolve(true),
              close: () => Promise.resolve(),
            };
          },
        };
      },
      startServer: (options, sink) => {
        sinkOf = sink;
        return fakeServer(options, sink, s.log);
      },
    };
    const run = runDesktopHost(s.deps);
    await until(
      () =>
        sinkOf !== undefined &&
        s.pipe.sent.some((m) => m.type === 'status' && m.state === 'running'),
    );
    const t = 'A'.repeat(43);
    await expect(sinkOf?.(`http://localhost:1/approve/x?t=${t}`)).resolves.toBe(false);
    await expect(sinkOf?.(`https://evil.example/?t=${t}`)).resolves.toBe(false);
    // The right form, but not this server's port.
    await expect(sinkOf?.(`http://localhost:1/?t=${t}`)).resolves.toBe(false);
    expect(readies(s.pipe.sent)).toEqual([]);
    s.pipe.shell({ v: 1, type: 'shutdown' });
    await run;
  });
});

describe('N7: native notifications from the desktop host', () => {
  const A = `0x${'a'.repeat(40)}`;
  const notifies = (sent: HostMessage[]): HostMessage[] => sent.filter((m) => m.type === 'notify');

  it('the desktop app owns notifications: its server never shows the osascript/notify-send alert', async () => {
    const s = setup();
    const run = runDesktopHost(s.deps);
    await until(() => readies(s.pipe.sent).length === 1);
    expect(await s.options()?.approvalAlerts?.()).toBe(false);
    s.pipe.shell({ v: 1, type: 'shutdown' });
    await run;
  });

  it('a new approval: one notify with the number waiting (D2: approvals on); nothing at start', async () => {
    let pending = 1;
    const s = setup({
      pending: () => pending,
      alerts: { state: () => ({ scope: 'default', items: [], prefs: { ...NOTIFY_DEFAULTS } }) },
    });
    const run = runDesktopHost(s.deps);
    await until(() => s.pipe.sent.some((m) => m.type === 'approval-waiting'));
    await new Promise((r) => setTimeout(r, 40));
    // Already waiting at start: the window opens on Home; no alert for it.
    expect(notifies(s.pipe.sent)).toEqual([]);
    pending = 2;
    await until(() => notifies(s.pipe.sent).length === 1);
    expect(notifies(s.pipe.sent)).toEqual([
      { v: 1, type: 'notify', kind: 'approvals', count: 2, name: '' },
    ]);
    s.pipe.shell({ v: 1, type: 'shutdown' });
    await run;
  });

  it('the switches are respected: approvals off → no notify', async () => {
    let pending = 0;
    const s = setup({
      pending: () => pending,
      alerts: {
        state: () => ({
          scope: 'default',
          items: [],
          prefs: { ...NOTIFY_DEFAULTS, approvals: false },
        }),
      },
    });
    const run = runDesktopHost(s.deps);
    await until(() => s.pipe.sent.some((m) => m.type === 'approval-waiting'));
    pending = 3;
    await until(() => s.pipe.sent.some((m) => m.type === 'approval-waiting' && m.count === 3));
    await new Promise((r) => setTimeout(r, 40));
    expect(notifies(s.pipe.sent)).toEqual([]);
    s.pipe.shell({ v: 1, type: 'shutdown' });
    await run;
  });

  it('new messages with Show names on: the owner-given name, asked only for that person', async () => {
    let count = 0;
    const asked: string[][] = [];
    const s = setup({
      alerts: {
        state: () => ({
          scope: 'default',
          items:
            count === 0
              ? []
              : [
                  {
                    id: `messages-${A}`,
                    kind: 'messages',
                    ref: A,
                    count,
                    at: 10 + count,
                    read: false,
                  },
                ],
          prefs: { ...NOTIFY_DEFAULTS, messages: true, showNames: true },
        }),
        names: new Map([[A, 'Ana']]),
        asked,
      },
    });
    const run = runDesktopHost(s.deps);
    await until(() => readies(s.pipe.sent).length === 1);
    await new Promise((r) => setTimeout(r, 30));
    count = 2;
    await until(() => notifies(s.pipe.sent).length === 1);
    expect(notifies(s.pipe.sent)).toEqual([
      { v: 1, type: 'notify', kind: 'messages', count: 2, name: 'Ana', target: A },
    ]);
    expect(asked).toEqual([[A]]);
    s.pipe.shell({ v: 1, type: 'shutdown' });
    await run;
  });

  it('show inbox and updates open fixed pages only', async () => {
    const s = setup();
    const run = runDesktopHost(s.deps);
    await until(() => readies(s.pipe.sent).length === 1);
    s.pipe.shell({ v: 1, type: 'show', route: 'inbox' });
    s.pipe.shell({ v: 1, type: 'show', route: 'updates' });
    await until(() => readies(s.pipe.sent).length === 3);
    expect(readies(s.pipe.sent).map((u) => new URL(u).pathname)).toEqual([
      '/settings/home',
      '/',
      '/settings/updates',
    ]);
    s.pipe.shell({ v: 1, type: 'shutdown' });
    await run;
  });

  it('NOTIFY-DEEPLINK: a show with a target opens that request or person; a bad one the page', async () => {
    const s = setup();
    const run = runDesktopHost(s.deps);
    await until(() => readies(s.pipe.sent).length === 1);
    const apr = `apr_${'A'.repeat(22)}`;
    const person = `0x${'ab'.repeat(20)}`;
    s.pipe.shell({ v: 1, type: 'show', route: 'approvals', target: apr });
    s.pipe.shell({ v: 1, type: 'show', route: 'inbox', target: person });
    s.pipe.shell({ v: 1, type: 'show', route: 'inbox' });
    await until(() => readies(s.pipe.sent).length === 4);
    const urls = readies(s.pipe.sent)
      .slice(1)
      .map((u) => new URL(u));
    expect(urls.map((u) => u.pathname)).toEqual([`/approve/${apr}`, '/', '/']);
    expect(urls.map((u) => u.hash)).toEqual(['', `#person=${person}`, '']);
    s.pipe.shell({ v: 1, type: 'shutdown' });
    await run;
  });

  /** A record double: what was written (the ID) and removed. */
  const recordDouble = (marks: string[]) => ({
    write: (scope: string) => {
      marks.push(`write:${scope}`);
      return Promise.resolve();
    },
    remove: () => {
      marks.push('remove');
      return Promise.resolve();
    },
  });
  const prefs = { ...NOTIFY_DEFAULTS };

  it('marks itself as alerting for the open ID while it runs, and only then', async () => {
    const marks: string[] = [];
    const s = setup({ alerts: { state: () => ({ scope: 'default', items: [], prefs }) } });
    s.deps = { ...s.deps, alertsRecord: recordDouble(marks) };
    const run = runDesktopHost(s.deps);
    await until(() => marks.includes('write:default'));
    s.pipe.shell({ v: 1, type: 'shutdown' });
    await run;
    expect(marks).toEqual(['write:default', 'remove']);
  });

  it('IR-N7-1 L-3: a failed look keeps the baseline, so the first new approval is still alerted', async () => {
    let pending: string[] = ['apr_old'];
    let failing = false;
    const s = setup({
      pending: () => pending,
      alerts: { state: () => (failing ? undefined : { scope: 'default', items: [], prefs }) },
    });
    const run = runDesktopHost(s.deps);
    await until(() => s.pipe.sent.some((m) => m.type === 'approval-waiting'));
    await new Promise((r) => setTimeout(r, 30));
    // The centre fails while a request arrives, then answers again.
    failing = true;
    pending = ['apr_old', 'apr_new'];
    await new Promise((r) => setTimeout(r, 40));
    expect(notifies(s.pipe.sent)).toEqual([]);
    failing = false;
    await until(() => notifies(s.pipe.sent).length === 1);
    expect(notifies(s.pipe.sent)).toEqual([
      { v: 1, type: 'notify', kind: 'approvals', count: 2, name: '' },
    ]);
    s.pipe.shell({ v: 1, type: 'shutdown' });
    await run;
  });

  it('IR-N7-1 L-3: one decided and another raised between two looks is still alerted', async () => {
    let pending: string[] = ['apr_a'];
    const s = setup({
      pending: () => pending,
      alerts: { state: () => ({ scope: 'default', items: [], prefs }) },
    });
    const run = runDesktopHost(s.deps);
    await until(() => s.pipe.sent.some((m) => m.type === 'approval-waiting'));
    await new Promise((r) => setTimeout(r, 30));
    pending = ['apr_b'];
    await until(() => notifies(s.pipe.sent).length === 1);
    expect(notifies(s.pipe.sent)).toEqual([
      { v: 1, type: 'notify', kind: 'approvals', count: 1, name: '' },
    ]);
    s.pipe.shell({ v: 1, type: 'shutdown' });
    await run;
  });

  it('IR-N7-1 L-3, L-5: switching IDs: the record follows only after the new first look; a later approval is alerted', async () => {
    const marks: string[] = [];
    let scope = 'default';
    let workPending: string[] = [];
    const s = setup({
      other: () => workPending,
      alerts: { state: () => ({ scope, items: [], prefs }) },
    });
    s.deps = { ...s.deps, alertsRecord: recordDouble(marks) };
    const run = runDesktopHost(s.deps);
    await until(() => marks.includes('write:default'));
    scope = 'work';
    workPending = ['apr_w1'];
    await s.server().switchTo('work');
    await until(() => marks.includes('write:work'));
    // What was waiting on `work` when the host first looked was alerted by mcp (the record still
    // named `default` until then); nothing is alerted for it here.
    expect(notifies(s.pipe.sent)).toEqual([]);
    workPending = ['apr_w1', 'apr_w2'];
    await until(() => notifies(s.pipe.sent).length === 1);
    expect(notifies(s.pipe.sent)).toEqual([
      { v: 1, type: 'notify', kind: 'approvals', count: 2, name: '' },
    ]);
    s.pipe.shell({ v: 1, type: 'shutdown' });
    await run;
    expect(marks).toEqual(['write:default', 'write:work', 'remove']);
  });
});

// APP-CONTINUITY (owner requirement 14 Nov; 08 §1 "One AgentLink, browser or app"; 08 §4): the app
// installed after starting in the browser continues exactly where the person left off. Before its
// own server starts, the core takes over a running `agentlink ui` host (or clears a stale record),
// so there is one host, one record and no second owner. Its record says `host: "desktop"`, and a
// terminal `agentlink ui` asking it to show (the record's token) brings its window forward.
describe('APP-CONTINUITY: the desktop host continues a browser host', () => {
  it('takes over first, then starts; its record says desktop; show brings the window forward', async () => {
    const s = setup();
    const order: string[] = [];
    const run = runDesktopHost({
      ...s.deps,
      takeOver: () => {
        order.push('take over');
        return Promise.resolve('yielded' as const);
      },
      startServer: (options, sink) => {
        order.push('start');
        return s.deps.startServer(options, sink);
      },
    });
    await until(() => readies(s.pipe.sent).length === 1);
    expect(order).toEqual(['take over', 'start']);
    const written = JSON.parse(
      readFileSync(join(home, '.agentlink', APP_HOST_FILE), 'utf8'),
    ) as Record<string, unknown>;
    expect(written['host']).toBe('desktop');
    const handoff = s.options()?.host?.handoff;
    expect(handoff?.onYield?.() ?? false).toBe(false);
    expect(handoff?.onShow?.()).toBe(true);
    await until(() => readies(s.pipe.sent).length === 2);
    s.pipe.shell({ v: 1, type: 'shutdown' });
    await expect(run).resolves.toBe(0);
  });

  it('a takeover that fails or is kept never stops the app from starting', async () => {
    const s = setup();
    const run = runDesktopHost({ ...s.deps, takeOver: () => Promise.reject(new Error('x')) });
    await until(() => readies(s.pipe.sent).length === 1);
    s.pipe.shell({ v: 1, type: 'shutdown' });
    await expect(run).resolves.toBe(0);
  });
});
