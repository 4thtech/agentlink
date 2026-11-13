// DESK051-UPD: the "Check for updates" path (src/shared/app-update.ts, src/main/updater/release-check.ts).
// 0.5.1 ships with the signed updater off (no pinned update key), so the app only reads the latest
// published version from ONE fixed source (GitHub Releases API for this repository) and, when newer,
// offers the exact release asset for this Mac in the default browser. Nothing is downloaded or run by
// the app. Every input from the network is hostile until parsed.
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  APP_UPDATE_STATES,
  isNewerVersion,
  isAppVersion,
  isDownloadUrlFor,
  macArch,
  macAssetName,
  macDownloadUrl,
  parseReleaseVersion,
  releasePageUrl,
} from '../../src/shared/app-update.js';
import {
  CHECK_STATE_FILE,
  DAY_MS,
  LAUNCH_CHECK_DELAY_MS,
  MANUAL_MIN_GAP_MS,
  MAX_RELEASE_BYTES,
  RELEASE_API_URL,
  ReleaseChecker,
  fetchLatestRelease,
  parseLatestRelease,
  updateChecksAllowed,
  type ReleaseCheckerDeps,
  type ReleaseFetch,
} from '../../src/main/updater/release-check.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const release = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  tag_name: 'v0.5.2',
  name: 'v0.5.2',
  draft: false,
  prerelease: false,
  body: 'Release notes with "quotes" and \\u0000 and <script>alert(1)</script>',
  reactions: { '+1': 3, '-1': 0 },
  assets: [
    { name: 'AgentLink-0.5.2-mac-arm64.dmg', size: 1 },
    { name: 'AgentLink-0.5.2-mac-x64.dmg', size: 2 },
    { name: 'SHA256SUMS-desktop-app.txt', size: 3 },
  ],
  ...over,
});
const bytesOf = (value: unknown): Uint8Array => enc(JSON.stringify(value));

