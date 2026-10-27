// @vitest-environment jsdom
// UI-REFRESH-e (S1): the Under the hood panel (B-11 §7; UX-V3 plan §3; I-5). It accepts only typed,
// allowlisted fields. The one link allowed is the public proof record link on a known public
// explorer; keys, codes, tokens, the session link and drop, upload, download and presigned URLs
// never reach the DOM, however they are labelled or typed. Read-only; collapsible; empty text.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lintVocabulary } from '../strings/lint.js';
import hoodCss from './hood.css?raw';
import {
  acceptHoodField,
  HOOD_STRINGS as S,
  HoodProvider,
  PROOF_LINK_HOSTS,
  PreviewTile,
  UnderTheHood,
  type HoodField,
} from './index.js';

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

const PROOF_URL = 'https://basescan.org/tx/0x' + 'ab'.repeat(32);
const render = (fields: unknown, on = true): void =>
  act(() =>
    root.render(
      h(HoodProvider, { value: on }, h(UnderTheHood, { fields: fields as readonly HoodField[] })),
    ),
  );

const record = (href: string): unknown => ({ kind: 'proofLink', label: 'Public record', href });
const FORBIDDEN: readonly [string, unknown][] = [
  ['a private key', { kind: 'text', label: 'Key', value: 'a'.repeat(64) }],
  ['a base64 key', { kind: 'text', label: 'Note', value: 'Zm9vYmFy-Zm9vYmFy-Zm9vYmFy' }],
  ['a code', { kind: 'text', label: 'Backup code', value: 'ABCD-EFGH-JKLM-NPQR' }],
  ['a token', { kind: 'text', label: 'Access token', value: 'tok_example_1' }],
  ['a token by value', { kind: 'text', label: 'Detail', value: 'Bearer zzzzzzzzzzzzzzzzzzzzzzzz' }],
  [
    'the session link',
    { kind: 'text', label: 'Session link', value: 'http://127.0.0.1:4318/#s=abc' },
  ],
  ['a session link as proof link', record('http://127.0.0.1:4318/#s=abc')],
  ['a drop url', { kind: 'text', label: 'Drop', value: 'https://drop.4th.tech/d/abc123' }],
  ['an upload url', { kind: 'text', label: 'Upload', value: 'https://example.com/upload/abc' }],
  [
    'a download url',
    { kind: 'text', label: 'Download', value: 'https://example.com/download/abc' },
  ],
  ['a presigned url', record('https://bucket.s3.amazonaws.com/o?X-Amz-Signature=abc')],
  ['a presigned url on an explorer host', record('https://basescan.org/tx/1?X-Amz-Signature=abc')],
  ['a link with credentials', record('https://user:pw@basescan.org/tx/1')],
  ['a link with a fragment', record('https://basescan.org/tx/1#token=abc')],
  ['a javascript link', record('javascript:alert(1)')],
  ['an http explorer link', record('http://basescan.org/tx/1')],
  ['a look-alike host', record('https://basescan.org.evil.example/tx/1')],
  ['a link typed as text', { kind: 'text', label: 'Record', value: PROOF_URL }],
  ['a look-alike subdomain', record('https://evil.basescan.org/tx/0x' + 'ab'.repeat(32))],
  ['another blockscout host', record('https://other.blockscout.com/tx/0x' + 'ab'.repeat(32))],
  ['a suffix host', record('https://notbasescan.org/tx/0x' + 'ab'.repeat(32))],
  ['a wrong path', record('https://basescan.org/address/0x' + 'ab'.repeat(20))],
  ['a short tx path', record('https://basescan.org/tx/0xabc')],
  ['an upper-case tx path', record('https://basescan.org/tx/0x' + 'AB'.repeat(32))],
  ['a port', record('https://basescan.org:8443/tx/0x' + 'ab'.repeat(32))],
  ['a backup code with dashes', { kind: 'text', label: 'Note', value: 'k3f9-a82d-77qz-10bc-x9y8' }],
  ['a backup code with spaces', { kind: 'text', label: 'Note', value: 'k3f9 a82d 77qz 10bc' }],
  ['a lower-case id code', { kind: 'id', label: 'Reference', value: 'abcd-efgh-jklm' }],
  [
    'a recovery phrase',
    {
      kind: 'text',
      label: 'Note',
      value: 'apple river stone cloud mango tiger lemon piano ocean daisy flame orbit',
    },
  ],
  ['a size that is not a size', { kind: 'size', label: 'Size', value: 'secret-ish text' }],
  ['an unknown kind', { kind: 'secret', label: 'Thing', value: 'odd-kind-value' }],
  ['a non-object', 'https://example.com'],
];

