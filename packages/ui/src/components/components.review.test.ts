// IR-M1-35b-1 fixes (S1, I-5): one test per finding.
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import * as ui from './index.js';

const html = (el: Parameters<typeof renderToStaticMarkup>[0]): string =>
  renderToStaticMarkup(el).replaceAll('&#x27;', "'");

describe('IR-M1-35b-1', () => {
  const approval = { type: 'proof', agent: 'a', headline: 'h' } as const;

  it('1: shows the contact in a receipt request and the remember offer under the name rule', () => {
    const hostile = { name: '<b>Marko</b>', fingerprint: '7F3A·19C2' };
    const out = html(
      h(ui.ApprovalCard, {
        ...approval,
        receiptRequest: { contact: hostile },
        remember: { reason: 'ask-me', contact: hostile, rule: 'Allow up to $1' },
      }),
    );
    expect(out).toContain('Ask Contact 7F3A·19C2 to confirm delivery?');
    expect(out).not.toContain('<b>');
    expect(out).not.toContain('Marko');
    const named = html(
      h(ui.ApprovalCard, { ...approval, receiptRequest: { contact: { name: 'Marko' } } }),
    );
    expect(named).toContain('Ask “Marko” (Self-declared) to confirm delivery?');
  });

  it('2: labels a declared name Self-declared by default, but not an alias', () => {
    expect(html(h(ui.ContactName, { name: 'Marko', fingerprint: 'AB' }))).toContain(
      'Self-declared',
    );
    expect(html(h(ui.ContactName, { alias: 'Marko' }))).not.toContain('Self-declared');
    expect(
      html(h(ui.ContactName, { name: 'Marko', fingerprint: 'AB', label: 'checked' })),
    ).toContain('Safety code checked');
  });

  it('3: keeps line breaks and tabs in a message body only', () => {
    const body = html(h(ui.UntrustedContent, { from: 'M' }, 'line one\n\tline two'));
    expect(body).toContain('line one\n\tline two');
    expect(ui.formatContactName({ alias: 'a\nb' }).text).toBe('ab');
    expect(html(h(ui.FileCard, { name: 'a\nb.pdf', size: '1' }))).not.toContain('a\nb');
  });

  it('4: rejects the multiplication and division signs in names and strips tag characters', () => {
    for (const name of ['Marko×', 'Mar÷ko']) {
      expect(ui.formatContactName({ name, fingerprint: 'AB' }).kind).toBe('fingerprint');
    }
    expect(ui.formatContactName({ name: 'Émile', fingerprint: 'AB' }).kind).toBe('restricted');
    const tags = String.fromCodePoint(0xe0041, 0xe0042, 0xe007f);
    expect(html(h(ui.UntrustedContent, { from: 'M' }, `hi${tags}there`))).toContain('hithere');
    expect(ui.formatContactName({ alias: `Al${tags}ex` }).text).toBe('Alex');
  });

  it('5: a verified label needs its domain (type and render)', () => {
    // @ts-expect-error a verified label must name its domain
    const missing = h(ui.IdentityLabel, { kind: 'verified' });
    expect(missing).toBeDefined();
    const out = html(h(ui.ContactName, { name: 'Marko', fingerprint: 'AB', label: 'verified' }));
    expect(out).not.toContain('Verified domain');
    expect(
      html(h(ui.ContactName, { name: 'Marko', label: 'verified', domain: 'example.com' })),
    ).toContain('Verified domain');
  });

  it('6: a nav link goes only to /, # or https:', () => {
    const href = (value: string): string | undefined =>
      /href="([^"]*)"/.exec(
        html(h(ui.AppShell, { nav: [{ icon: 'users', label: 'X', href: value }] })),
      )?.[1];
    expect(href('/contacts')).toBe('/contacts');
    expect(href('#top')).toBe('#top');
    expect(href('https://example.com/a')).toBe('https://example.com/a');
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,x',
      '//evil.example',
      'http://x',
      'mailto:a@b.c',
      'x/y',
      '/\\evil.example',
    ]) {
      expect(href(bad), bad).toBe('#');
    }
  });

  it('IR-2 1: a nav href with a tab or line break is refused', () => {
    const href = (value: string): string | undefined =>
      /href="([^"]*)"/.exec(
        html(h(ui.AppShell, { nav: [{ icon: 'users', label: 'X', href: value }] })),
      )?.[1];
    for (const bad of ['/\t/evil.example', '/\n/evil.example', '/\r/evil.example', 'https:\t//x']) {
      expect(href(bad), JSON.stringify(bad)).toBe('#');
    }
  });

  it('IR-2 2: a declared name shows (Self-declared) in the receipt line and the remember row', () => {
    const out = html(
      h(ui.ApprovalCard, {
        ...approval,
        receiptRequest: { contact: { name: 'Marko' } },
        remember: { reason: 'ask-me', contact: { name: 'Marko' }, rule: 'r' },
      }),
    );
    expect(out).toContain('Ask “Marko” (Self-declared) to confirm delivery?');
    expect(out).toContain('“Marko” (Self-declared)</span>');
    const alias = html(
      h(ui.ApprovalCard, { ...approval, receiptRequest: { contact: { alias: 'Marko' } } }),
    );
    expect(alias).toContain('Ask Marko to confirm delivery?');
    expect(alias).not.toContain('Self-declared');
  });
});
