// @vitest-environment jsdom
// WP-S1 (S1): Settings home (design-1112 §3.1) and the two-pane frame. Rows come from
// SETTINGS_PAGES (each exactly once, tolerant of pages other work packages add), states come from
// mocked reads and fall back to plain words when a read fails, the footer's version is the one the
// health read reports, and no private value shows.
import { HoodProvider, lintVocabulary } from '@4thtech-io/ui';
import axe from 'axe-core';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiResult } from '../../api/client.js';
import type { ApprovalsClient } from '../approvals/client.js';
import { SETTINGS_PAGES } from '../../nav.js';
import { resetPrefsForTests, setPref } from '../../prefs/index.js';
import { settingsGroups } from './groups.js';
import { lineFor, SettingsPage } from './index.js';
import { isSettingsSubpage, SettingsFrame } from './side-nav.js';
import { parseBackup } from './state.js';
import { SETTINGS_STRINGS as S } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  resetPrefsForTests();
  act(() => setPref('theme', 'system'));
  localStorage.clear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const ok = (data: unknown): ApiResult<unknown> => ({ kind: 'ok', status: 200, data });
const offline: ApiResult<unknown> = { kind: 'offline' };

// The R2 shape of GET /api/ui/backup: `covers` and `missing.ids` are {name, label} objects.
const KIT = {
  export: 'available',
  record: 'saved',
  state: 'out_of_date',
  lastKit: {
    at: Date.UTC(2026, 10, 3, 12),
    covers: [{ name: 'Tali', label: 'Tali' }],
    peopleAtSave: 4,
  },
  missing: { ids: [{ name: 'macbook-agent-1', label: 'MacBook' }], people: 2 },
};
const ANSWERS: Record<string, unknown> = {
  '/api/ui/backup': KIT,
  '/api/owner/passkey': {
    passkey: { rpId: 'localhost', registered: true, credentialId: 'x', prfSalt: 'y' },
  },
  '/api/ui/apps': {
    desktopRunning: false,
    apps: [
      {
        app: 'claude-code',
        name: 'Claude Code',
        path: '~/.claude.json',
        state: 'connected',
        agent: 'work',
        quitFirst: false,
      },
      {
        app: 'codex',
        name: 'Codex',
        path: '~/.codex/config.toml',
        state: 'connected',
        agent: 'work',
        quitFirst: false,
      },
      {
        app: 'cursor',
        name: 'Cursor',
        path: '~/.cursor/mcp.json',
        state: 'not_connected',
        quitFirst: false,
      },
    ],
  },
  '/api/ui/files': {
    folders: [
      { path: '~/a', resolved: '/Users/x/a' },
      { path: '~/b', resolved: null },
    ],
    version: 3,
  },
  '/api/ui/proofs/credits': {
    status: 'ok',
    proofsLeft: 24,
    balance: '$1.20',
    price: '$0.05',
    test: false,
    partial: false,
  },
  '/api/ui/health': {
    agent: 'running',
    relays: { connected: 2, total: 3 },
    lastSyncAt: 1700000000,
    version: '9.8.7',
  },
};
const answerFrom =
  (table: Record<string, unknown>) =>
  async (path: string): Promise<ApiResult<unknown>> => {
    const key = path.split('?')[0] ?? path;
    return key in table ? ok(table[key]) : offline;
  };

const approvals = (registered: boolean): ApprovalsClient =>
  ({
    passkey: async () =>
      registered
        ? { kind: 'ready', offered: true, passkey: { credentialId: 'x', prfSalt: 'y' } }
        : { kind: 'ready', offered: false },
  }) as unknown as ApprovalsClient;

async function mount(
  get: (p: string) => Promise<ApiResult<unknown>> = answerFrom(ANSWERS),
  registered = true,
): Promise<void> {
  await act(async () => {
    root.render(
      h(HoodProvider, { value: false }, h(SettingsPage, { get, approvals: approvals(registered) })),
    );
  });
}

const rows = (): HTMLAnchorElement[] => [...host.querySelectorAll<HTMLAnchorElement>('a.set-row')];
const rowFor = (path: string): HTMLAnchorElement | undefined =>
  rows().find((r) => r.getAttribute('href') === path);

