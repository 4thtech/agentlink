// Regenerates the screenshots of the local app for the user guide (docs model §5).
//
//   pnpm docs:screenshots   (builds the app first; needs `pnpm exec playwright install chromium` once)
//   node tools/docs-screenshots/capture.mjs --qa <folder>
//                           the owner's visual QA set (UI-REFRESH plan §10), not published: every page
//                           at 1280 and 360, dark, light and increased contrast, with Under the hood
//                           off and on. Write it outside the repo.
//
// How: the built app (apps/local-ui/dist) is served from a throwaway localhost server, and every
// /api/** call is answered in the browser by Playwright (page.route) from fixtures.mjs. There is no
// agent, no key store, no owner code and no network: only made-up data can appear on a page.
// Output: docs-site/guide/.gitbook/assets/<name>.png (1280 x 800, scale 2, UTC, en-US; dark unless a
// shot says light, or phone width, which is 360 x 800).
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/* global document */
import { chromium } from 'playwright';
import { CONTACTS_DUPLICATE, ROUTES } from './fixtures.mjs';

const DIST = fileURLToPath(new URL('../../apps/local-ui/dist/', import.meta.url));
const OUT = fileURLToPath(new URL('../../docs-site/guide/.gitbook/assets/', import.meta.url));
const QA_DIR = process.argv.includes('--qa') ? process.argv[process.argv.indexOf('--qa') + 1] : undefined;
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
  {
    name: 'local-contacts--duplicate',
    path: '/settings/contacts',
    ready: heading('Contacts'),
    routes: { '/api/ui/contacts': CONTACTS_DUPLICATE },
    steps: async (page) => {
      await page.getByRole('button', { name: /Ana/ }).first().click();
      await page.getByText('Looks like a second connection').waitFor();
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
  // The refreshed local app (UI-REFRESH): Home, Approvals, Appearance, About, Under the hood.
  { name: 'local-home--overview', path: '/settings/home', ready: heading('Home') },
  {
    name: 'local-home--overview-light',
    path: '/settings/home',
    ready: heading('Home'),
    theme: 'light',
  },
  {
    name: 'local-home--overview-phone',
    path: '/settings/home',
    ready: heading('Home'),
    width: 360,
  },
  {
    name: 'local-home--under-the-hood',
    path: '/settings/home',
    ready: heading('Home'),
    hood: true,
  },
  { name: 'local-approvals--waiting', path: '/', ready: heading('Approvals') },
  { name: 'local-appearance--choices', path: '/settings/appearance', ready: heading('Appearance') },
  {
    name: 'local-appearance--choices-light',
    path: '/settings/appearance',
    ready: heading('Appearance'),
    theme: 'light',
  },
  { name: 'local-about--page', path: '/settings/about', ready: heading('About') },
];

/** The QA set: every page, both widths, three looks, Under the hood off and on (plan §10). */
const QA_PAGES = [
  ['home', '/settings/home', 'Home'],
  ['approvals', '/', 'Approvals'],
  ['activity', '/settings/activity', 'Activity'],
  ['messages', '/settings/messages', 'Messages'],
  ['contacts', '/settings/contacts', 'Contacts'],
  ['files', '/settings/files', 'Files'],
  ['proofs', '/settings/proofs', 'Proofs & credits'],
  ['rules', '/settings/rules', 'Rules'],
  ['appearance', '/settings/appearance', 'Appearance'],
  ['about', '/settings/about', 'About'],
];
const QA_SHOTS = QA_PAGES.flatMap(([page, path, title]) =>
  [1280, 360].flatMap((width) =>
    ['dark', 'light', 'contrast'].flatMap((look) =>
      [false, true].map((hood) => ({
        name: `qa-${page}--${width}-${look}-hood-${hood ? 'on' : 'off'}`,
        path,
        ready: heading(title),
        width,
        hood,
        theme: look === 'light' ? 'light' : 'dark',
        contrast: look === 'contrast' ? 'more' : 'no-preference',
      })),
    ),
  ),
);

function answer(route, overrides = {}) {
  const url = new URL(route.request().url());
  const entry = overrides[url.pathname] ?? ROUTES[url.pathname];
  const body = typeof entry === 'function' ? entry(url) : entry;
  return route.fulfill({
    status: body === undefined ? 404 : 200,
    contentType: 'application/json',
    body: JSON.stringify(body ?? { error: 'not_found' }),
  });
}

const OUTDIR = QA_DIR ?? OUT;
mkdirSync(OUTDIR, { recursive: true });
const browser = await chromium.launch();
let failed = false;
try {
  for (const shot of QA_DIR ? QA_SHOTS : SHOTS) {
    const ctx = await browser.newContext({
      viewport: { width: shot.width ?? 1280, height: 800 },
      deviceScaleFactor: 2,
      colorScheme: shot.theme ?? 'dark',
      ...(shot.contrast ? { contrast: shot.contrast } : {}),
      locale: 'en-US',
      timezoneId: 'UTC',
      reducedMotion: 'reduce',
    });
    const page = await ctx.newPage();
    // The same words on every machine: the sheet names the computer's check ("Touch ID").
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'userAgentData', { get: () => ({ platform: 'macOS' }) });
    });
    if (shot.hood) {
      await page.addInitScript(() => {
        localStorage.setItem('agentlink.prefs', JSON.stringify({ hood: true }));
      });
    }
    await page.route('**/api/**', (route) => answer(route, shot.routes));
    await page.goto(origin + shot.path);
    await shot.ready(page);
    await page
      .getByText('Checking…')
      .waitFor({ state: 'detached', timeout: 6000 })
      .catch(() => {});
    if (shot.steps) await shot.steps(page);
    await page.evaluate(() => document.fonts.ready);
    await page.mouse.move(0, 0);
    const file = join(OUTDIR, `${shot.name}.png`);
    await page.screenshot({ path: file, animations: 'disabled' });
    const size = statSync(file).size;
    const flag = !QA_DIR && size > MAX_BYTES ? '  TOO BIG (docs model §5: 400 KB)' : '';
    if (flag) failed = true;
    console.log(`${shot.name}.png  ${Math.round(size / 1024)} KB${flag}`);
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}
if (failed) process.exitCode = 1;
