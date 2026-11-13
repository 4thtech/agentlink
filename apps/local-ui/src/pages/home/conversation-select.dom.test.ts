// @vitest-environment jsdom
// RET-4 (D-148; 08 §1 "Messages also allow selecting several messages, then Delete"; 11 §5): the
// conversation's Select mode. Each message gets a checkbox; "Delete {n} messages" hands exactly the
// chosen message IDs to the delete sheet; Cancel leaves the mode and chooses nothing.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageItem } from '../messages/api.js';
import { Conversation, type Thread } from './conversation.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const msg = (id: string, at: number, text: string): MessageItem => ({
  id,
  at,
  text,
  files: [],
  receipt: false,
  proof: false,
  size: 100,
});
const THREAD: Thread = {
  state: 'ready',
  inbox: { items: [msg('in-1', 1_800_000_010, 'Hello from Ana')], paged: false },
  sent: { items: [{ ...msg('out-1', 1_800_000_020, 'Hi Ana'), status: 'sent' }], paged: false },
};

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

const button = (pattern: RegExp): HTMLButtonElement | undefined =>
  [...host.querySelectorAll('button')].find((b) => pattern.test((b.textContent ?? '').trim()));

async function show(onDelete: (ids: readonly string[]) => void): Promise<void> {
  await act(async () => {
    root.render(
      createElement(Conversation, {
        name: 'Ana',
        agent: 'Personal',
        pro: false,
        thread: THREAD,
        loadEarlier: () => Promise.resolve(),
        onDelete,
      }),
    );
  });
}

describe('the conversation: select messages, then Delete (RET-4)', () => {
  it('checkboxes appear only in Select mode; Delete hands the chosen IDs on', async () => {
    const onDelete = vi.fn();
    await show(onDelete);
    expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    await act(async () => {
      button(/^Select$/)?.click();
    });
    const boxes = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes).toHaveLength(2);
    expect(button(/^Delete 0 messages$/)?.disabled).toBe(true);
    await act(async () => {
      boxes[1]?.click();
    });
    const del = button(/^Delete 1 message$/);
    expect(del?.disabled).toBe(false);
    await act(async () => {
      del?.click();
    });
    expect(onDelete).toHaveBeenCalledWith(['out-1']);
  });

  it('Cancel leaves Select mode and chooses nothing', async () => {
    const onDelete = vi.fn();
    await show(onDelete);
    await act(async () => {
      button(/^Select$/)?.click();
    });
    await act(async () => {
      button(/^Cancel$/)?.click();
    });
    expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('without a delete handler there is no Select', async () => {
    await act(async () => {
      root.render(
        createElement(Conversation, {
          name: 'Ana',
          agent: 'Personal',
          pro: false,
          thread: THREAD,
          loadEarlier: () => Promise.resolve(),
        }),
      );
    });
    expect(button(/^Select$/)).toBeUndefined();
  });
});
