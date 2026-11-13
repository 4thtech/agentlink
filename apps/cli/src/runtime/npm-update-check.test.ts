// REL051-UPD2: Settings > Updates for the browser app (the local app server from `agentlink` / npx).
// The server process reads one fixed npm registry answer (the `latest` dist-tag of this package),
// never anything else, and the page gets only a state word, two checked versions and how this copy
// was installed (so it can say "Restart AgentLink" or show the one update command).
import { describe, expect, it, vi } from 'vitest';
import {
  CHECK_TIMEOUT_MS,
  DAY_MS,
  LAUNCH_CHECK_DELAY_MS,
  MANUAL_MIN_GAP_MS,
  MAX_DIST_TAGS_BYTES,
  NPM_DIST_TAGS_URL,
  NpmUpdateChecker,
  browserInstall,
  browserUpdateDesk,
  fetchLatestVersion,
  parseDistTags,
  updateChecksAllowed,
  withUpdates,
  type RegistryFetch,
} from './npm-update-check.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const json = (body: string, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(body, { status, headers: { 'content-type': 'application/json', ...headers } });

describe('parseDistTags', () => {
  it('reads a plain latest version', () => {
    expect(parseDistTags(enc('{"latest":"0.5.2"}'))).toBe('0.5.2');
    expect(parseDistTags(enc('{"latest":"0.5.2","next":"0.6.0-beta.1"}'))).toBe('0.5.2');
  });

  it.each([
    ['empty', ''],
    ['not JSON', 'latest=0.5.2'],
    ['an array', '["0.5.2"]'],
    ['no latest', '{"next":"0.5.2"}'],
    ['a number', '{"latest":5}'],
    ['a prerelease', '{"latest":"0.5.2-beta.1"}'],
    ['a build suffix', '{"latest":"0.5.2+abc"}'],
    ['a v prefix', '{"latest":"v0.5.2"}'],
    ['leading zeros', '{"latest":"0.05.2"}'],
    ['too many digits', '{"latest":"0.5.1234567"}'],
    ['markup', '{"latest":"<b>0.5.2</b>"}'],
    ['duplicate keys', '{"latest":"0.5.2","latest":"9.9.9"}'],
  ])('refuses %s', (_label, body) => {
    expect(parseDistTags(enc(body))).toBeUndefined();
  });

  it('refuses invalid UTF-8 and anything over the cap', () => {
    expect(parseDistTags(new Uint8Array([0x7b, 0xff, 0x7d]))).toBeUndefined();
    const big = `{"latest":"0.5.2","x":"${'a'.repeat(MAX_DIST_TAGS_BYTES)}"}`;
    expect(parseDistTags(enc(big))).toBeUndefined();
  });
});

describe('fetchLatestVersion', () => {
  it('one GET to the fixed URL: no redirects, no credentials, nothing identifying', async () => {
    const calls: [string, Parameters<RegistryFetch>[1]][] = [];
    const f: RegistryFetch = (url, init) => {
      calls.push([url, init]);
      return Promise.resolve(json('{"latest":"0.5.2"}'));
    };
    expect(await fetchLatestVersion(f)).toEqual({ kind: 'ok', version: '0.5.2' });
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0] as [string, Parameters<RegistryFetch>[1]];
    expect(url).toBe('https://registry.npmjs.org/-/package/@4thtech-io%2fagentlink/dist-tags');
    expect(url).toBe(NPM_DIST_TAGS_URL);
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('error');
    expect(init.credentials).toBe('omit');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toEqual({ accept: 'application/json' });
  });

  it('a non-200, a redirect or an oversized body is a failure', async () => {
    expect(await fetchLatestVersion(() => Promise.resolve(json('{}', 404)))).toEqual({
      kind: 'failed',
    });
    expect(
      await fetchLatestVersion(() => Promise.resolve(json('', 302, { location: 'https://x' }))),
    ).toEqual({ kind: 'failed' });
    expect(
      await fetchLatestVersion(() =>
        Promise.resolve(json('{"latest":"0.5.2"}', 200, { 'content-length': '999999' })),
      ),
    ).toEqual({ kind: 'failed' });
    const huge = `{"latest":"0.5.2","x":"${'a'.repeat(MAX_DIST_TAGS_BYTES * 2)}"}`;
    expect(await fetchLatestVersion(() => Promise.resolve(json(huge)))).toEqual({
      kind: 'failed',
    });
  });

  it('a hostile answer is a failure', async () => {
    expect(
      await fetchLatestVersion(() => Promise.resolve(json('{"latest":"1.0.0-rc.1"}'))),
    ).toEqual({ kind: 'failed' });
  });

  it('no network (name lookup or no route) is offline; anything else thrown is a failure', async () => {
    const thrown = (code: string): RegistryFetch => () =>
      Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code } }));
    expect(await fetchLatestVersion(thrown('ENOTFOUND'))).toEqual({ kind: 'offline' });
    expect(await fetchLatestVersion(thrown('EAI_AGAIN'))).toEqual({ kind: 'offline' });
    expect(await fetchLatestVersion(thrown('ENETUNREACH'))).toEqual({ kind: 'offline' });
    expect(await fetchLatestVersion(thrown('ECONNRESET'))).toEqual({ kind: 'failed' });
    expect(await fetchLatestVersion(() => Promise.reject(new Error('x')))).toEqual({
      kind: 'failed',
    });
  });

  it('gives up after the timeout', async () => {
    expect(CHECK_TIMEOUT_MS).toBe(15_000);
    const f: RegistryFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      });
    expect(await fetchLatestVersion(f, 5)).toEqual({ kind: 'failed' });
  });
});

