// UI-REFRESH-e5 (S1): hardening follow-ups for the Under the hood filter (B-11 §7; 04 §4; I-5).
// (a) split values are cut on anything outside the chunk characters; (b) a wider table of look-alike letters.
// Canaries are built at runtime so no literal here looks like a real secret or a refused label.
import { describe, expect, it } from 'vitest';
import { acceptHoodField } from './index.js';

const rep = (part: string, sep: string, n: number): string => Array(n).fill(part).join(sep);
const cp = (...codes: number[]): string => String.fromCodePoint(...codes);
const M4 = ['Zm', '9v'].join(''); // four characters, letters and a digit

const text = (value: string): unknown => acceptHoodField({ kind: 'text', label: 'Detail', value });
const path = (value: string): unknown =>
  acceptHoodField({ kind: 'path', label: 'Folder', value: '/k/' + value });
const labelled = (label: string): unknown =>
  acceptHoodField({ kind: 'text', label, value: 'hello' });

describe('(a) pieces are cut on every character outside the chunk class', () => {
  // Visible separators that are not on any fixed list: symbols, punctuation, letters of other scripts.
  const seps = [0x2022, 0x00b7, 0x2192, 0x00a7, 0x00b0, 0x3001, 0x2014, 0x00e9, 0x4e2d, 0x1f511];
  it.each(seps.map((c) => [`U+${c.toString(16)}`, cp(c)] as const))(
    'refuses a key cut into pieces joined by %s',
    (_n, sep) => {
      const v = rep(M4, sep, 7);
      expect(text(v)).toBeNull();
      expect(path(v)).toBeNull();
    },
  );

  it('refuses pieces joined by a mix of unlisted separators', () => {
    expect(text(rep(M4, `${cp(0x2022)}${cp(0x2192)}`, 7))).toBeNull();
  });

  it.each([
    'Version 0.3.1 on macOS 15.6',
    'Q3 2026 report v2',
    'Delivered and read',
    'Caf' + cp(0x00e9) + ' menu 12 items',
    'Updated ' + cp(0x2022) + ' 3 files ' + cp(0x2022) + ' 2 folders',
    'See you at 10:30 on 2026-10-28 in room B12',
    'Build a1 b2 c3 d4 e5 f6 g7 h8 i9 j0 k1 l2 m3',
  ])('still shows ordinary text: %s', (v) => {
    expect(text(v)).not.toBeNull();
  });

  it.each([
    ['a nested folder', '/Users/tali/Documents/Reports 2026/Q3.pdf'],
    ['a drive path', 'C:\\Users\\tali\\Documents\\notes.txt'],
    ['dated folders', '/data/2026-10-28/run_3/out.json'],
  ])('still shows a path: %s', (_n, v) => {
    expect(acceptHoodField({ kind: 'path', label: 'Folder', value: v })).not.toBeNull();
  });

  it.each([
    ['a count', { kind: 'count', label: 'Messages', value: '12 of 40' }],
    ['a size', { kind: 'size', label: 'Size', value: '1.5 MB' }],
    ['a date', { kind: 'time', label: 'Sent', value: '2026-10-28T09:30:00Z' }],
    ['a normal id', { kind: 'id', label: 'Reference', value: 'env_' + 'abcdefghij1234567890ab' }],
  ])('still shows %s', (_n, f) => {
    expect(acceptHoodField(f)).not.toBeNull();
  });
});

describe('(b) a wider table of look-alike letters in labels', () => {
  const swap = (s: string, map: Readonly<Record<string, number>>): string =>
    Array.from(s)
      .map((c) => (map[c] !== undefined ? cp(map[c]) : c))
      .join('');
  const smallCaps: Record<string, number> = {
    a: 0x1d00, b: 0x0299, c: 0x1d04, d: 0x1d05, e: 0x1d07, g: 0x0262, h: 0x029c, i: 0x026a,
    k: 0x1d0b, l: 0x029f, m: 0x1d0d, n: 0x0274, o: 0x1d0f, p: 0x1d18, r: 0x0280, t: 0x1d1b,
    u: 0x1d1c, v: 0x1d20, w: 0x1d21, y: 0x028f,
  };
  it.each(['secret', 'token', 'password', 'private', 'recover', 'signature', 'cookie', 'key'])(
    'refuses %s spelled in small capitals',
    (w) => {
      expect(labelled(swap(w, smallCaps))).toBeNull();
    },
  );

  it.each([
    ['token with Armenian o', swap('token', { o: 0x0585 })],
    ['seed with Cyrillic ie', swap('seed', { e: 0x0435 })],
    ['password with open a', swap('password', { a: 0x0251 })],
    ['code with Armenian o', swap('code', { o: 0x0585 })],
    ['key with Cyrillic u-like y', swap('key', { y: 0x04af })],
    ['cookie with Armenian o', swap('cookie', { o: 0x0585 })],
    ['salt with long s', swap('salt', { s: 0x017f })],
    ['private with Latin v-hook', swap('private', { v: 0x028b })],
    ['link with Cyrillic palochka', swap('link', { l: 0x04cf })],
    ['download with Cyrillic h-like', swap('download', { d: 0x0501 })],
    ['credential with Cyrillic q-like', swap('credential', { c: 0x0441 })],
    ['signature with Latin g-script', swap('signature', { g: 0x0261 })],
    ['url with Latin r-like', swap('url', { r: 0x027c })],
    ['recover with Armenian o', swap('recover', { o: 0x0585 })],
    ['session with Armenian n', swap('session', { n: 0x0578 })],
    ['upload with Cyrillic w-like p', swap('upload', { p: 0x0440, u: 0x057d })],
    ['secret with Latin f-like t', swap('secret', { t: 0x01ad })],
    ['mnemonic with Armenian n', swap('mnemonic', { n: 0x0578 })],
    ['authorize with Latin z-like z', swap('authorize', { z: 0x0290 })],
    ['passphrase with Latin h-hook', swap('passphrase', { h: 0x0266 })],
  ])('refuses %s', (_n, label) => {
    expect(labelled(label)).toBeNull();
  });

  it.each([
    'Size',
    'Sent',
    'Messages',
    'Folder',
    'Reference',
    'Caf' + cp(0x00e9) + ' orders',
    'Messages ' + cp(0x0431) + cp(0x043e) + cp(0x0442),
    cp(0x0420, 0x0430, 0x0437, 0x043c, 0x0435, 0x0440),
  ])('still shows the label %s', (label) => {
    expect(labelled(label)).not.toBeNull();
  });
});