describe('Settings home', () => {
  it('has one h1, the three groups, and every SETTINGS_PAGES entry exactly once', async () => {
    await mount();
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(host.querySelector('h1')?.textContent).toBe(S.title);
    const hrefs = rows().map((r) => r.getAttribute('href'));
    expect(hrefs).toHaveLength(SETTINGS_PAGES.length);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const p of SETTINGS_PAGES) expect(hrefs).toContain(p.path);
    const titles = [...host.querySelectorAll('.set-group-title')].map((e) => e.textContent);
    expect(titles).toEqual([S.groups.safety, S.groups.ai, S.groups.app]);
    expect(host.querySelector('.al-subnav')).toBeNull();
  });

  it('shows the Touch ID & master code row and the Advanced entry exactly once (integration)', async () => {
    await mount();
    const titles = rows().map((r) => r.querySelector('.set-row-title')?.textContent);
    expect(titles.filter((t) => t === S.touchId.title)).toHaveLength(1);
    expect(rows().filter((r) => r.getAttribute('href') === '/settings/advanced')).toHaveLength(1);
  });

  it('groups: Backup in Safety, Rules/AI apps/Files in Your AI, the rest in This app', () => {
    const g = settingsGroups([
      { label: 'x', path: '/settings/appearance' },
      { label: 'x', path: '/settings/files' },
      { label: 'x', path: '/settings/rules' },
      { label: 'x', path: '/settings/backup' },
      { label: 'New', path: '/settings/brand-new' },
    ]);
    expect(g.map((x) => x.id)).toEqual(['safety', 'ai', 'app']);
    expect(g[1]?.pages.map((p) => p.path)).toEqual(['/settings/rules', '/settings/files']);
    expect(g[2]?.pages.map((p) => p.path)).toEqual(['/settings/appearance', '/settings/brand-new']);
  });

  it('shows each state from its read', async () => {
    await mount();
    const text = (path: string): string => rowFor(path)?.textContent ?? '';
    expect(text('/settings/backup')).toContain('Last recovery kit saved');
    expect(text('/settings/backup')).toContain('covers Tali');
    expect(text('/settings/backup')).toContain(S.backup.outOfDate);
    expect(text('/settings/apps')).toContain('Claude Code and Codex are connected');
    expect(text('/settings/apps')).toContain('2 connected');
    expect(text('/settings/files')).toContain('send from 2 folders');
    expect(text('/settings/proofs')).toContain('A public proof costs about $0.05.');
    expect(text('/settings/proofs')).toContain('$1.20 · about 24 proofs');
    expect(text('/settings/appearance')).toContain(S.appearance.system);
    expect(text('/settings/advanced') + text('/advanced/network')).toContain(S.advanced.working);
  });

  it('follows the theme choice on the Appearance state', async () => {
    act(() => setPref('theme', 'dark'));
    await mount();
    expect(rowFor('/settings/appearance')?.textContent).toContain(S.appearance.dark);
  });

  it('falls back to plain words on failed reads and invents nothing', async () => {
    await mount(async () => offline);
    const text = host.textContent ?? '';
    expect(text).toContain(S.backup.fallback);
    expect(text).toContain(S.proofs.fallback);
    expect(text).toContain(S.apps.fallback);
    expect(text).not.toMatch(/\$\d|connected|saved \d|\d+ folders/);
    expect(host.querySelector('.set-state')?.textContent).toBe(S.appearance.system);
    expect(host.querySelector('.set-footer')).toBeNull();
  });

  it('the footer carries the version the health read reports, never a fixed one', async () => {
    await mount();
    expect(host.querySelector('.set-footer')?.textContent).toBe(S.footer.version('9.8.7'));
    await mount(
      answerFrom({ ...ANSWERS, '/api/ui/health': { agent: 'running', version: '1.2.3' } }),
    );
    expect(host.querySelector('.set-footer')?.textContent).toBe(S.footer.version('1.2.3'));
    await mount(answerFrom({ ...ANSWERS, '/api/ui/health': { agent: 'running', version: null } }));
    expect(host.querySelector('.set-footer')).toBeNull();
  });

  it('puts one notice on top by priority: no kit, then out of date, then Touch ID', async () => {
    await mount(
      answerFrom({
        ...ANSWERS,
        '/api/ui/backup': {
          export: 'available',
          record: 'none',
          state: 'none',
          lastKit: null,
          missing: null,
        },
      }),
    );
    expect(host.querySelectorAll('section.al-notice, section.set-notice')).toHaveLength(1);
    expect(host.textContent).toContain(S.notice.noKitTitle);
    expect(host.querySelector('section.set-notice a.al-btn-primary')?.textContent).toBe(
      S.notice.noKitAction,
    );
    expect(rowFor('/settings/backup')?.textContent).toContain(S.backup.notBackedUp);

    await mount();
    expect(host.querySelectorAll('section.al-notice, section.set-notice')).toHaveLength(1);
    expect(host.textContent).toContain('Your recovery kit is missing 1 ID and 2 people.');
    expect(host.querySelector('section.set-notice a.al-btn-primary')?.textContent).toBe(
      S.notice.staleAction,
    );

    await mount(
      answerFrom({
        ...ANSWERS,
        '/api/ui/backup': { ...KIT, state: 'backed_up', missing: { ids: [], people: 0 } },
      }),
      false,
    );
    expect(
      host.querySelectorAll('section.al-notice, section.set-notice').length,
    ).toBeLessThanOrEqual(1);
    expect(host.textContent).not.toContain('recovery kit is missing');
    expect(rowFor('/settings/backup')?.textContent).toContain(S.backup.upToDate);
  });

  it('keeps the keyboard order: the rows are links in reading order, then the page', async () => {
    await mount();
    const links = [...host.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'));
    expect(links.filter((l) => l?.startsWith('/settings/') || l?.startsWith('/advanced/'))).toEqual(
      expect.arrayContaining(SETTINGS_PAGES.map((p) => p.path)),
    );
    for (const r of rows()) expect(r.tabIndex).toBe(0);
  });

  it('shows nothing private: no address, key, token or local path', async () => {
    await mount();
    const text = host.textContent ?? '';
    expect(text).not.toMatch(/wss?:\/\/|https?:\/\/|\/Users\/|127\.0\.0\.1|token|0x[0-9a-f]{8}/i);
  });

  it('has no accessibility violations', async () => {
    await mount();
    const result = await axe.run(host, { rules: { 'color-contrast': { enabled: false } } });
    expect(result.violations).toEqual([]);
  });

  it('uses plain words (11 §5)', () => {
    expect(lintVocabulary(JSON.stringify(S))).toEqual([]);
  });
});

