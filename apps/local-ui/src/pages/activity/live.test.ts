// @vitest-environment jsdom
// W4-SETTINGS-ADVANCED (S1): the live activity stream (Under the hood; prototype "Live activity
// stream"). It listens to one source (today the 5 s polling of api/live.ts; U1-b's SSE replaces the
// source, not the page). Names are text only, isolated for bidi (I-5), and nothing of a message.
import { lintVocabulary } from '@4thtech-io/ui';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveAgent, LiveSnapshot } from '../../api/live.js';
import { LiveActivityPage } from './live.js';
import { LIVE_STREAM_STRINGS as S } from './live-strings.js';
import { MAX_STREAM_LINES, diffLines, type RawLine, type StreamSource } from './live-stream.js';

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

const agent = (
  label: string,
  apps: readonly [string, 'ready' | 'off' | 'working'][],
): LiveAgent => ({
  name: label.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  label,
  current: false,
  state: 'ready',
  statusText: '',
  removing: false,
  apps: apps.map(([app, state]) => ({ app, state, word: state })),
});
const snap = (...agents: LiveAgent[]): LiveSnapshot => ({ list: undefined, agents, error: false });

describe('diffLines', () => {
  it('says where every app stands on the first answer', () => {
    const lines = diffLines(undefined, snap(agent('Work', [['Claude Code', 'ready']])), 1000);
    expect(lines).toEqual([{ at: 1000, kind: 'heartbeat', text: 'Claude Code · Work · ready' }]);
  });
  it('says nothing while nothing changed, and one line for a change', () => {
    const a = snap(agent('Work', [['Claude Code', 'ready']]));
    expect(diffLines(a, snap(agent('Work', [['Claude Code', 'ready']])), 2000)).toEqual([]);
    const b = snap(agent('Work', [['Claude Code', 'working']]));
    expect(diffLines(a, b, 3000)).toEqual([
      { at: 3000, kind: 'state', text: 'Claude Code · Work · working' },
    ]);
  });
  it('says when an app is gone', () => {
    const a = snap(agent('Work', [['Claude Code', 'ready']]));
    expect(diffLines(a, snap(agent('Work', [])), 4000)).toEqual([
      { at: 4000, kind: 'state', text: 'Claude Code · Work · not set up' },
    ]);
  });
});

function manualSource(): { source: StreamSource; emit: (l: RawLine) => void; open: () => boolean } {
  let on: ((l: RawLine) => void) | undefined;
  return {
    source: {
      subscribe(onLine) {
        on = onLine;
        return () => {
          on = undefined;
        };
      },
    },
    emit: (l) => on?.(l),
    open: () => on !== undefined,
  };
}

async function mount(source: StreamSource): Promise<void> {
  await act(async () => root.render(h(LiveActivityPage, { source })));
}

describe('Live activity stream', () => {
  it('has one h1, a polite log and says it is waiting before the first line', async () => {
    const m = manualSource();
    await mount(m.source);
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(host.querySelector('h1')?.textContent).toBe(S.title);
    expect(host.querySelector('[role="log"]')?.getAttribute('aria-live')).toBe('polite');
    expect(host.textContent).toContain(S.waiting);
  });

  it('lists lines newest first, with the time, the kind and the text', async () => {
    const m = manualSource();
    await mount(m.source);
    await act(async () =>
      m.emit({ at: Date.UTC(2026, 9, 30, 14, 12, 0), kind: 'heartbeat', text: 'A' }),
    );
    await act(async () =>
      m.emit({ at: Date.UTC(2026, 9, 30, 14, 12, 5), kind: 'state', text: 'B' }),
    );
    const rows = [...host.querySelectorAll('[role="log"] .ls-line')];
    expect(rows.map((r) => r.querySelector('.ls-text')?.textContent)).toEqual(['B', 'A']);
    expect(rows[0]?.querySelector('.ls-kind')?.textContent).toBe('state');
    expect(rows[0]?.querySelector('time')).not.toBeNull();
  });

  it('shows names as text with bidi isolation, never as markup', async () => {
    const m = manualSource();
    await mount(m.source);
    await act(async () =>
      m.emit({ at: 1, kind: 'state', text: '<img src=x onerror=alert(1)> ‮evil' }),
    );
    expect(host.querySelector('[role="log"] img')).toBeNull();
    const text = host.querySelector('.ls-text');
    expect(text?.querySelector('bdi')).not.toBeNull();
    expect(text?.textContent).not.toContain('‮');
    expect(text?.textContent).toContain('<img');
  });

  it('pauses without losing lines, and shows them when it resumes', async () => {
    const m = manualSource();
    await mount(m.source);
    await act(async () => m.emit({ at: 1, kind: 'heartbeat', text: 'one' }));
    const toggle = host.querySelector<HTMLButtonElement>('button.ls-toggle');
    expect(toggle?.textContent).toBe(S.pause);
    await act(async () => toggle?.click());
    expect(toggle?.textContent).toBe(S.resume);
    await act(async () => m.emit({ at: 2, kind: 'state', text: 'two' }));
    expect(host.querySelectorAll('.ls-line')).toHaveLength(1);
    await act(async () => toggle?.click());
    expect(host.querySelectorAll('.ls-line')).toHaveLength(2);
  });

  it('keeps at most MAX_STREAM_LINES and stops listening when it goes away', async () => {
    const m = manualSource();
    await mount(m.source);
    await act(async () => {
      for (let i = 0; i < MAX_STREAM_LINES + 5; i++)
        m.emit({ at: i, kind: 'heartbeat', text: `l${String(i)}` });
    });
    expect(host.querySelectorAll('.ls-line')).toHaveLength(MAX_STREAM_LINES);
    expect(m.open()).toBe(true);
    act(() => root.unmount());
    expect(m.open()).toBe(false);
    root = createRoot(host);
  });

  it('uses plain words (11 §5) and shows no message, key or file name', () => {
    expect(lintVocabulary(JSON.stringify(S))).toEqual([]);
    expect(S.intro).toContain('only');
  });
});
