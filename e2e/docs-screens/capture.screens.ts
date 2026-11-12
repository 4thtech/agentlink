// DOCS-OVERHAUL: the screenshot generator of the public docs (`pnpm docs:screens`; docs model §5).
//
// It renders the real local app on the journey harness (e2e/test/journey/world.ts), never on a real
// computer's state:
//   - two "computers", each a fresh temp home folder (never the real HOME), with the keychain stand-in
//     file (e2e/src/file-keychain.mjs), never the OS keychain;
//   - one in-memory relay and one fake encrypted drop shared by both, so the invite, the accept and a
//     message really travel between Tali's and Natasa's app hosts; no network;
//   - Chromium's virtual authenticator as Touch ID (CDP WebAuthn with PRF), so the server runs its real
//     owner checks; nothing fakes a signature, and no guard is switched off. `agentlink ui` runs as an
//     owner's own terminal (a TTY, no AI app marker), as in the journey tests.
// The friend's invite page is the built apps/invite site with a made-up invite (e2e invite fixtures).
//
// Output: docs-site/assets/screens/<name>.webp, light theme, 1280 x 800 CSS pixels at device scale 2,
// encoded as WebP by the same Chromium (no extra dependency). Names and contents are fixed (Tali,
// Natasa, the same messages); keys, links and the Contact check digits are new on every run, so the
// pixels are not byte-identical between runs. Nothing is printed; a failed step names itself.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { build } from 'vite';
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  builtAppFiles,
  fakeClaudeCode,
  launchBrowser,
  startAiAppMcp,
  until,
} from '../test/app-world.js';
import { futureLink } from '../test/invite/fixtures.js';
import { CONNECT_WITH } from '../test/journey/helpers-wizard.js';
import {
  ACCEPT_WITH,
  CONFIRM_PASSKEY,
  goTo,
  inboxHas,
  journeyWorld,
  navTo,
  pairedWith,
  startUiRun,
} from '../test/journey/world.js';

const OUT = fileURLToPath(new URL('../../docs-site/assets/screens/', import.meta.url));
const INVITE_ROOT = fileURLToPath(new URL('../../apps/invite', import.meta.url));
const INVITE_OUT = fileURLToPath(new URL('../../apps/invite/dist/site/', import.meta.url));
const VIEWPORT = { width: 1280, height: 800 };
const SCALE = 2;
const QUALITY = 0.82;
/** Only these shots are written when set (comma-separated names), for a quick refresh of one page. */
const ONLY = process.env['DOCS_SCREENS_ONLY']?.split(',').filter(Boolean);

const closers: (() => Promise<unknown>)[] = [];
let browser: Browser | undefined;
let encoder: Page | undefined;

/** A light-theme page at 1280 x 800, scale 2, with the virtual authenticator (Touch ID). */
async function screenPage(
  b: Browser,
  viewport = VIEWPORT,
): Promise<{ page: Page; context: BrowserContext }> {
  const context = await b.newContext({
    viewport,
    deviceScaleFactor: SCALE,
    colorScheme: 'light',
    reducedMotion: 'reduce',
    locale: 'en-US',
    timezoneId: 'UTC',
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  closers.push(() => context.close());
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    },
  });
  return { page, context };
}

/** PNG from Playwright → WebP from Chromium's own encoder (a blank page with a canvas). */
async function toWebp(png: Buffer): Promise<Buffer> {
  if (encoder === undefined) throw new Error('no encoder page');
  const dataUrl = await encoder.evaluate(
    async ({ b64, quality }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d')?.drawImage(img, 0, 0);
      return canvas.toDataURL('image/webp', quality);
    },
    { b64: png.toString('base64'), quality: QUALITY },
  );
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

/** Settles the page (fonts, no focus ring, no caret), then writes one shot. */
async function shot(
  page: Page,
  name: string,
  options: { fullPage?: boolean; above?: Locator } = {},
): Promise<void> {
  if (ONLY !== undefined && !ONLY.includes(name)) return;
  await page.evaluate(() => document.fonts.ready);
  // Passing notices ("Your new contact accepted your invite") belong to a moment, not to the page.
  for (const x of await page.locator('.al-toast-x').all()) await x.click().catch(() => undefined);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(400);
  // `above`: crop just above this element (a button that belongs to the page behind the moment).
  const box = options.above === undefined ? null : await options.above.boundingBox();
  const png = await page.screenshot({
    fullPage: options.fullPage ?? false,
    ...(box === null
      ? {}
      : { clip: { x: 0, y: 0, width: VIEWPORT.width, height: Math.floor(box.y - 16) } }),
    animations: 'disabled',
    caret: 'hide',
  });
  const webp = await toWebp(png);
  writeFileSync(`${OUT}${name}.webp`, webp);
}

/** One step of the story; a failed step names itself, and the story stops (later steps need it). */
async function step(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    const first = error instanceof Error ? error.message.split('\n')[0] : String(error);
    throw new Error(`docs screens, step "${name}": ${first}`, { cause: error });
  }
}

