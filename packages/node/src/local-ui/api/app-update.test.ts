// DESK051-UPD: Settings > Updates (`GET /api/ui/app-update`, `GET /api/ui/app-update/check`).
// Reads only; the desk is the desktop host's; every answer is checked again field by field, so only
// the fixed forms reach the page (a version and this repository's release link, only when newer).
import { describe, expect, it } from 'vitest';
import type { LocalUiContext } from '../context.js';
import {
  MARK_PATHS,
  NOT_AVAILABLE,
  UI_INVALID_QUERY,
  UI_UNAVAILABLE,
  type LocalUiMarkRoute,
  type LocalUiReadRoute,
  type LocalUiRequest,
} from '../route-types.js';
import { createLocalUiRoutes } from '../routes.js';
import {
  APP_UPDATE_CHECK_PATH,
  APP_UPDATE_INSTALL_PATH,
  APP_UPDATE_PATH,
  APP_UPDATE_RESTART_PATH,
  appUpdateBody,
  appUpdateRoutes,
  type AppUpdateInstall,
  type AppUpdateView,
  type LocalUiAppUpdateDesk,
} from './app-update.js';

const DMG =
  'https://github.com/4thtech/agentlink/releases/download/v0.5.2/AgentLink-0.5.2-mac-arm64.dmg';
// WIN-DESK-2: the Windows app's link is the exact setup.exe of the newer release.
const EXE =
  'https://github.com/4thtech/agentlink/releases/download/v0.5.2/AgentLink-0.5.2-win-x64-setup.exe';

describe('the Windows setup link (WIN-DESK-2)', () => {
  it('is accepted for the desktop app, and only in its exact form', () => {
    // No in-app update on Windows in this release: the link only.
    const extra = { ...AVAILABLE, download: EXE, installable: false, percent: 0 };
    expect(appUpdateBody(extra, 'desktop')?.download).toBe(EXE);
    for (const bad of [
      EXE.replace('win-x64', 'win-arm64'),
      EXE.replace('v0.5.2/AgentLink-0.5.2', 'v0.5.2/AgentLink-0.5.3'),
      `${EXE}#x`,
    ]) {
      expect(appUpdateBody({ ...extra, download: bad }, 'desktop'), bad).toBeUndefined();
    }
  });
});
const AVAILABLE: AppUpdateView = {
  state: 'available',
  current: '0.5.1',
  latest: '0.5.2',
  download: DMG,
};
const [read, check] = appUpdateRoutes as readonly LocalUiReadRoute[];
const [installRoute, restartRoute] = appUpdateRoutes.slice(2) as readonly LocalUiMarkRoute[];
/** UPD-5: what the desktop app adds to every answer (nothing in-app here, nothing waiting). */
const DESK_EXTRA = { installable: false, percent: 0, busy: false } as const;
const req = (query = ''): LocalUiRequest => ({ params: {}, query: new URLSearchParams(query) });
const ctx = (appUpdate?: LocalUiAppUpdateDesk): LocalUiContext =>
  (appUpdate === undefined ? {} : { appUpdate }) as unknown as LocalUiContext;
const desk = (
  view: AppUpdateView | undefined,
  onCheck = (): void => undefined,
  install: AppUpdateInstall = 'desktop',
) =>
  ({
    install,
    view: () => view,
    check: () => {
      onCheck();
      return view;
    },
  }) satisfies LocalUiAppUpdateDesk;

