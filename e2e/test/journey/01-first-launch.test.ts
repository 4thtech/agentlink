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
import { CONNECT_WITH } from './helpers-wizard.js';
import { chapter, journeyPage, journeyWorld, startUi, text, WAVE4 } from './world.js';

const ch = chapter();
beforeAll(() => ch.start(), 120_000);
afterAll(() => ch.stop());

// W4-ONE-TOUCH (builder A) turned this on: one gesture creates the owner and the agent and connects
// the AI app. W4-WIZARD moved it onto Get started (steps 1 to 4, ungated). Only the very end (the
// empty Home) waits for Home (U3), so it alone stays behind the JOURNEY_WAVE4 gate.
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
    await page.getByRole('button', { name: /^Change the agent's name/ }).click();
    const name = page.getByLabel('Name your agent');
    expect(await name.inputValue()).not.toBe('');
    await name.fill('Home base');
    await page.getByRole('button', { name: CONNECT_WITH }).click();
    // The owner code is still shown once on first run.
    const saved = page.getByRole('button', { name: 'I saved it' });
    await saved.waitFor();
    await saved.click();

    // Step 3 (A2): Connected ✓.
    await page.waitForURL((url) => url.pathname === '/start/connected');
    await page.getByRole('heading', { name: 'Connected to Claude Code' }).waitFor();
    expect(await text(page)).not.toContain('Your backup code');

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

    // No reload since step 1 (the finish answer's new generation is adopted in place); no layout
    // shift across the four steps.
    await probe.check();
    await expectStableLayout(page);

    // Home (gated until U3's Home lands): once set up, Home, and Get started does not come back.
    if (WAVE4) {
      await page.getByRole('button', { name: 'Done, go to Home' }).click();
      await page.waitForURL((url) => url.pathname === '/');
      expect(await text(page)).not.toContain('Which AI app do you use?');
    }
  }, 180_000);
});
