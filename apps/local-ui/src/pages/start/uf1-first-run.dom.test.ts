// @vitest-environment jsdom
// REL051-UF1 (R1-UI findings 01, 09, 10, 12): Home before an ID exists offers one clear way forward;
// the Get started card follows real state (and stays done); "Tidy up" waits; the stopped-app page
// says how to open AgentLink again.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetHostClosedForTests, markHostClosed } from '../../api/host-closed.js';
import { HostClosedGate } from '../../layout/host-closed-gate.js';
import { START_REFRESH_MS, useStartProgress } from '../approvals/index.js';
import type { Progress } from './setup-state.js';
import { TIDY_AFTER_MS, dueForTidy } from '../agents/tidy.js';
import { FinishSetupCard } from './finish-setup-card.js';
import {
  INVITED_KEY,
  UNKNOWN_STATE,
  invitedBefore,
  readSetupState,
  startProgress,
  type SetupState,
} from './setup-state.js';
import { FINISH_SETUP } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SET_UP: SetupState = {
  owner: 'set_up',
  agent: true,
  appConnected: true,
  contacts: [],
};

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  resetHostClosedForTests();
});

describe('R1-UI-01: Home before an ID exists', () => {
  it('needsFirstId is true with no owner or no ID, never from an unanswered read', () => {
    expect(startProgress({ ...SET_UP, owner: 'missing', agent: false }).needsFirstId).toBe(true);
    expect(startProgress({ ...SET_UP, agent: false }).needsFirstId).toBe(true);
    expect(startProgress(SET_UP).needsFirstId).toBe(false);
    expect(startProgress(UNKNOWN_STATE).needsFirstId).toBe(false);
  });

  it('the card offers "Create your first ID" inside the app and no terminal command', async () => {
    await act(async () => {
      root.render(h(FinishSetupCard));
    });
    const button = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === FINISH_SETUP.create,
    );
    expect(button).toBeDefined();
    expect(button?.className).toContain('al-btn-primary');
    expect(host.textContent).not.toMatch(/terminal|npx|owner init|ask your AI/i);
  });
});

describe('R1-UI-10: the Get started card follows the real state', () => {
  it('an accepted invite on another ID counts as connected with someone', () => {
    const p = startProgress({ ...SET_UP, otherPeople: 2 });
    expect(p.steps.find((s) => s.id === 'invite')?.done).toBe(true);
    expect(p.done).toBe(2);
    expect(p.complete).toBe(true);
  });

  it('once it has happened it stays done (the person was removed)', () => {
    expect(startProgress(SET_UP).steps.find((s) => s.id === 'invite')?.done).toBe(false);
    expect(startProgress(SET_UP, true).steps.find((s) => s.id === 'invite')?.done).toBe(true);
  });

  it('readSetupState reads the people of the other IDs (counts)', async () => {
    const get = vi.fn((path: string) => {
      const data: Record<string, unknown> = {
        '/api/ui/first-run': { owner: 'set_up' },
        '/api/ui/agents': {
          switchable: true,
          current: 'work',
          agents: [{ name: 'work', labelled: true, running: true, apps: ['claude-code'] }],
        },
        '/api/approvals': { approvals: [] },
        '/api/ui/people': {
          status: 'ok',
          ids: [
            { name: 'work', label: 'Work', current: true, status: 'ok', contacts: [] },
            { name: 'home', label: 'Home', current: false, status: 'ok', count: 3 },
          ],
        },
      };
      return Promise.resolve(path in data ? { kind: 'ok', data: data[path] } : { kind: 'offline' });
    });
    const state = await readSetupState({ client: { get } as never });
    expect(state.otherPeople).toBe(3);
  });

  it('Home reads again: a person who accepts while Home is open ticks the step, and it is remembered', async () => {
    vi.useFakeTimers();
    let accepted = false;
    const read = (): Promise<SetupState> =>
      Promise.resolve({ ...SET_UP, otherPeople: accepted ? 1 : 0 });
    let seen: Progress | null | undefined;
    function Probe(): null {
      seen = useStartProgress(read);
      return null;
    }
    await act(async () => {
      root.render(h(Probe));
      await Promise.resolve();
    });
    expect(seen?.steps.find((s) => s.id === 'invite')?.done).toBe(false);
    accepted = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(START_REFRESH_MS + 50);
    });
    expect(seen?.steps.find((s) => s.id === 'invite')?.done).toBe(true);
    expect(localStorage.getItem(INVITED_KEY)).toBe('1');
    expect(invitedBefore()).toBe(true);
  });
});

describe('R1-UI-09: "Tidy up" is not shown right after a restore or a first run', () => {
  it('stamps a new unused ID today and says it is due only after a few days', () => {
    const now = 1_000_000_000_000;
    expect(dueForTidy(['work'], now)).toEqual([]);
    expect(dueForTidy(['work'], now + TIDY_AFTER_MS - 1000)).toEqual([]);
    expect(dueForTidy(['work'], now + TIDY_AFTER_MS)).toEqual(['work']);
  });

  it('forgets an ID that got an app or a person, so it starts again if it is unused later', () => {
    const now = 1_000_000_000_000;
    dueForTidy(['work'], now);
    dueForTidy([], now + 1000);
    expect(dueForTidy(['work'], now + TIDY_AFTER_MS + 5000)).toEqual([]);
  });
});

describe('R1-UI-12: the app stopped', () => {
  it('has a heading, plain steps for this computer, and the terminal only as a second line', async () => {
    markHostClosed();
    await act(async () => {
      root.render(h(HostClosedGate));
    });
    expect(host.querySelector('h1')?.textContent).toBe('AgentLink closed.');
    const items = [...host.querySelectorAll('li')].map((li) => li.textContent ?? '');
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items[0]).toMatch(/Open AgentLink from/);
    const text = host.textContent ?? '';
    expect(text.indexOf('Open AgentLink from')).toBeLessThan(text.indexOf('npx'));
    expect(text).toContain('ui');
  });
});
