// UX1113-R3 (D-147; design-1112 spec §6.6): restore from a recovery kit in the app, end to end. Ana and
// Bo are paired and Bo has written to Ana; Ana saves a recovery kit in Settings. Ana's profile is then
// "wiped": a new computer with a fresh temp home gets the kit file in its Downloads folder, and the
// wizard brings her back (kit file, recovery code, what comes back, one passkey, the new master code),
// and Home shows Bo and his message. Temp homes and the file keychain only; never the real home.
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { until } from '../app-world.js';
import {
  CONFIRM_PASSKEY,
  chapter,
  inboxHas,
  journeyPage,
  journeyWorld,
  pairedOwners,
  startUi,
  text,
} from './world.js';

const ch = chapter();
beforeAll(() => ch.start(), 120_000);
afterAll(() => ch.stop());

const HELLO = 'Hello Ana, this is Bo';

function findKit(dir: string): string | undefined {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (/^agentlink-recovery-kit.*\.alkk$/.test(name)) return path;
    if (statSync(path).isDirectory() && !name.startsWith('.')) {
      const inner = findKit(path);
      if (inner !== undefined) return inner;
    }
  }
  return undefined;
}

describe('restore from a recovery kit', () => {
  it('save a kit → new profile → restore → Home shows the person and the message', async (ctx) => {
    const ready = ch.need(ctx);
    if (ready === undefined) return;
    const world = journeyWorld();
    const { pcA, a, mcpA, mcpB } = await pairedOwners(
      ready.browser,
      ready.files,
      world,
      ch.closers,
    );
    expect(
      (await mcpB.call('agentlink_send', { to: 'Ana', text: HELLO })).structured['status'],
    ).toBe('ok');
    await until('the hello reaches Ana', () => inboxHas(mcpA, HELLO), 30_000);

    // Ana saves a recovery kit (Settings › Backup & restore) and writes the recovery code down.
    await a.page.goto(new URL('/settings/backup', a.page.url()).toString());
    await a.page.getByRole('button', { name: 'Save recovery kit' }).first().click();
    const confirm = a.page.getByRole('button', { name: CONFIRM_PASSKEY });
    const code = a.page.getByRole('region', { name: 'Your recovery code' });
    await confirm.or(code).first().waitFor({ timeout: 30_000 });
    if (await confirm.isVisible()) await confirm.click();
    await code.waitFor({ timeout: 30_000 });
    const recoveryCode = (await code.locator('[data-recovery-code] span').allInnerTexts()).join('');
    expect(recoveryCode).toMatch(/^[A-Z0-9]{24}$/);
    await a.page.getByRole('button', { name: 'I saved it' }).click();
    const kit = findKit(pcA.home);
    expect(kit, 'the kit file was written into the temp home').toBeDefined();

    // The old profile is gone: a new computer, with the kit file copied to its Downloads folder.
    const pcC = await world.computer();
    mkdirSync(join(pcC.home, 'Downloads'), { recursive: true });
    copyFileSync(kit as string, join(pcC.home, 'Downloads', 'agentlink-recovery-kit-test.alkk'));
    const c = await journeyPage(ready.browser);
    const { page } = c;
    await page.goto(await startUi(pcC, ready.files, ch.closers));
    await page.goto(new URL('/restore/kit', page.url()).toString());

    // Step 1: the kit file is found and preselected; nothing is asked of the AI.
    await page.getByRole('heading', { name: 'Choose your kit file' }).waitFor();
    await page.getByText('agentlink-recovery-kit-test.alkk').waitFor();
    await page.getByRole('button', { name: 'Continue' }).click();

    // Step 2: six boxes of four; the whole code is pasted.
    await page.getByRole('heading', { name: 'Type your recovery code' }).waitFor();
    expect(await page.locator('.rs-code-box').count()).toBe(6);
    await page
      .locator('.rs-code-box')
      .first()
      .evaluate((el, value) => {
        const data = new DataTransfer();
        data.setData('text/plain', value);
        el.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
        );
      }, recoveryCode.toLowerCase());
    await page.getByRole('button', { name: 'Open my kit' }).click();

    // Step 3: what comes back; nothing was written yet.
    await page
      .getByRole('heading', { name: 'Here is what comes back' })
      .waitFor({ timeout: 60_000 });
    await page.getByText('Will be restored').waitFor();
    await page.getByRole('button', { name: 'Restore 1 ID' }).click();

    // Step 4: one passkey gesture creates this computer's protection; the new master code is shown once.
    await page
      .getByRole('heading', { name: /You're back\. 1 ID restored\./ })
      .waitFor({ timeout: 60_000 });
    expect(c.gestures.create).toBe(1);
    const master = (await page.locator('[data-master-code]').innerText()).trim();
    expect(master).toMatch(/^([A-Z0-9]{4}-){5}[A-Z0-9]{4}$/);
    const goHome = page.getByRole('button', { name: 'Go to Home' });
    expect(await goHome.isDisabled()).toBe(true);
    await page.getByLabel('I saved it').check();
    // The codes are in no storage, no URL and no attribute.
    const leaks = await page.evaluate(
      ({ recovery, masterCode }) => {
        const dump = JSON.stringify([{ ...localStorage }, { ...sessionStorage }, location.href]);
        const attrs = [...document.querySelectorAll('*')].flatMap((el) =>
          el.getAttributeNames().map((n) => el.getAttribute(n) ?? ''),
        );
        const secrets = [
          recovery,
          recovery.toLowerCase(),
          masterCode,
          masterCode.replace(/-/g, ''),
        ];
        return secrets.filter((s) => dump.includes(s) || attrs.some((v) => v.includes(s)));
      },
      { recovery: recoveryCode, masterCode: master },
    );
    expect(leaks).toEqual([]);
    await goHome.click();

    // Home shows the person and the message.
    await page.getByRole('navigation', { name: 'Sections' }).first().waitFor({ timeout: 60_000 });
    await until(
      'Home shows Bo',
      async () => ((await text(page)).includes('Bo') ? true : undefined),
      30_000,
    );
    await page
      .getByRole('button', { name: /^B(o)?\b/ })
      .filter({ hasText: 'Bo' })
      .first()
      .click();
    await page.getByText(HELLO).first().waitFor({ timeout: 30_000 });
  }, 300_000);
});
