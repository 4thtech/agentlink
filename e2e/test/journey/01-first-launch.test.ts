// W4-JOURNEY-E2E chapter 1, Onboarding (WAVE-4 build plan §1 step 1; D-140 one Touch ID creates the
// agent and connects its AI app; 08 §1 First run v3; 11 §5.8 copy). A fresh home where Claude Code is
// installed: `agentlink ui` opens Get started (W4-WIZARD, W4 UX v2 layer 1: four steps, each its own
// route), the person picks the AI app, and ONE Touch ID creates the owner, the agent and its Claude
// Code entry; Connected ✓, then the optional invite step. See world.ts for the gesture counter and
// the probe, helpers-wizard.ts for the steps and helpers/motion.ts for reduced motion and CLS.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeClaudeCode } from '../app-world.js';
import { emulateReducedMotion, expectStableLayout, observeLayoutShift } from '../helpers/motion.js';
import { CONNECT_WITH, getStartedWithTouchId } from './helpers-wizard.js';
import { chapter, journeyPage, journeyWorld, startUi, startUiRun, text } from './world.js';

const ch = chapter();
beforeAll(() => ch.start(), 120_000);
afterAll(() => ch.stop());

// W4-ONE-TOUCH (builder A) turned this on: one gesture creates the owner and the agent and connects
// the AI app. W4-WIZARD moved it onto Get started (steps 1 to 4). W4-HOME un-gated the very end:
// once set up, the app opens on Home.
describe('chapter 1: onboarding', () => {
  it('fresh home → Get started → one Touch ID creates the agent and connects Claude Code', async (ctx) => {
    const ready = ch.need(ctx);
    if (ready === undefined) return;
    const world = journeyWorld();
    const pc = await world.computer();
    const claude = await fakeClaudeCode(pc.home);
    const settingsBefore = JSON.parse(readFileSync(claude.file, 'utf8')) as Record<string, unknown>;
    const jp = await journeyPage(ready.browser);
    const { page } = jp;
    // Reduced motion: every Get started moment is a fade (U0 kit); no layout shift on any step.
    await emulateReducedMotion(page);
    await page.goto(await startUi(pc, ready.files, ch.closers));
    await observeLayoutShift(page);
    const probe = await jp.arm();

    // Step 1 (A1): the app opens on Get started; Claude Code is found on this computer and picked.
    await page.waitForURL((url) => url.pathname === '/start/app');
    await page.getByRole('heading', { name: 'Which AI app do you use?' }).waitFor();
    await page
      .getByText(/Step 1 of 4/)
      .first()
      .waitFor();
    await page.getByRole('link', { name: 'Skip to Home' }).waitFor();
    await page.getByRole('button', { name: 'Continue with Claude Code' }).click();

    // Step 2 (A1): "Confirm it's you": the agent card (renamed), Connect with Touch ID.
    await page.waitForURL((url) => url.pathname === '/start/connect');
    await page.getByRole('heading', { name: "Confirm it's you" }).waitFor();
    // W7-ID-B1: the name people see is asked for (empty on a fresh home); the gesture waits for it.
    const name = page.getByLabel('Name people see');
    expect(await name.inputValue()).toBe('');
    expect(await page.getByRole('button', { name: CONNECT_WITH }).isDisabled()).toBe(true);
    await name.fill('Home base');
    await page.getByRole('button', { name: CONNECT_WITH }).click();
    // The master code is still shown once on first run.
    const saved = page.getByRole('button', { name: 'I saved it' });
    await saved.waitFor();
    await saved.click();

    // Step 3 (A2): Connected ✓.
    await page.waitForURL((url) => url.pathname === '/start/connected');
    await page.getByRole('heading', { name: 'Connected to Claude Code' }).waitFor();
    expect(await text(page)).not.toContain('Your master code');

    // Exactly one gesture: the passkey create that also signs card, policy, label and app.connect.
    expect(jp.gestures.create).toBe(1);
    expect(jp.gestures.get).toBe(0);

    // The agent exists with its label, and the Claude Code entry is written (the rest kept).
    expect(await pc.directory.read('default')).toMatchObject({
      label: 'Home base',
      available: true,
    });
    const settings = JSON.parse(readFileSync(claude.file, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(settings.mcpServers['agentlink']).toMatchObject({
      args: ['-y', '@4thtech-io/agentlink', 'mcp'],
    });
    expect(settings.mcpServers['other']).toEqual(
      (settingsBefore['mcpServers'] as Record<string, unknown>)['other'],
    );

    // Step 4 (A3): optional; Skip for now is always there.
    await page.getByRole('button', { name: 'Invite someone' }).click();
    await page.waitForURL((url) => url.pathname === '/start/invite');
    await page.getByRole('heading', { name: 'Invite someone' }).waitFor();
    await page.getByRole('button', { name: 'Skip for now' }).waitFor();
    // W4-WIRE: step 4 is U4's invite panel itself: the link is made at once, with Copy, in place.
    await page.locator('.inv-link[data-state="ready"]').waitFor();
    await page.getByRole('button', { name: 'Copy', exact: true }).waitFor();

    // No reload since step 1 (the finish answer's new generation is adopted in place); no layout
    // shift across the four steps.
    await probe.check();
    await expectStableLayout(page);

    // W4-HOME (un-gated): once set up, the app opens on Home with no one in People yet, and Get
    // started does not come back.
    // UX1113: the link was not copied, so leaving says so once (it would stop working).
    await page.getByRole('button', { name: 'Done, go to Home' }).click();
    await page.getByRole('alert').filter({ hasText: "haven't copied" }).waitFor();
    await page.getByRole('button', { name: 'Leave without copying' }).first().click();
    await page.waitForURL((url) => url.pathname === '/');
    expect(await text(page)).not.toContain('Which AI app do you use?');
    await page.getByRole('heading', { name: 'People' }).first().waitFor();
    // W4-WIRE: Home shows once its Get started read has answered too (its skeleton until then).
    await page.getByText('No one here yet.').first().waitFor();
    // W4-WIRE: Home carries the Get started card (one of the three ways back), counted from real
    // state: the AI app is connected; inviting someone is next, on the Invite screen.
    await page.getByRole('heading', { name: 'Get started · 1 of 2 done' }).waitFor();
    expect(
      await page.getByRole('link', { name: 'Invite someone' }).first().getAttribute('href'),
    ).toBe('/contacts?invite');
  }, 180_000);

  // IR-W4-WIZARD-1 H: the app opens Get started by itself only while setup is incomplete, on the
  // real entry path (`agentlink ui` opens the session link, which lands on /settings/home); and the
  // load that Get started itself ended on Home never loops back.
  it('no AI app yet: "Go to Home" stays on Home; the next launch opens Get started by itself', async (ctx) => {
    const ready = ch.need(ctx);
    if (ready === undefined) return;
    const world = journeyWorld();
    const pc = await world.computer();
    const jp = await journeyPage(ready.browser);
    const { page } = jp;

    // First run with no AI app on this computer: the agent is ready, nothing is connected.
    const first = await startUiRun(pc, ready.files, ch.closers);
    await page.goto(first.link);
    await getStartedWithTouchId(page, 'Solo');
    await page.getByRole('heading', { name: 'Solo is ready' }).waitFor();
    await page.getByRole('button', { name: 'Go to Home' }).click();
    await page.waitForURL((url) => url.pathname === '/');
    // Give the check every chance to run: it must not send the person back.
    await page.waitForTimeout(1500);
    expect(new URL(page.url()).pathname).toBe('/');
    await first.stop();

    // The next launch, like the real app: the session link → /settings/home → Get started.
    const again = await startUiRun(pc, ready.files, ch.closers);
    expect(new URL(again.link).pathname).toBe('/settings/home');
    await page.goto(again.link);
    await page.waitForURL((url) => url.pathname === '/start/app');
    await page.getByRole('heading', { name: 'Which AI app do you use?' }).waitFor();
  }, 180_000);

  // REL051-CF3 (R1-CLASS-03): a reload on "Your master code" shows the same code again; after the app
  // was closed before "I saved it", the next launch says the code was not saved and offers a new one.
  it('a reload on "Your master code" keeps the code; a restart says it was not saved', async (ctx) => {
    const ready = ch.need(ctx);
    if (ready === undefined) return;
    const world = journeyWorld();
    const pc = await world.computer();
    const jp = await journeyPage(ready.browser);
    const { page } = jp;
    const first = await startUiRun(pc, ready.files, ch.closers);
    await page.goto(first.link);
    await page.getByRole('heading', { name: 'Which AI app do you use?' }).waitFor();
    await page
      .getByRole('button', { name: /^Continue with / })
      .first()
      .click();
    await page.getByLabel('Name people see').fill('Reloaded');
    await page.getByRole('button', { name: CONNECT_WITH }).click();
    await page.getByRole('heading', { name: 'Your master code' }).waitFor();
    const codeOf = async (): Promise<string> =>
      (await page.locator('[data-backup-code] span').allInnerTexts()).join(' ');
    const shown = await codeOf();
    expect(shown).toMatch(/^[A-Z2-9]{4}( [A-Z2-9]{4}){5}$/);

    await page.reload();
    await page.getByRole('heading', { name: 'Your master code' }).waitFor();
    expect(await codeOf()).toBe(shown);
    expect(new URL(page.url()).pathname).toBe('/start/connect');
    expect(jp.gestures.create).toBe(1);

    // The app is closed before "I saved it": the next launch never shows or asks for that code.
    await first.stop();
    const again = await startUiRun(pc, ready.files, ch.closers);
    await page.goto(again.link);
    await page.getByRole('heading', { name: "Your master code wasn't saved" }).waitFor();
    await page.getByRole('button', { name: 'Make a new master code' }).waitFor();
    expect(await text(page)).not.toContain(shown);
    expect(await page.locator('input[type="password"]').count()).toBe(0);
  }, 180_000);
});