describe('app-update routes', () => {
  it('are two reads on fixed paths, registered once', () => {
    expect(read?.method).toBe('GET');
    expect(read?.path).toBe(APP_UPDATE_PATH);
    expect(read?.presence).toBe(false);
    expect(check?.method).toBe('GET');
    expect(check?.path).toBe(APP_UPDATE_CHECK_PATH);
    expect(check?.presence).toBe(false);
    const registry = createLocalUiRoutes();
    expect(registry.match('GET', APP_UPDATE_PATH)).toMatchObject({ route: read });
    expect(registry.match('GET', APP_UPDATE_CHECK_PATH)).toMatchObject({ route: check });
  });

  it('outside the desktop app: 501 not_available, and no check', async () => {
    expect(await read?.handler(ctx(), req())).toEqual(NOT_AVAILABLE);
    expect(await check?.handler(ctx(), req())).toEqual(NOT_AVAILABLE);
  });

  it('answers the shell’s state as is', async () => {
    expect(await read?.handler(ctx(desk(AVAILABLE)), req())).toEqual({
      status: 200,
      body: { ...AVAILABLE, install: 'desktop', ...DESK_EXTRA },
    });
  });

  it('a check asks the desk once and answers what it returns', async () => {
    let asked = 0;
    const checking: AppUpdateView = {
      state: 'checking',
      current: '0.5.1',
      latest: '',
      download: '',
    };
    const result = await check?.handler(
      ctx(
        desk(checking, () => {
          asked += 1;
        }),
      ),
      req(),
    );
    expect(asked).toBe(1);
    expect(result).toEqual({
      status: 200,
      body: { ...checking, install: 'desktop', ...DESK_EXTRA },
    });
  });

  it('refuses a query', async () => {
    let asked = 0;
    const d = desk(AVAILABLE, () => {
      asked += 1;
    });
    expect(await read?.handler(ctx(d), req('x=1'))).toEqual(UI_INVALID_QUERY);
    expect(await check?.handler(ctx(d), req('force=1'))).toEqual(UI_INVALID_QUERY);
    expect(asked).toBe(0);
  });

  it('no state from the shell yet → 503 (the page tries again)', async () => {
    expect(await read?.handler(ctx(desk(undefined)), req())).toEqual(UI_UNAVAILABLE);
  });

  it.each<[string, AppUpdateView]>([
    ['an unknown state', { ...AVAILABLE, state: 'installing' as never }],
    ['a link elsewhere', { ...AVAILABLE, download: 'https://evil.example/AgentLink.dmg' }],
    ['a link for another version', { ...AVAILABLE, download: DMG.replaceAll('0.5.2', '0.5.3') }],
    ['a version that is not newer', { ...AVAILABLE, current: '0.5.2' }],
    ['a prerelease', { ...AVAILABLE, latest: '0.5.2-beta.1' }],
    ['markup in a version', { ...AVAILABLE, current: '<b>0.5.1</b>' }],
    ['a link while not available', { ...AVAILABLE, state: 'current' }],
  ])('never passes on %s', async (_label, view) => {
    expect(appUpdateBody(view, 'desktop')).toBeUndefined();
    expect(await read?.handler(ctx(desk(view)), req())).toEqual(UI_UNAVAILABLE);
  });

  it('the body has exactly its fields (nothing else of the desk’s object)', () => {
    const extra = { ...AVAILABLE, secret: 'x' } as AppUpdateView;
    expect(Object.keys(appUpdateBody(extra, 'desktop') ?? {}).sort()).toEqual([
      'busy',
      'current',
      'download',
      'install',
      'installable',
      'latest',
      'percent',
      'state',
    ]);
    // The browser app keeps its five (its restart is the update).
    expect(Object.keys(appUpdateBody({ ...AVAILABLE, download: '' }, 'npx') ?? {}).sort()).toEqual([
      'current',
      'download',
      'install',
      'latest',
      'state',
    ]);
  });

  // UPD-5: Update now and Restart now (the mark kind: session, CSRF, Origin, fetch metadata,
  // octet-stream, generation, no input, no body, no presence).
  const IN_APP: AppUpdateView = { ...AVAILABLE, installable: true, percent: 0 };
  it('UPD-5: two POSTs of the mark kind at fixed paths, registered once', () => {
    expect(installRoute?.method).toBe('POST');
    expect(installRoute?.path).toBe(APP_UPDATE_INSTALL_PATH);
    expect(installRoute?.presence).toBe('mark');
    expect(restartRoute?.method).toBe('POST');
    expect(restartRoute?.path).toBe(APP_UPDATE_RESTART_PATH);
    expect(restartRoute?.presence).toBe('mark');
    expect(MARK_PATHS).toContain(APP_UPDATE_INSTALL_PATH);
    expect(MARK_PATHS).toContain(APP_UPDATE_RESTART_PATH);
    const registry = createLocalUiRoutes();
    expect(registry.match('POST', APP_UPDATE_INSTALL_PATH)).toMatchObject({ route: installRoute });
    expect(registry.match('POST', APP_UPDATE_RESTART_PATH)).toMatchObject({ route: restartRoute });
  });

  it('UPD-5: Update now and Restart now ask the desk and answer its new state', async () => {
    const calls: string[] = [];
    const d: LocalUiAppUpdateDesk = {
      install: 'desktop',
      view: () => IN_APP,
      check: () => IN_APP,
      startInstall: () => {
        calls.push('install');
        return { ...IN_APP, state: 'downloading', percent: 0 };
      },
      restart: () => {
        calls.push('restart');
        return { ...IN_APP, state: 'restarting' };
      },
      busy: () => true,
    };
    expect(await installRoute?.handler(ctx(d), {})).toEqual({
      status: 200,
      body: { ...IN_APP, state: 'downloading', install: 'desktop', busy: true },
    });
    expect(await restartRoute?.handler(ctx(d), {})).toEqual({
      status: 200,
      body: { ...IN_APP, state: 'restarting', install: 'desktop', busy: true },
    });
    expect(calls).toEqual(['install', 'restart']);
  });

  it('UPD-5: outside the desktop app, or a desk without the in-app steps: 501', async () => {
    expect(await installRoute?.handler(ctx(), {})).toEqual(NOT_AVAILABLE);
    expect(await restartRoute?.handler(ctx(), {})).toEqual(NOT_AVAILABLE);
    expect(await installRoute?.handler(ctx(desk(AVAILABLE)), {})).toEqual(NOT_AVAILABLE);
    expect(await restartRoute?.handler(ctx(desk(BROWSER, undefined, 'npx')), {})).toEqual(
      NOT_AVAILABLE,
    );
  });

  it.each<[string, AppUpdateView]>([
    [
      'downloading that is not installable',
      { ...IN_APP, state: 'downloading', installable: false },
    ],
    ['a percent outside downloading', { ...IN_APP, percent: 4 }],
    ['a percent over 100', { ...IN_APP, state: 'downloading', percent: 101 }],
    ['install_failed with Update now', { ...IN_APP, state: 'install_failed' }],
    ['ready without the link', { ...IN_APP, state: 'ready', download: '' }],
  ])('UPD-5: never passes on %s', (_label, view) => {
    expect(appUpdateBody(view, 'desktop')).toBeUndefined();
  });

  it('UPD-5: the in-app states never reach the browser app', () => {
    for (const state of ['downloading', 'verifying', 'ready', 'restarting', 'install_failed']) {
      expect(
        appUpdateBody({ ...AVAILABLE, state, download: '' } as AppUpdateView, 'npx'),
      ).toBeUndefined();
    }
  });

  // REL051-UPD2: the browser app (the local app server) has its own desk: the npm registry's latest
  // version and how this copy was installed. The page shows the action; there is never a link.
  const BROWSER: AppUpdateView = {
    state: 'available',
    current: '0.5.1',
    latest: '0.5.2',
    download: '',
  };

  it.each<AppUpdateInstall>(['installer', 'npx', 'global'])(
    'browser app (%s): the version and how it was installed, no link',
    async (install) => {
      expect(await read?.handler(ctx(desk(BROWSER, undefined, install)), req())).toEqual({
        status: 200,
        body: { ...BROWSER, install },
      });
    },
  );

  it.each<[string, AppUpdateView, AppUpdateInstall]>([
    ['a link in the browser app', { ...BROWSER, download: DMG }, 'npx'],
    ['a release page in the browser app', { ...BROWSER, download: DMG }, 'global'],
    ['no link in the desktop app', BROWSER, 'desktop'],
    ['an unknown install', BROWSER, 'brew' as never],
  ])('never passes on %s', async (_label, view, install) => {
    expect(appUpdateBody(view, install)).toBeUndefined();
    expect(await read?.handler(ctx(desk(view, undefined, install)), req())).toEqual(UI_UNAVAILABLE);
  });
});
