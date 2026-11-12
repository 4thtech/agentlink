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

/** The 12 digits are behind the optional check (WP-3): open it, then wait for them. */
async function seesDigits(page: Page, ms: number): Promise<void> {
  const digits = page.getByText(/\d{4}\D{1,3}\d{4}\D{1,3}\d{4}/).first();
  if (!(await digits.isVisible())) {
    await page
      .getByRole('button', { name: /^Optional: make sure it's really .*Contact check/ })
      .click();
  }
  await digits.waitFor({ timeout: ms });
}

/** The Connected moment on a side that named the contact itself: "You and {name} are connected". */
export async function seesConnected(page: Page, name: string, ms = 30_000): Promise<void> {
  // The name rule quotes a name the contact gave itself: “Ana”.
  await page
    .getByRole('heading', { name: new RegExp(`^You and “?${name}”? are connected$`) })
    .waitFor({ timeout: ms });
  await seesDigits(page, ms);
}

/**
 * The Connected moment on a side that only has the contact's own (self-declared) name (WP-3): it
 * says "You are connected" and puts nothing the contact chose into the hello prompt.
 */
export async function seesConnectedUnnamed(page: Page, chosen: string, ms = 30_000): Promise<void> {
  await page
    .getByRole('heading', { name: 'You are connected', exact: true })
    .waitFor({ timeout: ms });
  const before = await page.locator('body').innerText();
  if (!before.includes('Say hello to my new contact on AgentLink.')) {
    throw new Error('the hello prompt must say "my new contact" before naming');
  }
  if (before.includes(`Say hello to ${chosen}`)) {
    throw new Error('the self-declared name is in the hello prompt before naming');
  }
}

/**
 * The owner names the contact ("Name this contact", confirmed with the owner's presence); only then
 * "You and {alias} are connected" and the hello prompt carry that name.
 */
export async function namesContact(page: Page, alias: string, ms = 30_000): Promise<void> {
  await page.getByLabel('Name this contact').fill(alias);
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await page
    .getByRole('button', { name: /^Confirm with (Touch ID|Windows Hello|your passkey)$/ })
    .click();
  await seesConnected(page, alias, ms);
  await page.getByText(`Say hello to ${alias} on AgentLink.`).first().waitFor({ timeout: ms });
}

/** Both steps, for a side where nothing else is in flight. */
export async function seesConnectedThenNames(
  page: Page,
  chosen: string,
  alias = chosen,
  ms = 30_000,
): Promise<void> {
  await seesConnectedUnnamed(page, chosen, ms);
  await namesContact(page, alias, ms);
}
