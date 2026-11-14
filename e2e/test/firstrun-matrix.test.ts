// FIRSTRUN-MATRIX (S1; release 0.5.5): the first run on a FRESH profile can't silently break again.
// Owner acceptance: fresh profile -> create the master code in the app or browser (no WebAuthn on
// the code path) -> optional Touch ID / Windows Hello / platform passkey -> create the ID -> connect
// the AI app -> Home. No terminal, no browser hand-off, no USB key.
//
// The real built local app and the real approval server on a temp HOME (app-world.ts; the OS
// keychain is a file stand-in), in real Chromium with the CDP virtual authenticator set to each
// situation of the matrix. A pass-through counter on `navigator.credentials` proves where WebAuthn
// is (and is not) called. Words come from the apps' own strings files (never invented here).
//
// Cases (FIRSTRUN-MATRIX 1a-1e):
//   a. no platform authenticator at all -> master code, no navigator.credentials call, reaches Home
//   b. platform authenticator without PRF -> no dead end, the master code is offered and finishes
//   c. platform authenticator with PRF -> the passkey path works (one create), master code still shown
//   d. a cancelled gesture -> "Try again, or use your master code instead" and Back works
//   e. "Skip to Home" is not shown before an owner exists
// Firefox and WebKit: ci.yml installs them (browsers: chromium firefox webkit) for other jobs, but
// the CDP virtual authenticator is Chromium-only, so this file is Chromium; the no-WebAuthn code
// path is also run with `PublicKeyCredential` removed from the page (what Firefox-without-passkeys
// and the desktop window look like to the page).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, BrowserContext, Page } from 'playwright';
// eslint-disable-next-line boundaries/no-bypass -- the shipped words and the smoke driver are the thing under test
import {
  FIRST_RUN,
  SETUP_MESSAGES,
  NAME,
} from '../../apps/local-ui/src/pages/first-run/strings.js';
// eslint-disable-next-line boundaries/no-bypass -- the shipped words and the smoke driver are the thing under test
import { WIZARD } from '../../apps/local-ui/src/pages/start/strings.js';
// eslint-disable-next-line boundaries/no-bypass -- the shipped words and the smoke driver are the thing under test
import { createOwnerWithCode } from '../../apps/desktop/test/smoke/first-run-code.mjs';
import { chapter, journeyWorld, startUi } from './journey/world.js';

const ch = chapter();
beforeAll(() => ch.start(), 120_000);
afterAll(() => ch.stop());

const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const WIN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

type Situation = 'none' | 'noprf' | 'prf' | 'cancel';

interface Probe {
  readonly page: Page;
  readonly context: BrowserContext;
  /** navigator.credentials.create/get calls with a publicKey option, so far. */
  calls(): { create: number; get: number };
}

/** Pass-through counter; for `cancel` the create/get reject like a dismissed system dialog. */
const counter = (cancel: boolean, removeApi: boolean): string => `(() => {
  ${removeApi ? 'try { delete window.PublicKeyCredential; } catch {}' : ''}
  const c = navigator.credentials;
  if (!c || window.__fr) return;
  window.__fr = true;
  for (const name of ['create', 'get']) {
    const original = c[name].bind(c);
    c[name] = (options) => {
      if (options && options.publicKey) window.__frCall(name);
      if (${String(cancel)} && options && options.publicKey) {
        return Promise.reject(new DOMException('The operation was not allowed.', 'NotAllowedError'));
      }
      return original(options);
    };
  }
})();`;

async function probePage(
  browser: Browser,
  situation: Situation,
  options: { ua?: string; removeApi?: boolean } = {},
): Promise<Probe> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: options.ua ?? MAC_UA,
    locale: 'en-US',
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  if (situation !== 'none') {
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
        hasPrf: situation !== 'noprf',
        automaticPresenceSimulation: true,
      },
    });
  }
  const seen = { create: 0, get: 0 };
  // Counted outside the page, so a reload or a new document never loses a call.
  await context.exposeBinding('__frCall', (_source, name: unknown) => {
    if (name === 'create') seen.create += 1;
    else if (name === 'get') seen.get += 1;
  });
  await context.addInitScript(counter(situation === 'cancel', options.removeApi === true));
  return {
    page,
    context,
    calls: () => ({ ...seen }),
  };
}

/** A fresh computer with `agentlink ui` running: the page opened on its one-shot link. */
async function fresh(
  ctx: { skip: () => void },
  situation: Situation,
  options: { ua?: string; removeApi?: boolean } = {},
): Promise<{ probe: Probe } | undefined> {
  const ready = ch.need(ctx);
  if (ready === undefined) return undefined;
  const pc = await journeyWorld().computer();
  const probe = await probePage(ready.browser, situation, options);
  await probe.page.goto(await startUi(pc, ready.files, ch.closers));
  return { probe };
}

/** Step 1 to step 2 of Get started; names the ID. */
async function toConfirm(page: Page, label: string): Promise<void> {
  await page.getByRole('heading', { name: 'Which AI app do you use?' }).waitFor();
  await page
    .getByRole('button', { name: /^Continue with / })
    .first()
    .click();
  await page.getByRole('heading', { name: "Confirm it's you" }).waitFor();
  await page.getByLabel(NAME.label).fill(label);
}

/** The master code screen to Home. */
async function saveCodeAndGoHome(page: Page): Promise<void> {
  await page.getByRole('heading', { name: FIRST_RUN.backupTitle }).waitFor({ timeout: 60_000 });
  await page.getByRole('button', { name: FIRST_RUN.savedIt }).click();
  await page.getByRole('heading', { name: /is ready|Connected to/ }).waitFor();
  await page.getByRole('button', { name: 'Go to Home' }).click();
  await page.waitForURL((url) => url.pathname === '/');
  await page.getByRole('navigation', { name: 'Sections' }).first().waitFor();
}

