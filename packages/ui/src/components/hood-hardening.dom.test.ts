// @vitest-environment jsdom
// UI-REFRESH-e3 (S1): the Under the hood allowlist holds against encoded and look-alike inputs
// (B-11 §7; 04 §4; I-5). Every refused kind stays refused whatever form it arrives in; real message
// IDs and real folder paths still show. The inert-hold helper is internal, not part of the package.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as pkg from '../index.js';
import { acceptHoodField, HoodProvider, UnderTheHood, type HoodField } from './index.js';

const SRC = import.meta.glob(['./surface.tsx', './inert.ts', './pay-confirm.tsx'], {
  query: '?raw',
  import: 'default',
  eager: true,
});
const surfaceSrc = SRC['./surface.tsx'] ?? '';
const inertSrc = SRC['./inert.ts'] ?? '';
const payConfirmSrc = SRC['./pay-confirm.tsx'] ?? '';

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

const render = (fields: unknown[]): void =>
  act(() =>
    root.render(
      h(HoodProvider, { value: true }, h(UnderTheHood, { fields: fields as readonly HoodField[] })),
    ),
  );

const fw = (s: string): string =>
  Array.from(s)
    .map((c) => {
      const n = c.charCodeAt(0);
      return n > 0x20 && n < 0x7f ? String.fromCharCode(n + 0xfee0) : c;
    })
    .join('');

// [name, kind, value]: each must be refused for every kind it is tried as.
const ENCODED: readonly [string, string][] = [
  // percent-encoding
  ['a percent-encoded drop url', 'https%3A%2F%2Fdrop.4th.tech%2Fd%2Fabc123'],
  ['a percent-encoded session fragment', 'app%23s%3Dabc'],
  ['a percent-encoded presigned field', 'x%3FX-Amz-Signature%3Dabc'],
  ['a percent-encoded token prefix', '%74ok_example_1'],
  ['a double percent-encoded url', 'https%253A%252F%252Fexample.com%252Fdownload'],
  // full-width and compatibility forms
  ['a full-width drop url', fw('https://drop.4th.tech/d/abc123')],
  ['a full-width scheme only', fw('https:') + '//example.com/x'],
  ['a full-width session fragment', 'app' + fw('#s=abc')],
  ['a full-width token', fw('tok_example_1')],
  ['a full-width bearer value', fw('Bearer zzzzzzzz')],
  ['a full-width localhost', fw('localhost') + ':4318'],
  ['a look-alike slash scheme', 'https:\u2044\u2044example.com/download/abc'],
  ['a look-alike colon scheme', 'https\u2236//example.com/download/abc'],
  // single-slash and slash-less schemes
  ['a single-slash scheme', 'https:/drop.4th.tech/d/abc123'],
  ['a backslash scheme', 'https:\\\\example.com\\download'],
  ['a slash-less scheme', 'https:drop.4th.tech'],
  ['a single-slash custom scheme', 'agentlink:/session/abc'],
  // scheme-less known drop and storage hosts
  ['a scheme-less drop host', 'drop.4th.tech/d/abc123'],
  ['a scheme-less product drop host', 'drop.agentlink.4thtech.io/v1/obj'],
  ['a scheme-less bucket host', 'bucket.s3.amazonaws.com/obj'],
  ['a scheme-less worker host', 'agentlink-drop-staging.example.workers.dev/u'],
  ['a scheme-less r2 host', 'acct.r2.cloudflarestorage.com/b/o'],
  // bidi, format, DEL and C1 control characters
  ['a right-to-left override', 'm-12\u202Eexe.txt'],
  ['a bidi isolate', 'm\u2066-12\u2069'],
  ['a zero-width space', 'tok\u200B_example_1'],
  ['a zero-width joiner', 'm-\u200D12'],
  ['a byte-order mark', '\uFEFFm-12'],
  ['an arabic letter mark', 'm-12\u061C'],
  ['a DEL character', 'm-12\u007F'],
  ['a C1 control character', 'm-12\u0085'],
  ['a C1 CSI character', 'm-\u009B12'],
  ['a line separator', 'm-12\u2028x'],
];

