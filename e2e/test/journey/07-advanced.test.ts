// W4-SETTINGS-ADVANCED chapter 7, Advanced (W4 UX v2 three layers; A9 Settings, the Advanced group).
// One owner on one computer. Under the hood on: the Advanced group appears in the menu, the live
// activity stream, Relays & network and Diagnostics open in the same document (no reload), the
// diagnostics report copies without messages or keys, and reduced motion keeps fades only with no
// layout shift. Settings (the list) and its Advanced rows are checked in the simple layer first.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import {
  emulateReducedMotion,
  expectFadesOnly,
  CLS_BUDGET,
  layoutShiftScore,
  observeLayoutShift,
} from '../helpers/motion.js';
import { skipGetStartedIfShown } from './helpers-wizard.js';
import {
  chapter,
  firstRunWithTouchId,
  goTo,
  journeyPage,
  journeyWorld,
  navTo,
  startUi,
  startUiRun,
  text,
} from './world.js';

const ch = chapter();
beforeAll(() => ch.start(), 120_000);
afterAll(() => ch.stop());

const sections = (page: Page) => page.getByRole('navigation', { name: 'Sections' });

describe('chapter 7: advanced', () => {
  it('Settings is a list; Under the hood adds the Advanced group, live stream and diagnostics', async (ctx) => {
    const ready = ch.need(ctx);
    if (ready === undefined) return;
    const world = journeyWorld();
    const pc = await world.computer();
    const jp = await journeyPage(ready.browser);
    const first = await startUiRun(pc, ready.files, ch.closers);
    await firstRunWithTouchId(jp, first.link, 'Ana');
    await first.stop();
    await jp.page.goto(await startUi(pc, ready.files, ch.closers));
    const { page } = jp;
    // W4-WIZARD: no AI app is connected here, so the launch opens Get started; skip it.
    await skipGetStartedIfShown(page);
    const probe = await jp.arm();

    // Simple layer: Settings is one list; Advanced opens in place.
    await sections(page)
      .getByRole('link', { name: /^Settings/ })
      .click();
    await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor();
    const list = await text(page);
    for (const row of [
      'Backup & restore',
      'Touch ID & master code',
      'Files',
      'Appearance',
      'Rules',
      'Proofs & credits',
    ]) {
      expect(list).toContain(row);
    }
    // WP-7: no Notifications row, and the old address lands on Settings.
    expect(list).not.toContain('Notifications');
    expect(await page.locator('a[href="/settings/notifications"]').count()).toBe(0);
    // Advanced is a row that leads to its page now (the in-place list is gone).
    expect(await page.locator('a.set-row[href="/settings/advanced"]').count()).toBe(1);
    expect(
      await sections(page)
        .getByRole('link', { name: /Live activity/ })
        .count(),
    ).toBe(0);

    // Under the hood: the Advanced group appears; the same app, the same document.
    // W4-WIRE (U1): turning it on moves nothing in the shell (the agent chip once shifted ~0.023).
    await observeLayoutShift(page);
    await page.waitForTimeout(500);
    const beforeHood = await layoutShiftScore(page);
    await page.getByRole('switch', { name: 'Under the hood', exact: true }).click();
    await sections(page)
      .getByRole('link', { name: /Live activity/ })
      .waitFor();
    // Rules and Proofs & credits are Settings pages now (asserted in the Settings list above).
    for (const item of ['Relays & network', 'Diagnostics', 'Connections map']) {
      await sections(page).getByRole('link', { name: item }).waitFor();
    }

    // Shifts count from the Advanced pages on: the shell's live status strip fills in first.
    await page
      .getByRole('region', { name: 'Live status' })
      .getByText('AgentLink', { exact: true })
      .waitFor();
    await page.waitForTimeout(1500);
    expect((await layoutShiftScore(page)) - beforeHood).toBeLessThanOrEqual(0.01);
    // The observer replays earlier shifts (the shell's own, when the switch turned): count the walk.
    const shiftedBefore = await layoutShiftScore(page);
    await sections(page)
      .getByRole('link', { name: /Live activity/ })
      .click();
    await page.getByRole('heading', { name: 'Live activity stream', level: 1 }).waitFor();
    await page.getByRole('log').waitFor();
    await page.getByRole('button', { name: 'Pause stream' }).click();
    await page.getByRole('button', { name: 'Resume stream' }).click();

    await sections(page).getByRole('link', { name: 'Relays & network' }).click();
    await page.getByRole('heading', { name: 'Relays & network', level: 1 }).waitFor();
    expect(await text(page)).not.toMatch(/wss?:\/\//);

    await sections(page).getByRole('link', { name: 'Connections map' }).click();
    // UX1113-QA-UTH: the live Connections map, not a "Coming next" stub.
    await page.getByRole('heading', { name: 'Connections map', level: 1 }).waitFor();
    expect(await text(page)).not.toContain('Coming next');

    // Diagnostics: the report copies, and says what it holds.
    await jp.context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => undefined);
    await sections(page).getByRole('link', { name: 'Diagnostics' }).click();
    await page.getByRole('heading', { name: 'Diagnostics', level: 1 }).waitFor();
    await page.getByRole('button', { name: 'Copy diagnostics report' }).click();
    await page.getByText('Copied. No messages, keys or file names included.').waitFor();
    const copied = await page.evaluate(() => navigator.clipboard.readText()).catch(() => undefined);
    if (copied !== undefined) {
      expect(copied).toMatch(/^AgentLink /);
      expect(copied).not.toMatch(/https?:|wss?:|\/Users\/|token/i);
    }

    // Reduced motion: fades only, and nothing shifted during the whole walk.
    await emulateReducedMotion(page);
    await sections(page)
      .getByRole('link', { name: /Live activity/ })
      .click();
    await page.getByRole('heading', { name: 'Live activity stream', level: 1 }).waitFor();
    await expectFadesOnly(page);
    expect((await layoutShiftScore(page)) - shiftedBefore).toBeLessThanOrEqual(CLS_BUDGET);
    await probe.check();
    // WP-7: the old Notifications address lands on Settings (a fresh load, so after the probe).
    await page.goto(new URL('/settings/notifications', page.url()).href);
    await page.getByRole('heading', { name: 'Settings', level: 1 }).waitFor();
    expect(new URL(page.url()).pathname).toBe('/settings');
  }, 240_000);

  // W4-WIRE-3 (owner walkthrough 30 Oct): on a phone (375 px) every section is one tap from the
  // section bar's sheet, Activity included, with Under the hood off and on; and Go to reaches it too.
  it('375 px: the section sheet and Go to reach Activity, Agents and Settings', async (ctx) => {
    const ready = ch.need(ctx);
    if (ready === undefined) return;
    const world = journeyWorld();
    const pc = await world.computer();
    const jp = await journeyPage(ready.browser);
    await firstRunWithTouchId(jp, await startUi(pc, ready.files, ch.closers), 'Ana');
    const { page } = jp;
    await skipGetStartedIfShown(page);
    await page.setViewportSize({ width: 375, height: 812 });
    const probe = await jp.arm();
    const viaSheet = async (label: string, heading: string): Promise<void> => {
      await page.locator('.al-topnav-btn').click();
      await sections(page).getByRole('link', { name: label, exact: true }).click();
      await page.getByRole('heading', { name: heading, level: 1 }).first().waitFor();
      expect(await sections(page).count()).toBe(0);
    };
    await viaSheet('Activity', 'Activity');
    await viaSheet('My IDs', 'My IDs');
    await page.getByRole('switch', { name: 'Under the hood', exact: true }).click();
    await viaSheet('Activity', 'Activity');
    await viaSheet('Settings', 'Settings');
    // Go to (the search button on a phone) reaches Activity as well, also from the fleet table,
    // whose own filters are comboboxes too (the walkthrough's helper picked theirs).
    await viaSheet('My IDs', 'My IDs');
    await goTo(page, 'Activity');
    await page.getByRole('heading', { name: 'Activity', level: 1 }).first().waitFor();
    // navTo opens the sheet itself on a phone.
    await navTo(page, 'Home');
    await page.locator('.al-topnav-btn').getByText('Home').waitFor();
    // Nothing on the page is wider than the phone.
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await probe.check();
  }, 180_000);
});
