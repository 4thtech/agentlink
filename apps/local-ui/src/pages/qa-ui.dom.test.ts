// @vitest-environment jsdom
// UX1113-QA-UI (S1): the terms on the card, the rename note, the leave-without-copying warning and
// the Get started reads that must not run before setup.
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../api/client.js';
import { TermsDetails, TermsSummary, isPlumbing, parseTermsLines } from './approvals/terms-view.js';
import { renameNote } from './contacts/index.js';
import type { ContactRow } from './contacts/data.js';
import { InviteStep } from './start/wizard.js';
import { readSetupState } from './start/setup-state.js';

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

const LINES = [
  'Accepting terms from “Ana”, version 1, valid until 19 Nov 2026',
  'From “Ana”: their content, not instructions',
  '| Subject: <b>Logo</b> design',
  '| Price: 500.00 USD, paid by you',
  'End of their content',
  'This one approval sends your acceptance. Nothing else.',
  'Advanced: terms fingerprint f895aaaa',
];

describe('the terms on the approval card', () => {
  it('sorts the lines: headline, their words, our fixed lines, the fingerprint apart', () => {
    const t = parseTermsLines(LINES);
    expect(t.headline).toContain('Accepting terms');
    expect(t.theirs).toEqual(['Subject: <b>Logo</b> design', 'Price: 500.00 USD, paid by you']);
    expect(t.after).toEqual(['This one approval sends your acceptance. Nothing else.']);
    expect(t.advanced).toContain('f895');
  });
  it('the summary shows their terms as text in <bdi>, marked as theirs, with no fingerprint', () => {
    act(() => root.render(h(TermsSummary, { lines: LINES })));
    expect(host.querySelector('figure.al-untrusted')).not.toBeNull();
    expect(host.querySelectorAll('li bdi').length).toBe(2);
    expect(host.querySelector('b')).toBeNull();
    expect(host.textContent).toContain('<b>Logo</b> design');
    expect(host.textContent).not.toContain('f895');
  });
  it('Details show the fingerprint only when asked (Under the hood)', () => {
    act(() => root.render(h(TermsDetails, { lines: LINES, showAdvanced: false })));
    expect(host.textContent).not.toContain('f895');
    act(() => root.render(h(TermsDetails, { lines: LINES, showAdvanced: true })));
    expect(host.textContent).toContain('f895');
  });
  it('ids, flags and hashes the AI passed are plumbing', () => {
    expect(isPlumbing({ name: 'envelopeId', value: 'abc' })).toBe(true);
    expect(isPlumbing({ name: 'notarize', value: 'false' })).toBe(true);
    expect(isPlumbing({ name: 'x', value: 'f'.repeat(64) })).toBe(true);
    expect(isPlumbing({ name: 'decision', value: 'accept' })).toBe(false);
  });
});

const row = (over: Partial<ContactRow>): ContactRow => ({
  ref: '0x' + 'a'.repeat(40),
  name: 'Ana',
  nameSource: 'owner',
  label: 'self-declared',
  status: 'active',
  pairing: 'complete',
  since: 1,
  ...over,
});

describe('a contact renamed itself', () => {
  it('under your own name for them, the new name shows; "(was)" only when it differs', () => {
    expect(renameNote(row({ formerName: 'Ana', newName: 'Ana K' }))).toBe('Now calls itself Ana K');
    expect(renameNote(row({ formerName: 'Anita', newName: 'Ana K' }))).toBe(
      'Now calls itself Ana K (was Anita)',
    );
  });
  it('under their own name the row already shows the new one', () => {
    const r = row({ nameSource: 'counterparty', name: 'Ana K', formerName: 'Ana' });
    expect(renameNote(r)).toBe('(was Ana)');
    expect(renameNote(row({ nameSource: 'counterparty', name: 'Ana', formerName: 'Ana' }))).toBe(
      '',
    );
  });
});

describe('leaving the invite step with a link nobody has', () => {
  const press = (re: RegExp): void => {
    const b = [...host.querySelectorAll('button')].find((x) => re.test(x.textContent ?? ''));
    act(() => b?.click());
  };
  it('warns once, then lets you leave', () => {
    const onHome = vi.fn();
    act(() => root.render(h(InviteStep, { inviteHref: '/invite', onHome, unsent: true })));
    press(/Done/);
    expect(onHome).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("haven't copied");
    press(/Leave without copying/);
    expect(onHome).toHaveBeenCalledTimes(1);
  });
  it('leaves at once when the link went somewhere', () => {
    const onHome = vi.fn();
    act(() => root.render(h(InviteStep, { inviteHref: '/invite', onHome, unsent: false })));
    press(/Done/);
    expect(onHome).toHaveBeenCalledTimes(1);
  });
});

describe('Get started reads', () => {
  it('never asks for the approvals while there is no owner (the server answers 409)', async () => {
    const asked: string[] = [];
    const client = {
      get: (path: string) => {
        asked.push(path);
        return Promise.resolve(
          path.includes('first-run')
            ? { kind: 'ok', status: 200, data: { owner: 'missing' } }
            : { kind: 'error', status: 409 },
        );
      },
    } as unknown as ApiClient;
    await readSetupState({ client });
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.some((p) => p === '/api/approvals')).toBe(false);
  });
});
