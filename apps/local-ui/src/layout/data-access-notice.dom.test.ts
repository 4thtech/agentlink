// @vitest-environment jsdom
// WIN-ACL-NOTICE: a health answer with `dataAccess: 'unchecked'` shows one non-blocking notice;
// nothing else does, and it can be closed.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiResult } from '../api/client.js';
import {
  DATA_ACCESS_STRINGS,
  DataAccessNotice,
  dataAccessUnchecked,
} from './data-access-notice.js';
import { resetHealthFeedForTests } from './health-feed.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  resetHealthFeedForTests();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  resetHealthFeedForTests();
});

const ok = (data: unknown): ApiResult<unknown> => ({ kind: 'ok', data }) as ApiResult<unknown>;

async function show(result: ApiResult<unknown>): Promise<void> {
  await act(async () => {
    root.render(h(DataAccessNotice, { read: () => Promise.resolve(result) }));
    await Promise.resolve();
  });
}

describe('dataAccessUnchecked', () => {
  it('is true only for the exact word', () => {
    expect(dataAccessUnchecked(ok({ agent: 'running', dataAccess: 'unchecked' }))).toBe(true);
    expect(dataAccessUnchecked(ok({ agent: 'running' }))).toBe(false);
    expect(dataAccessUnchecked(ok({ dataAccess: 'ok' }))).toBe(false);
    expect(dataAccessUnchecked(ok(null))).toBe(false);
    expect(dataAccessUnchecked({ kind: 'offline' } as ApiResult<unknown>)).toBe(false);
  });
});

describe('DataAccessNotice', () => {
  it('shows the fixed notice, closable, and no other text from the answer', async () => {
    await show(ok({ agent: 'running', dataAccess: 'unchecked', dataFolder: '~/.agentlink' }));
    const notice = host.querySelector('[data-notice="warning"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain(DATA_ACCESS_STRINGS.title);
    expect(notice?.textContent).not.toMatch(/ACL|SID|DACL|wallet|gas|seed/);
    const close = notice?.querySelector('button');
    expect(close).not.toBeNull();
    await act(async () => {
      close?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(host.querySelector('[data-notice]')).toBeNull();
  });

  it('shows nothing when the answer has no flag', async () => {
    await show(ok({ agent: 'running' }));
    expect(host.querySelector('[data-notice]')).toBeNull();
  });
});
