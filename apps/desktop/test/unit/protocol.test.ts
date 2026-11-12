// The pipe protocol (src/shared/protocol.ts): strict parsing both ways; every unknown or malformed
// message is rejected.
import { describe, expect, it } from 'vitest';
import {
  INVITE_LINK_PREFIX,
  MAX_LINE_BYTES,
  SHOW_ROUTES,
  encodeCoreMessage,
  encodeShellMessage,
  isCanonicalInviteLink,
  parseCoreMessage,
  parseShellMessage,
  sessionUrlOrigin,
  type ShellMessage,
} from '../../src/shared/protocol.js';
import { SESSION_URL, TOKEN } from './fakes.js';

const line = (value: unknown): string => JSON.stringify(value);
const SHORT = `2.${'A'.repeat(42)}A`;

describe('session links', () => {
  it.each([
    [`http://localhost:4567/?t=${TOKEN}`, 'http://localhost:4567'],
    [`http://localhost:1/first-run?t=${TOKEN}`, 'http://localhost:1'],
    [`http://localhost:65535/approve/apr_${'a'.repeat(22)}?t=${TOKEN}`, 'http://localhost:65535'],
    [`http://localhost:80/settings/home?t=${TOKEN}`, 'http://localhost:80'],
  ])('accepts %s', (url, origin) => {
    expect(sessionUrlOrigin(url)).toBe(origin);
  });

  it.each([
    `https://localhost:4567/?t=${TOKEN}`,
    `http://127.0.0.1:4567/?t=${TOKEN}`,
    `http://[::1]:4567/?t=${TOKEN}`,
    `http://localhost.evil.example:4567/?t=${TOKEN}`,
    `http://user@localhost:4567/?t=${TOKEN}`,
    `http://localhost:0/?t=${TOKEN}`,
    `http://localhost:65536/?t=${TOKEN}`,
    `http://localhost:04567/?t=${TOKEN}`,
    `http://localhost/?t=${TOKEN}`,
    `http://localhost:4567?t=${TOKEN}`,
    `http://localhost:4567/?t=${TOKEN.slice(1)}`,
    `http://localhost:4567/?t=${TOKEN}A`,
    `http://localhost:4567/?t=${TOKEN}#x`,
    `http://localhost:4567/?t=${TOKEN}&x=1`,
    `http://localhost:4567/a/../b?t=${TOKEN}`,
    `http://localhost:4567//evil?t=${TOKEN}`,
    `http://localhost:4567/a%2fb?t=${TOKEN}`,
    `http://localhost:4567/${'a'.repeat(201)}?t=${TOKEN}`,
    `http://localhost:4567/`,
    `javascript:alert(1)`,
    ` ${SESSION_URL}`,
    `${SESSION_URL}\n`,
    42,
    null,
  ])('rejects %s', (url) => {
    expect(sessionUrlOrigin(url)).toBeNull();
  });
});

describe('invite links', () => {
  it('accepts the short and the long canonical forms', () => {
    expect(isCanonicalInviteLink(`${INVITE_LINK_PREFIX}${SHORT}`)).toBe(true);
    expect(isCanonicalInviteLink(`${INVITE_LINK_PREFIX}abc_DEF-123`)).toBe(true);
    expect(isCanonicalInviteLink(`${INVITE_LINK_PREFIX}${'a'.repeat(21_846)}`)).toBe(true);
  });

  it.each([
    `${INVITE_LINK_PREFIX}`,
    `${INVITE_LINK_PREFIX}${'a'.repeat(21_847)}`,
    `${INVITE_LINK_PREFIX}2.${'A'.repeat(42)}B`, // trailing bits set
    `${INVITE_LINK_PREFIX}2.${'A'.repeat(41)}`,
    `${INVITE_LINK_PREFIX}abc def`,
    `${INVITE_LINK_PREFIX}abc=`,
    `http://agentlink.4thtech.io/i#abc`,
    `https://agentlink.4thtech.io.evil.example/i#abc`,
    `agentlink://join#abc`,
    `https://agentlink.4thtech.io/i#abc --remote-debugging-port=1`,
  ])('rejects %s', (link) => {
    expect(isCanonicalInviteLink(link)).toBe(false);
  });
});

