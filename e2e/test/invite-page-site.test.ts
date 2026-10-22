// M1-19 (S1, I-2; 08 §4, D-53): the static files of the invite host. Headers are checked in the
// `_headers` file (the form Cloudflare static hosting reads); the browser test checks that a real
// response carries them. The page has one first-party script, no inline script or style, no
// analytics and no third-party URL.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INSTALL_AND_ACCEPT_TEMPLATE } from '@4thtech-io/invite';
import { CSP, headersFor } from './invite/headers.js';

const site = (path: string): string =>
  fileURLToPath(new URL(`../../apps/invite/site/${path}`, import.meta.url));
const read = (path: string): string => readFileSync(site(path), 'utf8');

describe('_headers', () => {
  const file = read('_headers');
  const headers = headersFor(file, '/i');

  it('sends the CSP of 08 §4 on every path', () => {
    expect(headers['content-security-policy']).toBe(CSP);
  });

  it('sends no referrer, and nosniff', () => {
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['x-content-type-options']).toBe('nosniff');
  });

  it('refuses framing in both ways', () => {
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(headers['x-frame-options']).toBe('DENY');
  });

  it('does not cache the page, whose body never holds the invite anyway', () => {
    expect(headers['cache-control']).toMatch(/no-store|no-cache|max-age=0/);
  });

  it('sets no cookie and allows no cross-origin use', () => {
    expect(file).not.toMatch(/set-cookie/i);
    expect(file).not.toMatch(/access-control-allow/i);
  });
});

describe('the pages', () => {
  const pages = ['index.html', 'i/index.html'];

  for (const page of pages) {
    describe(page, () => {
      const html = read(page);

      it('has exactly one script, a first-party module with a src, and nothing inline', () => {
        const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi)];
        expect(scripts).toHaveLength(1);
        const [, attrs, body] = scripts[0] ?? [];
        expect(attrs).toMatch(/\btype="module"/);
        expect(attrs).toMatch(/\bsrc="\/invite\.js"/);
        expect(body).toBe('');
      });

      it('has no inline style, event handler, javascript: URL or third-party URL', () => {
        expect(html).not.toMatch(/<style\b/i);
        expect(html).not.toMatch(/\sstyle\s*=/i);
        expect(html).not.toMatch(/\son[a-z]+\s*=/i);
        expect(html).not.toMatch(/javascript:/i);
        expect(html).not.toMatch(/https?:\/\//i);
        expect(html).not.toMatch(/<(iframe|object|embed|form|img|link|base)\b/i);
      });

      it('has no analytics and no tracking', () => {
        expect(html).not.toMatch(/analytics|gtag|plausible|matomo|segment|pixel|beacon|hotjar/i);
      });

      it('sends no referrer even where headers are lost', () => {
        expect(html).toMatch(/<meta name="referrer" content="no-referrer"\s*\/?>/);
      });

      it('has the elements the script fills, and the prompt section apart from the inviter', () => {
        for (const id of [
          'state',
          'inviter',
          'inviter-name',
          'inviter-label',
          'inviter-fingerprint',
          'inviter-expiry',
          'inviter-host',
          'prompt',
          'prompt-heading',
          'prompt-text',
          'copy',
        ]) {
          expect(html, id).toMatch(new RegExp(`id="${id}"`));
        }
        const inviter = /<section id="inviter"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
        const prompt = /<section id="prompt"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
        expect(inviter).not.toBe('');
        expect(prompt).not.toBe('');
        expect(inviter).not.toContain('prompt-text');
        expect(prompt).not.toContain('inviter-');
        // Sections are siblings, never nested.
        expect(html.indexOf(prompt)).toBeGreaterThan(html.indexOf(inviter) + inviter.length - 1);
      });

      it('starts with the invite parts hidden', () => {
        expect(html).toMatch(/<section id="inviter" hidden/);
        expect(html).toMatch(/<section id="prompt" hidden/);
      });
    });
  }

  it('the two pages are the same page', () => {
    expect(read('i/index.html')).toBe(read('index.html'));
  });

  it('the site folder holds only the files named here', () => {
    const files = readdirSync(site(''), { recursive: true, withFileTypes: false })
      .map(String)
      .filter((f) => statSync(site(f)).isFile())
      .sort();
    expect(files).toEqual(['_headers', 'i/index.html', 'index.html']);
    expect(existsSync(site('invite.js'))).toBe(false); // built, never committed
  });
});

describe('the prompt', () => {
  it('is the install-and-accept template of the skill file (06 §7.1)', () => {
    const skill = readFileSync(
      fileURLToPath(new URL('../../skills/agentlink/SKILL.md', import.meta.url)),
      'utf8',
    );
    expect(skill).toContain(`> ${INSTALL_AND_ACCEPT_TEMPLATE}`);
  });
});