describe('the two-pane frame', () => {
  it('lists the same pages with a back link and marks the current one', () => {
    act(() =>
      root.render(h(SettingsFrame, { path: '/settings/files', children: h('p', null, 'page') })),
    );
    expect(host.querySelector('a.set-back')?.getAttribute('href')).toBe('/settings');
    const links = [...host.querySelectorAll('a.set-side-link')].map((a) => a.getAttribute('href'));
    for (const p of SETTINGS_PAGES) expect(links).toContain(p.path);
    expect(host.querySelector('[aria-current="page"]')?.getAttribute('href')).toBe(
      '/settings/files',
    );
    expect(host.querySelector('.set-body')?.textContent).toBe('page');
  });

  it('wraps the /settings/ pages of the list and Relays & network, not home or the other Advanced pages', () => {
    expect(isSettingsSubpage('/settings')).toBe(false);
    expect(isSettingsSubpage('/settings/files')).toBe(true);
    // UX1113: Settings' Advanced row opens Relays & network inside the two-pane.
    expect(isSettingsSubpage('/advanced/network')).toBe(true);
    expect(isSettingsSubpage('/advanced/diagnostics')).toBe(false);
    expect(isSettingsSubpage('/settings/join')).toBe(false);
  });
});

describe('the kit record read', () => {
  it('reads the R2 record; a bad shape or an unreadable record is unknown, not a guess', () => {
    expect(parseBackup({ export: 'available' })).toBeUndefined();
    expect(parseBackup({ lastKit: 'x' })).toBeUndefined();
    expect(parseBackup({ ...KIT, record: 'unreadable', state: 'unknown' })).toBeUndefined();
    expect(parseBackup({ ...KIT, lastKit: { at: 'x', covers: [] } })).toBeUndefined();
    expect(
      parseBackup({ export: 'available', record: 'none', state: 'none', lastKit: null }),
    ).toEqual({ kind: 'none' });
    // `covers` and `missing.ids` are {name, label} objects (WP-R2).
    expect(parseBackup(KIT)).toEqual({
      kind: 'saved',
      at: KIT.lastKit.at,
      covers: ['Tali'],
      stale: true,
      missingIds: 1,
      missingPeople: 2,
    });
  });
});

