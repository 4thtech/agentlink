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
  journeyPage,
  journeyWorld,
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
      'Backup & Touch ID',
      'Files folder',
      'Appearance',
      'Rules for approvals',
      'Proofs & credits',
      'Notifications',
    ]) {
      expect(list).toContain(row);
    }
    await page.locator('button.st-row[aria-expanded]').click();
    await page.getByText('Activity log', { exact: true }).waitFor();
    expect(await text(page)).toContain('Long invite links');
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
    await page.getByRole('switch', { name: /Under the hood/ }).click();
    await sections(page)
      .getByRole('link', { name: /Live activity/ })
      .waitFor();
    for (const item of [
      'Rules',
      'Proofs & credits',
      'Relays & network',
      'Diagnostics',
      'Connections map',
    ]) {
      await sections(page).getByRole('link', { name: item }).waitFor();
    }

    // Shifts count from the Advanced pages on: the shell's live status strip fills in first.
    await page.getByRole('region', { name: 'Live status' }).getByText('AgentLink').waitFor();
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
    await page.getByText('Coming next').first().waitFor();

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
  }, 240_000);
});
