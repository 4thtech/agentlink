// NOTIFY-DEEPLINK (S1): the core side of the pipe accepts and sends one opaque local ID with a
// `notify` and a `show`, and a session link for one request or one person. Mirrors the shell's
// apps/desktop/test/unit/notify-deeplink.test.ts.
import { describe, expect, it } from 'vitest';
import {
  encodeHostMessage,
  isNotifyTarget,
  isSessionUrl,
  parseHostMessage,
  parseShellMessage,
} from './protocol.js';

const APR = `apr_${'A'.repeat(22)}`;
const PERSON = `0x${'ab'.repeat(20)}`;
const TOKEN = 'T'.repeat(43);
const line = (value: unknown): string => JSON.stringify(value);

describe('opaque targets', () => {
  it('a request ID for approvals, a person ID for messages, files and inbox', () => {
    expect(isNotifyTarget('approvals', APR)).toBe(true);
    expect(isNotifyTarget('messages', PERSON)).toBe(true);
    expect(isNotifyTarget('inbox', PERSON)).toBe(true);
    expect(isNotifyTarget('messages', APR)).toBe(false);
    expect(isNotifyTarget('update', PERSON)).toBe(false);
    expect(isNotifyTarget('files', '/x')).toBe(false);
  });

  it('notify: a valid target round-trips; any other is refused on encode and parse', () => {
    const ok = { v: 1, type: 'notify', kind: 'files', count: 1, name: '', target: PERSON } as const;
    expect(encodeHostMessage(ok)).toBe(`${line(ok)}\n`);
    expect(parseHostMessage(line(ok))).toEqual(ok);
    expect(encodeHostMessage({ ...ok, target: APR })).toBeUndefined();
    expect(encodeHostMessage({ ...ok, kind: 'update', target: PERSON })).toBeUndefined();
  });

  it('show: only a target that fits its route', () => {
    expect(
      parseShellMessage(line({ v: 1, type: 'show', route: 'approvals', target: APR })),
    ).toEqual({ v: 1, type: 'show', route: 'approvals', target: APR });
    expect(parseShellMessage(line({ v: 1, type: 'show', route: 'inbox', target: PERSON }))).toEqual(
      { v: 1, type: 'show', route: 'inbox', target: PERSON },
    );
    expect(parseShellMessage(line({ v: 1, type: 'show', route: 'home', target: PERSON }))).toBe(
      undefined,
    );
    expect(parseShellMessage(line({ v: 1, type: 'show', route: 'inbox', target: 'x' }))).toBe(
      undefined,
    );
  });
});

describe('the session link', () => {
  it('may name one request or one person, nothing else', () => {
    expect(isSessionUrl(`http://localhost:4567/approve/${APR}?t=${TOKEN}`)).toBe(true);
    expect(isSessionUrl(`http://localhost:4567/?t=${TOKEN}#person=${PERSON}`)).toBe(true);
    expect(isSessionUrl(`http://localhost:4567/approve/x?t=${TOKEN}`)).toBe(false);
    expect(isSessionUrl(`http://localhost:4567/?t=${TOKEN}#person=0x12`)).toBe(false);
    expect(isSessionUrl(`http://localhost:4567/?t=${TOKEN}#frag`)).toBe(false);
  });
});
