// @vitest-environment jsdom
// HOTFIX-045-TOPBAR (B7): a file that arrived and is not saved shows a fixed label, not a bar that
// animates for ever at step 0.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilesPage, type FilesPageProps } from './index.js';

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

const RECEIVED = '/api/ui/files/received?limit=20';
const routes: Record<string, unknown> = {
  [RECEIVED]: {
    items: [
      {
        id: 'a.00',
        from: 'Marko',
        at: 1_792_000_000,
        name: 'plan.pdf',
        size: 1000,
        state: 'not_saved',
        savedName: undefined,
        proof: false,
      },
    ],
  },
};
const fetchFn = ((input: RequestInfo | URL) => {
  const found = routes[String(input)];
  return Promise.resolve(
    found === undefined
      ? new Response('{}', { status: 404 })
      : new Response(JSON.stringify(found), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
  );
}) as typeof fetch;

describe('HOTFIX-045-TOPBAR: the Arrived label', () => {
  it('has no endless animation on a file that arrived: no progress bar, a fixed label', async () => {
    await act(async () => {
      root.render(h<FilesPageProps>(FilesPage, { fetch: fetchFn, token: 'tok' }));
    });
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await Promise.resolve();
      });
    }
    const row = host.querySelector('.fl-item');
    expect(row).not.toBeNull();
    expect(row?.querySelector('[role="progressbar"]')).toBeNull();
    expect(row?.querySelector('.al-pb, .is-unknown')).toBeNull();
    // 11 §5: the fixed line, once.
    expect(row?.textContent).toContain('Not saved yet. Ask your AI to fetch it.');
  });
});
