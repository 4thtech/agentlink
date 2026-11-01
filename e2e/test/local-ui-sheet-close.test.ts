// W5-SHEET-CLOSE (S1): a right-hand panel must always be closable. The built local app
// (apps/local-ui/dist, made by `^build`) in real Chromium, every /api/** call answered from the
// fixtures of local-ui-refresh.test.ts. jsdom has no `inert`, hit-testing or focus loss on click,
// which is why the unit tests never saw the owner's bug: a click on text inside the contact panel
// dropped focus to <body>, the page behind was inert, and Escape had nowhere to go.
//
// Covered: Escape after a click on non-focusable content; the × (at least 44 px, and the topmost
// element at its centre); a click on the backdrop; Back (a route change) closing it; and `inert`
// cleared every time. Also W5-SAFETY-STEP: `?check=<ref>` opens that contact's panel by itself.
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROUTES } from './fixtures/local-ui-refresh.js';

const DIST = fileURLToPath(new URL('../../apps/local-ui/dist/', import.meta.url));
const ANA = `0x${(2).toString(16).padStart(40, '0')}`; // self-declared, answered: can be compared

let site: Server;
let origin: string;
let browser: Browser;

function serve(): Promise<Server> {
  const types: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.woff2': 'font/woff2',
    '.svg': 'image/svg+xml',
  };
  const server = createServer((req, res) => {
    const p = (req.url ?? '/').split('?')[0] ?? '/';
    const file = p.startsWith('/assets/') && !p.includes('..') ? p.slice(1) : 'index.html';
    try {
      const body = readFileSync(join(DIST, file));
      res.writeHead(200, { 'content-type': types[extname(file)] ?? 'text/html' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function open(): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
  });
  const page = await ctx.newPage();
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    const body = url.pathname === '/api/ui/first-run' ? { owner: 'set_up' } : ROUTES[url.pathname];
    return route.fulfill({
      status: body === undefined ? 404 : 200,
      contentType: 'application/json',
      body: JSON.stringify(body ?? { error: 'not_found' }),
    });
  });
  return { ctx, page };
}

async function onContacts(page: Page): Promise<void> {
  await page.goto(`${origin}/contacts`);
  await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 10_000 });
  await page.getByRole('button', { name: /Ana/ }).first().waitFor();
}

async function openPanel(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Ana/ }).first().click();
  await page.getByRole('dialog').first().waitFor();
  await page.waitForTimeout(450); // the slide-in
}

const dialogs = (page: Page): Promise<number> => page.getByRole('dialog').count();
const inertCount = (page: Page): Promise<number> =>
  page.evaluate(() => document.querySelectorAll('[inert], [data-al-inert]').length);

async function expectClosed(page: Page): Promise<void> {
  await page.getByRole('dialog').first().waitFor({ state: 'detached', timeout: 3_000 });
  expect(await dialogs(page)).toBe(0);
  expect(await inertCount(page)).toBe(0);
}

beforeAll(async () => {
  site = await serve();
  origin = `http://127.0.0.1:${String((site.address() as AddressInfo).port)}`;
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  site?.close();
});

describe('W5-SHEET-CLOSE: the contact panel can always be closed (real Chromium)', () => {
  it('Escape closes it after a click on non-focusable content (focus falls to the page)', async () => {
    const { ctx, page } = await open();
    try {
      await onContacts(page);
      await openPanel(page);
      expect(await inertCount(page)).toBeGreaterThan(0);
      // The panel's own text: nothing to focus, so focus leaves for <body> (the owner's bug).
      const body = page.locator('.al-sheet-body').first();
      await body.click({ position: { x: 4, y: 4 } });
      await page.getByRole('dialog').getByText(/./).first().click({ force: true });
      await page.keyboard.press('Escape');
      await expectClosed(page);
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it('Escape also closes it while focus is on the page body', async () => {
    const { ctx, page } = await open();
    try {
      await onContacts(page);
      await openPanel(page);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press('Escape');
      await expectClosed(page);
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it('the × is a 44 px target, the topmost thing at its centre, and closes it', async () => {
    const { ctx, page } = await open();
    try {
      await onContacts(page);
      await openPanel(page);
      const close = page.locator('.al-sheet-close').first();
      const box = await close.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
      const hit = await close.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return top === el || el.contains(top);
      });
      expect(hit).toBe(true);
      await close.click();
      await expectClosed(page);
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it('a click outside the panel (the backdrop) closes it', async () => {
    const { ctx, page } = await open();
    try {
      await onContacts(page);
      await openPanel(page);
      await page.mouse.click(40, 400);
      await expectClosed(page);
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it('a route change (Back) closes it and clears inert', async () => {
    const { ctx, page } = await open();
    try {
      await page.goto(`${origin}/activity`);
      await page.getByRole('heading', { level: 1 }).first().waitFor({ timeout: 10_000 });
      await onContacts(page);
      await page.evaluate(() => history.pushState(null, '', '/contacts#x'));
      await openPanel(page);
      await page.goBack();
      await expectClosed(page);
    } finally {
      await ctx.close();
    }
  }, 60_000);

  it('the app navigating away closes it and clears inert', async () => {
    const { ctx, page } = await open();
    try {
      await onContacts(page);
      await openPanel(page);
      await page.evaluate(() => {
        history.pushState(null, '', '/activity');
        window.dispatchEvent(new Event('agentlink:navigate'));
      });
      await expectClosed(page);
    } finally {
      await ctx.close();
    }
  }, 60_000);
});

describe('W5-SAFETY-STEP: the Home link opens the contact at its safety code', () => {
  it('?check=<ref> opens that contact panel with no click, and leaves the address clean', async () => {
    const { ctx, page } = await open();
    try {
      await page.goto(`${origin}/contacts?check=${ANA}`);
      await page.getByRole('dialog').first().waitFor({ timeout: 10_000 });
      expect(
        await page
          .getByRole('dialog')
          .getByText(/safety code/i)
          .count(),
      ).toBeGreaterThan(0);
      expect(new URL(page.url()).search).toBe('');
      await page.keyboard.press('Escape');
      await expectClosed(page);
    } finally {
      await ctx.close();
    }
  }, 60_000);
});
