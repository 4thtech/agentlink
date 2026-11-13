// WP-D3: the pipe schema is strict: exactly the listed keys, version 1, fixed enums, a session link
// only of the server's own form, an invite only in the 08 §4 form. Anything else is undefined.
import { INVITE_LINK_PREFIX, INVITE_MAX_PAYLOAD_CHARS } from '@4thtech-io/core';
import { describe, expect, it } from 'vitest';
import { joinLinkOf } from '../commands/join.js';
import {
  MAX_PIPE_LINE_BYTES,
  SHOW_ROUTES,
  encodeHostMessage,
  encodeShellMessage,
  isInviteLink,
  isSessionUrl,
  parseHostMessage,
  parseShellMessage,
} from './protocol.js';

const TOKEN = 'A'.repeat(42) + 'g';
const URL_HOME = `http://localhost:41234/settings/home?t=${TOKEN}`;
const INVITE = `${INVITE_LINK_PREFIX}abc_DEF-123`;
const SHORT = `${INVITE_LINK_PREFIX}2.${'A'.repeat(42)}A`;

describe('shell -> core messages', () => {
  it('accepts exactly the three messages', () => {
    expect(parseShellMessage(JSON.stringify({ v: 1, type: 'shutdown' }))).toEqual({
      v: 1,
      type: 'shutdown',
    });
    for (const route of ['home', 'approvals', 'join']) {
      expect(parseShellMessage(JSON.stringify({ v: 1, type: 'show', route }))).toEqual({
        v: 1,
        type: 'show',
        route,
      });
    }
    expect(parseShellMessage(JSON.stringify({ v: 1, type: 'invite', link: INVITE }))).toEqual({
      v: 1,
      type: 'invite',
      link: INVITE,
    });
    expect(parseShellMessage(JSON.stringify({ type: 'invite', link: SHORT, v: 1 }))?.type).toBe(
      'invite',
    );
  });

  it.each([
    ['not JSON', 'shutdown'],
    ['an array', '[]'],
    ['null', 'null'],
    ['no version', '{"type":"shutdown"}'],
    ['version 2', '{"v":2,"type":"shutdown"}'],
    ['version as text', '{"v":"1","type":"shutdown"}'],
    ['an extra key', '{"v":1,"type":"shutdown","now":true}'],
    ['__proto__', '{"v":1,"type":"shutdown","__proto__":{"x":1}}'],
    ['an unknown type', '{"v":1,"type":"ready","sessionUrl":"x"}'],
    ['a route not in the enum', '{"v":1,"type":"show","route":"/settings/home"}'],
    ['a route path', '{"v":1,"type":"show","route":"../x"}'],
    ['a missing route', '{"v":1,"type":"show"}'],
    ['a quoted invite', JSON.stringify({ v: 1, type: 'invite', link: `'${INVITE}'` })],
    ['an invite with a space', JSON.stringify({ v: 1, type: 'invite', link: `${INVITE} ` })],
    ['another host', JSON.stringify({ v: 1, type: 'invite', link: 'https://evil.example/i#abc' })],
    [
      'an http invite',
      JSON.stringify({ v: 1, type: 'invite', link: INVITE.replace('https', 'http') }),
    ],
    ['the app scheme', JSON.stringify({ v: 1, type: 'invite', link: 'agentlink://join#abc' })],
    ['an invite number', '{"v":1,"type":"invite","link":1}'],
  ])('rejects %s', (_name, line) => {
    expect(parseShellMessage(line)).toBeUndefined();
  });

  it('rejects a line over the limit', () => {
    const link = `${INVITE_LINK_PREFIX}${'A'.repeat(INVITE_MAX_PAYLOAD_CHARS)}`;
    expect(parseShellMessage(JSON.stringify({ v: 1, type: 'invite', link }))?.type).toBe('invite');
    const padded = `${JSON.stringify({ v: 1, type: 'shutdown' })}${' '.repeat(MAX_PIPE_LINE_BYTES)}`;
    expect(parseShellMessage(padded)).toBeUndefined();
  });

  it('accepts the same invite links as `agentlink join`, and only those', () => {
    const max = `${INVITE_LINK_PREFIX}${'A'.repeat(INVITE_MAX_PAYLOAD_CHARS)}`;
    for (const link of [INVITE, SHORT, max, `${max}A`, `${INVITE_LINK_PREFIX}`, `'${INVITE}'`]) {
      const join = joinLinkOf([link]);
      expect(isInviteLink(link)).toBe(join !== undefined && join === link);
    }
  });

  it('encodes only valid shell messages', () => {
    expect(encodeShellMessage({ v: 1, type: 'show', route: 'home' })).toBe(
      '{"v":1,"type":"show","route":"home"}\n',
    );
    expect(encodeShellMessage({ v: 1, type: 'show', route: 'x' as 'home' })).toBeUndefined();
  });
});