describe('versions', () => {
  it('parses only plain x.y.z release versions', () => {
    expect(parseReleaseVersion('0.5.1')).toEqual([0, 5, 1]);
    expect(parseReleaseVersion('10.20.300')).toEqual([10, 20, 300]);
    for (const bad of [
      '',
      '0.5',
      '0.5.1.2',
      'v0.5.1',
      '00.5.1',
      '0.05.1',
      '0.5.1-beta.1',
      '0.5.1+build',
      ' 0.5.1',
      '0.5.1 ',
      '0.5.1\n',
      '1234567.0.0',
      '٠.٥.١',
      '0x1.0.0',
      '-1.0.0',
      7,
      null,
      undefined,
      ['0.5.1'],
    ]) {
      expect(parseReleaseVersion(bad), String(bad)).toBeUndefined();
    }
  });

  it('compares numerically, never as text', () => {
    expect(isNewerVersion('0.5.2', '0.5.1')).toBe(true);
    expect(isNewerVersion('0.10.0', '0.9.9')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.99.99')).toBe(true);
    expect(isNewerVersion('0.5.1', '0.5.1')).toBe(false);
    expect(isNewerVersion('0.5.0', '0.5.1')).toBe(false);
    expect(isNewerVersion('0.4.15', '0.5.0')).toBe(false);
  });

  it('never calls a version newer when either side is not a plain release version', () => {
    expect(isNewerVersion('0.5.2', '0.0.0-dev')).toBe(false);
    expect(isNewerVersion('9.9.9-beta.1', '0.5.1')).toBe(false);
    expect(isNewerVersion('v9.9.9', '0.5.1')).toBe(false);
  });

  it('the installed version may carry a short build suffix, nothing else', () => {
    expect(isAppVersion('0.5.1')).toBe(true);
    expect(isAppVersion('0.0.0-dev')).toBe(true);
    expect(isAppVersion('0.5.1-beta.2')).toBe(true);
    for (const bad of ['', 'dev', '0.5.1-', '0.5.1-a b', '0.5.1-<x>', `0.5.1-${'a'.repeat(33)}`]) {
      expect(isAppVersion(bad), bad).toBe(false);
    }
  });
});

describe('the asset for this Mac', () => {
  it('maps the architecture to the names the release attaches', () => {
    expect(macArch('arm64', false)).toBe('arm64');
    expect(macArch('x64', false)).toBe('x64');
    // An Intel copy running under Rosetta on Apple silicon gets the Apple silicon build.
    expect(macArch('x64', true)).toBe('arm64');
    for (const bad of ['ia32', 'arm', 'ppc64', 'universal', '', 'ARM64']) {
      expect(macArch(bad, false), bad).toBeUndefined();
    }
    expect(macAssetName('0.5.2', 'arm64')).toBe('AgentLink-0.5.2-mac-arm64.dmg');
    expect(macAssetName('0.5.2', 'x64')).toBe('AgentLink-0.5.2-mac-x64.dmg');
  });

  it('builds the exact release download link, and only from a plain version', () => {
    expect(macDownloadUrl('0.5.2', 'arm64')).toBe(
      'https://github.com/4thtech/agentlink/releases/download/v0.5.2/AgentLink-0.5.2-mac-arm64.dmg',
    );
    expect(macDownloadUrl('0.5.2', 'x64')).toBe(
      'https://github.com/4thtech/agentlink/releases/download/v0.5.2/AgentLink-0.5.2-mac-x64.dmg',
    );
    expect(releasePageUrl('0.5.2')).toBe(
      'https://github.com/4thtech/agentlink/releases/tag/v0.5.2',
    );
    expect(() => macDownloadUrl('0.5.2/../../evil', 'arm64')).toThrow();
    expect(() => releasePageUrl('0.5.2?x')).toThrow();
  });

  it('accepts a download link only in one of the exact forms for that version', () => {
    expect(isDownloadUrlFor(macDownloadUrl('0.5.2', 'arm64'), '0.5.2')).toBe(true);
    expect(isDownloadUrlFor(macDownloadUrl('0.5.2', 'x64'), '0.5.2')).toBe(true);
    expect(isDownloadUrlFor(releasePageUrl('0.5.2'), '0.5.2')).toBe(true);
    for (const bad of [
      macDownloadUrl('0.5.3', 'arm64'),
      'https://github.com/4thtech/agentlink/releases/download/v0.5.2/evil.dmg',
      'http://github.com/4thtech/agentlink/releases/tag/v0.5.2',
      'https://evil.example/4thtech/agentlink/releases/tag/v0.5.2',
      'https://github.com/4thtech/agentlink/releases/tag/v0.5.2#x',
      '',
    ]) {
      expect(isDownloadUrlFor(bad, '0.5.2'), bad).toBe(false);
    }
  });

  it('lists the states the Settings page knows', () => {
    expect([...APP_UPDATE_STATES]).toEqual([
      'off',
      'idle',
      'checking',
      'current',
      'available',
      'failed',
      'offline',
      // UPD-5: the in-app update (updater/in-app.ts).
      'downloading',
      'verifying',
      'ready',
      'restarting',
      'install_failed',
    ]);
  });
});

describe('parsing the latest release (hostile input)', () => {
  it('reads the version and the asset names of a normal answer', () => {
    const parsed = parseLatestRelease(bytesOf(release()));
    expect(parsed?.version).toBe('0.5.2');
    expect(parsed?.assets.has('AgentLink-0.5.2-mac-arm64.dmg')).toBe(true);
    expect(parsed?.assets.has('AgentLink-0.5.2-mac-x64.dmg')).toBe(true);
  });

  it.each<[string, Uint8Array]>([
    ['empty', enc('')],
    ['not JSON', enc('<html>rate limited</html>')],
    ['an array', bytesOf([release()])],
    ['null', enc('null')],
    ['a string', enc('"v0.5.2"')],
    ['invalid UTF-8', new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])],
    [
      'a duplicate key',
      enc('{"tag_name":"v0.5.2","tag_name":"v9.9.9","draft":false,"prerelease":false,"assets":[]}'),
    ],
    ['no tag', bytesOf(release({ tag_name: undefined }))],
    ['a tag without v', bytesOf(release({ tag_name: '0.5.2' }))],
    ['a prerelease tag', bytesOf(release({ tag_name: 'v0.5.2-beta.1' }))],
    ['a package tag', bytesOf(release({ tag_name: '@4thtech-io/agentlink@0.5.2' }))],
    ['a path in the tag', bytesOf(release({ tag_name: 'v0.5.2/../x' }))],
    ['a tag with spaces', bytesOf(release({ tag_name: 'v0.5.2 ' }))],
    ['a number tag', bytesOf(release({ tag_name: 52 }))],
    ['a draft', bytesOf(release({ draft: true }))],
    ['a prerelease', bytesOf(release({ prerelease: true }))],
    ['draft not a boolean', bytesOf(release({ draft: 'false' }))],
    ['no assets', bytesOf(release({ assets: undefined }))],
    ['assets not a list', bytesOf(release({ assets: {} }))],
    [
      'too many assets',
      bytesOf(
        release({ assets: Array.from({ length: 201 }, (_, i) => ({ name: `a${String(i)}` })) }),
      ),
    ],
    ['an asset without a name', bytesOf(release({ assets: [{ size: 1 }] }))],
    ['an asset name that is not text', bytesOf(release({ assets: [{ name: 5 }] }))],
    [
      'an asset that is not an object',
      bytesOf(release({ assets: ['AgentLink-0.5.2-mac-arm64.dmg'] })),
    ],
  ])('refuses %s', (_label, bytes) => {
    expect(parseLatestRelease(bytes)).toBeUndefined();
  });

  it('refuses an answer larger than the cap before parsing it', () => {
    const big = enc(JSON.stringify(release({ body: 'x'.repeat(MAX_RELEASE_BYTES) })));
    expect(big.length).toBeGreaterThan(MAX_RELEASE_BYTES);
    expect(parseLatestRelease(big)).toBeUndefined();
  });

  it('keeps nothing of the answer but the version and the asset names', () => {
    const parsed = parseLatestRelease(bytesOf(release()));
    expect(Object.keys(parsed ?? {}).sort()).toEqual(['assets', 'version']);
  });
});

