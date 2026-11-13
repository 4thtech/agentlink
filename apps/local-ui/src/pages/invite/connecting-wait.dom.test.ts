// @vitest-environment jsdom
// REL051-CF1 (R1-CLASS-01, -06; 08 §1; 04 §3.6): an accept that waits never sits on "Connecting to
// …" for good. From when it began (`startedAt`, from the server, so it holds after a restart):
// - the first seconds: "Connecting to {name}…";
// - after a short wait (REL051-R2C, R2-CLASS-01): "Waiting for {name}'s AgentLink. If someone else
//   already used this invite, it won't connect: ask {name} for a new one." (never "it connects by
//   itself": a lost race never does);
// - after a bounded wait: "No answer from {name} yet. If this invite was already used or cancelled,
//   it won't connect. Ask {name} for a new one." Nothing says who else answered (there is no such
//   signal): the line is honest about what this side cannot know.
// Every waiting row has a real Cancel (the server route, REL051-B1). Names are text only (I-5).
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectingRow } from '../contacts/invite-api.js';
import { parseConnecting } from '../contacts/invite-api.js';
import {
  CONNECTING_HINT_MS,
  CONNECTING_NO_ANSWER_MS,
  connectingLine,
  connectingStage,
} from './connecting-stage.js';
import { ConnectingInviteRow } from './pending-row.js';

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

const NOW = 1_800_000_000_000;
const REF = `0x${'a1'.repeat(20)}`;
const at = (agoMs: number, over: Partial<ConnectingRow> = {}): ConnectingRow => ({
  ref: REF,
  name: 'Ana Novak',
  expiresAt: NOW + 6 * 86_400_000,
  sent: true,
  again: false,
  startedAt: NOW - agoMs,
  ...over,
});

const WAITING =
  "Waiting for Ana Novak's AgentLink. If someone else already used this invite, it won't connect: ask Ana Novak for a new one.";
const NO_ANSWER =
  "No answer from Ana Novak yet. If this invite was already used or cancelled, it won't connect. Ask Ana Novak for a new one.";

describe('connectingStage: from when the accept began', () => {
  it('connecting, then waiting after a short time, then no answer after a bounded time', () => {
    expect(CONNECTING_HINT_MS).toBe(10_000);
    expect(CONNECTING_NO_ANSWER_MS).toBe(120_000);
    expect(connectingStage(at(2_000), NOW)).toBe('connecting');
    expect(connectingStage(at(CONNECTING_HINT_MS), NOW)).toBe('waiting');
    expect(connectingStage(at(CONNECTING_NO_ANSWER_MS - 1), NOW)).toBe('waiting');
    expect(connectingStage(at(CONNECTING_NO_ANSWER_MS), NOW)).toBe('noAnswer');
  });

  it('blocked wins; an accept that has not left this computer says so until the bound', () => {
    expect(connectingStage(at(999_999, { blocked: true }), NOW)).toBe('blocked');
    expect(connectingStage(at(20_000, { sent: false }), NOW)).toBe('notSent');
    expect(connectingStage(at(CONNECTING_NO_ANSWER_MS, { sent: false }), NOW)).toBe('noAnswer');
  });

  it('with no start time (an older server) it stays as before', () => {
    const old: ConnectingRow = { ...at(0) };
    delete (old as { startedAt?: number }).startedAt;
    expect(connectingStage(old, NOW)).toBe('connecting');
    expect(connectingStage({ ...old, sent: false }, NOW)).toBe('notSent');
  });

  it('the lines, text only', () => {
    // IR-REL051-R2C-1: honest from the first line.
    expect(connectingLine(at(2_000), NOW)).toBe(
      "Connecting to Ana Novak… If someone else already used this invite, it won't connect: ask Ana Novak for a new one.",
    );
    expect(connectingLine(at(15_000), NOW)).toBe(WAITING);
    expect(connectingLine(at(180_000), NOW)).toBe(NO_ANSWER);
  });
});

describe('parseConnecting reads startedAt', () => {
  it('as unix milliseconds; a value of another shape is left out', () => {
    const base = {
      ref: REF,
      name: 'Ana',
      expiresAt: '2099-01-15T08:00:00Z',
      sent: true,
      again: false,
    };
    const [one, two] = parseConnecting({
      connecting: [
        { ...base, startedAt: '2027-01-15T08:00:00Z' },
        { ...base, startedAt: 'yesterday' },
      ],
    });
    expect(one?.startedAt).toBe(Date.parse('2027-01-15T08:00:00Z'));
    expect(two).toBeDefined();
    expect(Object.hasOwn(two ?? {}, 'startedAt')).toBe(false);
  });
});

describe('ConnectingInviteRow: never stuck (R1-CLASS-01, -06)', () => {
  const buttons = (label: string): HTMLButtonElement[] =>
    [...host.querySelectorAll('button')].filter((b) => (b.textContent ?? '').trim() === label);

  it('after a short wait: the hint, and Cancel', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      act(() =>
        root.render(
          h(ConnectingInviteRow, {
            row: at(15_000),
            onCancel: () => Promise.resolve('cancelled' as const),
          }),
        ),
      );
      expect(host.textContent).toContain(WAITING);
      expect(buttons('Cancel')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('after the bound: no answer, ask for a new invite, and Cancel that removes the row', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const onCancel = vi.fn(() => Promise.resolve('cancelled' as const));
    try {
      act(() => root.render(h(ConnectingInviteRow, { row: at(180_000), onCancel })));
      expect(host.textContent).toContain(NO_ANSWER);
      const [cancel] = buttons('Cancel');
      await act(async () => {
        cancel?.click();
        await Promise.resolve();
      });
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(host.querySelector('li')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('moves on by itself while it is shown', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      act(() => root.render(h(ConnectingInviteRow, { row: at(0) })));
      expect(host.textContent).toContain('Connecting to Ana Novak…');
      act(() => {
        vi.advanceTimersByTime(CONNECTING_HINT_MS + 5_000);
      });
      expect(host.textContent).toContain(WAITING);
    } finally {
      vi.useRealTimers();
    }
  });

  // REL051-R2C (R2-CLASS-04): a row the server has not timed yet moves on too, without a restart,
  // and Cancel is the plain way out from then on.
  it('a row with no start time yet is timed from when it was shown', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const row: ConnectingRow = { ...at(0) };
      delete (row as { startedAt?: number }).startedAt;
      const onCancel = vi.fn(() => Promise.resolve('cancelled' as const));
      act(() => root.render(h(ConnectingInviteRow, { row, onCancel })));
      expect(host.textContent).toContain('Connecting to Ana Novak…');
      act(() => {
        vi.advanceTimersByTime(CONNECTING_HINT_MS + 5_000);
      });
      expect(host.textContent).toContain(WAITING);
      expect(host.textContent).not.toContain('connects by itself');
      const cancel = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Cancel');
      expect(cancel?.className).toContain('secondary');
    } finally {
      vi.useRealTimers();
    }
  });
});