describe('the Under the hood panel', () => {
  it('renders nothing while the switch is off (the default) or outside a provider', () => {
    render([{ kind: 'text', label: 'Message ID', value: 'm-12' }], false);
    expect(host.innerHTML).toBe('');
    act(() =>
      root.render(h(UnderTheHood, { fields: [{ kind: 'text', label: 'ID', value: 'm-1' }] })),
    );
    expect(host.innerHTML).toBe('');
  });

  it('shows metadata fields in a marked, read-only, labelled region', () => {
    render([
      { kind: 'id', label: 'Message ID', value: 'm-12' },
      { kind: 'size', label: 'Size', value: '2.4 KB' },
      { kind: 'time', label: 'Received', value: '2026-10-27 09:41' },
    ]);
    const region = host.querySelector('section[aria-label]') as HTMLElement;
    expect(region.getAttribute('aria-label')).toBe(S.title);
    expect(region.classList.contains('al-hood')).toBe(true);
    expect(region.querySelector('svg.al-icon')).not.toBeNull();
    expect(host.textContent).toContain('m-12');
    expect(host.textContent).toContain('2.4 KB');
    expect(host.querySelectorAll('input, textarea, select, form, [contenteditable]').length).toBe(
      0,
    );
    expect(host.querySelectorAll('button').length).toBe(1);
  });

  it('shows the empty text when there is nothing technical to show', () => {
    render([]);
    expect(S.empty).toBe('Nothing technical to show here yet.');
    expect(host.textContent).toContain(S.empty);
  });

  it('renders the public proof record link, safely', () => {
    render([record(PROOF_URL)]);
    const a = host.querySelector('a') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe(PROOF_URL);
    expect(a.getAttribute('rel')).toContain('noreferrer');
    expect(a.getAttribute('rel')).toContain('noopener');
    expect(a.getAttribute('target')).toBe('_blank');
  });

  it.each(FORBIDDEN)('refuses %s: it never reaches the DOM', (_name, field) => {
    expect(acceptHoodField(field)).toBeNull();
    render([field, { kind: 'text', label: 'Message ID', value: 'm-12' }]);
    const f = field as { value?: string; href?: string } | string;
    const needle = typeof f === 'string' ? f : (f.value ?? f.href ?? '');
    expect(host.innerHTML).not.toContain(needle);
    expect(host.querySelectorAll('a').length).toBe(0);
    expect(host.textContent).toContain('m-12');
  });

  it('keeps the allowed fields and drops the forbidden ones from a mixed fixture', () => {
    render([
      ...FORBIDDEN.map(([, f]) => f),
      record(PROOF_URL),
      { kind: 'id', label: 'Message ID', value: 'm-12' },
    ]);
    expect(host.querySelectorAll('a').length).toBe(1);
    const html = host.innerHTML;
    for (const bad of [
      'drop.4th.tech',
      'X-Amz',
      '127.0.0.1',
      'tok_live',
      'ABCD-EFGH',
      'Bearer',
      'a'.repeat(40),
      'javascript:',
    ]) {
      expect(html, bad).not.toContain(bad);
    }
    expect(host.textContent).toContain('m-12');
  });

  it('does not carry extra properties of a field into the DOM', () => {
    render([
      {
        kind: 'id',
        label: 'Message ID',
        value: 'm-12',
        token: 'zzz-secret',
        href: 'https://x.test/u',
      },
    ]);
    expect(host.innerHTML).not.toContain('zzz-secret');
    expect(host.innerHTML).not.toContain('x.test');
  });

  it('collapses and expands from the header button', () => {
    render([{ kind: 'id', label: 'Message ID', value: 'm-12' }]);
    const btn = host.querySelector('button') as HTMLButtonElement;
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    act(() => btn.click());
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(host.textContent).not.toContain('m-12');
    act(() => btn.click());
    expect(host.textContent).toContain('m-12');
  });

  it('uses plain words (11 §5)', () => {
    expect(lintVocabulary(Object.values(S).join('\n'))).toEqual([]);
  });
});

describe('the proof link hosts', () => {
  it('are exactly the chain config explorers plus the two mainnet explorers', () => {
    // packages/chain/src/config/testnets.ts `explorer` hosts (a package may not import across; update both).
    const fromConfig = ['sepolia.basescan.org', 'gnosis-chiado.blockscout.com'];
    expect([...PROOF_LINK_HOSTS].sort()).toEqual(
      [...fromConfig, 'basescan.org', 'gnosisscan.io'].sort(),
    );
  });
  it('accept each host with a record path', () => {
    for (const host of PROOF_LINK_HOSTS) {
      expect(acceptHoodField(record(`https://${host}/tx/0x${'ab'.repeat(32)}`))).not.toBeNull();
    }
  });
});

describe('the Appearance preview tile', () => {
  it('moves a sample chip on request and says so in words', () => {
    act(() => root.render(h(PreviewTile)));
    const tile = host.querySelector('.al-preview-tile') as HTMLElement;
    expect(tile).not.toBeNull();
    const btn = host.querySelector('button') as HTMLButtonElement;
    expect(tile.classList.contains('is-moved')).toBe(false);
    act(() => btn.click());
    expect(tile.classList.contains('is-moved')).toBe(true);
    expect(host.querySelector('[aria-live="polite"]')?.textContent).toBeTruthy();
  });
});

describe('hood.css', () => {
  it('uses tokens for time and animates only opacity and transform', () => {
    expect(hoodCss.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/\d(ms|s)\b/);
    expect(hoodCss).toMatch(/var\(--al-duration-base\)/);
    expect(hoodCss).not.toMatch(/transition:[^;]*\b(height|width|top|left|margin|padding|all)\b/);
  });
});