interface Call {
  readonly url: string;
  readonly init: Parameters<ReleaseFetch>[1];
}
const answer =
  (
    body: Uint8Array | string,
    init: ResponseInit = { status: 200 },
    calls: Call[] = [],
  ): ReleaseFetch =>
  (url, i) => {
    calls.push({ url, init: i });
    return Promise.resolve(new Response(typeof body === 'string' ? body : Buffer.from(body), init));
  };

describe('fetching the latest release', () => {
  it('asks only the one fixed URL, refuses redirects, sends no credentials', async () => {
    const calls: Call[] = [];
    const got = await fetchLatestRelease(answer(bytesOf(release()), { status: 200 }, calls));
    expect(got?.version).toBe('0.5.2');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(RELEASE_API_URL);
    expect(RELEASE_API_URL).toBe('https://api.github.com/repos/4thtech/agentlink/releases/latest');
    expect(calls[0]?.init.redirect).toBe('error');
    expect(calls[0]?.init.credentials).toBe('omit');
    const headers = calls[0]?.init.headers ?? {};
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('authorization');
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('cookie');
  });

  it.each([301, 302, 304, 403, 404, 429, 500])('gives nothing on HTTP %i', async (status) => {
    expect(await fetchLatestRelease(answer(bytesOf(release()), { status }))).toBeUndefined();
  });

  it('gives nothing when the declared size is over the cap', async () => {
    const got = await fetchLatestRelease(
      answer(bytesOf(release()), {
        status: 200,
        headers: { 'content-length': String(MAX_RELEASE_BYTES + 1) },
      }),
    );
    expect(got).toBeUndefined();
  });

  it('stops reading once the body passes the cap (no declared size)', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.length;
        if (pulled > MAX_RELEASE_BYTES * 4) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const got = await fetchLatestRelease(() => Promise.resolve(new Response(stream)));
    expect(got).toBeUndefined();
    expect(pulled).toBeLessThanOrEqual(MAX_RELEASE_BYTES + 2 * chunk.length);
  });

  it('gives nothing when the network fails or the fetch throws', async () => {
    expect(await fetchLatestRelease(() => Promise.reject(new Error('ENOTFOUND')))).toBeUndefined();
    expect(
      await fetchLatestRelease(() => {
        throw new Error('sync');
      }),
    ).toBeUndefined();
  });
});

