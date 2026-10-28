// UI-REFRESH-e4 (S1): robustness follow-ups for the Under the hood allowlist (B-11 §7; 04 §4; I-5).
// Multi-part ids, finer split-value checks, the full sensitive-label list and look-alike spellings.
// Canaries are built at runtime so no literal here looks like a real secret.
import { describe, expect, it } from 'vitest';
import { acceptHoodField } from './index.js';

const rep = (part: string, sep: string, n: number): string => Array(n).fill(part).join(sep);
const L12 = ['Abcdef', 'ghijkl'].join('');
const L12b = ['Mnopqr', 'stuvwx'].join('');
const L8 = ['Abcd', 'efgh'].join('');
const M3 = ['Zm', '9'].join(''); // three characters, letters and a digit

const text = (value: string): unknown => acceptHoodField({ kind: 'text', label: 'Detail', value });
const id = (value: string): unknown => acceptHoodField({ kind: 'id', label: 'Reference', value });
const labelled = (label: string): unknown =>
  acceptHoodField({ kind: 'text', label, value: 'hello' });

describe('(a) an id built from several parts is judged like a single piece', () => {
  it.each([
    ['two long parts joined by a dot', `${L12}.${L12b}`],
    ['three parts joined by dots', rep(L8, '.', 3)],
    ['three parts joined by colons', rep(L8, ':', 3)],
    ['a prefix and two long parts', `env_${L12}.${L12b}`],
    ['mixed dot and colon parts', `${L8}.${L8}:${L8}`],
  ])('refuses %s', (_n, value) => {
    expect(id(value)).toBeNull();
  });

  it.each(['0.3.1', 'm-12', 'v1.2.3-beta.4', 'build.2026.10.28', 'env_' + L12 + 'ab', 'a.b:c'])(
    'still shows the id %s',
    (value) => {
      expect(id(value)).not.toBeNull();
    },
  );
});

describe('(b) the split-value rule counts parts against total length', () => {
  it.each([
    ['eight three-character parts, dots', rep(M3, '.', 8)],
    ['eight three-character parts, spaces', rep(M3, ' ', 8)],
    ['eight three-character parts, slashes', rep(M3, '/', 8)],
    ['four-character parts joined by tildes', rep('Zm9v', '~', 6)],
    ['four-character parts joined by stars', rep('Zm9v', '*', 6)],
    ['four-character parts joined by at signs', rep('Zm9v', '@', 6)],
    ['four-character parts joined by pipes and commas', 'Zm9v|Zm9v,Zm9v;Zm9v|Zm9v,Zm9v'],
  ])('refuses %s', (_n, value) => {
    expect(text(value)).toBeNull();
    expect(acceptHoodField({ kind: 'path', label: 'Folder', value: '/k/' + value })).toBeNull();
  });

  it.each([
    'Version 0.3.1 on macOS 15.6',
    'Q3 2026 report v2',
    'Delivered and read',
    'Build a1 b2 c3 d4 e5 f6 g7 h8 i9 j0 k1 l2 m3',
    'See you at 10:30 on 2026-10-28 in room B12',
    'The quick brown fox jumps over the lazy dog',
  ])('still shows ordinary text: %s', (value) => {
    expect(text(value)).not.toBeNull();
  });
});

describe('(c) the sensitive-label list is complete', () => {
  it.each([
    'Salt',
    'Account salt',
    'Private',
    'Private note',
    'Recovery',
    'Recovery info',
    'Mnemonic',
    'Mnemonic words',
  ])('refuses the label %s', (label) => {
    expect(labelled(label)).toBeNull();
    expect(acceptHoodField({ kind: 'path', label, value: '/Users/tali/Files' })).toBeNull();
  });
});

describe('(d) look-alike spellings of those labels are refused the same', () => {
  it.each([
    ['digits for letters in salt', 'S4lt'],
    ['digits for letters in private', 'Pr1vate'],
    ['digit for a letter in key', 'K3y'],
    ['symbols for letters in password', 'Pa$$w0rd'],
    ['spaced letters', 'M n e m o n i c'],
    ['dashed letters', 'Re-cov-ery'],
    ['dotted letters', 'S.e.e.d'],
    ['underscores', 'Se_ed'],
    ['a cyrillic letter in recovery', 'Rеcovery'],
    ['a cyrillic letter in private', 'Prіvate'],
    ['a cyrillic letter in token', 'Tоken'],
    ['a greek letter in secret', 'Sεcret'],
    ['a non-breaking hyphen in pass-word', 'Pass‑word'],
    ['a macron in token', 'Tōken'],
    ['a dotless i in session', 'Sessıon'],
    ['full-width letters in salt', 'Ｓａｌｔ'],
    ['digit for a letter in drop', 'Dr0p'],
  ])('refuses %s', (_n, label) => {
    expect(labelled(label)).toBeNull();
  });

  it.each([
    'Message ID',
    'Version',
    'Size on disk',
    'Received',
    'Files folder',
    'Status',
    'Public record',
    'Top 10 files',
    'Build 3',
    'Dropdown count',
  ])('still shows the label %s', (label) => {
    expect(labelled(label)).not.toBeNull();
  });
});
