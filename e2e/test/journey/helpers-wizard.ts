// W4-WIZARD (W4 UX v2 layer 1; artboards A1 to A3): Get started in the journey. Step 1 picks the AI
// app (tiles), step 2 is "Confirm it's you" with one Touch ID (D-140) and the backup code once,
// step 3 is Connected. The chapters that need an owner go through it with `getStartedWithTouchId`.
import type { Page } from 'playwright';

/** Step 2's one button, by platform (headless Chromium reports neither Mac nor Windows). */
export const CONNECT_WITH = /^Connect with (Touch ID|Windows Hello|your passkey)$/;

/**
 * Get started from step 1 to step 3: pick `app` (or keep the first found one), rename the agent to
 * `label`, Connect with Touch ID (one `create`), save the backup code. Ends on step 3 (Connected, or
 * "{label} is ready" when the app is not on this computer), or on the join screen when an invite
 * waits.
 */
export async function getStartedWithTouchId(
  page: Page,
  label: string,
  app?: string,
): Promise<void> {
  await page.getByRole('heading', { name: 'Which AI app do you use?' }).waitFor();
  if (app !== undefined) {
    await page
      .getByRole('button', { name: new RegExp(`^${app}`) })
      .first()
      .click();
  }
  await page
    .getByRole('button', { name: /^Continue with / })
    .first()
    .click();
  await page.getByRole('heading', { name: "Confirm it's you" }).waitFor();
  await page.getByRole('button', { name: /^Change the agent's name/ }).click();
  await page.getByLabel('Name your agent').fill(label);
  await page.getByRole('button', { name: CONNECT_WITH }).click();
  await page.getByRole('heading', { name: 'Your backup code' }).waitFor();
  await page.getByRole('button', { name: 'I saved it' }).click();
}

/**
 * A launch of a home with agents but no AI app connected: setup is incomplete, so the app opens Get
 * started by itself (IR-W4-WIZARD-1); these chapters skip it, as a person may, and go on from Home.
 */
export async function skipGetStartedIfShown(page: Page): Promise<void> {
  const start = page.getByRole('link', { name: 'Skip to Home' });
  const home = page.getByRole('navigation', { name: 'Sections' }).first();
  const which = await Promise.race([
    start.waitFor().then(() => 'start' as const),
    home.waitFor().then(() => 'home' as const),
  ]);
  if (which === 'start') {
    await start.click();
    await home.waitFor();
  }
}
