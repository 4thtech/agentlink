// @vitest-environment jsdom
// W4-SETTINGS-ADVANCED (S1): Advanced › Diagnostics. Each AI app with the agent in it and its status,
// and a report with versions, statuses and counts only: no message, key or file name.
import { lintVocabulary } from '@4thtech-io/ui';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiResult } from '../../api/client.js';
import type { LiveSnapshot } from '../../api/live.js';
import { DiagnosticsPage, buildReport } from './diagnostics.js';
import { DIAGNOSTICS_STRINGS as S } from './diagnostics-strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLElement;
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

const ok = (data: unknown): ApiResult<unknown> => ({ kind: 'ok', status: 200, data });
const health = ok({ agent: 'running', version: '0.4.6', relays: { connected: 1, total: 2 } });
const live: LiveSnapshot = {
  list: undefined,
  error: false,
  agents: [
    {
      name: 'work',
      label: 'Work',
      current: true,
      state: 'ready',
      statusText: '',
      removing: false,
      apps: [{ app: 'Claude Code', state: 'ready', word: 'Ready' }],
    },
  ],
};

describe('buildReport', () => {
  it('has the version, the statuses and the relay counts only', () => {
    const text = buildReport({ version: '0.4.6', relays: { connected: 1, total: 2 }, live });
    expect(text).toContain('AgentLink 0.4.6');
    expect(text).toContain('Claude Code · Work · Ready');
    expect(text).toContain('Relays: 1 of 2 connected');
    expect(text).not.toMatch(/wss?:|https?:|\/Users\/|token/i);
  });
});

describe('Diagnostics', () => {
  async function mount(clip?: (t: string) => Promise<void>): Promise<void> {
    await act(async () =>
      root.render(h(DiagnosticsPage, { read: async () => health, live, copy: clip })),
    );
  }
  it('has one h1, the version and a row per AI app with its agent and status', async () => {
    await mount();
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(host.querySelector('h1')?.textContent).toBe(S.title);
    expect(host.textContent).toContain('AgentLink 0.4.6');
    const row = host.querySelector('tbody tr');
    expect(row?.textContent).toContain('Claude Code');
    expect(row?.textContent).toContain('Work');
    expect(row?.textContent).toContain('Ready');
  });
  it('copies the report and says what it holds, in a polite status', async () => {
    const copied: string[] = [];
    await mount(async (t) => void copied.push(t));
    await act(async () => host.querySelector<HTMLButtonElement>('button.dg-copy')?.click());
    expect(copied).toHaveLength(1);
    expect(copied[0]).toContain('Claude Code · Work · Ready');
    expect(host.querySelector('[role="status"]')?.textContent).toBe(S.copied);
  });
  it('keeps the licence and the public links of About', async () => {
    await mount();
    expect(host.textContent).toContain('MIT');
    expect(host.querySelectorAll('a[href^="https://"]').length).toBeGreaterThanOrEqual(3);
  });
  it('uses plain words (11 §5)', () => {
    expect(lintVocabulary(JSON.stringify(S))).toEqual([]);
  });
});
