// @vitest-environment jsdom
// RELAY-SHARED-CONN L4 (08 §1 "What the owner sees"; 11 §5.15): Advanced › Message network (Under
// the hood) shows one line about the shared server connection from the answer's `sharedLink`:
// a boolean and a count only.
import { lintVocabulary } from '@4thtech-io/ui';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '../../../api/client.js';
import { parseNetwork } from './data.js';
import { NETWORK_STRINGS as S } from './strings.js';
import { NetworkView } from './view.js';

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

const NOW = 1_800_000_000;
const answer = (sharedLink?: unknown): Record<string, unknown> => ({
  agent: 'running',
  mode: 'automatic',
  checking: false,
  checkedAt: NOW - 20,
  servers: [],
  legacyReadUntil: null,
  contacts: { total: 0, sharing: 0 },
  ...(sharedLink === undefined ? {} : { sharedLink }),
});

async function mount(data: unknown): Promise<void> {
  const read = vi.fn(() => Promise.resolve<ApiResult<unknown>>({ kind: 'ok', status: 200, data }));
  await act(async () => root.render(h(NetworkView, { read, now: () => NOW, online: () => true })));
  await act(async () => undefined);
}

describe('Message network: the shared server connection line (11 §5.15)', () => {
  it('the strings are the spec copy and pass the vocabulary lint', () => {
    expect(S.sharedOn(3)).toBe('Shared server connection: on · 3 programs on this computer');
    expect(S.sharedOff).toBe('Shared server connection: off · each program connects on its own');
    expect(lintVocabulary(S.sharedOn(2))).toEqual([]);
    expect(lintVocabulary(S.sharedOff)).toEqual([]);
  });

  it('parses sharedLink: a boolean and a count, off for anything else', () => {
    expect(parseNetwork(answer({ on: true, programs: 2 }))?.sharedLink).toEqual({
      on: true,
      programs: 2,
    });
    expect(parseNetwork(answer())?.sharedLink).toEqual({ on: false, programs: 0 });
    expect(parseNetwork(answer({ on: 'yes', programs: -3 }))?.sharedLink).toEqual({
      on: false,
      programs: 0,
    });
  });

  it('shows the on line with the count', async () => {
    await mount(answer({ on: true, programs: 2 }));
    expect(host.textContent).toContain(S.sharedOn(2));
    expect(host.querySelectorAll('.nw-shared')).toHaveLength(1);
  });

  it('shows the off line when it is off or not answered', async () => {
    await mount(answer({ on: false, programs: 0 }));
    expect(host.textContent).toContain(S.sharedOff);
  });
});
