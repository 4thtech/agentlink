// TRAY-PIPE (D-155; 08 §8): the shell's side of the three tray messages. The parser takes exactly
// the spec's keys, words, counts and booleans; anything else is a violation (undefined), and
// nothing throws. createTrayFeed is what TRAY-SHELL wires into the tray: typed callbacks, a
// state only on change, pulses at most one per kind per 2 s, listener errors kept in.
import { describe, expect, it } from 'vitest';
import {
  MAX_LINE_BYTES,
  SHELL_MOTIONS,
  TRAY_LINKS,
  TRAY_PULSE_GAP_MS,
  TRAY_PULSE_KINDS,
  createTrayFeed,
  encodeCoreMessage,
  parseCoreMessage,
  parseShellMessage,
  type CoreMessage,
  type ShellPrefs,
  type TrayPulseKind,
  type TrayStateView,
} from '../../src/shared/protocol.js';
import { PipeClient, type PipeStream } from '../../src/main/pipe.js';

const line = (value: unknown): string => JSON.stringify(value);
const A = `0x${'a'.repeat(40)}`;

describe('TRAY-PIPE: the fixed words match the core', () => {
  it('are exactly the spec lists', () => {
    expect([...TRAY_LINKS]).toEqual(['connecting', 'connected', 'paused', 'offline']);
    expect([...TRAY_PULSE_KINDS]).toEqual(['message_in', 'ai_sent', 'approval']);
    expect([...SHELL_MOTIONS]).toEqual(['system', 'on', 'off']);
    expect(TRAY_PULSE_GAP_MS).toBe(2_000);
  });
});

describe('TRAY-PIPE: parseCoreMessage', () => {
  it('accepts the three messages and round-trips them', () => {
    const ok: CoreMessage[] = [
      { v: 1, type: 'tray-state', link: 'connected', unread: 2, approvals: 1 },
      { v: 1, type: 'tray-state', link: 'offline', unread: 0, approvals: 0 },
      { v: 1, type: 'tray-pulse', kind: 'message_in' },
      { v: 1, type: 'tray-pulse', kind: 'ai_sent' },
      { v: 1, type: 'tray-pulse', kind: 'approval' },
      { v: 1, type: 'shell-prefs', menuBarIcon: false, motion: 'off' },
      { v: 1, type: 'shell-prefs', menuBarIcon: true, motion: 'system' },
    ];
    for (const m of ok) {
      expect(parseCoreMessage(line(m))).toEqual(m);
      expect(encodeCoreMessage(m)).toBe(`${line(m)}\n`);
    }
  });

  it.each([
    { v: 1, type: 'tray-state', link: 'update', unread: 0, approvals: 0 },
    { v: 1, type: 'tray-state', link: 'connected', unread: -1, approvals: 0 },
    { v: 1, type: 'tray-state', link: 'connected', unread: 0.5, approvals: 0 },
    { v: 1, type: 'tray-state', link: 'connected', unread: false, approvals: 0 },
    { v: 1, type: 'tray-state', link: 'connected', unread: 0, approvals: 2_000_000 },
    { v: 1, type: 'tray-state', link: 'connected', unread: 0 },
    { v: 1, type: 'tray-state', link: 'connected', unread: 0, approvals: 0, name: 'Ana' },
    { v: 1, type: 'tray-pulse', kind: 'msg-out' },
    { v: 1, type: 'tray-pulse', kind: 'message_in', target: A },
    { v: 1, type: 'tray-pulse', kind: 'message_in', text: 'hi' },
    { v: 1, type: 'tray-pulse' },
    { v: 1, type: 'shell-prefs', menuBarIcon: 'yes', motion: 'off' },
    { v: 1, type: 'shell-prefs', menuBarIcon: true, motion: 'slow' },
    { v: 1, type: 'shell-prefs', menuBarIcon: true, motion: 'off', widgetPreviews: true },
    { v: 1, type: 'shell-prefs', menuBarIcon: true },
    { v: 2, type: 'tray-pulse', kind: 'approval' },
    { v: 1, type: 'tray-widget', kind: 'approval' },
  ])('refuses %j', (m) => {
    expect(parseCoreMessage(line(m))).toBeUndefined();
    // The encoder rebuilds from the spec's keys: a bad value throws, an extra key never gets out.
    let encoded: string | undefined;
    try {
      encoded = encodeCoreMessage(m as unknown as CoreMessage);
    } catch {
      encoded = undefined;
    }
    if (encoded !== undefined) {
      expect(parseCoreMessage(encoded.slice(0, -1))).toBeDefined();
      for (const bad of ['name', 'target', 'text', 'widgetPreviews', '"v":2']) {
        expect(encoded).not.toContain(bad);
      }
    }
  });

  it('never throws, whatever the line', () => {
    const lines = [
      '',
      '{',
      'null',
      '[]',
      '"tray-pulse"',
      '{"v":1,"type":"tray-pulse","kind":"approval","__proto__":{}}',
      '{"v":1,"type":"tray-state","link":"connected","unread":1e400,"approvals":0}',
      `{"v":1,"type":"tray-pulse","kind":"approval"${' '.repeat(MAX_LINE_BYTES)}}`,
      '\u0000￿',
    ];
    for (const l of lines) expect(() => parseCoreMessage(l)).not.toThrow();
    for (const l of lines) expect(parseCoreMessage(l)).toBeUndefined();
  });

  it('the core never receives them from the shell', () => {
    expect(parseShellMessage(line({ v: 1, type: 'tray-pulse', kind: 'approval' }))).toBeUndefined();
  });
});