describe('round 2', () => {
  it('never claims "up to date": no update check is read, so the footer is the version alone', async () => {
    await mount();
    expect(host.querySelector('.set-footer')?.textContent).toBe('AgentLink 9.8.7');
    expect(host.textContent).not.toMatch(/up to date/i);
  });

  it('tints the states: amber out of date, green working, plain values', async () => {
    await mount();
    const pill = (path: string): Element | null | undefined =>
      rowFor(path)?.querySelector('.set-state');
    expect(pill('/settings/backup')?.className).toContain('is-warn');
    expect(rowFor('/settings/backup')?.querySelector('.set-row-ic')?.className).toContain(
      'is-warn',
    );
    expect(pill('/settings/apps')?.className).toContain('is-plain');
    expect(pill('/settings/proofs')?.className).toContain('is-plain');
    expect(pill('/settings/appearance')?.className).toContain('is-plain');
    const adv = pill('/settings/advanced') ?? pill('/advanced/network');
    expect(adv?.className).toContain('is-good');
  });

  it('a Touch ID entry injected into the pages renders with its meta and state', async () => {
    const pages = [
      ...SETTINGS_PAGES.filter((p) => p.path !== '/settings/touch-id'),
      { label: 'Touch ID', path: '/settings/touch-id' },
    ];
    const render = async (answers: Record<string, unknown>, registered: boolean): Promise<void> => {
      await act(async () => {
        root.render(
          h(
            HoodProvider,
            { value: false },
            h(SettingsPage, { get: answerFrom(answers), approvals: approvals(registered), pages }),
          ),
        );
      });
    };
    await render(ANSWERS, true);
    const row = rowFor('/settings/touch-id');
    expect(row?.querySelector('.set-row-title')?.textContent).toBe(S.touchId.title);
    expect(row?.querySelector('.set-row-line')?.textContent).toBe(S.touchId.line);
    expect(row?.querySelector('.set-state')?.className).toContain('is-good');
    expect(row?.querySelector('.set-state')?.textContent).toMatch(/ on$/);
    expect(row?.querySelector('.set-row-ic svg')).not.toBeNull();
    await render(
      { ...ANSWERS, '/api/owner/passkey': { passkey: { rpId: 'localhost', registered: false } } },
      false,
    );
    expect(rowFor('/settings/touch-id')?.querySelector('.set-state')?.textContent).toBe(
      S.touchId.masterOnly,
    );
  });

  it('finds a setting by title or line, Esc clears, and says so when nothing matches', async () => {
    await mount();
    const input = host.querySelector<HTMLInputElement>('.set-search input');
    const type = (value: string): void => {
      act(() => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        set?.call(input, value);
        input?.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    type('proofs');
    expect(rows().map((r) => r.getAttribute('href'))).toEqual(['/settings/proofs']);
    type('zzzz');
    expect(rows()).toHaveLength(0);
    expect(host.textContent).toContain(S.search.empty);
    act(() => {
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(input?.value).toBe('');
    expect(rows().length).toBe(SETTINGS_PAGES.length);
  });

  it('Rules shows the ID name on the right only when it is given', () => {
    const rules = { asks: 3, total: 4 };
    const withName = lineFor('/settings/rules', { rules }, 'system', 'Touch ID', 'Tali');
    expect(withName.state).toBe('Tali');
    expect(withName.line).toContain('Asks you first for 3 of 4 things.');
    expect(lineFor('/settings/rules', { rules }, 'system', 'Touch ID').state).toBeUndefined();
  });
});
