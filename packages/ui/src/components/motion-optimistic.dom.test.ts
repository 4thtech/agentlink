// @vitest-environment jsdom
// W4-MOTION-KIT (S0): the optimistic-item helper ("messages you send appear at once, then confirm").
// An added item shows at once as pending; once the confirmed list holds its id the confirmed copy
// replaces it in place (no flash, no jump); confirm() before the list catches up keeps it shown;
// fail() keeps it with a failed state for a retry; dismiss() removes it.
import { act, createElement as h, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mergeOptimistic, useOptimisticItems, type OptimisticHandle } from './index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Msg {
  id: string;
  text: string;
}

describe('mergeOptimistic', () => {
  it('lists confirmed items first, then pending ones not yet confirmed', () => {
    const out = mergeOptimistic<Msg>(
      [{ id: 'a', text: 'A' }],
      [
        { item: { id: 'b', text: 'B' }, state: 'pending' },
        { item: { id: 'a', text: 'A (local)' }, state: 'pending' },
      ],
    );
    expect(out).toEqual([
      { item: { id: 'a', text: 'A' }, state: 'confirmed' },
      { item: { id: 'b', text: 'B' }, state: 'pending' },
    ]);
  });
});

describe('useOptimisticItems', () => {
  let host: HTMLElement;
  let root: Root;
  let api!: { items: ReturnType<typeof mergeOptimistic<Msg>>; add: (m: Msg) => OptimisticHandle };
  function List({ confirmed }: { confirmed: Msg[] }): ReactElement {
    api = useOptimisticItems(confirmed);
    return h(
      'ul',
      null,
      api.items.map((e) => h('li', { key: e.item.id, 'data-state': e.state }, e.item.text)),
    );
  }
  const rows = (): string[] =>
    [...host.querySelectorAll('li')].map((l) => `${l.textContent}:${l.getAttribute('data-state')}`);

  beforeEach(() => {
    host = document.body.appendChild(document.createElement('div'));
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('shows an added item at once, then the confirmed copy in its place', () => {
    act(() => root.render(h(List, { confirmed: [{ id: '1', text: 'hi' }] })));
    let handle!: OptimisticHandle;
    act(() => {
      handle = api.add({ id: '2', text: 'sending' });
    });
    expect(rows()).toEqual(['hi:confirmed', 'sending:pending']);
    act(() => handle.confirm());
    expect(rows()).toEqual(['hi:confirmed', 'sending:confirmed']);
    act(() =>
      root.render(
        h(List, {
          confirmed: [
            { id: '1', text: 'hi' },
            { id: '2', text: 'sent' },
          ],
        }),
      ),
    );
    expect(rows()).toEqual(['hi:confirmed', 'sent:confirmed']);
  });

  it('forgets a local item once it is confirmed, so it never comes back stale', () => {
    act(() => root.render(h(List, { confirmed: [] })));
    act(() => {
      api.add({ id: 'm', text: 'local copy' });
    });
    act(() => root.render(h(List, { confirmed: [{ id: 'm', text: 'sent' }] })));
    expect(rows()).toEqual(['sent:confirmed']);
    // The confirmed list later drops it (deleted elsewhere): the old local copy must not reappear.
    act(() => root.render(h(List, { confirmed: [] })));
    expect(rows()).toEqual([]);
  });

  it('keeps a failed item with a failed state, and dismiss removes it', () => {
    act(() => root.render(h(List, { confirmed: [] })));
    let handle!: OptimisticHandle;
    act(() => {
      handle = api.add({ id: 'x', text: 'oops' });
    });
    act(() => handle.fail());
    expect(rows()).toEqual(['oops:failed']);
    act(() => handle.dismiss());
    expect(rows()).toEqual([]);
  });
});
