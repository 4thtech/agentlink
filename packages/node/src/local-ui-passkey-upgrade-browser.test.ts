// M1-UX-FIRSTRUN-V2-c acceptance in a real browser (B-9; 08 §1 first run v2; 04 §2.5, §2.3.1; I-1,
// I-4, I-7): an owner set up before 0.3.0 in the terminal (`owner init`: an `owner` item and its
// owner code, no passkey) opens the local app. Approvals (`/`) and every app page show the
// "Switch to …" next step; the first-run page asks for the backup code once, then one passkey
// gesture registers the passkey through the existing `/api/owner/passkey` owner operation.
//
// - The owner identity is the same before and after: the `owner` item is byte for byte unchanged,
//   and the passkey item opens to the same owner key. Never a second owner.
// - A wrong code registers nothing and changes nothing.
// - The backup code keeps approving afterwards.
// - Canary: the code never reaches a URL, a server event, the console, or a later page.
// - The next step is gone once the passkey is registered.
//
// Needs the built app (`pnpm build`) and the Playwright Chromium; without them it is skipped locally
// (in CI a missing browser fails it). AGENTLINK_TEST_CHROMIUM names another Chromium executable. The
// keychain is a file in a temp folder, never the OS keychain.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { equalBytes, readPasskeyBlobHeader } from '@4thtech-io/crypto';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startApprovalServerWith,
  type ApprovalServer,
  type ApprovalServerEvent,
} from './approval-server.js';
import { approvalId, fakeSource, ownerWorld, type OwnerWorld } from './approval-ui.fixture.js';
import { KeychainOwnerKeyStore, OWNER_ACCOUNT } from './owner-keystore.js';
import { OWNER_PASSKEY_ACCOUNT } from './owner-passkey.js';

const DIST = fileURLToPath(new URL('../../../apps/local-ui/dist/', import.meta.url));

/** The built app as the CLI embeds it: index.html and assets/<name>. */
function appAssets(): Map<string, Uint8Array> | undefined {
  if (!existsSync(join(DIST, 'index.html'))) return undefined;
  const files = new Map<string, Uint8Array>([
    ['index.html', new Uint8Array(readFileSync(join(DIST, 'index.html')))],
  ]);
  for (const name of readdirSync(join(DIST, 'assets'))) {
    files.set(`assets/${name}`, new Uint8Array(readFileSync(join(DIST, 'assets', name))));
  }
  return files;
}

const AXE_SOURCE = readFileSync(fileURLToPath(import.meta.resolve('axe-core/axe.min.js')), 'utf8');

/**
 * CHORE-FLAKE-SB-CONTRAST: the status bar state (`.al-sb-state`) fades in (opacity, 200 ms) every time
 * the connection state changes. axe samples the computed colour, so a pass while the fade runs blends
 * text and background and can fail colour-contrast on a slow runner. Wait until every animation and
 * transition has finished, so axe always reads the settled colours; the rule stays on.
 */
async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(
    `(async () => {
      for (let i = 0; i < 5; i += 1) {
        const running = document
          .getAnimations()
          .filter((a) => a.playState !== 'finished' && a.effect.getComputedTiming().endTime !== Infinity);
        if (running.length === 0) return;
        await Promise.allSettled(running.map((a) => a.finished));
      }
    })()`,
  );
}

async function axeViolations(page: Page): Promise<string[]> {
  await settleAnimations(page);
  await page.evaluate(AXE_SOURCE);
  return page.evaluate(`(async () => {
    const result = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    });
    return result.violations.map((v) => v.id + ': ' + v.nodes.map((n) => n.target.join(' ')).join(', '));
  })()`);
}

let browser: Browser | undefined;
let launchError: unknown;
let world: OwnerWorld;
const closers: (() => Promise<unknown>)[] = [];

beforeAll(async () => {
  world = await ownerWorld('agentlink-m1-ux-firstrun-v2-c-');
  const executablePath = process.env['AGENTLINK_TEST_CHROMIUM'];
  try {
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath });
  } catch (error) {
    launchError = error;
  }
}, 120_000);

afterAll(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
  await browser?.close();
  world.cleanup();
});

async function pageWithAuthenticator(): Promise<Page> {
  if (browser === undefined) throw new Error('unreachable');
  const context = await browser.newContext();
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
  closers.push(() => context.close());
  return page;
}

const SWITCH = /^Switch to (Touch ID|Windows Hello|a passkey)$/;
const USE = /^Use (Touch ID|Windows Hello|a passkey)$/;

