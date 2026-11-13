// M1-19 (S1, I-2; 08 §4, D-53): the static files of the invite host. Headers are checked in the
// `_headers` file (the form Cloudflare static hosting reads); the browser test checks that a real
// response carries them. The page has one first-party script, no inline script or style, no
// analytics and no third-party URL.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DOCS_LINKS, INSTALL_AND_ACCEPT_TEMPLATE } from '@4thtech-io/invite';
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

  it('WP-2 (F33): allows images from the site itself only, for its favicon', () => {
    const directives = CSP.split('; ');
    expect(directives).toContain("img-src 'self'");
    expect(directives.filter((d) => d.startsWith('img-src'))).toEqual(["img-src 'self'"]);
    expect(directives).toContain("default-src 'none'");
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

  // INSTALLER-1 (owner Decision 58): curl | sh and irm | iex read plain text; never cached, so an
  // update of the installer is served at once.
  it('serves the one-line installers as plain text, with the headers of every path', () => {
    for (const path of ['/install.sh', '/install.ps1']) {
      const own = headersFor(file, path);
      expect(own['content-type'], path).toBe('text/plain; charset=utf-8');
      expect(own['x-content-type-options'], path).toBe('nosniff');
      expect(own['cache-control'], path).toBe('no-store');
      expect(own['content-security-policy'], path).toBe(CSP);
    }
    // Only the installers get a content type of their own.
    expect(headersFor(file, '/i')['content-type']).toBeUndefined();
    expect(headersFor(file, '/')['content-type']).toBeUndefined();
  });

  it('sets no cookie and allows no cross-origin use', () => {
    expect(file).not.toMatch(/set-cookie/i);
    expect(file).not.toMatch(/access-control-allow/i);
  });
});

