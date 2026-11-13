// UPD-5: "Update now" → progress → "Restart now" in Settings › Updates (the shell's side). The pipe
// carries fixed states, versions, a link the shell built, a flag and a percentage only; the core may
// only ask for an install or a restart (no other key). The in-app path stays off while root-key.json
// holds the placeholder (today), so the page keeps the download link there.
import { describe, expect, it } from 'vitest';
import rootKeyFile from '../../src/main/updater/root-key.json' with { type: 'json' };
import offFile from '../../src/main/updater/root-key.updates-off.json' with { type: 'json' };
import {
  InAppUpdater,
  inAppEnabled,
  type InAppUpdaterDeps,
  type InstallHooks,
} from '../../src/main/updater/in-app.js';
import type { InstallOutcome } from '../../src/main/updater/install.js';
import type { AcceptedUpdate } from '../../src/main/updater/manifest.js';
import {
  isAppUpdatePipeView,
  macDownloadUrl,
  type AppUpdateView,
} from '../../src/shared/app-update.js';
import {
  encodeCoreMessage,
  encodeShellMessage,
  parseCoreMessage,
  parseShellMessage,
  type ShellMessage,
} from '../../src/shared/protocol.js';

const line = (value: unknown): string => JSON.stringify(value);
const DMG = macDownloadUrl('0.5.3', 'arm64');
const GENERATOR_X = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const APP_EXEC = '/Applications/AgentLink.app/Contents/MacOS/AgentLink';

const accepted = (version = '0.5.3'): AcceptedUpdate => ({
  version,
  required: false,
  asset: {
    platform: 'darwin',
    arch: 'arm64',
    kind: 'zip',
    url: `https://github.com/4thtech/agentlink/releases/download/v${version}/AgentLink-${version}-mac-arm64.zip`,
    sha256: '0'.repeat(64),
    size: 1000,
  },
});

const CURRENT: AppUpdateView = { state: 'current', current: '0.5.2', latest: '', download: '' };

describe('the placeholder root key means in-app updates are off (UPD-5)', () => {
  const base = { platform: 'darwin', packaged: true, preview: false, execPath: APP_EXEC };

  it('today’s root-key.json and the updates-off file turn the in-app path off', () => {
    expect(rootKeyFile.rootPublicKey).toMatch(/^PLACEHOLDER-AGENTLINK-DESKTOP-ROOT-KEY/);
    expect(inAppEnabled({ ...base })).toBe(false);
    expect(inAppEnabled({ ...base, root: rootKeyFile })).toBe(false);
    expect(inAppEnabled({ ...base, root: offFile })).toBe(false);
  });

  it('a pinned root turns it on only for a packaged Mac copy inside AgentLink.app', () => {
    const root = { rootPublicKey: GENERATOR_X, minimumStatementSequence: 0 };
    expect(inAppEnabled({ ...base, root })).toBe(true);
    expect(inAppEnabled({ ...base, root, platform: 'win32' })).toBe(false);
    expect(inAppEnabled({ ...base, root, packaged: false })).toBe(false);
    expect(inAppEnabled({ ...base, root, preview: true })).toBe(false);
    expect(
      inAppEnabled({ ...base, root, execPath: '/tmp/Other.app/Contents/MacOS/AgentLink' }),
    ).toBe(false);
  });

  it('while off, the page gets today’s view (download link, no Update now) and no install runs', async () => {
    let checks = 0;
    let installs = 0;
    const u = new InAppUpdater({
      enabled: false,
      currentVersion: '0.5.2',
      arch: 'arm64',
      check: () => {
        checks += 1;
        return Promise.resolve(accepted());
      },
      install: () => {
        installs += 1;
        return Promise.resolve({ kind: 'restarting', version: '0.5.3' });
      },
      onChange: () => undefined,
    });
    await u.check();
    const release: AppUpdateView = {
      state: 'available',
      current: '0.5.2',
      latest: '0.5.3',
      download: DMG,
    };
    expect(u.view(release)).toEqual({ ...release, installable: false, percent: 0 });
    expect(u.install()).toBe(false);
    expect(u.restart()).toBe(false);
    expect(checks).toBe(0);
    expect(installs).toBe(0);
  });
});