/** Serves the built invite site: `/` and `/i` are pages. */
function serveInvite(): Promise<Server> {
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
  };
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split(/[?#]/)[0] ?? '/';
    const file = path === '/' ? 'index.html' : path === '/i' ? 'i/index.html' : path.slice(1);
    try {
      if (file.includes('..') || file.startsWith('_')) throw new Error('not found');
      const body = readFileSync(`${INVITE_OUT}${file}`);
      res.writeHead(200, {
        'content-type': types[file.slice(file.lastIndexOf('.'))] ?? 'text/plain',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

beforeAll(async () => {
  mkdirSync(OUT, { recursive: true });
  const launched = await launchBrowser();
  if (launched.browser === undefined) throw launched.error;
  browser = launched.browser;
  encoder = await (await browser.newContext()).newPage();
});

afterAll(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
  await browser?.close();
});

describe('docs screens', () => {
  it('the invite page a friend opens', async () => {
    if (browser === undefined) throw new Error('no browser');
    await build({
      root: INVITE_ROOT,
      configFile: `${INVITE_ROOT}/vite.config.ts`,
      logLevel: 'silent',
    });
    const site = await serveInvite();
    closers.push(() => new Promise((r) => site.close(r)));
    const { page } = await screenPage(browser);
    const link = await futureLink({ name: 'Tali' });
    const fragment = link.slice(link.indexOf('#') + 1);
    await page.goto(`http://127.0.0.1:${(site.address() as AddressInfo).port}/i#${fragment}`);
    await page.waitForFunction(() => document.getElementById('state')?.dataset['ready'] === 'true');
    await shot(page, 'invite-page', { fullPage: true });
  });

  it('Tali sets up, invites Natasa; Natasa accepts; they talk', async () => {
    if (browser === undefined) throw new Error('no browser');
    const files = builtAppFiles();
    if (files === undefined) throw new Error('build the local app first (pnpm docs:screens does)');
    const world = journeyWorld();
    const pcA = await world.computer();
    const pcB = await world.computer();
    // Tali has Claude Code on this computer, so Get started finds it and connects it.
    await fakeClaudeCode(pcA.home);
    const a = (await screenPage(browser)).page;
    const b = (await screenPage(browser)).page;

    // ---- Tali: Get started (Simple view, layer 1) ----
    await step('get started', async () => {
      const ui = await startUiRun(pcA, files, closers);
      await a.goto(ui.link);
      await a.getByRole('heading', { name: 'Which AI app do you use?' }).waitFor();
      await shot(a, 'get-started-pick-app');
      await a.getByRole('button', { name: 'Continue with Claude Code' }).click();
      await a.getByRole('heading', { name: "Confirm it's you" }).waitFor();
      await a.getByLabel('Name people see').fill('Tali');
      await shot(a, 'get-started-confirm');
      await a.getByRole('button', { name: CONNECT_WITH }).click();
      const saved = a.getByRole('button', { name: 'I saved it' });
      await saved.waitFor();
      await shot(a, 'master-code');
      await saved.click();
      await a.getByRole('heading', { name: 'Connected to Claude Code' }).waitFor();
      await shot(a, 'get-started-connected');
      await a.getByRole('button', { name: 'Invite someone' }).click();
      await a.locator('.inv-link[data-state="ready"]').waitFor();
      await a.getByRole('button', { name: 'Done, go to Home' }).click();
      await a.waitForURL((url) => url.pathname === '/');
      await a.getByRole('heading', { name: 'People' }).first().waitFor();
      await shot(a, 'home-first');
    });

    // ---- Natasa: her own first run (no AI app on her computer yet) ----
    await step('natasa first run', async () => {
      const ui = await startUiRun(pcB, files, closers);
      await b.goto(ui.link);
      await b.getByRole('heading', { name: 'Which AI app do you use?' }).waitFor();
      await b
        .getByRole('button', { name: /^Continue with / })
        .first()
        .click();
      await b.getByRole('heading', { name: "Confirm it's you" }).waitFor();
      await b.getByLabel('Name people see').fill('Natasa');
      await b.getByRole('button', { name: CONNECT_WITH }).click();
      await b.getByRole('button', { name: 'I saved it' }).click();
      await b.getByRole('button', { name: 'Go to Home' }).click();
      await b.waitForURL((url) => url.pathname === '/');
    });
    const mcpA = await startAiAppMcp(pcA, undefined);
    closers.push(() => mcpA.close());
    const mcpB = await startAiAppMcp(pcB, undefined);
    closers.push(() => mcpB.close());

    // ---- Tali invites Natasa ----
    let link = '';
    await step('invite', async () => {
      await goTo(a, 'Invite someone');
      await a.getByRole('heading', { name: 'Invite someone', level: 1 }).waitFor();
      await a.getByLabel('Who is it for?').fill('Natasa');
      await a.getByLabel('Who is it for?').blur();
      await a.getByText('Invite link for Natasa').waitFor();
      const shown = a.locator('.inv-link[data-state="ready"]');
      await shown.waitFor();
      const value = (await shown.innerText()).trim();
      link = value.startsWith('https://') ? value : `https://${value}`;
      await a.getByRole('button', { name: 'Copy', exact: true }).click();
      await a.getByRole('button', { name: 'Copied', exact: true }).waitFor();
      await shot(a, 'invite-someone');
      await a.getByRole('button', { name: 'Done', exact: true }).click();
    });

    // ---- Natasa accepts in her app ----
    await step('accept', async () => {
      await goTo(b, 'Invite someone');
      await b.getByRole('heading', { name: 'Invite someone', level: 1 }).waitFor();
      await b.getByRole('button', { name: 'Have an invite link? Paste it' }).click();
      await b.getByLabel('Paste the invite link').fill(link);
      await b.getByRole('button', { name: 'Continue', exact: true }).click();
      await b
        .getByText(/invites you to connect your AIs$/)
        .first()
        .waitFor();
      await shot(b, 'accept-invite', {
        above: b.getByRole('button', { name: 'Done', exact: true }).last(),
      });
      await b.getByRole('button', { name: ACCEPT_WITH }).click();
      await until('Natasa is paired with Tali', () => pairedWith(mcpB, 'Tali'), 60_000);
      await until('Tali is paired with Natasa', () => pairedWith(mcpA, 'Natasa'), 60_000);
      await b
        .getByRole('heading', { name: 'You are connected', exact: true })
        .waitFor({ timeout: 30_000 });
      await shot(b, 'connected-name-contact');
      await b.getByLabel('Name this contact').fill('Tali');
      await b.getByRole('button', { name: 'Save name', exact: true }).click();
      const confirm = b.getByRole('button', { name: CONFIRM_PASSKEY });
      await confirm.waitFor();
      await shot(b, 'confirm-presence');
      await confirm.click();
      await b
        .getByRole('heading', { name: /^You and “?Tali”? are connected$/ })
        .waitFor({ timeout: 30_000 });
      const check = b.getByRole('button', {
        name: /^Optional: make sure it's really .*Contact check/,
      });
      if (await check.isVisible()) await check.click();
      await b
        .getByText(/\d{4}\D{1,3}\d{4}\D{1,3}\d{4}/)
        .first()
        .waitFor();
      await shot(b, 'connected');
    });

    // ---- Tali's side: connected, then a message from Natasa's AI ----
    await step('tali connected', async () => {
      await a
        .getByRole('heading', { name: /connected$/ })
        .first()
        .waitFor({ timeout: 30_000 });
      await shot(a, 'connected-inviter');
      const name = a.getByLabel('Name this contact');
      if (await name.isVisible()) {
        await name.fill('Natasa');
        await a.getByRole('button', { name: 'Save name', exact: true }).click();
        await a.getByRole('button', { name: CONFIRM_PASSKEY }).click();
        await a.getByRole('heading', { name: /^You and “?Natasa”? are connected$/ }).waitFor();
      }
    });
    await step('message', async () => {
      await mcpB.call('agentlink_send', {
        to: 'Tali',
        text: 'Hi Tali, the workshop slides are ready. Can your AI check the agenda?',
      });
      await until('Tali has the message', () => inboxHas(mcpA, 'workshop slides'), 60_000);
      await mcpA.call('agentlink_send', {
        to: 'Natasa',
        text: 'Thanks Natasa. The agenda looks good; one change to the start time.',
      });
      await navTo(a, 'Home');
      await a.getByText('Natasa').first().waitFor();
      await a.waitForTimeout(1500);
      await shot(a, 'home');
    });

    // ---- People, contact actions ----
    await step('people', async () => {
      await goTo(a, 'People');
      await a.getByText('Natasa').first().waitFor();
      await shot(a, 'people');
      await a.getByRole('list', { name: 'Your people' }).getByText('Natasa').first().click();
      await a.getByRole('region', { name: 'Natasa' }).first().waitFor();
      await a.waitForTimeout(600);
      await shot(a, 'contact');
    });

    // ---- IDs: the simple card, rename, remove (not confirmed) ----
    await step('ids', async () => {
      await a.keyboard.press('Escape');
      await goTo(a, 'IDs');
      await a.getByRole('heading', { name: 'IDs', level: 1 }).first().waitFor();
      await shot(a, 'ids');
      const card = a.getByRole('main').getByRole('region', { name: 'Tali', exact: true }).first();
      await card.getByRole('button', { name: 'Rename', exact: true }).click();
      await a.getByLabel('Name', { exact: true }).fill('Tali R');
      await a.waitForTimeout(400);
      await shot(a, 'id-rename');
      await a.keyboard.press('Escape');
      await a
        .getByRole('button', { name: 'Cancel', exact: true })
        .first()
        .click()
        .catch(() => undefined);
      await card.getByRole('button', { name: 'Remove', exact: true }).click();
      await a.getByRole('heading', { name: /^Remove .*Tali.*\?$/ }).waitFor();
      await shot(a, 'id-remove');
      await a
        .getByRole('button', { name: 'Cancel', exact: true })
        .first()
        .click()
        .catch(() => undefined);
      await a.keyboard.press('Escape');
    });

    // ---- Under the hood (layer 3) ----
    await step('under the hood', async () => {
      const sw = a.getByRole('switch', { name: /Under the hood/ }).first();
      if ((await sw.getAttribute('aria-checked')) !== 'true') await sw.click();
      await a.waitForTimeout(800);
      await shot(a, 'ids-under-the-hood');
      await navTo(a, 'Home');
      await a.waitForTimeout(800);
      await shot(a, 'home-under-the-hood');
      if ((await sw.getAttribute('aria-checked')) === 'true') await sw.click();
    });

    // ---- Settings: AI apps, recovery kit ----
    await step('settings', async () => {
      await goTo(a, 'Settings');
      await a.getByRole('heading', { name: 'Settings', level: 1 }).first().waitFor();
      await shot(a, 'settings');
      await a.goto(new URL('/settings/apps', a.url()).toString());
      await a.getByRole('heading', { level: 1 }).first().waitFor();
      await a.waitForTimeout(800);
      await shot(a, 'ai-apps');
      await a.goto(new URL('/settings/backup', a.url()).toString());
      await a.getByRole('heading', { level: 1 }).first().waitFor();
      await a.waitForTimeout(800);
      await shot(a, 'recovery-kit');
      // WP-11: save the kit (Touch ID), then the recovery code shown once. The kit is written into
      // this computer's temp home, never a real Downloads folder.
      await a.getByRole('button', { name: 'Save recovery kit' }).first().click();
      const confirm = a.getByRole('button', { name: CONFIRM_PASSKEY });
      const code = a.getByRole('region', { name: 'Your recovery code' });
      await confirm.or(code).first().waitFor({ timeout: 30_000 });
      if (await confirm.isVisible()) await confirm.click();
      await code.waitFor({ timeout: 30_000 });
      await shot(a, 'recovery-kit-saved');
    });
  });
});