describe('core -> shell messages', () => {
  it('a session link only on the server origin form and its fixed paths', () => {
    expect(isSessionUrl(URL_HOME)).toBe(true);
    for (const path of ['/', '/first-run', '/settings/home', '/settings/join']) {
      expect(isSessionUrl(`http://localhost:41234${path}?t=${TOKEN}`)).toBe(true);
    }
    for (const bad of [
      `http://localhost:41234/approve/abc?t=${TOKEN}`,
      `http://127.0.0.1:41234/settings/home?t=${TOKEN}`,
      `https://localhost:41234/settings/home?t=${TOKEN}`,
      `http://localhost:99999/settings/home?t=${TOKEN}`,
      `http://localhost:0/settings/home?t=${TOKEN}`,
      `http://localhost:41234/settings/home?t=short`,
      `http://localhost:41234/settings/home?t=${TOKEN}&x=1`,
      `http://localhost:41234/settings/home#t=${TOKEN}`,
      `http://evil@localhost:41234/settings/home?t=${TOKEN}`,
    ]) {
      expect(isSessionUrl(bad)).toBe(false);
    }
  });

  it('encodes the five messages and refuses a bad value', () => {
    expect(encodeHostMessage({ v: 1, type: 'ready', sessionUrl: URL_HOME })).toBe(
      `${JSON.stringify({ v: 1, type: 'ready', sessionUrl: URL_HOME })}\n`,
    );
    expect(
      encodeHostMessage({
        v: 1,
        type: 'status',
        state: 'running',
        counts: { openPages: 1, waitingApprovals: 2 },
      }),
    ).toBeDefined();
    expect(encodeHostMessage({ v: 1, type: 'approval-waiting', count: 3 })).toBeDefined();
    expect(encodeHostMessage({ v: 1, type: 'invite-result', outcome: 'waiting' })).toBeDefined();
    expect(encodeHostMessage({ v: 1, type: 'stopped', reason: 'shutdown' })).toBeDefined();
    expect(
      encodeHostMessage({ v: 1, type: 'ready', sessionUrl: 'http://localhost:1/approve/x' }),
    ).toBeUndefined();
    expect(encodeHostMessage({ v: 1, type: 'approval-waiting', count: -1 })).toBeUndefined();
    expect(encodeHostMessage({ v: 1, type: 'approval-waiting', count: 1.5 })).toBeUndefined();
    expect(
      encodeHostMessage({
        v: 1,
        type: 'status',
        state: 'running',
        counts: { openPages: 1, waitingApprovals: 2, name: 'x' } as never,
      }),
    ).toBeUndefined();
  });

  it('parses its own lines back', () => {
    const line = encodeHostMessage({ v: 1, type: 'invite-result', outcome: 'expired' }) ?? '';
    expect(parseHostMessage(line.trimEnd())).toEqual({
      v: 1,
      type: 'invite-result',
      outcome: 'expired',
    });
    expect(parseHostMessage('{"v":1,"type":"stopped","reason":"other"}')).toBeUndefined();
  });
});