// Key-shaped values cut into pieces.
const SPLIT: readonly [string, string][] = [
  ['a base64 key split across path segments', '/keys/Zm9vYmFy/Zm9vYmFy/Zm9vYmFy/Zm9vYmFy'],
  ['a hex key split across path segments', '/k/3f9a2b7c/8d1e4f60/a5b9c2d7/e0f1a2b3'],
  ['a key split across backslash segments', 'C:\\k\\Zm9vYmFy\\Zm9vYmFy\\Zm9vYmFy\\Zm9vYmFy'],
  ['a key split across dots in a path', '/k/Zm9vYmFy.Zm9vYmFy.Zm9vYmFy.Zm9vYmFy'],
];
const SPLIT_TEXT: readonly [string, string][] = [
  ['a base64 key split by spaces', 'Zm9vYmFy Zm9vYmFy Zm9vYmFy Zm9vYmFy'],
  ['a hex key split by slashes', '3f9a2b7c/8d1e4f60/a5b9c2d7/e0f1a2b3'],
  ['a key split by dots', 'Zm9vYmFy.Zm9vYmFy.Zm9vYmFy.Zm9vYmFy'],
  ['a key split by colons', '3f9a2b7c:8d1e4f60:a5b9c2d7:e0f1a2b3'],
];

const LABELS: readonly string[] = [
  fw('Key'),
  fw('Session') + ' id',
  'Back%75p code',
  'Ac\u200Bcess token',
  'Down\u00ADload',
  'Up\u200Dload',
];

describe('encoded and look-alike inputs (UI-REFRESH-e3)', () => {
  it.each(ENCODED)('refuses %s as text, id, path and time', (_n, value) => {
    for (const kind of ['text', 'id', 'path', 'time']) {
      const v = kind === 'path' && !value.startsWith('/') ? `/Users/tali/${value}` : value;
      expect(acceptHoodField({ kind, label: 'Detail', value: v }), `${kind}: ${v}`).toBeNull();
    }
    render([
      { kind: 'text', label: 'Detail', value },
      { kind: 'path', label: 'Folder', value: `/Users/tali/${value}` },
      { kind: 'id', label: 'Message ID', value: 'm-12' },
    ]);
    expect(host.innerHTML).not.toContain(value);
    expect(host.textContent).toContain('m-12');
  });

  it.each(SPLIT)('refuses %s typed as a path', (_n, value) => {
    expect(acceptHoodField({ kind: 'path', label: 'Folder', value })).toBeNull();
    expect(acceptHoodField({ kind: 'text', label: 'Folder', value })).toBeNull();
  });

  it.each(SPLIT_TEXT)('refuses %s typed as text or id', (_n, value) => {
    expect(acceptHoodField({ kind: 'text', label: 'Detail', value })).toBeNull();
    expect(acceptHoodField({ kind: 'id', label: 'Reference', value })).toBeNull();
  });

  it.each(LABELS)('refuses the disguised label %j', (label) => {
    expect(acceptHoodField({ kind: 'text', label, value: 'hello' })).toBeNull();
    expect(acceptHoodField({ kind: 'path', label, value: '/Users/tali/Files' })).toBeNull();
  });

  it('refuses a proof link that hides a control or format character', () => {
    const tx = '0x' + 'ab'.repeat(32);
    for (const href of [
      `https://basescan.org/tx/${tx}\u202E`,
      `https://basescan.org/tx/${tx}\u007F`,
      `https://basescan.org\u200B/tx/${tx}`,
      `https://basescan.org/tx/${tx}%23token`,
      `https://basescan.org/tx%2F${tx}`,
    ]) {
      expect(acceptHoodField({ kind: 'proofLink', href }), JSON.stringify(href)).toBeNull();
    }
  });
});

