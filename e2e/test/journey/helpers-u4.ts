// W4-PEOPLE-INVITE journey helpers (chapter 2): the Invite screen (prototype v23 A3/A5) and the
// Connected moment (A7). world.ts stays U1's; this unit adds its steps here.
import type { Page } from 'playwright';
import { navTo, type JourneyPage } from './world.js';

/** People → Invite someone: the Invite screen, with its link made at once. */
export async function openInviteScreen(page: Page): Promise<void> {
  await navTo(page, 'Contacts');
  await page.getByRole('button', { name: 'Invite someone', exact: true }).first().click();
  await page.getByRole('heading', { name: 'Invite someone', level: 1 }).waitFor();
}

/** The link on the Invite screen, as the person copies it (the screen shows it without https://). */
export async function inviteLinkOnScreen(page: Page): Promise<string> {
  // While a fresh link is being made (a name was added), the box says so; wait for the ready one.
  const shown = page.locator('.inv-link[data-state="ready"]');
  await shown.waitFor();
  const value = (await shown.innerText()).trim();
  return value.startsWith('https://') ? value : `https://${value}`;
}

/** Invite screen: optional name, Copy (✓ Copied), Done. Answers the link. */
export async function inviteFromScreen(jp: JourneyPage, name?: string): Promise<string> {
  const { page } = jp;
  await openInviteScreen(page);
  if (name !== undefined) {
    await page.getByLabel('Who is it for?').fill(name);
    await page.getByLabel('Who is it for?').blur();
    await page.getByText(`Invite link for ${name}`).waitFor();
  }
  const link = await inviteLinkOnScreen(page);
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  await page.getByRole('button', { name: 'Copied', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  return link;
}

/** The Connected moment on either side: "You and {name} are connected" and a 12-digit code. */
export async function seesConnected(page: Page, name: string, ms = 30_000): Promise<void> {
  // The name rule quotes a name the contact gave itself: “Ana”.
  await page
    .getByRole('heading', { name: new RegExp(`^You and “?${name}”? are connected$`) })
    .waitFor({ timeout: ms });
  await page
    .getByText(/\d{4}\D{1,3}\d{4}\D{1,3}\d{4}/)
    .first()
    .waitFor({ timeout: ms });
}
