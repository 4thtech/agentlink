// @vitest-environment jsdom
// WIN-BROKEN-ID: an ID whose key is missing: the IDs read marks it, and Home's notice offers exactly
// Restore from backup (the restore-in-app flow), Remove from this computer and Continue without it.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrokenIdNotice, RESTORE_HREF } from './broken-id.js';
import { parseAgents, type AgentRow } from './data.js';
import { AGENTS_STRINGS as S } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const row = (over: Partial<AgentRow> = {}): AgentRow => ({
  name: 'default',
  label: 'Personal',
  current: false,
  available: true,
  removing: false,
  broken: true,
  contacts: null,
  running: false,
  apps: [],
  ...over,
});

describe('the IDs read (WIN-BROKEN-ID)', () => {
  it('marks a broken ID, and only when the host says so', () => {
    const list = parseAgents({
      switchable: true,
      generation: 1,
      current: 'work',
      label: 'Work',
      agents: [
        {
          name: 'default',
          label: 'Personal',
          labelled: true,
          current: false,
          available: true,
          removing: false,
          broken: true,
          contacts: null,
          running: false,
          apps: [],
        },
        {
          name: 'work',
          label: 'Work',
          labelled: true,
          current: true,
          available: true,
          removing: false,
          contacts: 0,
          running: false,
          apps: [],
        },
      ],
    });
    const rows = list?.agents ?? [];
    expect(rows.find((r) => r.name === 'default')?.broken).toBe(true);
    expect(rows.find((r) => r.name === 'work')?.broken).toBeUndefined();
  });
});

describe('BrokenIdNotice (WIN-BROKEN-ID)', () => {
  it('names the ID and offers the three choices', () => {
    const removed: string[] = [];
    const continued: string[] = [];
    act(() =>
      root.render(
        createElement(BrokenIdNotice, {
          row: row(),
          onRemove: (r) => removed.push(r.name),
          onContinue: (r) => continued.push(r.name),
        }),
      ),
    );
    const text = host.textContent ?? '';
    expect(text).toContain(S.brokenTitle('Personal'));
    expect(text).not.toMatch(/wallet|seed phrase|keychain|gas|transaction/i);
    const link = host.querySelector('a');
    expect(link?.getAttribute('href')).toBe(RESTORE_HREF);
    expect(link?.textContent).toBe(S.restoreFromBackup);
    const buttons = [...host.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toEqual([S.removeFromComputer, S.continueWithout]);
    act(() => buttons[0]?.click());
    act(() => buttons[1]?.click());
    expect(removed).toEqual(['default']);
    expect(continued).toEqual(['default']);
  });
});
