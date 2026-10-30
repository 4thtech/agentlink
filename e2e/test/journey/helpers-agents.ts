// W4-AGENTS: the Agents moves shared by chapter 4 (agents) and chapter 6 (power user). Every move is
// a click in the app (never `goto`), so the no-reload probe of world.ts holds.
import type { Page } from 'playwright';
import { CONFIRM_PASSKEY } from './world.js';

/**
 * W4-SHELL-V2: the agent chip's dropdown, top left, opens the Agents page ("Manage agents"; Agents
 * is also a section of the menu). An in-app move, never `goto`.
 */
export async function openAgents(page: Page): Promise<void> {
  await page
    .getByRole('button', { name: /^Agent: / })
    .first()
    .click();
  await page.getByRole('menuitem', { name: 'Manage agents' }).click();
  await page.getByRole('heading', { name: 'Agents', level: 1 }).first().waitFor();
}

/**
 * The agent chip → Add agent (the switcher opens Add on the Agents page) → name → Add with Touch ID
 * → Not now. W4-AGENTS: the page's own "New agent" goes to Get started (U2); the chip keeps the sheet.
 */
export async function addAgent(page: Page, label: string): Promise<void> {
  await page
    .getByRole('button', { name: /^Agent: / })
    .first()
    .click();
  await page.getByRole('menuitem', { name: 'Add agent' }).click();
  await page.getByLabel('Name your agent').fill(label);
  await page.getByRole('button', { name: 'Add with Touch ID' }).click();
  await page.getByRole('button', { name: CONFIRM_PASSKEY }).click();
  await page.getByText('Connect an AI app to it?').waitFor();
  await page.getByRole('button', { name: 'Not now' }).click();
}

/** A label as the app words it in titles and statements: inside U+2068 … U+2069 (bidi isolates). */
export function labelled(before: string, label: string, after = ''): RegExp {
  const esc = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${esc(before)}\u2068?${esc(label)}\u2069?${esc(after)}$`);
}

/** The agent's card on the simple Agents page: a region named by its label. */
export function agentCard(page: Page, label: string) {
  return page.getByRole('main').getByRole('region', { name: label, exact: true }).first();
}

/** Agents → the agent's Remove → type the name → Remove with Touch ID. */
export async function removeAgent(page: Page, label: string): Promise<void> {
  await openAgents(page);
  await agentCard(page, label).getByRole('button', { name: 'Remove', exact: true }).click();
  await page.getByRole('heading', { name: labelled('Remove ', label, '?') }).waitFor();
  await page.getByLabel(labelled('Type ', label, ' to confirm')).fill(label);
  await page.getByRole('button', { name: 'Remove with Touch ID' }).click();
  const confirm = page.getByRole('button', { name: CONFIRM_PASSKEY });
  // W4-WIRE: the label is its own bidi-isolated run in the sentence (I-5).
  const done = page.getByText(labelled('', label, ' was removed.')).first();
  await Promise.race([confirm.waitFor().then(() => confirm.click()), done.waitFor()]).catch(
    () => undefined,
  );
  await done.waitFor({ timeout: 30_000 });
}

/** Under the hood on, from the top bar switch. */
export async function hoodOn(page: Page): Promise<void> {
  const sw = page.getByRole('switch', { name: /Under the hood/ }).first();
  if ((await sw.getAttribute('aria-checked')) !== 'true') await sw.click();
}
