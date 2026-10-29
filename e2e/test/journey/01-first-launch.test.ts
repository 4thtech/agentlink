// W4-JOURNEY-E2E chapter 1, Onboarding (WAVE-4 build plan §1 step 1; D-140 one Touch ID creates the
// agent and connects its AI app; 08 §1 First run v3; 11 §5.8 copy). A fresh home where Claude Code is
// installed: `agentlink ui` opens Welcome, the person picks the AI app, and ONE Touch ID creates the
// owner, the agent and its Claude Code entry. See world.ts for the gesture counter and the probe.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeClaudeCode } from '../app-world.js';
import { chapter, journeyPage, journeyWorld, startUi, text, TOUCH_ID, WAVE4 } from './world.js';

const ch = chapter();
beforeAll(() => ch.start(), 120_000);
afterAll(() => ch.stop());

// Gate: W4-ONE-TOUCH (builder A) turns this on. Today first run takes two gestures (the AI app is a
// separate signed step after the agent exists) and ends on Home, not the Inbox.
describe.runIf(WAVE4)('chapter 1: onboarding', () => {
  it('fresh home → "Connect your AI app" → one Touch ID creates the agent and connects Claude Code', async (ctx) => {
    const ready = ch.need(ctx);
    if (ready === undefined) return;
    const world = journeyWorld();
    const pc = await world.computer();
    const claude = await fakeClaudeCode(pc.home);
    const settingsBefore = JSON.parse(readFileSync(claude.file, 'utf8')) as Record<string, unknown>;
    const jp = await journeyPage(ready.browser);
    const { page } = jp;
    await page.goto(await startUi(pc, ready.files, ch.closers));
    const probe = await jp.arm();

    // Welcome leads with the AI app; Claude Code is detected and picked.
    await page.getByRole('button', { name: /Connect your AI app|Get started/ }).click();
    await page.getByText('Claude Code').first().waitFor();
    await page.getByRole('button', { name: 'Continue' }).click();

    // One screen: the name (prefilled), "Connect to Claude Code" (prefilled), Use Touch ID.
    const name = page.getByLabel('Name your agent');
    expect(await name.inputValue()).not.toBe('');
    await name.fill('Home base');
    await page.getByText('Connect to Claude Code').first().waitFor();
    await page.getByRole('button', { name: TOUCH_ID }).click();
    // The owner code is still shown once on first run.
    const saved = page.getByRole('button', { name: 'I saved it' });
    await saved.waitFor();
    await saved.click();
    await page
      .getByText('Home base is ready in Claude Code. Restart Claude Code to finish.')
      .waitFor();

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

    // The app opens on the empty Inbox, with no reload since Welcome.
    await page.getByRole('heading', { name: 'Inbox' }).first().waitFor();
    expect(await text(page)).toContain('All caught up');
    await probe.check();
  }, 180_000);
});
