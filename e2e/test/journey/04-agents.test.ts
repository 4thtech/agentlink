// W4-JOURNEY-E2E chapter 4, Agents (WAVE-4 build plan §1 steps 7–8; b11 §34.2 switcher; D-138
// labels; W4-RENAME-REACHES-CONTACTS). One owner with two agents on computer A; for the contact's
// view, computer B paired with A. See world.ts for the gesture counter and the no-reload probe.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { until } from '../app-world.js';
import {
  CONFIRM_PASSKEY,
  chapter,
  eventually,
  firstRunWithTouchId,
  journeyPage,
  journeyWorld,
  navTo,
  pairedOwners,
  startUi,
  startUiRun,
  text,
  WAVE4,
} from './world.js';

const ch = chapter();
beforeAll(() => ch.start(), 120_000);
afterAll(() => ch.stop());

/** Agents → Add agent → name → Add with Touch ID → Not now. */
async function addAgent(page: Page, label: string): Promise<void> {
  await navTo(page, 'Agents');
  await page.getByRole('button', { name: 'Add agent' }).first().click();
  await page.getByLabel('Name your agent').fill(label);
  await page.getByRole('button', { name: 'Add with Touch ID' }).click();
  await page.getByRole('button', { name: CONFIRM_PASSKEY }).click();
  await page.getByText('Connect an AI app to it?').waitFor();
  await page.getByRole('button', { name: 'Not now' }).click();
}

/** The agent's card on the Agents page: the nearest box around its name with one More button. */
function agentCard(page: Page, label: string) {
  return page
    .getByRole('main')
    .getByText(label, { exact: true })
    .first()
    .locator('xpath=ancestor::*[count(.//button[normalize-space()="More"])=1][1]');
}

/** Agents → the agent's More menu → Remove → type the name → Remove with Touch ID. */
async function removeAgent(page: Page, label: string): Promise<void> {
  await navTo(page, 'Agents');
  await agentCard(page, label).getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Remove' }).click();
  await page.getByRole('heading', { name: `Remove ${label}?` }).waitFor();
  await page.getByLabel(`Type ${label} to confirm`).fill(label);
  await page.getByRole('button', { name: 'Remove with Touch ID' }).click();
  const confirm = page.getByRole('button', { name: CONFIRM_PASSKEY });
  const done = page.getByText(`${label} was removed.`).first();
  await Promise.race([confirm.waitFor().then(() => confirm.click()), done.waitFor()]).catch(
    () => undefined,
  );
  await done.waitFor({ timeout: 30_000 });
}