describe('a 0.2.0 owner switches to a passkey in the local app (M1-UX-FIRSTRUN-V2-c; Chromium)', () => {
  it('backup code once, one gesture, same owner; the code still approves; nothing leaks', async (ctx) => {
    const files = appAssets();
    if (browser === undefined && process.env['CI'] !== undefined) throw launchError;
    if (browser === undefined || files === undefined) {
      ctx.skip();
      return;
    }
    const before = await world.keychain.get(OWNER_ACCOUNT);
    if (before === null) throw new Error('no owner item');
    expect(await world.keychain.get(OWNER_PASSKEY_ACCOUNT)).toBeNull();

    const source = fakeSource(world);
    const events: ApprovalServerEvent[] = [];
    const opened: string[] = [];
    const server: ApprovalServer = await startApprovalServerWith(
      { source, onEvent: (event) => void events.push(event), localUi: { assets: { files } } },
      {
        keychain: world.keychain,
        openOwnerStore: (expected) => KeychainOwnerKeyStore.open(world.keychain, expected),
        opener: (url) => {
          opened.push(url);
          return Promise.resolve(true);
        },
        notifier: () => Promise.resolve(true),
      },
    );
    closers.push(() => server.close());
    await server.open();

    const page = await pageWithAuthenticator();
    const urls: string[] = [];
    const consoleLines: string[] = [];
    page.on('request', (r) => urls.push(r.url()));
    page.on('console', (m) => consoleLines.push(m.text()));

    // Approvals (`/`, the home page for now): the next step, a plain link to the first-run page.
    await page.goto(opened[0] ?? '');
    const next = page.getByRole('link', { name: SWITCH });
    await next.waitFor();
    expect(await next.getAttribute('href')).toBe('/first-run');
    // One path: the inline passkey set-up of the old page is not offered next to it.
    expect(await page.getByRole('button', { name: 'Set up a passkey' }).count()).toBe(0);

    // Another app page shows the same next step.
    await page.goto(`${server.origin}/settings/activity`);
    await page.getByRole('link', { name: SWITCH }).waitFor();

    await page.goto(`${server.origin}/first-run`);
    await page.getByRole('heading', { level: 1, name: SWITCH }).waitFor();
    expect(await axeViolations(page)).toEqual([]);
    const field = page.getByLabel('Backup code');

    // A wrong code registers nothing.
    await field.fill('WRNG WRNG WRNG WRNG WRNG WRNG');
    await page.getByRole('button', { name: USE }).click();
    await page.getByText("That backup code didn't work.").waitFor();
    expect(await world.keychain.get(OWNER_PASSKEY_ACCOUNT)).toBeNull();

    // The right code and one gesture.
    await field.fill(world.code);
    await page.getByRole('button', { name: USE }).click();
    await page.getByRole('heading', { level: 1, name: /is on$/ }).waitFor();
    expect(await page.locator('input').count()).toBe(0);
    expect(await page.content()).not.toContain(world.code);

    // Same owner: the owner item is unchanged, the passkey item names the same owner key.
    const after = await world.keychain.get(OWNER_ACCOUNT);
    expect(after !== null && equalBytes(after, before)).toBe(true);
    const blob = await world.keychain.get(OWNER_PASSKEY_ACCOUNT);
    if (blob === null) throw new Error('no owner-passkey item');
    expect(readPasskeyBlobHeader(blob).ownerNostr).toEqual(world.owner.ownerNostr);

    // The next step is gone everywhere.
    await page.goto(`${server.origin}/settings/activity`);
    await page.getByRole('heading', { level: 1 }).first().waitFor();
    expect(await page.getByRole('link', { name: SWITCH }).count()).toBe(0);
    // W4-WIZARD: with the passkey on, Get started goes on for this owner (no switch offered).
    // W4-WIRE-2: no agent is open in this server, so it is New agent, which names the agent first.
    await page.goto(`${server.origin}/first-run`);
    await page.getByRole('heading', { name: 'Name your agent' }).waitFor();
    expect(await page.getByLabel('Backup code').count()).toBe(0);

    // The backup code keeps approving (it is the recovery way when the passkey isn't there).
    source.add(1);
    await page.goto(server.approvalUrl(approvalId(1)));
    expect(await page.getByRole('link', { name: SWITCH }).count()).toBe(0);
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.locator('input[type=password]').fill(world.code);
    await page.getByRole('button', { name: 'Confirm approval' }).click();
    await page.getByText('Approved.').waitFor();
    expect(source.applied).toHaveLength(1);

    // Canary: the code is in no URL, server event or console line.
    const compact = world.code.replace(/\s+/g, '');
    for (const text of [...urls, JSON.stringify(events), ...consoleLines]) {
      expect(text).not.toContain(world.code);
      expect(text.replace(/\s+/g, '')).not.toContain(compact);
    }
    expect(events).toContainEqual({ kind: 'passkey', outcome: 'presence_rejected' });
    expect(events).toContainEqual({ kind: 'passkey', outcome: 'registered' });
  }, 180_000);
});
