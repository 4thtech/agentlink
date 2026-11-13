// HOTFIX-NOID (owner report, Mac app 0.5.1 on a Mac that had AgentLink before): the owner exists on
// this computer but no ID does. "Create {app}'s ID → Confirm it's you" answered "No ID is left on
// this computer … In your own terminal, run `agentlink init` …" and the master code confirmed
// nothing. Everything must be doable in the app: here the last ID is removed, the app is quit and
// opened again (the host then has no ID open), and Get started makes a new ID with the master code.
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openAgents, removeAgent } from './helpers-agents.js';
import { CONNECT_WITH } from './helpers-wizard.js';
import { chapter, journeyPage, journeyWorld, startUi, startUiRun } from './world.js';

const ch = chapter();
beforeAll(() => ch.start(), 120_000);
afterAll(() => ch.stop());

/** Get started up to its master code screen; the code as shown (its groups joined by spaces). */
async function firstRunCode(page: Page, link: string, label: string): Promise<string> {
  await page.goto(link);
  await page.getByRole('heading', { name: 'Which AI app do you use?' }).waitFor();
  await page
    .getByRole('button', { name: /^Continue with / })
    .first()
    .click();
  await page.getByLabel('Name people see').fill(label);
  await page.getByRole('button', { name: CONNECT_WITH }).click();
  await page.getByRole('heading', { name: 'Your master code' }).waitFor();
  const code = (await page.locator('[data-backup-code] span').allInnerTexts()).join(' ');
  await page.getByRole('button', { name: 'I saved it' }).click();
  await page.getByRole('button', { name: 'Go to Home' }).click();
  await page.waitForURL((url) => url.pathname === '/');
  return code;
}

describe('HOTFIX-NOID: an owner with zero IDs makes a new ID in the app', () => {
  it('removes the last ID, reopens the app, and Get started makes a new ID with the master code', async (ctx) => {
    const ready = ch.need(ctx);
    if (ready === undefined) return;
    const world = journeyWorld();
    const pc = await world.computer();
    const jp = await journeyPage(ready.browser);
    const { page } = jp;
    const first = await startUiRun(pc, ready.files, ch.closers);
    const code = await firstRunCode(page, first.link, 'Ana');
    await openAgents(page);
    await removeAgent(page, 'Ana');
    await first.stop();
    expect(await pc.directory.list()).toEqual([]);

    // The app opened again with the owner and no ID: Get started offers to make one.
    await page.goto(await startUi(pc, ready.files, ch.closers));
    await page.getByRole('heading', { name: 'Name this ID', level: 1 }).waitFor();
    await page.getByLabel('Name people see').fill('Claude Desktop');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('heading', { name: 'Which AI app do you use?' }).waitFor();
    await page.getByRole('button').filter({ hasText: 'Not found yet' }).first().click();
    await page
      .getByRole('button', { name: /^Continue with / })
      .first()
      .click();
    const field = page.getByLabel('Name people see');
    if ((await field.count()) > 0 && (await field.first().inputValue()) === '') {
      await field.first().fill('Claude Desktop');
    }
    await page.getByRole('button', { name: CONNECT_WITH }).click();
    // The owner can't be known before the master code unlocks it: the code form (never a terminal).
    const confirm = page.getByRole('button', { name: 'Confirm with my master code' });
    await confirm.waitFor({ timeout: 20_000 });
    const said = (await page.getByRole('main').innerText()).toLowerCase();
    expect(said).not.toContain('terminal');
    expect(said).not.toContain('agentlink init');
    await page.getByLabel('Master code').fill(code);
    await confirm.click();
    await page
      .getByRole('heading', { name: /Claude Desktop.* is ready/ })
      .first()
      .waitFor({ timeout: 60_000 });
    const listed = await pc.directory.list();
    expect(listed.map((e) => e.label)).toEqual(['Claude Desktop']);
  }, 240_000);
});
