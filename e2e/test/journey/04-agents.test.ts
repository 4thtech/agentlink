// W4-JOURNEY-E2E chapter 4, Agents (WAVE-4 build plan §1 steps 7–8; b11 §34.2 switcher; D-138
// labels; W4-RENAME-REACHES-CONTACTS; W4-AGENTS: Pause one click, Resume with Touch ID, D-143). One
// owner with two agents on computer A; for the contact's view, computer B paired with A. See world.ts
// for the gesture counter and the no-reload probe.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeClaudeCode, startAiAppMcp, until } from '../app-world.js';
import {
  CLS_BUDGET,
  emulateReducedMotion,
  expectFadesOnly,
  layoutShiftScore,
  observeLayoutShift,
} from '../helpers/motion.js';
import { addAgent, agentCard, labelled, openAgents, removeAgent } from './helpers-agents.js';
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
import { skipGetStartedIfShown } from './helpers-wizard.js';

const ch = chapter();
beforeAll(() => ch.start(), 120_000);
afterAll(() => ch.stop());

/** Agents → Pause on Ana's card → the sheet's Pause; Ana reads Paused (one click, no Touch ID). */
async function pauseAna(page: Page): Promise<void> {
  await openAgents(page);
  await agentCard(page, 'Ana')
    .getByText(/^(Offline|Ready|Working|Idle)/)
    .first()
    .waitFor();
  await agentCard(page, 'Ana').getByRole('button', { name: 'Pause', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: labelled('Pause ', 'Ana', '?') });
  await sheet.getByText('Nothing is deleted.', { exact: false }).waitFor();
  await sheet.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.getByText('Ana is paused').first().waitFor();
  await agentCard(page, 'Ana').getByText('Paused', { exact: true }).first().waitFor();
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
    // W4-WIZARD: no AI app is connected here, so the launch opens Get started; skip it.
    await skipGetStartedIfShown(jp.page);
    // W4-SHELL-V2: the app opens on Home (the section marked current).
    await jp.page
      .getByRole('navigation', { name: 'Sections' })
      .locator('a[aria-current="page"][href="/"]')
      .first()
      .waitFor();
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

  // W4-SHELL (D1): the switcher lists every agent with its letter icon (Decision 44 B1), and a
  // switch changes the agent in place (the generation guard swaps the views, no reload).
  it('the switcher lists every agent with its letter icon, and switching does not reload', async (ctx) => {
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
      const row = page.getByRole('menuitemradio').filter({ hasText: label }).first();
      await row.waitFor();
      expect((await row.innerText()).trim().startsWith(letter)).toBe(true);
    }
    await page.getByRole('menuitemradio').filter({ hasText: 'Side project' }).first().click();
    await page
      .getByRole('button', { name: /^Agent: Side project/ })
      .first()
      .waitFor();
    await probe.check();
  }, 180_000);

  // W4-WIRE-3 (D-143; 06 §6 "MCP session heartbeat"; owner walkthrough 30 Oct): Claude Code's MCP
  // session, run through `agentlink mcp`'s own command and heartbeat, shows in the agent chip and the
  // dropdown as Ready, then Working after a tool call, then Not running once it ends, with no reload.
  it('Claude Code shows Ready, Working, then Not running as its MCP session runs and ends', async (ctx) => {
    const ready = ch.need(ctx);
    if (ready === undefined) return;
    const world = journeyWorld();
    const pc = await world.computer();
    await fakeClaudeCode(pc.home);
    const jp = await journeyPage(ready.browser);
    await firstRunWithTouchId(jp, await startUi(pc, ready.files, ch.closers), 'Ana');
    const probe = await jp.arm();
    const { page } = jp;
    const chip = page.locator('.al-chip-status').first();
    const appWord = async (): Promise<string> => {
      await page
        .getByRole('button', { name: /^Agent: / })
        .first()
        .click();
      const line = page.locator('.al-am-app').filter({ hasText: 'Claude Code' }).first();
      const word = (await line.locator('.al-am-app-word').innerText()).trim();
      await page.keyboard.press('Escape');
      return word;
    };
    await eventually('Offline before', async () => (await chip.innerText()).startsWith('Offline'));

    const mcp = await startAiAppMcp(pc, undefined);
    ch.closers.push(() => mcp.close());
    await eventually(
      'Ready in Claude Code',
      async () => (await chip.innerText()).trim() === 'Ready in Claude Code',
      20_000,
    );
    expect(await appWord()).toBe('Ready');

    await mcp.call('agentlink_status');
    await eventually(
      'Working in Claude Code',
      async () => (await chip.innerText()).trim() === 'Working in Claude Code',
      20_000,
    );
    expect(await appWord()).toBe('Working');

    await mcp.close();
    await eventually(
      'Offline after',
      async () => (await chip.innerText()).startsWith('Offline'),
      20_000,
    );
    expect(await appWord()).toMatch(/^Not running/);
    await probe.check();
  }, 180_000);

  // W4-AGENTS (D-143 (5), 08 §1 "Pause an agent"): Pause is one click with no Touch ID; the open
  // agent shows Paused on its card and in a banner with "Resume with Touch ID". Reduced motion keeps
  // fades only, and the page does not shift while its live status settles.
  it('pauses the open agent in one click, with no Touch ID and no reload', async (ctx) => {
    const ready = ch.need(ctx);
    if (ready === undefined) return;
    const world = journeyWorld();
    const pc = await world.computer();
    const jp = await journeyPage(ready.browser);
    await firstRunWithTouchId(jp, await startUi(pc, ready.files, ch.closers), 'Ana');
    const { page } = jp;
    const probe = await jp.arm();
    const before = jp.gestures.total();

    await pauseAna(page);
    expect(jp.gestures.total() - before).toBe(0);
    await page.getByRole('button', { name: 'Resume with Touch ID' }).first().waitFor();

    // Reduced motion: fades only; no layout shift on the Agents page while it settles.
    await emulateReducedMotion(page);
    await observeLayoutShift(page);
    const shifted = await layoutShiftScore(page);
    await agentCard(page, 'Ana').getByRole('button', { name: 'AI apps', exact: true }).click();
    await page.getByText('Quit the AI app first, then open it again.').first().waitFor();
    await expectFadesOnly(page);
    await page.waitForTimeout(1_000);
    expect((await layoutShiftScore(page)) - shifted).toBeLessThanOrEqual(CLS_BUDGET);
    await probe.check();
  }, 180_000);

  // W4-AGENTS + W4-PAUSE (#735): Resume signs `agent.resume` (04 §2.5.1) with one Touch ID.
  it('resumes the paused agent with one Touch ID, with no reload', async (ctx) => {
    const ready = ch.need(ctx);
    if (ready === undefined) return;
    const world = journeyWorld();
    const pc = await world.computer();
    const jp = await journeyPage(ready.browser);
    await firstRunWithTouchId(jp, await startUi(pc, ready.files, ch.closers), 'Ana');
    const { page } = jp;
    const probe = await jp.arm();
    await pauseAna(page);
    const before = jp.gestures.total();
    await page.getByRole('button', { name: 'Resume with Touch ID' }).first().click();
    await page.getByRole('button', { name: CONFIRM_PASSKEY }).click();
    await eventually(
      'Ana resumed',
      async () => !(await text(page)).includes('Ana is paused'),
      30_000,
    );
    expect(jp.gestures.total() - before).toBe(1);
    await probe.check();
  }, 180_000);

  // 08 §1: Pause and Resume act on the open agent; on another agent's card the app switches to it
  // first (no reload: the views mount again) and then asks: "Pause Work?", or Resume's Touch ID.
  it('Pause and Resume on another agent switch to it first, then ask', async (ctx) => {
    const ready = ch.need(ctx);
    if (ready === undefined) return;
    const world = journeyWorld();
    const pc = await world.computer();
    const jp = await journeyPage(ready.browser);
    await firstRunWithTouchId(jp, await startUi(pc, ready.files, ch.closers), 'Ana');
    await addAgent(jp.page, 'Work');
    const { page } = jp;
    const probe = await jp.arm();

    await openAgents(page);
    await agentCard(page, 'Work').getByRole('button', { name: 'Pause', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: labelled('Pause ', 'Work', '?') });
    // The switch mounts the views again; the page's own read then opens the sheet.
    await sheet.waitFor();
    await page
      .getByRole('button', { name: /^Agent: Work/ })
      .first()
      .waitFor();
    await sheet.getByRole('button', { name: 'Pause', exact: true }).click();
    await page.getByText('Work is paused').first().waitFor();

    // Back to Ana; Resume on Work's card opens Work and asks for Touch ID once.
    await agentCard(page, 'Ana').getByRole('button', { name: 'Switch', exact: true }).click();
    await page
      .getByRole('button', { name: /^Agent: Ana/ })
      .first()
      .waitFor();
    // The switch mounts the views again: wait until the Agents page itself shows Ana open (its own
    // read), so Resume is pressed on the page for the agent open now, not on the one being replaced.
    await agentCard(page, 'Ana').getByText('Open', { exact: true }).waitFor();
    await agentCard(page, 'Work').getByText('Paused', { exact: true }).first().waitFor();
    const before = jp.gestures.total();
    await agentCard(page, 'Work').getByRole('button', { name: 'Resume', exact: true }).click();
    // Switch to Work, its own read, then the Resume gate (Touch ID).
    await page.getByRole('button', { name: CONFIRM_PASSKEY }).click();
    await eventually(
      'Work resumed',
      async () => !(await text(page)).includes('Work is paused'),
      30_000,
    );
    expect(jp.gestures.total() - before).toBe(1);
    await probe.check();
  }, 240_000);

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

      await openAgents(a.page);
      await agentCard(a.page, 'Ana').getByRole('button', { name: 'Rename', exact: true }).click();
      await a.page.getByLabel('Name').fill('Ana Studio');
      await a.page.getByRole('button', { name: 'Rename with Touch ID' }).click();
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
      expect(await a.page.getByRole('menuitemradio').filter({ hasText: 'Ana' }).count()).toBe(0);
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
