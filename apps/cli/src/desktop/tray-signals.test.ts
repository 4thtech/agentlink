// TRAY-PIPE (D-155; 08 §8): what the icon shows, computed from the same look as the N7 alerts.
// A first look never pulses; message in from the notification items, approval from the waiting
// IDs, AI sent only from the newest outbound time; at most one pulse per kind per 2 s; counts only.
import type { NotificationItem } from '@4thtech-io/types/ui-contract/notifications';
import { describe, expect, it } from 'vitest';
import {
  TRAY_PULSE_GAP_MS,
  createPulseGate,
  planTray,
  shellPrefsOf,
  type TrayLook,
} from './tray-signals.js';

const A = `0x${'a'.repeat(40)}`;
const B = `0x${'b'.repeat(40)}`;

const msg = (ref: string, count: number, at: number, read = false): NotificationItem => ({
  id: `messages-${ref}`,
  kind: 'messages',
  ref,
  count,
  at,
  read,
});
const file = (ref: string, count: number, at: number, read = false): NotificationItem => ({
  id: `files-${ref}`,
  kind: 'files',
  ref,
  count,
  at,
  read,
});

const look = (over: Partial<TrayLook> = {}): TrayLook => ({
  scope: 'default',
  approvals: [],
  items: [],
  outAt: null,
  link: 'connected',
  ...over,
});

describe('planTray: the state', () => {
  it('counts unread messages and files, and the approvals waiting; never a ref', () => {
    const t = planTray(
      undefined,
      look({
        approvals: ['apr_1', 'apr_2'],
        items: [
          msg(A, 2, 10),
          file(B, 1, 11),
          msg(B, 4, 9, true),
          { id: 'update', kind: 'update', count: 1, at: 5, read: false },
        ],
        link: 'paused',
      }),
    );
    expect(t.state).toEqual({ link: 'paused', unread: 3, approvals: 2 });
    expect(JSON.stringify(t.state)).not.toContain('0x');
  });
});

describe('planTray: pulses', () => {
  it('a first look never pulses, whatever is there', () => {
    const t = planTray(
      undefined,
      look({ approvals: ['apr_1'], items: [msg(A, 3, 10)], outAt: 100 }),
    );
    expect(t.pulses).toEqual([]);
  });

  it('message in: a new, grown or again-unread messages or files item', () => {
    let base = planTray(undefined, look({ items: [msg(A, 1, 10, true)] })).baseline;
    let t = planTray(base, look({ items: [msg(A, 1, 12)] }));
    expect(t.pulses).toEqual(['message_in']);
    base = t.baseline;
    t = planTray(base, look({ items: [msg(A, 1, 12)] }));
    expect(t.pulses).toEqual([]);
    t = planTray(t.baseline, look({ items: [msg(A, 2, 13)] }));
    expect(t.pulses).toEqual(['message_in']);
    t = planTray(t.baseline, look({ items: [msg(A, 2, 13), file(B, 1, 14)] }));
    expect(t.pulses).toEqual(['message_in']);
  });

  it('marking read never pulses', () => {
    const base = planTray(undefined, look({ items: [msg(A, 2, 10)] })).baseline;
    expect(planTray(base, look({ items: [msg(A, 2, 10, true)] })).pulses).toEqual([]);
    expect(planTray(base, look({ items: [] })).pulses).toEqual([]);
  });

  it('approval: a waiting ID that was not there, even when another was decided', () => {
    const base = planTray(undefined, look({ approvals: ['apr_1'] })).baseline;
    expect(planTray(base, look({ approvals: ['apr_2'] })).pulses).toEqual(['approval']);
    expect(planTray(base, look({ approvals: [] })).pulses).toEqual([]);
    expect(planTray(base, look({ approvals: ['apr_1'] })).pulses).toEqual([]);
  });

  it('AI sent: only a newer outbound time; never on receipt', () => {
    const base = planTray(undefined, look({ outAt: 100 })).baseline;
    expect(planTray(base, look({ outAt: 100 })).pulses).toEqual([]);
    expect(planTray(base, look({ outAt: 101 })).pulses).toEqual(['ai_sent']);
    // A message in alone is not an AI send.
    expect(planTray(base, look({ outAt: 100, items: [msg(A, 1, 200)] })).pulses).toEqual([
      'message_in',
    ]);
  });

  it('AI sent: none sent before, then one', () => {
    const base = planTray(undefined, look({ outAt: null })).baseline;
    expect(planTray(base, look({ outAt: 5 })).pulses).toEqual(['ai_sent']);
  });

  it('AI sent: an older send leaving the window, an unknown read, then the same one: no pulse', () => {
    let t = planTray(undefined, look({ outAt: 100 }));
    t = planTray(t.baseline, look({ outAt: null }));
    expect(t.pulses).toEqual([]);
    t = planTray(t.baseline, look({ outAt: undefined }));
    expect(t.pulses).toEqual([]);
    t = planTray(t.baseline, look({ outAt: 100 }));
    expect(t.pulses).toEqual([]);
    t = planTray(t.baseline, look({ outAt: 150 }));
    expect(t.pulses).toEqual(['ai_sent']);
  });

  it('another ID is a fresh first look (silent)', () => {
    const base = planTray(undefined, look({ scope: 'work' })).baseline;
    const t = planTray(
      base,
      look({ scope: 'personal', approvals: ['apr_9'], items: [msg(A, 1, 1)], outAt: 9 }),
    );
    expect(t.pulses).toEqual([]);
  });

  it('several kinds at once, each at most once', () => {
    const base = planTray(undefined, look()).baseline;
    const t = planTray(
      base,
      look({ approvals: ['apr_1', 'apr_2'], items: [msg(A, 1, 1), file(B, 1, 2)], outAt: 3 }),
    );
    expect([...t.pulses].sort()).toEqual(['ai_sent', 'approval', 'message_in']);
  });
});

