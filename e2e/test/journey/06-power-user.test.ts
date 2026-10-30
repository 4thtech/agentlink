// W4-AGENTS chapter 6, the power user (W4 UX v2 "Layer 3", A11 Agents fleet): one owner with three
// agents. Under the hood turns the same Agents route into the fleet table in place (no reload): search,
// filter by status, sort; a row opens the agent's own page (`/agents/<name>`) with its AI apps,
// people, rules, activity and backup; Back returns to the table. Reduced motion keeps fades only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CLS_BUDGET,
  emulateReducedMotion,
  expectFadesOnly,
  layoutShiftScore,
  observeLayoutShift,
} from '../helpers/motion.js';
import { addAgent, hoodOn, openAgents } from './helpers-agents.js';
import { chapter, firstRunWithTouchId, journeyPage, journeyWorld, startUi } from './world.js';

const ch = chapter();
beforeAll(() => ch.start(), 120_000);
afterAll(() => ch.stop());

describe('chapter 6: power user', () => {
  it('three agents: the fleet table filters and sorts, and a row opens the agent page', async (ctx) => {
    const ready = ch.need(ctx);
    if (ready === undefined) return;
    const world = journeyWorld();
    const pc = await world.computer();
    const jp = await journeyPage(ready.browser);
    await firstRunWithTouchId(jp, await startUi(pc, ready.files, ch.closers), 'Ana');
    await addAgent(jp.page, 'Work agent');
    await addAgent(jp.page, 'Research');
    const { page } = jp;
    const probe = await jp.arm();

    await openAgents(page);
    await hoodOn(page);
    const table = page.getByRole('main').getByRole('table');
    await table.waitFor();
    const rows = table.locator('tbody tr[data-agent]');
    await expect.poll(() => rows.count(), { timeout: 15_000 }).toBe(3);

    const search = page.getByRole('searchbox', { name: 'Search' });
    await search.fill('work');
    await expect.poll(() => rows.count()).toBe(1);
    await search.fill('');
    await expect.poll(() => rows.count()).toBe(3);

    await page.getByLabel('Sort by').selectOption('name');
    // Each row names its agent once, in its own isolated run (I-5).
    await expect
      .poll(() => rows.locator('bdi').allInnerTexts())
      .toEqual(['Ana', 'Research', 'Work agent']);

    await page.getByLabel('Show').selectOption('paused');
    await page.getByText('No agents match.').waitFor();
    await page.getByLabel('Show').selectOption('all');

    // A row opens the agent's own page, in the same document.
    await observeLayoutShift(page);
    const shifted = await layoutShiftScore(page);
    await table.getByRole('button', { name: 'Research', exact: true }).click();
    await page.getByRole('heading', { name: 'Research', level: 1 }).waitFor();
    expect(new URL(page.url()).pathname).toMatch(/^\/agents\/[a-z0-9-]+$/);
    for (const section of ['AI apps', 'People', 'Rules', 'Activity', 'Backup']) {
      await page.getByRole('heading', { name: section, level: 2 }).waitFor();
    }
    await emulateReducedMotion(page);
    await page.getByRole('link', { name: 'Agents', exact: true }).first().click();
    await table.waitFor();
    await expectFadesOnly(page);
    expect((await layoutShiftScore(page)) - shifted).toBeLessThanOrEqual(CLS_BUDGET);
    await probe.check();
  }, 240_000);
});
