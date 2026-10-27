// Regenerates the dark-theme screenshots of the local app for the user guide (docs model §5).
//
//   pnpm docs:screenshots   (builds the app first; needs `pnpm exec playwright install chromium` once)
//
// How: the built app (apps/local-ui/dist) is served from a throwaway localhost server, and every
// /api/** call is answered in the browser by Playwright (page.route) from fixtures.mjs. There is no
// agent, no key store, no owner code and no network: only made-up data can appear on a page.
// Output: docs-site/guide/.gitbook/assets/<name>.png (1280 x 800, scale 2, dark, UTC, en-US).
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/* global document */
import { chromium } from 'playwright';
import { ROUTES } from './fixtures.mjs';

const DIST = fileURLToPath(new URL('../../apps/local-ui/dist/', import.meta.url));
const OUT = fileURLToPath(new URL('../../docs-site/guide/.gitbook/assets/', import.meta.url));
const MAX_BYTES = 400 * 1024;
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
};

const server = createServer((req, res) => {
  const p = (req.url ?? '/').split('?')[0];
  const file = p.startsWith('/assets/') && !p.includes('..') ? p.slice(1) : 'index.html'; // SPA fallback
  try {
    const body = readFileSync(join(DIST, file));
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'text/html' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

/** One page to capture: where to go, what proves it is ready, optional steps before the shot. */
const heading = (name) => (page) => page.getByRole('heading', { name, level: 1 }).waitFor();
const openEnter = async (page) => {
  await page.getByRole('tab', { name: 'Send folders' }).click();
  await page.getByRole('button', { name: 'Allow a folder' }).click();
  await page.getByRole('textbox', { name: 'Folder' }).fill('~/Documents/Shared');
};
const SHOTS = [
  { name: 'local-activity--list', path: '/settings/activity', ready: heading('Activity') },
  { name: 'local-contacts--list', path: '/settings/contacts', ready: heading('Contacts') },
  {
    name: 'local-files--list',
    path: '/settings/files',
    ready: heading('Files'),
    steps: async (page) => {
      await page.getByRole('tab', { name: 'Send folders' }).click();
      await page.getByText('Folders your AI can send files from').first().waitFor();
    },
  },
  {
    name: 'local-files--received',
    path: '/settings/files',
    ready: heading('Files'),
    steps: async (page) => {
      await page.getByText('draft-notes.txt').first().waitFor();
    },
  },
  {
    name: 'local-files--sent',
    path: '/settings/files',
    ready: heading('Files'),
    steps: async (page) => {
      await page.getByRole('tab', { name: 'Sent' }).click();
      await page.getByText('project-plan.pdf').first().waitFor();
    },
  },
  { name: 'local-messages--list', path: '/settings/messages', ready: heading('Messages') },
  {
    name: 'local-messages--inbox',
    path: '/settings/messages',
    ready: heading('Messages'),
    steps: async (page) => {
      await page.getByRole('button', { name: /Marko/ }).first().click();
      await page.getByText('To reply, ask your AI.').waitFor();
    },
  },
  {
    name: 'local-rules--confirm-spending',
    path: '/settings/rules',
    ready: heading('Rules'),
    steps: async (page) => {
      await page.getByRole('textbox', { name: 'Ask me over' }).fill('1');
      await page.getByRole('button', { name: 'Review and save' }).click();
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.getByRole('button', { name: 'Confirm with Touch ID' }).waitFor();
    },
  },
  {
    name: 'local-files--enter',
    path: '/settings/files',
    ready: heading('Files'),
    steps: openEnter,
  },
  {
    name: 'local-files--confirm-add',
    path: '/settings/files',
    ready: heading('Files'),
    steps: async (page) => {
      await openEnter(page);
      await page.getByRole('button', { name: 'Check folder' }).click();
      await page.getByText('Before you confirm, tick each one:').waitFor();
      await page.getByRole('checkbox').first().check();
    },
  },
  { name: 'local-proofs--list', path: '/settings/proofs', ready: heading('Proofs & credits') },
  { name: 'local-rules--overview', path: '/settings/rules', ready: heading('Rules') },
];

function answer(route) {
  const url = new URL(route.request().url());
  const entry = ROUTES[url.pathname];
  const body = typeof entry === 'function' ? entry(url) : entry;
  return route.fulfill({
    status: body === undefined ? 404 : 200,
    contentType: 'application/json',
    body: JSON.stringify(body ?? { error: 'not_found' }),
  });
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
let failed = false;
try {
  for (const shot of SHOTS) {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
      colorScheme: 'dark',
      locale: 'en-US',
      timezoneId: 'UTC',
      reducedMotion: 'reduce',
    });
    const page = await ctx.newPage();
    // The same words on every machine: the sheet names the computer's check ("Touch ID").
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'userAgentData', { get: () => ({ platform: 'macOS' }) });
    });
    await page.route('**/api/**', answer);
    await page.goto(origin + shot.path);
    await shot.ready(page);
    await page
      .getByText('Checking…')
      .waitFor({ state: 'detached', timeout: 6000 })
      .catch(() => {});
    if (shot.steps) await shot.steps(page);
    await page.evaluate(() => document.fonts.ready);
    await page.mouse.move(0, 0);
    const file = join(OUT, `${shot.name}.png`);
    await page.screenshot({ path: file, animations: 'disabled' });
    const size = statSync(file).size;
    const flag = size > MAX_BYTES ? '  TOO BIG (docs model §5: 400 KB)' : '';
    if (flag) failed = true;
    console.log(`${shot.name}.png  ${Math.round(size / 1024)} KB${flag}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
if (failed) process.exitCode = 1;
