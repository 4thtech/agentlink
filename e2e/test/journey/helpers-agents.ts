// W4-AGENTS: the Agents moves shared by chapter 4 (agents) and chapter 6 (power user). Every move is
// a click in the app (never `goto`), so the no-reload probe of world.ts holds.
import type { Page } from 'playwright';
import { CONNECT_WITH } from './helpers-wizard.js';
import { CONFIRM_PASSKEY, withDiagnostics } from './world.js';

/**
 * W4-SHELL-V2: the agent chip's dropdown, top left, opens the Agents page ("Manage agents"; Agents
 * is also a section of the menu). An in-app move, never `goto`.
 */
export async function openAgents(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^ID: / }).first().click();
  await page.getByRole('menuitem', { name: 'Manage IDs' }).click();
  await page.getByRole('heading', { name: 'IDs', level: 1 }).first().waitFor();
}

/**
 * The agent chip → Add agent → Get started's add mode (W4-WIRE-2, Decision 52 (2)): "Name your
 * agent" → Continue → an AI app that is not on this computer (the agent alone, as the old Add sheet
 * made it; no app moves to it) → one Touch ID → "{label} is ready" → Go to Home, in the app.
 */
export async function addAgent(page: Page, label: string): Promise<void> {
  await withDiagnostics(page, `add agent "${label}"`, async () => {
    await page.getByRole('button', { name: /^ID: / }).first().click();
    await page.getByRole('menuitem', { name: 'New ID' }).click();
    await page.getByRole('heading', { name: 'Name this ID', level: 1 }).waitFor();
    await fillNameAfterPrefill(page, label);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('heading', { name: 'Which AI app do you use?' }).waitFor();
    await page.getByRole('button').filter({ hasText: 'Not found yet' }).first().click();
    await page
      .getByRole('button', { name: /^Continue with / })
      .first()
      .click();
    await page.getByRole('button', { name: CONNECT_WITH }).click();
    // The app answers "{label} is ready" or shows an alert. Wait for either: a refusal fails at
    // once with the app's own words, and a slow host gets the time the signing needs.
    const ready = page.getByRole('heading', { name: labelled('', label, ' is ready') });
    const refused = page.getByRole('alert').first();
    const won = await Promise.race([
      ready.waitFor({ timeout: 60_000 }).then(() => 'ready' as const),
      refused.waitFor({ timeout: 60_000 }).then(() => 'refused' as const),
    ]);
    if (won === 'refused') {
      throw new Error(`the app refused: ${(await refused.innerText()).slice(0, 300)}`);
    }
    await page.getByRole('button', { name: 'Go to Home', exact: true }).click();
    await page.getByRole('navigation', { name: 'Sections' }).first().waitFor();
  });
}

/**
 * The name field starts with the open ID's name once the list of IDs has been read. Wait for that
 * read first, so what is typed is not overwritten by it (or typed over it).
 */
export async function fillNameAfterPrefill(page: Page, label: string): Promise<void> {
  await page
    .waitForFunction(
      () => {
        const input = document.querySelector<HTMLInputElement>('input[name="agent-name"]');
        return input !== null && input.value !== '';
      },
      undefined,
      { timeout: 10_000 },
    )
    .catch(() => undefined);
  await page.getByLabel('Name people see').fill(label);
  await page.waitForFunction(
    (expected) =>
      document.querySelector<HTMLInputElement>('input[name="agent-name"]')?.value === expected,
    label,
    { timeout: 5_000 },
  );
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

/**
 * WP-I1: Back up (open ID), AI apps and Remove sit behind the card's "More" button; a card with no
 * AI app shows Remove directly. Opens More when needed and returns the button.
 */
export async function inMore(page: Page, label: string, name: string) {
  const card = agentCard(page, label);
  const direct = card.getByRole('button', { name, exact: true });
  // The card mounts again while the list is read (the button can detach under the click): retry,
  // and only press More while it is closed (it toggles).
  const more = card.getByRole('button', { name: 'More about this ID', exact: true });
  for (let attempt = 0; attempt < 5 && (await direct.count()) === 0; attempt += 1) {
    try {
      if ((await more.getAttribute('aria-expanded', { timeout: 5_000 })) !== 'true') {
        await more.click({ timeout: 5_000 });
      }
      await direct.waitFor({ timeout: 3_000 });
    } catch {
      // detached or not yet drawn: look again
    }
  }
  return direct;
}

/** Agents → the agent's Remove → type the name → Remove with Touch ID. */
export async function removeAgent(page: Page, label: string): Promise<void> {
  await openAgents(page);
  await (await inMore(page, label, 'Remove')).click();
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