describe('chapter 4: agents', () => {
  // Passes today (0.4.5: HOTFIX-045-REMOVE): a real agent folder, the real folder lock, no faked rm.
  // The app is quit and opened again after first run: on main 909bdc76 the host that first run
  // started (`startUiWelcome`, apps/cli ui-host.ts) gets no removal port, so Remove answers 501
  // ("Couldn't finish removing …") until `agentlink ui` restarts. The WAVE4 test "removing a paired
  // agent" below runs in the first-run session and covers that gap.
  it('adds a second agent and removes it on a real folder, one Touch ID each, with no reload', async (ctx) => {
    const ready = ch.need(ctx);
    if (ready === undefined) return;
    const world = journeyWorld();
    const pc = await world.computer();
    const jp = await journeyPage(ready.browser);
    const first = await startUiRun(pc, ready.files, ch.closers);
    await firstRunWithTouchId(jp, first.link, 'Ana');
    await first.stop();
    await jp.page.goto(await startUi(pc, ready.files, ch.closers));
    await jp.page.getByRole('heading', { name: 'Home', exact: true }).first().waitFor();
    const probe = await jp.arm();
    const before = jp.gestures.total();

    await addAgent(jp.page, 'Side project');
    const added = (await pc.directory.list()).find((e) => e.label === 'Side project');
    expect(added).toBeDefined();
    const folder = join(pc.home, '.agentlink', 'agents', added?.name ?? '?');
    expect(existsSync(folder)).toBe(true);

    await removeAgent(jp.page, 'Side project');
    expect((await pc.directory.list()).map((e) => e.name)).toEqual(['default']);
    expect(existsSync(folder)).toBe(false);
    expect(jp.gestures.total() - before).toBe(2);
    await probe.check();
  }, 180_000);

  // Gate: the wave-4 agent switcher (builder D, D3; W4-SWITCHER-STATUS) turns this on. Today the
  // switcher has no per-agent icon, and switching reloads the page (api/generation.ts).
  it.runIf(WAVE4)(
    'the switcher lists every agent with its letter icon, and switching does not reload',
    async (ctx) => {
      const ready = ch.need(ctx);
      if (ready === undefined) return;
      const world = journeyWorld();
      const pc = await world.computer();
      const jp = await journeyPage(ready.browser);
      await firstRunWithTouchId(jp, await startUi(pc, ready.files, ch.closers), 'Ana');
      await addAgent(jp.page, 'Side project');
      const probe = await jp.arm();
      const { page } = jp;

      await page
        .getByRole('button', { name: /^Agent: / })
        .first()
        .click();
      for (const [label, letter] of [
        ['Ana', 'A'],
        ['Side project', 'S'],
      ] as const) {
        const row = page.getByRole('menuitem').filter({ hasText: label }).first();
        await row.waitFor();
        expect((await row.innerText()).trim().startsWith(letter)).toBe(true);
      }
      await page.getByRole('menuitem').filter({ hasText: 'Side project' }).first().click();
      await page
        .getByRole('button', { name: /^Agent: Side project/ })
        .first()
        .waitFor();
      await probe.check();
    },
    180_000,
  );

  // Gate: W4-RENAME-REACHES-CONTACTS (builder D, D2; the contact row is C2) turns this on. Today a
  // rename changes only the local label; the contact keeps the old name.
  it.runIf(WAVE4)(
    'a rename reaches the contact as "{new} (was {old})"',
    async (ctx) => {
      const ready = ch.need(ctx);
      if (ready === undefined) return;
      const world = journeyWorld();
      const { a, b, mcpB } = await pairedOwners(ready.browser, ready.files, world, ch.closers);
      const aProbe = await a.arm();
      const bProbe = await b.arm();
      const before = a.gestures.total();

      await navTo(a.page, 'Agents');
      await agentCard(a.page, 'Ana').getByRole('button', { name: 'Rename', exact: true }).click();
      await a.page.getByLabel('Name').fill('Ana Studio');
      await a.page.getByRole('button', { name: 'Save with Touch ID' }).click();
      await a.page.getByRole('button', { name: CONFIRM_PASSKEY }).click();
      await a.page.getByText('Ana Studio').first().waitFor();
      expect(a.gestures.total() - before).toBe(1);

      // The contact's agent learns the new name (a card update), and its Contacts shows it once.
      await until(
        'Bo sees the new name',
        async () => {
          const listed = await mcpB.call('agentlink_list_contacts');
          const contacts = (listed.structured['contacts'] ?? []) as Record<string, unknown>[];
          return contacts.some((c) => c['name'] === 'Ana Studio') ? true : undefined;
        },
        30_000,
      );
      await navTo(b.page, 'Contacts');
      await b.page
        .getByText(/Ana Studio.*\(was .*Ana.*\)/)
        .first()
        .waitFor({ timeout: 30_000 });
      await aProbe.check();
      await bProbe.check();
    },
    180_000,
  );

  // Gate: W4-RENAME-REACHES-CONTACTS / the wave-4 contacts (builder C, C2) turn this on: the contact
  // of a removed agent shows it as no longer active without a reload.
  it.runIf(WAVE4)(
    "removing a paired agent: gone from the switcher, and the contact's app shows it retired",
    async (ctx) => {
      const ready = ch.need(ctx);
      if (ready === undefined) return;
      const world = journeyWorld();
      const { a, b, mcpA } = await pairedOwners(ready.browser, ready.files, world, ch.closers);
      // A second agent so the paired one can go (an owner keeps at least one agent open).
      await addAgent(a.page, 'Side project');
      await mcpA.close();
      const bProbe = await b.arm();
      await navTo(b.page, 'Contacts');
      await removeAgent(a.page, 'Ana');
      await a.page
        .getByRole('button', { name: /^Agent: / })
        .first()
        .click();
      expect(await a.page.getByRole('menuitem').filter({ hasText: 'Ana' }).count()).toBe(0);
      await eventually(
        'Bo sees Ana retired',
        async () => (await text(b.page)).includes('No longer active'),
        30_000,
      );
      await bProbe.check();
    },
    240_000,
  );
});