describe('policy', () => {
  it('checks only in a packaged release build, unless turned off for this computer', () => {
    expect(updateChecksAllowed({ packaged: true, preview: false, env: {} })).toBe(true);
    expect(updateChecksAllowed({ packaged: false, preview: false, env: {} })).toBe(false);
    expect(updateChecksAllowed({ packaged: true, preview: true, env: {} })).toBe(false);
    expect(
      updateChecksAllowed({
        packaged: true,
        preview: false,
        env: { AGENTLINK_UPDATE_CHECK: 'off' },
      }),
    ).toBe(false);
    expect(
      updateChecksAllowed({
        packaged: true,
        preview: false,
        env: { AGENTLINK_UPDATE_CHECK: 'on' },
      }),
    ).toBe(true);
  });
});

describe('the checker', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'al-upd-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  interface Harness {
    readonly checker: ReleaseChecker;
    readonly calls: Call[];
    readonly views: unknown[];
    readonly timers: { ms: number; run: () => void }[];
    clock: number;
  }
  const harness = (over: Partial<ReleaseCheckerDeps> = {}, body = bytesOf(release())): Harness => {
    const calls: Call[] = [];
    const views: unknown[] = [];
    const timers: { ms: number; run: () => void }[] = [];
    const h = {
      calls,
      views,
      timers,
      clock: 1_800_000_000_000,
    } as Harness & { checker: ReleaseChecker };
    const deps: ReleaseCheckerDeps = {
      currentVersion: '0.5.1',
      platform: 'darwin',
      arch: 'arm64',
      translated: false,
      enabled: true,
      stateDir: dir,
      isOnline: () => true,
      fetch: answer(body, { status: 200 }, calls),
      now: () => h.clock,
      timers: {
        setTimeout: (run, ms) => {
          timers.push({ ms, run });
          return undefined;
        },
      },
      onChange: (view) => views.push(view),
      ...over,
    };
    (h as { checker: ReleaseChecker }).checker = new ReleaseChecker(deps);
    return h;
  };
  const runTimers = async (h: Harness): Promise<void> => {
    const due = h.timers.splice(0);
    for (const t of due) t.run();
    // Every timer here is a check tick, and a tick schedules the next one only once its check has
    // finished: wait for that (not a fixed 20 ms, which a loaded CI runner can outlast).
    for (let waited = 0; h.timers.length < due.length && waited < 10_000; waited += 5) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(h.timers.length).toBeGreaterThanOrEqual(due.length);
  };

  it('starts idle with the installed version and never fetches before the quiet check is due', async () => {
    const h = harness();
    await h.checker.start();
    expect(h.checker.view()).toEqual({ state: 'idle', current: '0.5.1', latest: '', download: '' });
    expect(h.calls).toHaveLength(0);
    expect(h.timers[0]?.ms).toBe(LAUNCH_CHECK_DELAY_MS);
  });

  it('a newer release with this Mac’s file → available with the exact asset link', async () => {
    const h = harness();
    await h.checker.start();
    await runTimers(h);
    expect(h.calls).toHaveLength(1);
    expect(h.checker.view()).toEqual({
      state: 'available',
      current: '0.5.1',
      latest: '0.5.2',
      download:
        'https://github.com/4thtech/agentlink/releases/download/v0.5.2/AgentLink-0.5.2-mac-arm64.dmg',
    });
    expect(h.views.at(-1)).toEqual(h.checker.view());
  });

  it('the Intel Mac gets the x64 file', async () => {
    const h = harness({ arch: 'x64' });
    await h.checker.check();
    expect(h.checker.view().download).toBe(macDownloadUrl('0.5.2', 'x64'));
  });

  it('Windows gets the release page (no Windows file name is guessed)', async () => {
    const h = harness({ platform: 'win32', arch: 'x64' });
    await h.checker.check();
    expect(h.checker.view()).toMatchObject({
      state: 'available',
      download: releasePageUrl('0.5.2'),
    });
  });

  it('a newer release whose file for this Mac is not attached yet is not offered', async () => {
    const h = harness({}, bytesOf(release({ assets: [{ name: 'AgentLink-0.5.2-mac-x64.dmg' }] })));
    await h.checker.check();
    expect(h.checker.view()).toMatchObject({ state: 'current', latest: '', download: '' });
  });

  it('the same or an older release → up to date', async () => {
    for (const tag of ['v0.5.1', 'v0.5.0', 'v0.4.15']) {
      const h = harness({}, bytesOf(release({ tag_name: tag })));
      await h.checker.check();
      expect(h.checker.view(), tag).toMatchObject({ state: 'current', latest: '', download: '' });
    }
  });

  it('a hostile answer → failed on a manual check, nothing from it shown', async () => {
    const h = harness({}, enc('{"tag_name":"v9.9.9<script>","draft":false}'));
    await h.checker.check();
    expect(h.checker.view()).toEqual({
      state: 'failed',
      current: '0.5.1',
      latest: '',
      download: '',
    });
  });

  it('a quiet check that fails stays quiet (idle), and is tried again next launch', async () => {
    const h = harness({ fetch: () => Promise.reject(new Error('down')) });
    await h.checker.start();
    await runTimers(h);
    expect(h.checker.view().state).toBe('idle');
    await expect(stat(join(dir, CHECK_STATE_FILE))).rejects.toThrow();
  });

  it('offline: no fetch at all; a manual check says offline', async () => {
    const h = harness({ isOnline: () => false });
    await h.checker.start();
    await runTimers(h);
    expect(h.calls).toHaveLength(0);
    expect(h.checker.view().state).toBe('idle');
    await h.checker.check();
    expect(h.calls).toHaveLength(0);
    expect(h.checker.view().state).toBe('offline');
  });

  it('turned off by policy: never fetches, never schedules, even when asked', async () => {
    const h = harness({ enabled: false });
    await h.checker.start();
    expect(h.timers).toHaveLength(0);
    await h.checker.check();
    expect(h.calls).toHaveLength(0);
    expect(h.checker.view()).toEqual({ state: 'off', current: '0.5.1', latest: '', download: '' });
  });

  it('an installed version that is not a release version (development build) → off, no fetch', async () => {
    const h = harness({ currentVersion: '0.0.0-dev' });
    await h.checker.start();
    await h.checker.check();
    expect(h.calls).toHaveLength(0);
    expect(h.checker.view().state).toBe('off');
  });

  it('once a day: a launch within 24 h of the last check does not fetch, and shows what it found', async () => {
    const first = harness();
    await first.checker.check();
    expect(first.calls).toHaveLength(1);
    const saved = JSON.parse(await readFile(join(dir, CHECK_STATE_FILE), 'utf8')) as unknown;
    expect(saved).toEqual({ checkedAt: first.clock, latest: '0.5.2' });
    expect((await stat(join(dir, CHECK_STATE_FILE))).mode & 0o777).toBe(0o600);

    const later = harness();
    later.clock = first.clock + DAY_MS - 1;
    await later.checker.start();
    await runTimers(later);
    expect(later.calls).toHaveLength(0);
    expect(later.checker.view()).toMatchObject({ state: 'available', latest: '0.5.2' });

    const nextDay = harness();
    nextDay.clock = first.clock + DAY_MS;
    await nextDay.checker.start();
    await runTimers(nextDay);
    expect(nextDay.calls).toHaveLength(1);
  });

  it('the cached version is shown only while it is still newer than this app (after updating it is not)', async () => {
    await writeFile(
      join(dir, CHECK_STATE_FILE),
      JSON.stringify({ checkedAt: 1_800_000_000_000, latest: '0.5.2' }),
    );
    const h = harness({ currentVersion: '0.5.2' });
    await h.checker.start();
    await runTimers(h);
    expect(h.calls).toHaveLength(0);
    expect(h.checker.view()).toMatchObject({ state: 'current', current: '0.5.2', latest: '' });
  });

  it.each([
    ['damaged', '{not json'],
    ['a foreign version', JSON.stringify({ checkedAt: 1_800_000_000_000, latest: '9.9.9-evil' })],
    ['an extra key', JSON.stringify({ checkedAt: 1_800_000_000_000, latest: '0.5.2', x: 1 })],
    ['a time in the future', JSON.stringify({ checkedAt: 1_900_000_000_000, latest: '0.5.2' })],
    ['a negative time', JSON.stringify({ checkedAt: -1, latest: '' })],
    [
      'oversize',
      JSON.stringify({ checkedAt: 1_800_000_000_000, latest: '0.5.2', pad: 'x'.repeat(5000) }),
    ],
  ])('a %s throttle file counts as "never checked"', async (_label, text) => {
    await writeFile(join(dir, CHECK_STATE_FILE), text);
    const h = harness();
    await h.checker.start();
    expect(h.checker.view().state).toBe('idle');
    await runTimers(h);
    expect(h.calls).toHaveLength(1);
  });

  it('UPD-N1: two clicks share one request; a click within a minute gets the last result', async () => {
    const h = harness();
    await Promise.all([h.checker.check(), h.checker.check()]);
    expect(h.calls).toHaveLength(1);
    h.clock += MANUAL_MIN_GAP_MS - 1;
    const again = await h.checker.check();
    expect(h.calls).toHaveLength(1);
    expect(again).toMatchObject({ state: 'available', latest: '0.5.2' });
    h.clock += 1;
    await h.checker.check();
    expect(h.calls).toHaveLength(2);
  });

  it('UPD-N1: a failed check is shown again within the minute, then asked again', async () => {
    let n = 0;
    const h = harness({
      fetch: () => {
        n += 1;
        return n === 1
          ? Promise.reject(new Error('down'))
          : Promise.resolve(new Response(Buffer.from(bytesOf(release()))));
      },
    });
    expect((await h.checker.check()).state).toBe('failed');
    expect((await h.checker.check()).state).toBe('failed');
    expect(n).toBe(1);
    h.clock += MANUAL_MIN_GAP_MS;
    expect((await h.checker.check()).state).toBe('available');
    expect(n).toBe(2);
  });

  it('shows "checking" while a manual check runs', async () => {
    let release_: (r: Response) => void = () => undefined;
    const h = harness({
      fetch: () =>
        new Promise<Response>((resolve) => {
          release_ = resolve;
        }),
    });
    const running = h.checker.check();
    expect(h.checker.view().state).toBe('checking');
    release_(new Response(Buffer.from(bytesOf(release()))));
    await running;
    expect(h.checker.view().state).toBe('available');
  });

  it('checks again once a day while the app keeps running', async () => {
    const h = harness();
    await h.checker.start();
    await runTimers(h); // the launch check
    expect(h.calls).toHaveLength(1);
    const daily = h.timers.find((t) => t.ms === DAY_MS);
    expect(daily).toBeDefined();
    h.clock += DAY_MS;
    await runTimers(h);
    expect(h.calls).toHaveLength(2);
  });
});
