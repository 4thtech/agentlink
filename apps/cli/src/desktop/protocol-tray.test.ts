// TRAY-PIPE (D-155; 08 §8): the core's three tray messages are strict: exact key sets, fixed words,
// counts and booleans only. Anything else (unknown word, extra or missing key, wrong type, text,
// a ref or an ID, an oversize line) is undefined, and the encoder never writes it.
import { describe, expect, it } from 'vitest';
import {
  MAX_PIPE_LINE_BYTES,
  SHELL_MOTIONS,
  TRAY_LINKS,
  TRAY_PULSE_KINDS,
  encodeHostMessage,
  parseHostMessage,
  parseShellMessage,
  type HostMessage,
} from './protocol.js';

const line = (value: unknown): string => JSON.stringify(value);
const A = `0x${'a'.repeat(40)}`;

describe('TRAY-PIPE: the fixed words', () => {
  it('are exactly the spec lists', () => {
    expect([...TRAY_LINKS]).toEqual(['connecting', 'connected', 'paused', 'offline']);
    expect([...TRAY_PULSE_KINDS]).toEqual(['message_in', 'ai_sent', 'approval']);
    expect([...SHELL_MOTIONS]).toEqual(['system', 'on', 'off']);
  });
});

describe('TRAY-PIPE: tray-state', () => {
  it('accepts every link with two counts', () => {
    for (const link of TRAY_LINKS) {
      const m = { v: 1, type: 'tray-state', link, unread: 3, approvals: 0 };
      expect(parseHostMessage(line(m))).toEqual(m);
      expect(encodeHostMessage(m as HostMessage)).toBe(`${line(m)}\n`);
    }
  });

  it.each([
    { v: 1, type: 'tray-state', link: 'update', unread: 0, approvals: 0 },
    { v: 1, type: 'tray-state', link: 'Connected', unread: 0, approvals: 0 },
    { v: 1, type: 'tray-state', link: 'connected', unread: -1, approvals: 0 },
    { v: 1, type: 'tray-state', link: 'connected', unread: 1.5, approvals: 0 },
    { v: 1, type: 'tray-state', link: 'connected', unread: '1', approvals: 0 },
    { v: 1, type: 'tray-state', link: 'connected', unread: true, approvals: 0 },
    { v: 1, type: 'tray-state', link: 'connected', unread: 0, approvals: 1_000_001 },
    { v: 1, type: 'tray-state', link: 'connected', unread: 0 },
    { v: 1, type: 'tray-state', link: 'connected', unread: 0, approvals: 0, name: 'Ana' },
    { v: 1, type: 'tray-state', link: 'connected', unread: 0, approvals: 0, ref: A },
    { v: 2, type: 'tray-state', link: 'connected', unread: 0, approvals: 0 },
    { type: 'tray-state', link: 'connected', unread: 0, approvals: 0 },
  ])('refuses %j', (m) => {
    expect(parseHostMessage(line(m))).toBeUndefined();
    expect(encodeHostMessage(m as unknown as HostMessage)).toBeUndefined();
  });
});

describe('TRAY-PIPE: tray-pulse', () => {
  it('accepts the three kinds', () => {
    for (const kind of TRAY_PULSE_KINDS) {
      const m = { v: 1, type: 'tray-pulse', kind };
      expect(parseHostMessage(line(m))).toEqual(m);
      expect(encodeHostMessage(m as HostMessage)).toBe(`${line(m)}\n`);
    }
  });

  it.each([
    { v: 1, type: 'tray-pulse', kind: 'msg-in' },
    { v: 1, type: 'tray-pulse', kind: 'messages' },
    { v: 1, type: 'tray-pulse', kind: 'connecting' },
    { v: 1, type: 'tray-pulse', kind: 'message_in', count: 1 },
    { v: 1, type: 'tray-pulse', kind: 'message_in', target: A },
    { v: 1, type: 'tray-pulse', kind: 'message_in', text: 'hello' },
    { v: 1, type: 'tray-pulse' },
    { v: 1, type: 'tray-pulse', kind: 1 },
  ])('refuses %j', (m) => {
    expect(parseHostMessage(line(m))).toBeUndefined();
  });
});

describe('TRAY-PIPE: shell-prefs', () => {
  it('accepts both switches with each motion', () => {
    for (const motion of SHELL_MOTIONS) {
      for (const menuBarIcon of [true, false]) {
        const m = { v: 1, type: 'shell-prefs', menuBarIcon, motion };
        expect(parseHostMessage(line(m))).toEqual(m);
        expect(encodeHostMessage(m as HostMessage)).toBe(`${line(m)}\n`);
      }
    }
  });

  it.each([
    { v: 1, type: 'shell-prefs', menuBarIcon: 'true', motion: 'system' },
    { v: 1, type: 'shell-prefs', menuBarIcon: 1, motion: 'system' },
    { v: 1, type: 'shell-prefs', menuBarIcon: true, motion: 'reduce' },
    { v: 1, type: 'shell-prefs', menuBarIcon: true },
    { v: 1, type: 'shell-prefs', menuBarIcon: true, motion: 'off', widgetPreviews: true },
    { v: 1, type: 'shell-prefs', menuBarIcon: null, motion: 'off' },
  ])('refuses %j', (m) => {
    expect(parseHostMessage(line(m))).toBeUndefined();
  });
});

describe('TRAY-PIPE: direction and size', () => {
  it('the shell never sends them to the core', () => {
    for (const m of [
      { v: 1, type: 'tray-state', link: 'connected', unread: 0, approvals: 0 },
      { v: 1, type: 'tray-pulse', kind: 'ai_sent' },
      { v: 1, type: 'shell-prefs', menuBarIcon: true, motion: 'system' },
    ]) {
      expect(parseShellMessage(line(m))).toBeUndefined();
    }
  });

  it('an oversize line is refused before parsing', () => {
    const big = `{"v":1,"type":"tray-pulse","kind":"ai_sent"${' '.repeat(MAX_PIPE_LINE_BYTES)}}`;
    expect(parseHostMessage(big)).toBeUndefined();
  });

  it('a prototype trick is refused', () => {
    expect(
      parseHostMessage('{"v":1,"type":"tray-pulse","kind":"ai_sent","__proto__":{"x":1}}'),
    ).toBeUndefined();
  });
});