describe('the id kind (UI-REFRESH-e3)', () => {
  const MSG_ID = 'env_' + 'Ab3-_x9Qz7LmN0pR2sT4uV'; // env_ plus 22 base64url characters
  it('shows a real message id', () => {
    expect(MSG_ID.length).toBe(26);
    expect(acceptHoodField({ kind: 'id', label: 'Message ID', value: MSG_ID })).toEqual({
      kind: 'id',
      label: 'Message ID',
      value: MSG_ID,
    });
    render([{ kind: 'id', label: 'Message ID', value: MSG_ID }]);
    expect(host.textContent).toContain(MSG_ID);
  });

  it.each([
    'env_Ab3-x9Qz-7LmN0pR2sT4uV',
    'env_-_-_x9Qz7LmN0pR2sT4uVw',
    'env_Ab3x9Qz7LmN0pR2sT4uVwX',
  ])('shows the message id %s, dashes and underscores included', (value) => {
    expect(value.length).toBe(26);
    expect(acceptHoodField({ kind: 'id', label: 'Message ID', value })).not.toBeNull();
  });

  it('keeps the 24-character run rule for text', () => {
    expect(acceptHoodField({ kind: 'text', label: 'Message ID', value: MSG_ID })).toBeNull();
  });

  it.each([
    ['a 64-char hex key', 'a'.repeat(64)],
    ['a 43-char base64url key', 'Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9'],
    ['a 41-char value', 'env_' + 'x'.repeat(37)],
    ['a bare 32-char hex secret', '3f9a2b7c8d1e4f60a5b9c2d7e0f1a2b3'],
    ['a bare 24-char base64 secret', 'Zm9vYmFyZm9vYmFyZm9vYmFy'],
    ['a secret with a token prefix', 'sk_' + 'Ab3x9Qz7LmN0pR2sT4uVwX'],
    ['a secret with a key prefix', 'key_' + 'Ab3x9Qz7LmN0pR2sT4uVwX'],
    ['a jwt head', 'eyJhbGciOiJIUzI1NiJ9'],
    ['a code', 'ABCD-EFGH-JKLM-NPQR'],
    ['a value with a slash', 'env_abc/def'],
    ['a value with a space', 'env_abc def'],
  ])('refuses %s as an id', (_n, value) => {
    expect(acceptHoodField({ kind: 'id', label: 'Message ID', value })).toBeNull();
  });
});

describe('ordinary values still show (UI-REFRESH-e3)', () => {
  it.each([
    ['text', 'Status', 'Delivered and read'],
    ['text', 'Note', 'Version 0.3.1 on macOS 15.6'],
    ['id', 'Version', '0.3.1'],
    ['id', 'Message ID', 'm-12'],
    ['time', 'Received', '2026-10-27 09:41'],
    ['time', 'Received', '2026-10-27T09:41:00.000Z'],
    ['size', 'Size', '2.4 KB'],
    ['count', 'Messages', '3 of 12'],
    ['path', 'Files folder', '/Users/talirezun/Documents/AgentLink/Files/2026/October'],
    ['path', 'Files folder', 'C:\\Users\\Tali\\Documents\\AgentLink\\Files'],
    ['path', 'Files folder', '/home/tali/.local/share/agentlink/files'],
    ['path', 'Files folder', '/Users/tali/Files/Q3 2026 report v2'],
    ['path', 'Files folder', '/Users/tali/Files/drop.zip'],
    ['path', 'Files folder', '/Users/tali/Café Résumé'],
  ])('accepts %s %s = %s', (kind, label, value) => {
    expect(acceptHoodField({ kind, label, value })).toEqual({ kind, label, value });
  });
});

describe('the inert-hold helper is internal (UI-REFRESH-e3)', () => {
  it('is not exported from the package index', () => {
    expect('holdInert' in pkg).toBe(false);
  });
  it('lives in its own module, marked @internal, imported relatively by its users', () => {
    expect(inertSrc).toMatch(/@internal[\s\S]*export function holdInert/);
    expect(surfaceSrc).toMatch(/import \{ holdInert \} from '\.\/inert\.js'/);
    expect(payConfirmSrc).toMatch(/import \{ holdInert \} from '\.\/inert\.js'/);
    expect(surfaceSrc).not.toMatch(/export function holdInert/);
  });
});
