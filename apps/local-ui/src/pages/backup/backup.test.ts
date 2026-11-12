// @vitest-environment jsdom
// WP-R4 (S1): Settings › Backup & restore, spec §6.2. The status card comes from the server's kit
// record (GET /api/ui/backup, WP-R2), in three states; an unreadable record is said in plain words.
import { lintVocabulary } from '@4thtech-io/ui';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiClient } from '../../api/client.js';
import {
  kitRecordState,
  recoveryKitPending,
  rememberRecoveryKitLater,
  setKitRecordState,
} from '../../states/index.js';
import { BackupPage } from './index.js';
import { parseKitStatus } from './status.js';
import { BACKUP_STRINGS as S } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  setKitRecordState(undefined);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const AT = Date.UTC(2026, 10, 3, 12);
const BACKED_UP = {
  export: 'available',
  record: 'saved',
  state: 'backed_up',
  lastKit: { at: AT, covers: [{ name: 'Tali', label: 'Tali' }], peopleAtSave: 3 },
  missing: { ids: [], people: 0 },
};
const STALE = {
  ...BACKED_UP,
  state: 'out_of_date',
  missing: { ids: [{ name: 'macbook-agent-1', label: 'x' }], people: 2 },
};
const NONE = { export: 'available', record: 'none', state: 'none', lastKit: null, missing: null };
const UNREADABLE = {
  export: 'available',
  record: 'unreadable',
  state: 'unknown',
  lastKit: null,
  missing: null,
};

function apiOf(data: unknown): ApiClient {
  return {
    get: () =>
      Promise.resolve(
        data === 'fail'
          ? ({ kind: 'offline' } as const)
          : ({ kind: 'ok', status: 200, data } as never),
      ),
    post: () => Promise.resolve({ kind: 'ok', status: 200, data: { status: 'shown' } } as never),
    owner: () => Promise.resolve({ kind: 'error', status: 404 }),
  };
}
async function show(data: unknown): Promise<void> {
  await act(async () =>
    root.render(h(BackupPage, { api: apiOf(data), passkey: () => Promise.resolve(undefined) })),
  );
  for (let i = 0; i < 6; i += 1)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
}
const text = (): string => host.textContent ?? '';
const labels = (): string[] =>
  [...host.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim());

describe('Backup & restore', () => {
  it('has one h1 with the lead, the three columns, two lists and the restore and move rows', async () => {
    await show(BACKED_UP);
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(host.querySelector('h1')?.textContent).toBe(S.title);
    expect(text()).toContain(S.lead);
    expect(host.querySelectorAll('.bk-col')).toHaveLength(3);
    expect(text()).toContain(S.neverToAi);
    expect(text()).toContain(S.comesBackTitle);
    expect(text()).toContain(S.againTitle);
    const hrefs = [...host.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/restore/kit');
    expect(hrefs).toContain('/restore/move');
    expect(host.querySelector('[data-native-slot="touch-id"]')).not.toBeNull();
  });

  it("backed up: green card, date, names, and 'Save a new kit'", async () => {
    await show(BACKED_UP);
    expect(host.querySelector('[data-kit-state="backed_up"]')?.className).toContain('is-good');
    expect(text()).toContain(S.upToDateTitle);
    expect(text()).toContain('Covers Tali.');
    expect(labels()).toContain(S.saveNew);
    expect(labels()).toContain(S.showInFinder);
  });

  it('out of date: amber, says what is not in the kit yet', async () => {
    await show(STALE);
    expect(host.querySelector('[data-kit-state="out_of_date"]')?.className).toContain('is-warn');
    expect(text()).toContain(S.staleTitle);
    expect(text()).toContain('Not in it yet: macbook-agent-1 and 2 people who joined since.');
    expect(labels()).toContain(S.saveNew);
  });

  it('no kit: amber, plain sentence, Save a recovery kit, no Show in Finder', async () => {
    await show(NONE);
    expect(text()).toContain(S.noneTitle);
    expect(text()).toContain(S.noneLine);
    expect(labels()).toContain(S.saveFirst);
    expect(labels()).not.toContain(S.showInFinder);
  });

  it('an unreadable record or a failed read says so and invents no state', async () => {
    for (const data of [UNREADABLE, 'fail']) {
      act(() => root.unmount());
      root = createRoot(host);
      await show(data);
      expect(host.querySelector('[data-kit-state="unknown"]')).not.toBeNull();
      expect(text()).toContain(S.unknownTitle);
      expect(text()).not.toContain(S.upToDateTitle);
      expect(text()).not.toContain(S.noneTitle);
    }
  });

  it('shows names as text in <bdi>, never as markup (I-5)', async () => {
    await show({
      ...BACKED_UP,
      lastKit: { ...BACKED_UP.lastKit, covers: [{ name: 'Tali', label: '<b>x</b>' }] },
    });
    expect(host.querySelector('.bk-status-text bdi')?.textContent).toBe('Tali');
    expect(host.querySelector('.bk-status-text b')).toBeNull();
  });

  it('the server record wins over the browser flag', async () => {
    rememberRecoveryKitLater();
    expect(recoveryKitPending()).toBe(true);
    await show(BACKED_UP);
    expect(kitRecordState()).toBe('backed_up');
    expect(recoveryKitPending()).toBe(false);
    act(() => root.unmount());
    root = createRoot(host);
    await show(NONE);
    expect(recoveryKitPending()).toBe(true);
  });

  it('parses strictly: odd answers are unknown', () => {
    expect(parseKitStatus(undefined).state).toBe('unknown');
    expect(parseKitStatus({ record: 'saved', state: 'backed_up', lastKit: null }).state).toBe(
      'unknown',
    );
    expect(parseKitStatus({ record: 'saved', state: 'weird', lastKit: { at: AT } }).state).toBe(
      'unknown',
    );
    expect(parseKitStatus(BACKED_UP).covers).toEqual(['Tali']);
  });

  it('uses plain words (11 §5)', () => {
    expect(lintVocabulary(JSON.stringify(S))).toEqual([]);
  });
});