describe('core -> shell messages', () => {
  it('parses the three message types', () => {
    expect(parseCoreMessage(line({ v: 1, type: 'ready', sessionUrl: SESSION_URL }))).toEqual({
      v: 1,
      type: 'ready',
      sessionUrl: SESSION_URL,
    });
    expect(
      parseCoreMessage(
        line({ v: 1, type: 'status', state: 'online', counts: { approvals: 2, unread: 0 } }),
      ),
    ).toEqual({ v: 1, type: 'status', state: 'online', counts: { approvals: 2, unread: 0 } });
    expect(parseCoreMessage(line({ v: 1, type: 'approval-waiting', count: 1 }))).toEqual({
      v: 1,
      type: 'approval-waiting',
      count: 1,
    });
  });

  it.each([
    ['empty', ''],
    ['not json', 'hello'],
    ['array', '[1]'],
    ['string', '"ready"'],
    ['leading space', ` ${line({ v: 1, type: 'approval-waiting', count: 1 })}`],
    ['trailing CR', `${line({ v: 1, type: 'approval-waiting', count: 1 })}\r`],
    ['unknown type', line({ v: 1, type: 'exec', cmd: 'x' })],
    ['shell type on the core side', line({ v: 1, type: 'shutdown' })],
    ['no version', line({ type: 'approval-waiting', count: 1 })],
    ['version 2', line({ v: 2, type: 'approval-waiting', count: 1 })],
    ['version as string', line({ v: '1', type: 'approval-waiting', count: 1 })],
    ['extra key', line({ v: 1, type: 'approval-waiting', count: 1, text: 'hi' })],
    ['missing key', line({ v: 1, type: 'approval-waiting' })],
    ['__proto__ key', '{"v":1,"type":"approval-waiting","count":1,"__proto__":{}}'],
    ['zero waiting', line({ v: 1, type: 'approval-waiting', count: 0 })],
    ['negative', line({ v: 1, type: 'approval-waiting', count: -1 })],
    ['fraction', line({ v: 1, type: 'approval-waiting', count: 1.5 })],
    ['huge', line({ v: 1, type: 'approval-waiting', count: 1e9 })],
    ['count as string', line({ v: 1, type: 'approval-waiting', count: '1' })],
    [
      'bad state',
      line({ v: 1, type: 'status', state: 'pwned', counts: { approvals: 0, unread: 0 } }),
    ],
    [
      'extra count',
      line({
        v: 1,
        type: 'status',
        state: 'online',
        counts: { approvals: 0, unread: 0, names: 1 },
      }),
    ],
    ['counts array', line({ v: 1, type: 'status', state: 'online', counts: [0, 0] })],
    ['ready with bad url', line({ v: 1, type: 'ready', sessionUrl: 'https://evil.example/' })],
    ['ready with extra key', line({ v: 1, type: 'ready', sessionUrl: SESSION_URL, title: 'x' })],
    ['oversize', `{"v":1,"type":"ready","sessionUrl":"${'a'.repeat(MAX_LINE_BYTES)}"}`],
  ])('rejects %s', (_name, text) => {
    expect(parseCoreMessage(text)).toBeUndefined();
  });

  it('encodes what it parses, one line each', () => {
    const text = encodeCoreMessage({ v: 1, type: 'ready', sessionUrl: SESSION_URL });
    expect(text.endsWith('\n')).toBe(true);
    expect(text.slice(0, -1)).not.toContain('\n');
    expect(parseCoreMessage(text.slice(0, -1))?.type).toBe('ready');
  });
});

describe('shell -> core messages', () => {
  it('encodes and parses invite, show and shutdown', () => {
    const messages: ShellMessage[] = [
      { v: 1, type: 'invite', link: `${INVITE_LINK_PREFIX}${SHORT}` },
      ...SHOW_ROUTES.map((route): ShellMessage => ({ v: 1, type: 'show', route })),
      { v: 1, type: 'shutdown' },
    ];
    for (const message of messages) {
      const text = encodeShellMessage(message);
      expect(text.endsWith('\n')).toBe(true);
      expect(parseShellMessage(text.slice(0, -1))).toEqual(message);
    }
  });

  it('refuses to encode an invalid message (no value in the error)', () => {
    const secret = `agentlink://join#${SHORT}`;
    expect(() => encodeShellMessage({ v: 1, type: 'invite', link: secret })).toThrow(
      /^protocol: invalid shell message$/,
    );
    expect(() => encodeShellMessage({ v: 1, type: 'show', route: '/evil' as 'home' })).toThrow();
    expect(() => encodeShellMessage({ v: 1, type: 'nope' } as unknown as ShellMessage)).toThrow();
  });

  it.each([
    line({ v: 1, type: 'show', route: '/settings' }),
    line({ v: 1, type: 'show', route: 'home', path: '/' }),
    line({ v: 1, type: 'shutdown', now: true }),
    line({ v: 1, type: 'invite', link: 'https://evil.example/i#abc' }),
    line({ v: 1, type: 'ready', sessionUrl: SESSION_URL }),
  ])('rejects %s', (text) => {
    expect(parseShellMessage(text)).toBeUndefined();
  });
});