// DESK051-UPD: the update messages; the same rules as the shell's copy (apps/desktop
// src/shared/protocol.ts + app-update.ts).
describe('app update messages', () => {
  const DMG =
    'https://github.com/4thtech/agentlink/releases/download/v0.5.2/AgentLink-0.5.2-mac-arm64.dmg';
  const ok = {
    v: 1,
    type: 'app-update',
    state: 'available',
    current: '0.5.1',
    latest: '0.5.2',
    download: DMG,
  };
  const line = (v: unknown): string => JSON.stringify(v);

  it('accepts the update state in its exact forms', () => {
    expect(parseShellMessage(line(ok))).toEqual(ok);
    for (const download of [
      DMG.replaceAll('arm64', 'x64'),
      'https://github.com/4thtech/agentlink/releases/tag/v0.5.2',
    ]) {
      expect(parseShellMessage(line({ ...ok, download }))).toEqual({ ...ok, download });
    }
    for (const state of ['off', 'idle', 'checking', 'current', 'failed', 'offline']) {
      const v = { ...ok, state, latest: '', download: '' };
      expect(parseShellMessage(line(v)), state).toEqual(v);
    }
    expect(encodeShellMessage(ok as never)).toBe(`${line(ok)}\n`);
  });

  it.each([
    ['an unknown state', { ...ok, state: 'installing' }],
    ['an extra key', { ...ok, x: 1 }],
    ['a missing key', { ...ok, download: undefined }],
    [
      'a version that is not newer',
      { ...ok, latest: '0.5.1', download: DMG.replaceAll('0.5.2', '0.5.1') },
    ],
    ['10 < 9 as text', { ...ok, current: '0.10.0' }],
    ['a prerelease', { ...ok, latest: '0.5.2-beta.1' }],
    ['a link for another version', { ...ok, download: DMG.replaceAll('0.5.2', '0.5.3') }],
    ['a link elsewhere', { ...ok, download: 'https://evil.example/x.dmg' }],
    [
      'another file of the release',
      { ...ok, download: DMG.replace('AgentLink-0.5.2-mac-arm64.dmg', 'x.dmg') },
    ],
    ['a link while not available', { ...ok, state: 'current' }],
    ['a bad current version', { ...ok, current: '0.5.1\n' }],
    ['a wrong version', { ...ok, v: 2 }],
  ])('refuses %s', (_label, value) => {
    expect(parseShellMessage(line(value))).toBeUndefined();
  });

  it('the core sends only a bare check request', () => {
    expect(encodeHostMessage({ v: 1, type: 'app-update-check' })).toBe(
      `${line({ v: 1, type: 'app-update-check' })}\n`,
    );
    expect(parseHostMessage(line({ v: 1, type: 'app-update-check', url: DMG }))).toBeUndefined();
    expect(parseShellMessage(line({ v: 1, type: 'app-update-check' }))).toBeUndefined();
    expect(parseHostMessage(line(ok))).toBeUndefined();
  });
});

describe('N7: notify (core -> shell), fixed codes only', () => {
  const l = (value: unknown): string => JSON.stringify(value);
  it('kind, count and a name ("" unless an owner alias on messages or files)', () => {
    expect(
      parseHostMessage(l({ v: 1, type: 'notify', kind: 'update', count: 1, name: '' })),
    ).toEqual({ v: 1, type: 'notify', kind: 'update', count: 1, name: '' });
    expect(
      parseHostMessage(l({ v: 1, type: 'notify', kind: 'files', count: 2, name: 'Ana' })),
    ).toEqual({ v: 1, type: 'notify', kind: 'files', count: 2, name: 'Ana' });
  });
  it.each([
    { v: 1, type: 'notify', kind: 'messages', count: 1, name: '', text: 'hello' },
    { v: 1, type: 'notify', kind: 'messages', count: 1 },
    { v: 1, type: 'notify', kind: 'network', count: 1, name: '' },
    { v: 1, type: 'notify', kind: 'messages', count: 0, name: '' },
    { v: 1, type: 'notify', kind: 'approvals', count: 1, name: 'Ana' },
    { v: 1, type: 'notify', kind: 'messages', count: 1, name: 'Ana\nhttps://x' },
    { v: 1, type: 'notify', kind: 'messages', count: 1, name: 'A'.repeat(33) },
  ])('rejects %j', (value) => {
    expect(parseHostMessage(l(value))).toBeUndefined();
  });
  it('show may also open inbox and updates; session links may land on /settings/updates', () => {
    expect(SHOW_ROUTES).toEqual(['home', 'approvals', 'join', 'inbox', 'updates']);
    expect(isSessionUrl(`http://localhost:4567/settings/updates?t=${TOKEN}`)).toBe(true);
  });
});