describe('the in-app update states (UPD-5)', () => {
  function harness(outcome: InstallOutcome = { kind: 'restarting', version: '0.5.3' }) {
    let hooks: InstallHooks | undefined;
    let finish: (o: InstallOutcome) => void = () => undefined;
    let changes = 0;
    const deps: InAppUpdaterDeps = {
      enabled: true,
      currentVersion: '0.5.2',
      arch: 'arm64',
      check: () => Promise.resolve(accepted()),
      install: (a, h) => {
        expect(a.version).toBe('0.5.3');
        hooks = h;
        return new Promise<InstallOutcome>((resolve) => {
          finish = resolve;
        });
      },
      onChange: () => {
        changes += 1;
      },
    };
    const u = new InAppUpdater(deps);
    return {
      u,
      hooks: () => hooks as InstallHooks,
      finish: () => finish(outcome),
      changes: () => changes,
    };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('available → downloading (percent) → verifying → ready → restarting', async () => {
    const h = harness();
    await h.u.check();
    expect(h.u.view(CURRENT)).toEqual({
      state: 'available',
      current: '0.5.2',
      latest: '0.5.3',
      download: DMG,
      installable: true,
      percent: 0,
    });
    // Restart before anything is ready: refused.
    expect(h.u.restart()).toBe(false);
    expect(h.u.install()).toBe(true);
    expect(h.u.install()).toBe(false); // one at a time
    expect(h.u.view(CURRENT)).toMatchObject({
      state: 'downloading',
      percent: 0,
      installable: true,
    });
    h.hooks().onProgress(250, 1000);
    expect(h.u.view(CURRENT)).toMatchObject({ state: 'downloading', percent: 25 });
    h.hooks().onProgress(1000, 1000);
    expect(h.u.view(CURRENT)).toMatchObject({ state: 'downloading', percent: 100 });
    h.hooks().onVerifying();
    expect(h.u.view(CURRENT)).toMatchObject({ state: 'verifying', percent: 0 });
    let confirmed = false;
    void h
      .hooks()
      .confirmRestart()
      .then(() => {
        confirmed = true;
      });
    await tick();
    expect(h.u.view(CURRENT)).toMatchObject({ state: 'ready', latest: '0.5.3', download: DMG });
    expect(confirmed).toBe(false); // waits for the click (OD-D option 1)
    expect(h.u.restart()).toBe(true);
    await tick();
    expect(confirmed).toBe(true);
    expect(h.u.view(CURRENT)).toMatchObject({ state: 'restarting' });
    h.finish();
    await tick();
    expect(h.u.view(CURRENT)).toMatchObject({ state: 'restarting' });
    expect(h.changes()).toBeGreaterThanOrEqual(5);
    for (const view of [h.u.view(CURRENT)]) expect(isAppUpdatePipeView(view)).toBe(true);
  });

  it('a refusal ends in "Couldn’t update here" with the download link, no Update now', async () => {
    const h = harness({ kind: 'fallback', code: 'not_writable' });
    await h.u.check();
    expect(h.u.install()).toBe(true);
    h.finish();
    await tick();
    expect(h.u.view(CURRENT)).toEqual({
      state: 'install_failed',
      current: '0.5.2',
      latest: '0.5.3',
      download: DMG,
      installable: false,
      percent: 0,
    });
    expect(h.u.install()).toBe(false);
  });

  it('a check that fails, or a prerelease, offers nothing in-app (the release view stays)', async () => {
    for (const check of [
      () => Promise.reject(new Error('refused')),
      () => Promise.resolve(accepted('0.5.3-beta.1')),
      () => Promise.resolve(undefined),
    ]) {
      const u = new InAppUpdater({
        enabled: true,
        currentVersion: '0.5.2',
        arch: 'arm64',
        check,
        install: () => Promise.resolve({ kind: 'restarting', version: '0.5.3' }),
        onChange: () => undefined,
      });
      await u.check();
      expect(u.view(CURRENT)).toEqual({ ...CURRENT, installable: false, percent: 0 });
      expect(u.install()).toBe(false);
    }
  });
});

describe('the update messages on the pipe (UPD-5)', () => {
  const ok = {
    v: 1,
    type: 'app-update',
    state: 'available',
    current: '0.5.2',
    latest: '0.5.3',
    download: DMG,
    installable: true,
    percent: 0,
  };

  it('accepts each state in its exact form', () => {
    for (const v of [
      ok,
      { ...ok, installable: false },
      { ...ok, state: 'downloading', percent: 42 },
      { ...ok, state: 'verifying' },
      { ...ok, state: 'ready' },
      { ...ok, state: 'restarting' },
      { ...ok, state: 'install_failed', installable: false },
      { ...ok, state: 'current', latest: '', download: '', installable: false },
    ]) {
      expect(parseShellMessage(line(v)), v.state).toEqual(v);
      expect(encodeShellMessage(v as ShellMessage)).toBe(`${line(v)}\n`);
    }
  });

  it.each([
    ['an unknown field', { ...ok, note: 'hello' }],
    ['a text percent', { ...ok, state: 'downloading', percent: '42' }],
    ['a percent over 100', { ...ok, state: 'downloading', percent: 101 }],
    ['a fractional percent', { ...ok, state: 'downloading', percent: 4.5 }],
    ['a percent outside downloading', { ...ok, percent: 5 }],
    ['installable as text', { ...ok, installable: 'yes' }],
    ['downloading that is not installable', { ...ok, state: 'downloading', installable: false }],
    ['install_failed with Update now', { ...ok, state: 'install_failed' }],
    ['installable while current', { ...ok, state: 'current', latest: '', download: '' }],
    ['ready without the link', { ...ok, state: 'ready', download: '' }],
    ['a missing installable', { ...ok, installable: undefined }],
  ])('refuses %s', (_label, value) => {
    expect(parseShellMessage(line(value))).toBeUndefined();
  });

  it('the core asks for an install or a restart with no other key', () => {
    for (const type of ['app-update-install', 'app-update-restart'] as const) {
      expect(parseCoreMessage(line({ v: 1, type }))).toEqual({ v: 1, type });
      expect(encodeCoreMessage({ v: 1, type })).toBe(`${line({ v: 1, type })}\n`);
      expect(parseCoreMessage(line({ v: 1, type, version: '0.5.3' }))).toBeUndefined();
      expect(parseCoreMessage(line({ v: 1, type, url: DMG }))).toBeUndefined();
      expect(parseShellMessage(line({ v: 1, type }))).toBeUndefined();
    }
  });
});