describe('FIRSTRUN-MATRIX: first run on a fresh profile (real Chromium, temp HOME)', () => {
  it('(a) no platform authenticator: the master code, no navigator.credentials call, Home', async (ctx) => {
    const got = await fresh(ctx, 'none');
    if (got === undefined) return;
    const { page } = got.probe;
    await toConfirm(page, 'Ana');
    // The master code is the primary action; no passkey button is offered at all.
    const go = page.getByRole('button', { name: FIRST_RUN.backupOnly });
    await go.waitFor();
    expect(await page.getByRole('button', { name: /^Connect with / }).count()).toBe(0);
    await go.click();
    await saveCodeAndGoHome(page);
    expect(got.probe.calls()).toEqual({ create: 0, get: 0 });
  }, 120_000);

  it('(a2) the page has no WebAuthn at all (Firefox without passkeys, the app window): same', async (ctx) => {
    const got = await fresh(ctx, 'none', { removeApi: true });
    if (got === undefined) return;
    const { page } = got.probe;
    expect(await page.evaluate(() => typeof window.PublicKeyCredential)).toBe('undefined');
    await toConfirm(page, 'Ana');
    await page.getByRole('button', { name: FIRST_RUN.backupOnly }).click();
    await saveCodeAndGoHome(page);
    expect(got.probe.calls()).toEqual({ create: 0, get: 0 });
  }, 120_000);

  it('(b) a platform authenticator without PRF: no dead end, the master code finishes setup', async (ctx) => {
    const got = await fresh(ctx, 'noprf');
    if (got === undefined) return;
    const { page } = got.probe;
    await toConfirm(page, 'Ana');
    // Whichever way the browser's report goes (code first, or a passkey try that has no PRF), the
    // person can always finish with the master code on this same screen.
    const code = page.getByRole('button', { name: FIRST_RUN.backupOnly });
    const instead = page.getByRole('button', { name: NAME.backupInstead });
    await code.or(instead).first().click();
    await saveCodeAndGoHome(page);
  }, 120_000);

  it('(c) a platform authenticator with PRF: the passkey path works (one create)', async (ctx) => {
    const got = await fresh(ctx, 'prf');
    if (got === undefined) return;
    const { page } = got.probe;
    await toConfirm(page, 'Ana');
    await page
      .getByRole('button', { name: /^Connect with (Touch ID|Windows Hello|your passkey)$/ })
      .click();
    await saveCodeAndGoHome(page);
    expect(got.probe.calls().create).toBe(1);
  }, 120_000);

  it('(c2) Windows with PRF: the master code comes first, Windows Hello is the alternative', async (ctx) => {
    const got = await fresh(ctx, 'prf', { ua: WIN_UA });
    if (got === undefined) return;
    const { page } = got.probe;
    await toConfirm(page, 'Ana');
    // Never "Touch ID" on Windows; the code is primary and no passkey call is made for it.
    expect(await page.locator('body').innerText()).not.toContain('Touch ID');
    await page.getByRole('button', { name: FIRST_RUN.backupOnly }).click();
    await saveCodeAndGoHome(page);
    expect(got.probe.calls().create).toBe(0);
  }, 120_000);

  it('(d) a cancelled gesture: "Try again, or use your master code instead", Back works', async (ctx) => {
    const got = await fresh(ctx, 'cancel');
    if (got === undefined) return;
    const { page } = got.probe;
    await toConfirm(page, 'Ana');
    await page
      .getByRole('button', { name: /^Connect with (Touch ID|Windows Hello|your passkey)$/ })
      .click();
    await page.getByText(SETUP_MESSAGES.cancelled).waitFor();
    expect(SETUP_MESSAGES.cancelled).toBe(
      'Not protected yet. Try again, or use your master code instead.',
    );
    await page.getByRole('button', { name: FIRST_RUN.tryAgain }).waitFor();
    const instead = page.getByRole('button', { name: NAME.backupInstead });
    await instead.waitFor();
    // Back leaves the step cleanly (no stuck "working" state), and a second visit works.
    await page.getByRole('button', { name: 'Back' }).first().click();
    await page.getByRole('heading', { name: 'Which AI app do you use?' }).waitFor();
    await page
      .getByRole('button', { name: /^Continue with / })
      .first()
      .click();
    await page.getByRole('heading', { name: "Confirm it's you" }).waitFor();
    await page.getByLabel(NAME.label).fill('Ana');
    await page.getByRole('button', { name: NAME.backupInstead }).click();
    await saveCodeAndGoHome(page);
  }, 120_000);

  it('(e) "Skip to Home" is not shown before an owner exists', async (ctx) => {
    const got = await fresh(ctx, 'prf');
    if (got === undefined) return;
    const { page } = got.probe;
    await page.getByRole('heading', { name: 'Which AI app do you use?' }).waitFor();
    expect(await page.getByRole('link', { name: WIZARD.skip }).count()).toBe(0);
    await toConfirm(page, 'Ana');
    expect(await page.getByRole('link', { name: WIZARD.skip }).count()).toBe(0);
  }, 120_000);

  it('(f) the desktop smoke driver: owner created over HTTP with the master code, no browser', async (ctx) => {
    const ready = ch.need(ctx);
    if (ready === undefined) return;
    const pc = await journeyWorld().computer();
    const link = await startUi(pc, ready.files, ch.closers);
    const result = await createOwnerWithCode(link, 'Ana');
    expect(result).toEqual({ ok: true, passkey: false, ownerCodeShape: true });
    expect((await pc.directory.list()).map((e) => e.label)).toEqual(['Ana']);
  }, 120_000);
});
