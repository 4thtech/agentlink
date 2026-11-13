// DESK051-UPD: Settings > Updates (`GET /api/ui/app-update`, `GET /api/ui/app-update/check`).
// Reads only; the desk is the desktop host's; every answer is checked again field by field, so only
// the fixed forms reach the page (a version and this repository's release link, only when newer).
import { describe, expect, it } from 'vitest';
import type { LocalUiContext } from '../context.js';
import {
  NOT_AVAILABLE,
  UI_INVALID_QUERY,
  UI_UNAVAILABLE,
  type LocalUiReadRoute,
  type LocalUiRequest,
} from '../route-types.js';
import { createLocalUiRoutes } from '../routes.js';
import {
  APP_UPDATE_CHECK_PATH,
  APP_UPDATE_PATH,
  appUpdateBody,
  appUpdateRoutes,
  type AppUpdateView,
  type LocalUiAppUpdateDesk,
} from './app-update.js';

const DMG =
  'https://github.com/4thtech/agentlink/releases/download/v0.5.2/AgentLink-0.5.2-mac-arm64.dmg';
const AVAILABLE: AppUpdateView = {
  state: 'available',
  current: '0.5.1',
  latest: '0.5.2',
  download: DMG,
};
const [read, check] = appUpdateRoutes as readonly LocalUiReadRoute[];
const req = (query = ''): LocalUiRequest => ({ params: {}, query: new URLSearchParams(query) });
const ctx = (appUpdate?: LocalUiAppUpdateDesk): LocalUiContext =>
  (appUpdate === undefined ? {} : { appUpdate }) as unknown as LocalUiContext;
const desk = (view: AppUpdateView | undefined, onCheck = (): void => undefined) =>
  ({
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
      body: AVAILABLE,
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
    expect(result).toEqual({ status: 200, body: checking });
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
    expect(appUpdateBody(view)).toBeUndefined();
    expect(await read?.handler(ctx(desk(view)), req())).toEqual(UI_UNAVAILABLE);
  });

  it('the body has exactly the four fields (nothing else of the desk’s object)', () => {
    const extra = { ...AVAILABLE, secret: 'x' } as AppUpdateView;
    expect(Object.keys(appUpdateBody(extra) ?? {}).sort()).toEqual([
      'current',
      'download',
      'latest',
      'state',
    ]);
  });
});
