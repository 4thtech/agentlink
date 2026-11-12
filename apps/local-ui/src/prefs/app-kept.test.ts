// @vitest-environment jsdom
// UX1113-QA-HOST (B3): the app listens on a new port on every launch, so this browser's storage for
// the page is empty each time. The page choices are kept by the app (UI settings `kept`, the same
// GET/PUT /api/ui/ui-settings and gate): read at start (the app's copy wins), the old browser copy
// sent once when the app has none, and every later change saved. Storage stays the page's working
// copy (and the fallback when the app can't be reached).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UI_SETTINGS_PATH, type UiSettings } from '@4thtech-io/types/ui-contract/ui-settings';
import {
  ARCHIVED_KEY,
  DISMISSED_KEY,
  archivedOf,
  dismissNotice,
  isDismissed,
  resetNoticesForTests,
  setArchived,
} from '../notices/index.js';
import {
  RECOVERY_KIT_LATER_KEY,
  forgetRecoveryKitLater,
  recoveryKitPending,
  rememberRecoveryKitLater,
} from '../states/recovery-kit.js';
import { resetKeptForTests } from './app-kept.js';
import { PREFS_KEY, getPrefs, resetPrefsForTests, setPref } from './store.js';
import { resetUiSettingsForTests, startUiSettings } from './ui-settings.js';

const REF = `0x${'ab'.repeat(20)}`;

interface App {
  stored: UiSettings;
  readonly puts: UiSettings[];
}

function app(stored: UiSettings = {}): { app: App; fetch: typeof fetch } {
  const a: App = { stored, puts: [] };
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : String(input), 'http://localhost');
    expect(url.pathname).toBe(UI_SETTINGS_PATH);
    if ((init?.method ?? 'GET') === 'PUT') {
      const body = JSON.parse(String(init?.body)) as UiSettings;
      a.puts.push(body);
      const kept: Record<string, string | null> = { ...a.stored.kept, ...body.kept };
      for (const k of Object.keys(kept)) if (kept[k] === null) delete kept[k];
      a.stored = { ...a.stored, ...body, ...(body.kept === undefined ? {} : { kept }) };
      return new Response(JSON.stringify(a.stored), { status: 200 });
    }
    return new Response(JSON.stringify(a.stored), { status: 200 });
  }) as typeof fetch;
  return { app: a, fetch: f };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
};

/** A new launch: a new origin, so this browser's storage for the page starts empty. */
function relaunch(): void {
  resetUiSettingsForTests();
  resetKeptForTests();
  localStorage.clear();
  resetNoticesForTests();
  resetPrefsForTests();
}

beforeEach(relaunch);
afterEach(relaunch);

describe('the page choices the app keeps', () => {
  it("the app's copy fills the page at start: theme, dismissals, archive, kit", async () => {
    const { fetch } = app({
      kept: {
        [PREFS_KEY]: JSON.stringify({ ...getPrefs(), theme: 'light' }),
        [DISMISSED_KEY]: JSON.stringify(['tidy-up']),
        [ARCHIVED_KEY]: JSON.stringify([`work/${REF}`]),
        [RECOVERY_KIT_LATER_KEY]: '1762900000000',
        'agentlink.getStarted.hidden': '1',
      },
    });
    await startUiSettings({ fetch });
    expect(getPrefs().theme).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(isDismissed('tidy-up')).toBe(true);
    expect([...archivedOf('work')]).toEqual([REF]);
    expect(recoveryKitPending()).toBe(true);
    expect(localStorage.getItem('agentlink.getStarted.hidden')).toBe('1');
  });

  it("the app's copy wins: a stale browser value the app doesn't hold is cleared", async () => {
    localStorage.setItem(RECOVERY_KIT_LATER_KEY, '5');
    const { fetch, app: a } = app({ kept: {} });
    await startUiSettings({ fetch });
    expect(recoveryKitPending()).toBe(false);
    expect(a.puts).toEqual([]);
  });

  it('sends the browser copy once when the app has none yet (the one-time move)', async () => {
    localStorage.setItem(ARCHIVED_KEY, JSON.stringify([`work/${REF}`]));
    localStorage.setItem('agentlink.idsFit.hidden', '1');
    localStorage.setItem('agentlink.some.other', 'x');
    const { fetch, app: a } = app();
    await startUiSettings({ fetch });
    await flush();
    expect(a.puts).toEqual([
      {
        kept: {
          [ARCHIVED_KEY]: JSON.stringify([`work/${REF}`]),
          'agentlink.idsFit.hidden': '1',
        },
      },
    ]);
  });

  it('saves every later change, and a forget as null', async () => {
    const { fetch, app: a } = app({ kept: {} });
    await startUiSettings({ fetch });
    setPref('theme', 'dark');
    dismissNotice('tidy-up');
    setArchived('work', REF, true);
    rememberRecoveryKitLater(42);
    await flush();
    forgetRecoveryKitLater();
    await flush();
    const kept = a.stored.kept ?? {};
    expect(JSON.parse(kept[PREFS_KEY] ?? '{}')).toMatchObject({ theme: 'dark' });
    expect(kept[DISMISSED_KEY]).toBe(JSON.stringify(['tidy-up']));
    expect(kept[ARCHIVED_KEY]).toBe(JSON.stringify([`work/${REF}`]));
    expect(RECOVERY_KIT_LATER_KEY in kept).toBe(false);
    expect(a.puts.some((p) => p.kept?.[RECOVERY_KIT_LATER_KEY] === null)).toBe(true);
    // Only the allowlisted keys are ever sent.
    localStorage.setItem('agentlink.some.other', 'x');
    await flush();
    for (const p of a.puts) expect(Object.keys(p)).toEqual(['kept']);
  });

  it('a second launch on a new port keeps the choices (Home and People agree on Archive)', async () => {
    const first = app({ kept: {} });
    await startUiSettings({ fetch: first.fetch });
    setPref('theme', 'light');
    setArchived('work', REF, true);
    dismissNotice('tidy-up');
    await flush();
    const kept = first.app.stored;

    relaunch();
    expect(getPrefs().theme).toBe('system');
    expect(archivedOf('work').size).toBe(0);
    const second = app(kept);
    await startUiSettings({ fetch: second.fetch });
    expect(getPrefs().theme).toBe('light');
    expect([...archivedOf('work')]).toEqual([REF]);
    expect(isDismissed('tidy-up')).toBe(true);
  });

  it('works on with the browser copy when the app is out of reach', async () => {
    localStorage.setItem(RECOVERY_KIT_LATER_KEY, '5');
    const down = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
    await startUiSettings({ fetch: down });
    expect(recoveryKitPending()).toBe(true);
    setPref('theme', 'dark');
    await flush();
    expect(getPrefs().theme).toBe('dark');
  });

  it('never sends a hostile value a page put in storage', async () => {
    const { fetch, app: a } = app({ kept: {} });
    await startUiSettings({ fetch });
    localStorage.setItem(ARCHIVED_KEY, JSON.stringify(['work/Alice says hi']));
    setArchived('work', REF, true);
    await flush();
    for (const p of a.puts) expect(JSON.stringify(p)).not.toContain('Alice');
  });
});