/** A pipe stream double. */
function stream(): PipeStream & { push(text: string): void; destroyed: boolean } {
  const data: ((chunk: Uint8Array) => void)[] = [];
  const s = {
    destroyed: false,
    on(event: string, listener: (chunk: Uint8Array) => void) {
      if (event === 'data') data.push(listener);
      return s;
    },
    write: () => true,
    destroy() {
      s.destroyed = true;
    },
    push(text: string) {
      for (const l of data) l(new TextEncoder().encode(text));
    },
  };
  return s as never;
}

describe('TRAY-PIPE: through the pipe client', () => {
  it('a valid tray line reaches onMessage; a bad one closes the pipe as a violation', () => {
    const got: CoreMessage[] = [];
    const violations: string[] = [];
    const s = stream();
    new PipeClient(s, {
      onMessage: (m) => got.push(m),
      onViolation: (v) => violations.push(v),
      onClose: () => undefined,
    });
    s.push(`${line({ v: 1, type: 'tray-pulse', kind: 'ai_sent' })}\n`);
    expect(got).toEqual([{ v: 1, type: 'tray-pulse', kind: 'ai_sent' }]);
    s.push(`${line({ v: 1, type: 'tray-pulse', kind: 'ai_sent', extra: 1 })}\n`);
    expect(violations).toEqual(['message']);
    expect(s.destroyed).toBe(true);
  });
});

describe('TRAY-PIPE: createTrayFeed (the API for TRAY-SHELL)', () => {
  const setup = () => {
    let now = 10_000;
    const states: TrayStateView[] = [];
    const pulses: TrayPulseKind[] = [];
    const prefs: ShellPrefs[] = [];
    const feed = createTrayFeed(
      {
        onState: (s) => states.push(s),
        onPulse: (k) => pulses.push(k),
        onPrefs: (p) => prefs.push(p),
      },
      { now: () => now },
    );
    return {
      feed,
      states,
      pulses,
      prefs,
      advance: (ms: number) => {
        now += ms;
      },
    };
  };

  it('hands each tray message to its typed callback and says it took it', () => {
    const t = setup();
    expect(
      t.feed.handle({ v: 1, type: 'tray-state', link: 'paused', unread: 1, approvals: 0 }),
    ).toBe(true);
    expect(t.feed.handle({ v: 1, type: 'tray-pulse', kind: 'approval' })).toBe(true);
    expect(t.feed.handle({ v: 1, type: 'shell-prefs', menuBarIcon: false, motion: 'on' })).toBe(
      true,
    );
    expect(t.states).toEqual([{ link: 'paused', unread: 1, approvals: 0 }]);
    expect(t.pulses).toEqual(['approval']);
    expect(t.prefs).toEqual([{ menuBarIcon: false, motion: 'on' }]);
  });

  it('leaves every other message alone', () => {
    const t = setup();
    expect(t.feed.handle({ v: 1, type: 'approval-waiting', count: 3 })).toBe(false);
    expect(t.states).toEqual([]);
  });

  it('a state or prefs only on change; reset() lets a new core start afresh', () => {
    const t = setup();
    const st: CoreMessage = {
      v: 1,
      type: 'tray-state',
      link: 'connected',
      unread: 0,
      approvals: 0,
    };
    t.feed.handle(st);
    t.feed.handle(st);
    t.feed.handle({ v: 1, type: 'shell-prefs', menuBarIcon: true, motion: 'system' });
    t.feed.handle({ v: 1, type: 'shell-prefs', menuBarIcon: true, motion: 'system' });
    expect(t.states).toHaveLength(1);
    expect(t.prefs).toHaveLength(1);
    t.feed.reset();
    t.feed.handle(st);
    t.feed.handle({ v: 1, type: 'shell-prefs', menuBarIcon: true, motion: 'system' });
    expect(t.states).toHaveLength(2);
    expect(t.prefs).toHaveLength(2);
  });

  it('pulses: at most one per kind per 2 s, whatever the core sends', () => {
    const t = setup();
    t.feed.handle({ v: 1, type: 'tray-pulse', kind: 'message_in' });
    t.feed.handle({ v: 1, type: 'tray-pulse', kind: 'message_in' });
    t.feed.handle({ v: 1, type: 'tray-pulse', kind: 'ai_sent' });
    t.advance(1_999);
    t.feed.handle({ v: 1, type: 'tray-pulse', kind: 'message_in' });
    t.advance(1);
    t.feed.handle({ v: 1, type: 'tray-pulse', kind: 'message_in' });
    expect(t.pulses).toEqual(['message_in', 'ai_sent', 'message_in']);
  });

  it('a throwing callback never reaches main', () => {
    const feed = createTrayFeed({
      onState: () => {
        throw new Error('x');
      },
      onPulse: () => {
        throw new Error('x');
      },
    });
    expect(() =>
      feed.handle({ v: 1, type: 'tray-state', link: 'offline', unread: 0, approvals: 0 }),
    ).not.toThrow();
    expect(() => feed.handle({ v: 1, type: 'tray-pulse', kind: 'approval' })).not.toThrow();
    // No callback: taken, nothing happens.
    expect(feed.handle({ v: 1, type: 'shell-prefs', menuBarIcon: true, motion: 'off' })).toBe(true);
  });

  it('the callbacks get fresh frozen values with exactly the spec keys', () => {
    const t = setup();
    t.feed.handle({ v: 1, type: 'tray-state', link: 'connected', unread: 4, approvals: 2 });
    const s = t.states[0];
    expect(Object.keys(s ?? {}).sort()).toEqual(['approvals', 'link', 'unread']);
    expect(Object.isFrozen(s)).toBe(true);
  });
});