describe('the pages', () => {
  const pages = ['i/index.html'];

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
        // WP-2, REL051-INV: the only outside URLs are the two help links to 4thTech Docs (the
        // build constants of config.ts), each a plain link in a new tab with no referrer. The Mac
        // app's links have no href in the HTML (its release switch is off). WP-D9: the two app
        // links of the command card are in the file only as empty, hidden placeholders with no
        // address and no text; only a build with the desktop app links flag on (src/flags.ts)
        // fills and shows them. WIN-DESK-2: the Windows app's link (#win-app-link) is in the file
        // with no href too, inside the hidden #win-app block; the script fills it only on Windows.
        expect([...html.matchAll(/https?:\/\/[^\s"'<>]*/gi)].map((m) => m[0])).toEqual([
          DOCS_LINKS.guide,
          DOCS_LINKS.windows,
        ]);
        const anchors = [...html.matchAll(/<a\b[^>]*>/gi)].map((m) => m[0]);
        expect(anchors).toHaveLength(7);
        expect(anchors.filter((a) => /id="win-app-link"/.test(a))).toEqual([
          '<a id="win-app-link" target="_blank" rel="noopener noreferrer">',
        ]);
        expect(html).toMatch(/<p id="win-app" class="mac-app small" hidden>/);
        const appAnchors = [
          '<a id="open-app" class="btn secondary">',
          '<a id="get-app" class="btn secondary" rel="noopener noreferrer">',
        ];
        expect(anchors.filter((a) => /id="(open|get)-app"/.test(a))).toEqual(appAnchors);
        for (const a of anchors.filter((x) => !appAnchors.includes(x))) {
          expect(a).toMatch(/\btarget="_blank"/);
          expect(a).toMatch(/\brel="noopener noreferrer"/);
        }
        expect(anchors.filter((a) => /\bhref=/.test(a))).toHaveLength(2);
        expect(html).toMatch(
          /<p id="app-links" class="actions" hidden>\s*<a id="open-app" class="btn secondary"><\/a>\s*<a id="get-app" class="btn secondary" rel="noopener noreferrer"><\/a>\s*<\/p>/,
        );
        const command = /<article id="way-command"[\s\S]*?<\/article>/.exec(html)?.[0] ?? '';
        expect(command).toContain('id="app-links"');
        expect(html).not.toMatch(/agentlink:\/\/|Open in the AgentLink app|Get the app/);
        // One first-party style file (CSP style-src 'self') and the site's own favicon (F33).
        const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
        expect(links).toEqual([
          '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />',
          '<link rel="stylesheet" href="/invite.css" />',
        ]);
        expect(html).not.toMatch(/<(iframe|object|embed|form|img|base)\b/i);
      });

      it('has no analytics and no tracking', () => {
        expect(html).not.toMatch(/analytics|gtag|plausible|matomo|segment|pixel|beacon|hotjar/i);
      });

      it('sends no referrer even where headers are lost', () => {
        expect(html).toMatch(/<meta name="referrer" content="no-referrer"\s*\/?>/);
      });

      it('has the elements the script fills, and the step section apart from the inviter', () => {
        for (const id of [
          'state',
          'retry',
          'inviter',
          'invite-heading',
          'inviter-name',
          'inviter-label',
          'inviter-fingerprint',
          'inviter-expiry',
          'step',
          'step-heading',
          'way-ai',
          'way-command',
          'way-link',
          'step-text',
          'step-help',
          'os-mac',
          'os-windows',
          'os-linux',
          'os-node',
          'open-help',
          'phone-note',
          'mac-app',
          'mac-app-arm64',
          'mac-app-x64',
          'help-again',
          'link-text',
          'copy-ai',
          'copy',
          'copy-link',
          'app-links',
          'open-app',
          'get-app',
          'next',
        ]) {
          expect(html, id).toMatch(new RegExp(`id="${id}"`));
        }
        const inviter = /<section id="inviter"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
        const step = /<section id="step"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
        expect(inviter).not.toBe('');
        expect(step).not.toBe('');
        expect(inviter).not.toContain('step-text');
        expect(step).not.toContain('inviter-');
        expect(step).not.toContain('id="next"');
        // Sections are siblings, never nested.
        expect(html.indexOf(step)).toBeGreaterThan(html.indexOf(inviter) + inviter.length - 1);
      });

      it('starts with the invite parts hidden', () => {
        expect(html).toMatch(/<section id="inviter" hidden/);
        expect(html).toMatch(/<section id="step" hidden/);
        expect(html).toMatch(/<p id="next"[^>]* hidden/);
      });
    });
  }

  // M1-19-d (owner Decision 55): the root of agentlink.4thtech.io is a minimal page. The invite
  // lives at /i only (CANONICAL_PREFIX); the root reads no fragment and runs no script.
  describe('index.html (the root)', () => {
    const html = read('index.html');

    it('is not the invite page and runs no script at all', () => {
      expect(html).not.toBe(read('i/index.html'));
      expect(html).not.toMatch(/<script\b/i);
      expect(html).not.toMatch(/<(iframe|object|embed|form|img|base)\b/i);
    });

    it('says what AgentLink is in one line and links to the public repository', () => {
      expect(html).toMatch(/<h1[^>]*>AgentLink<\/h1>/);
      const lead = /<p class="lead">([^<]*)<\/p>/.exec(html)?.[1] ?? '';
      expect(lead.length).toBeGreaterThan(20);
      expect(lead).not.toMatch(/wallet|gas|seed phrase|transaction/i);
      expect([...html.matchAll(/https?:\/\/[^\s"'<>]*/gi)].map((m) => m[0])).toEqual([
        'https://github.com/4thtech/agentlink',
      ]);
      const anchors = [...html.matchAll(/<a\b[^>]*>/gi)].map((m) => m[0]);
      expect(anchors).toHaveLength(1);
      expect(anchors[0]).toMatch(/\bhref="https:\/\/github\.com\/4thtech\/agentlink"/);
      expect(anchors[0]).toMatch(/\brel="noopener noreferrer"/);
    });

    it('has one first-party style file, no inline style or handler, no analytics, no referrer', () => {
      const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
      expect(links).toEqual([
        '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />',
        '<link rel="stylesheet" href="/invite.css" />',
      ]);
      expect(html).not.toMatch(/<style\b|\sstyle\s*=|\son[a-z]+\s*=|javascript:/i);
      expect(html).not.toMatch(/analytics|gtag|plausible|matomo|segment|pixel|beacon|hotjar/i);
      expect(html).toMatch(/<meta name="referrer" content="no-referrer"\s*\/?>/);
    });
  });

  it('the site folder holds only the files named here', () => {
    const files = readdirSync(site(''), { recursive: true, withFileTypes: false })
      .map(String)
      .filter((f) => statSync(site(f)).isFile())
      .sort();
    expect(files).toEqual(['_headers', 'favicon.svg', 'i/index.html', 'index.html', 'invite.css']);
  });

  it('F33: the favicon is a plain SVG image: no script, no link out, no outside reference', () => {
    const svg = read('favicon.svg');
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).not.toMatch(
      /<script\b|\son[a-z]+\s*=|javascript:|<foreignObject\b|href=|@import|url\(/i,
    );
    expect([...svg.matchAll(/https?:\/\/[^\s"'<>]*/gi)].map((m) => m[0])).toEqual([
      'http://www.w3.org/2000/svg',
    ]);
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