describe('createPulseGate: at most one per kind per 2 s', () => {
  it('passes the first, drops repeats within the gap, passes again after it', () => {
    expect(TRAY_PULSE_GAP_MS).toBe(2_000);
    const gate = createPulseGate();
    expect(gate.pass(['message_in'], 1_000)).toEqual(['message_in']);
    expect(gate.pass(['message_in'], 2_999)).toEqual([]);
    expect(gate.pass(['ai_sent', 'message_in'], 2_999)).toEqual(['ai_sent']);
    expect(gate.pass(['message_in'], 3_000)).toEqual(['message_in']);
  });

  it('coalesces duplicates in one call; a clock going back never opens the gate early', () => {
    const gate = createPulseGate();
    expect(gate.pass(['approval', 'approval'], 10_000)).toEqual(['approval']);
    expect(gate.pass(['approval'], 5_000)).toEqual([]);
  });
});

describe('shellPrefsOf: the two shell switches from the UI settings', () => {
  it('absent = on, motion system', () => {
    expect(shellPrefsOf(undefined)).toEqual({ menuBarIcon: true, motion: 'system' });
    expect(shellPrefsOf({})).toEqual({ menuBarIcon: true, motion: 'system' });
  });

  it('the icon switch and the app motion', () => {
    expect(
      shellPrefsOf({ menuBarIcon: false, kept: { 'agentlink.prefs': '{"motion":"off"}' } }),
    ).toEqual({ menuBarIcon: false, motion: 'off' });
    expect(shellPrefsOf({ kept: { 'agentlink.prefs': '{"motion":"on","theme":"dark"}' } })).toEqual(
      { menuBarIcon: true, motion: 'on' },
    );
  });

  it('anything malformed counts as system', () => {
    for (const raw of ['nope', '{"motion":"fast"}', '[1]', '{"motion":1}', 'null']) {
      expect(shellPrefsOf({ kept: { 'agentlink.prefs': raw } }).motion).toBe('system');
    }
    expect(shellPrefsOf({ kept: { 'agentlink.prefs': null } }).motion).toBe('system');
  });

  it('widgetPreviews never reaches the shell', () => {
    expect(Object.keys(shellPrefsOf({ widgetPreviews: false })).sort()).toEqual([
      'menuBarIcon',
      'motion',
    ]);
  });
});