describe('browserInstall', () => {
  const never = (): boolean => false;
  it('the installers’ launcher: a restart runs the latest (npx @latest every start)', () => {
    expect(browserInstall({ AGENTLINK_LAUNCHER: 'installer' }, '/x/_npx/1/agentlink.js', never)).toBe(
      'installer',
    );
  });
  it('npx, npm exec, dlx or an unknown start: the npx form', () => {
    expect(browserInstall({}, '/Users/a/.npm/_npx/ab12/node_modules/.bin/agentlink', never)).toBe(
      'npx',
    );
    expect(browserInstall({ npm_command: 'exec' }, '/a/agentlink.js', () => true)).toBe('npx');
    expect(browserInstall({}, 'C:\\x\\dlx\\agentlink.js', never)).toBe('npx');
    expect(browserInstall({}, undefined, never)).toBe('npx');
    expect(browserInstall({}, '/repo/apps/cli/dist/agentlink.js', never)).toBe('npx');
  });
  it('a global install (the bare agentlink on PATH is this program): pinned', () => {
    expect(browserInstall({}, '/usr/local/lib/node_modules/x/agentlink.js', () => true)).toBe(
      'global',
    );
  });
  it('an unknown launcher value grants nothing', () => {
    expect(browserInstall({ AGENTLINK_LAUNCHER: 'desktop' }, '/a', () => true)).toBe('global');
  });
});

describe('updateChecksAllowed', () => {
  it('a release build, unless turned off by policy', () => {
    expect(updateChecksAllowed({}, '0.5.1')).toBe(true);
    expect(updateChecksAllowed({ AGENTLINK_UPDATE_CHECK: 'off' }, '0.5.1')).toBe(false);
    expect(updateChecksAllowed({ AGENTLINK_UPDATE_CHECK: 'on' }, '0.5.1')).toBe(true);
    expect(updateChecksAllowed({}, '0.0.0-dev')).toBe(false);
    expect(updateChecksAllowed({}, 'garbage')).toBe(false);
  });
});

interface Harness {
  readonly checker: NpmUpdateChecker;
  readonly fetch: ReturnType<typeof vi.fn>;
  readonly timers: { fn: () => void; ms: number }[];
  clock: number;
}

function harness(
  answers: (() => Promise<Response>)[],
  options: { enabled?: boolean; current?: string } = {},
): Harness {
  const h: Harness = {
    clock: 1_000_000,
    timers: [],
    fetch: vi.fn(),
    checker: undefined as unknown as NpmUpdateChecker,
  };
  h.fetch.mockImplementation(() => {
    const next = answers.length > 1 ? answers.shift() : answers[0];
    return next === undefined ? Promise.reject(new Error('none')) : next();
  });
  (h as { checker: NpmUpdateChecker }).checker = new NpmUpdateChecker({
    currentVersion: options.current ?? '0.5.1',
    enabled: options.enabled ?? true,
    fetch: h.fetch as unknown as RegistryFetch,
    now: () => h.clock,
    timers: {
      setTimeout: (fn, ms) => {
        h.timers.push({ fn, ms });
      },
    },
  });
  return h;
}
const latest = (v: string) => (): Promise<Response> => Promise.resolve(json(`{"latest":"${v}"}`));
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

