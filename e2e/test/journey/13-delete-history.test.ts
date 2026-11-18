// RET-4 (D-148; 04 §4.2 "Presence and undo"; 08 §1 "The delete sheet"): Bo deletes his history with
// Ana in the app. The sheet shows what it removes; one Touch ID press; the 10-second Undo toast
// cancels it (nothing deleted); a second delete, left alone, removes the messages from this computer
// only: Bo's AI no longer reads them.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { until } from '../app-world.js';
import {
  CONFIRM_PASSKEY,
  chapter,
  eventually,
  inboxHas,
  journeyWorld,
  navTo,
  pairedOwners,
  text,
} from './world.js';

const ch = chapter();
beforeAll(() => ch.start(), 120_000);
afterAll(() => ch.stop());

const NOTE = 'RET4-journey-note';

/** Whether Bo's AI still reads the note (read ones included; core skips deleted messages). */
async function aiReads(mcp: Parameters<typeof inboxHas>[0], needle: string): Promise<boolean> {
  const all = await mcp.call('agentlink_inbox', { includeRead: true, limit: 50 });
  return JSON.stringify(all.structured).includes(needle);
}

describe('chapter 13: delete a person’s history, undo, delete again', () => {
  it('Bo deletes his history with Ana; Undo keeps it; the second delete removes it here only', async (ctx) => {
    const ready = ch.need(ctx);
    if (ready === undefined) return;
    const world = journeyWorld();
    const { b, mcpA, mcpB } = await pairedOwners(ready.browser, ready.files, world, ch.closers);
    for (const n of [1, 2]) {
      const sent = await mcpA.call('agentlink_send', { to: 'Bo', text: `${NOTE} ${String(n)}` });
      expect(sent.structured['status']).toBe('ok');
    }
    await until('Bo has both notes', () => inboxHas(mcpB, `${NOTE} 2`), 30_000);

    await navTo(b.page, 'Home');
    const anaRow = b.page
      .getByRole('button', { name: /^A(na)?\b/ })
      .filter({ hasText: 'Ana' })
      .first();
    await anaRow.waitFor({ timeout: 30_000 });
    await anaRow.click();
    await eventually('the notes show', async () => (await text(b.page)).includes(`${NOTE} 2`));

    // Bo's AI app acknowledges each message it reads after a random 5-90 s delay (D-156), and every
    // ack is a stored row of this conversation, so one can land between the sheet's list and the
    // press, or inside the Undo window. Core then refuses the apply because the list changed (the
    // safe direction; the app says "What would be deleted changed. Check it again."). The journey
    // reads that real outcome and presses again on the refreshed list, rather than waiting blind.
    const CHANGED = 'What would be deleted changed. Check it again.';
    const press = b.page.getByRole('button', {
      name: /^Delete with (Touch ID|Windows Hello|your passkey)$/,
    });
    const deleteOnce = async (): Promise<void> => {
      // A refusal notice from an earlier round is gone before the next round starts.
      await eventually(
        'the old notice is gone',
        async () => !(await text(b.page)).includes(CHANGED),
      );
      await b.page.getByRole('button', { name: /^More for Ana/ }).click();
      await b.page.getByRole('menuitem', { name: 'Delete history…' }).click();
      await b.page.getByText('Delete history with Ana?').waitFor();
      await eventually('the counts show', async () => /\d+ messages?,/.test(await text(b.page)));
      expect(await text(b.page)).toContain(
        'Only on this computer; Ana keeps their copy and is not told.',
      );
      const confirm = b.page.getByRole('button', { name: CONFIRM_PASSKEY });
      const toast = b.page.getByText(/^Deleted \d+ messages?\.$/).first();
      for (let attempt = 0; ; attempt += 1) {
        await press.click();
        let done = false;
        await eventually(
          'the delete scheduled or the list refreshed',
          async () => {
            if (await confirm.isVisible()) await confirm.click().catch(() => undefined);
            if (await toast.isVisible()) return (done = true);
            // The sheet re-reads its list after a refusal and offers the button again.
            return (
              (await text(b.page)).includes(CHANGED) &&
              (await press.isVisible()) &&
              (await press.isEnabled())
            );
          },
          30_000,
        );
        if (done) return;
        expect(attempt, 'the list kept changing').toBeLessThan(6);
      }
    };

    // 1. Delete, then Undo inside the window: nothing is deleted.
    await deleteOnce();
    await b.page.getByRole('button', { name: 'Undo' }).first().click();
    await b.page.getByText('Nothing was deleted.').first().waitFor({ timeout: 10_000 });
    await b.page.waitForTimeout(11_000);
    expect(await aiReads(mcpB, `${NOTE} 1`)).toBe(true);
    expect(await text(b.page)).toContain(`${NOTE} 1`);

    // 2. Delete again and let the window end: gone from this computer. If an ack landed in the
    //    window the apply is refused ("changed") and nothing is gone yet: delete again on the new list.
    for (let attempt = 0; ; attempt += 1) {
      await deleteOnce();
      let applied = false;
      await eventually(
        'the delete applied or refused',
        async () => {
          if (!(await aiReads(mcpB, `${NOTE} 1`))) return (applied = true);
          return (await text(b.page)).includes(CHANGED);
        },
        40_000,
      );
      if (applied) break;
      expect(attempt, 'the list kept changing').toBeLessThan(6);
    }
    expect(await aiReads(mcpB, `${NOTE} 2`)).toBe(false);
    await eventually('the conversation no longer shows them', async () => {
      const shown = await text(b.page);
      return !shown.includes(`${NOTE} 1`) && !shown.includes(`${NOTE} 2`);
    });
  }, 240_000);
});