describe('NpmUpdateChecker', () => {
  it('starts idle with this version; turned off: never a request', async () => {
    const h = harness([latest('0.5.2')], { enabled: false });
    expect(h.checker.view()).toEqual({ state: 'off', current: '0.5.1', latest: '', download: '' });
    h.checker.start();
    expect(await h.checker.check()).toMatchObject({ state: 'off' });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.timers).toHaveLength(0);
  });

  it('a development build is never offered anything', async () => {
    const h = harness([latest('0.5.2')], { current: '0.0.0-dev' });
    expect(h.checker.view().state).toBe('off');
    await h.checker.check();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('Check for updates: a newer version is available (no link: the page shows the action)', async () => {
    const h = harness([latest('0.5.2')]);
    expect(h.checker.view().state).toBe('idle');
    expect(await h.checker.check()).toEqual({
      state: 'available',
      current: '0.5.1',
      latest: '0.5.2',
      download: '',
    });
  });

  it('the same or an older version is current', async () => {
    expect((await harness([latest('0.5.1')]).checker.check()).state).toBe('current');
    expect((await harness([latest('0.4.9')]).checker.check()).state).toBe('current');
  });

  it('shows checking while the request runs; concurrent clicks share it', async () => {
    let release: (r: Response) => void = () => undefined;
    const h = harness([() => new Promise<Response>((r) => (release = r))]);
    const a = h.checker.check();
    expect(h.checker.view().state).toBe('checking');
    const b = h.checker.check();
    release(json('{"latest":"0.5.2"}'));
    expect((await a).state).toBe('available');
    expect((await b).state).toBe('available');
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('at most one request a minute; within it the last result', async () => {
    const h = harness([latest('0.5.1'), latest('0.5.2')]);
    expect((await h.checker.check()).state).toBe('current');
    h.clock += MANUAL_MIN_GAP_MS - 1;
    expect((await h.checker.check()).state).toBe('current');
    expect(h.fetch).toHaveBeenCalledTimes(1);
    h.clock += 1;
    expect((await h.checker.check()).state).toBe('available');
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it('a failed or offline click says so', async () => {
    expect((await harness([() => Promise.resolve(json('', 500))]).checker.check()).state).toBe(
      'failed',
    );
    const offline = (): Promise<Response> =>
      Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }));
    expect((await harness([offline]).checker.check()).state).toBe('offline');
  });

  it('quiet checks: one after launch, then once a day; a failing quiet check says nothing', async () => {
    const h = harness([() => Promise.resolve(json('', 500)), latest('0.5.2')]);
    h.checker.start();
    expect(h.timers).toEqual([{ fn: expect.any(Function), ms: LAUNCH_CHECK_DELAY_MS }]);
    h.timers.shift()?.fn();
    await flush();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.checker.view().state).toBe('idle');
    expect(h.timers).toEqual([{ fn: expect.any(Function), ms: DAY_MS }]);
    h.clock += DAY_MS;
    h.timers.shift()?.fn();
    await flush();
    expect(h.checker.view().state).toBe('available');
  });

  it('a quiet check within a day of a good one asks nothing', async () => {
    const h = harness([latest('0.5.1')]);
    await h.checker.check();
    h.checker.start();
    h.timers.shift()?.fn();
    await flush();
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('browserUpdateDesk', () => {
  it('passes the checker’s view and how this copy was installed', async () => {
    const h = harness([latest('0.5.2')]);
    const desk = browserUpdateDesk(h.checker, 'global');
    expect(desk.install).toBe('global');
    expect(desk.view()).toMatchObject({ state: 'idle' });
    expect(desk.check()).toMatchObject({ state: 'checking' });
    await flush();
    expect(desk.view()).toMatchObject({ state: 'available', latest: '0.5.2' });
  });
});

describe('withUpdates', () => {
  it('gives every server it starts the same desk, made once and only when a server starts', async () => {
    let made = 0;
    const desk = browserUpdateDesk(harness([latest('0.5.2')]).checker, 'npx');
    const seen: unknown[] = [];
    const start = withUpdates(
      (options: { appUpdate?: unknown; x: number }) => {
        seen.push(options.appUpdate);
        return Promise.resolve(options.x);
      },
      () => {
        made += 1;
        return desk;
      },
    );
    expect(made).toBe(0);
    expect(await start({ x: 1 })).toBe(1);
    expect(await start({ x: 2 })).toBe(2);
    expect(made).toBe(1);
    expect(seen).toEqual([desk, desk]);
  });
});
