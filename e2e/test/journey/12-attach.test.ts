// ATT-APP-ATTACH (08 §1 "Attach a file"; D-150 proposed; I-4, I-5): the owner's wish. Bo attaches a
// Markdown file in his conversation with Ana and sends it himself, without asking his AI:
// - Attach (the file picker) adds a chip; another type is refused with one plain line; Remove takes
//   a chip out; a note goes with it; Send sends once ("Sent to Ana.");
// - the copy is in Bo's Send folder (his own `~/AgentLink/Send`, mode 0600);
// - Ana's AI receives the message with the file, end to end, through the ordinary send.
// The browser signs nothing and no Touch ID is asked for the send (the same rules as Bo's AI).
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chapter, eventually, journeyWorld, navTo, pairedOwners, text } from './world.js';

const ch = chapter();
beforeAll(() => ch.start(), 120_000);
afterAll(() => ch.stop());

const NOTES = ['# Meeting notes', '', '- ship the attach button', '- Markdown first', ''].join(
  '\n',
);

describe('chapter 12: attach a file in the conversation', () => {
  it('Bo attaches notes.md, removes an extra file, adds a note and sends it to Ana', async (ctx) => {
    const ready = ch.need(ctx);
    if (ready === undefined) return;
    const world = journeyWorld();
    const { pcB, b, mcpA } = await pairedOwners(ready.browser, ready.files, world, ch.closers);

    await navTo(b.page, 'Home');
    const anaRow = b.page
      .getByRole('button', { name: /^A(na)?\b/ })
      .filter({ hasText: 'Ana' })
      .first();
    await anaRow.waitFor({ timeout: 30_000 });
    await anaRow.click();
    const zone = b.page.locator('[data-attach-zone]').first();
    await zone.waitFor({ timeout: 30_000 });
    const picker = zone.locator('input[type="file"]');

    // Another type is refused before anything leaves.
    await picker.setInputFiles({
      name: 'run.exe',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('MZ'),
    });
    await eventually('the type refusal', async () =>
      (await text(b.page)).includes('Only Markdown, text and JSON files'),
    );
    expect(await zone.locator('[data-attach-chip]').count()).toBe(0);

    // Two files as chips; Remove takes one out.
    await picker.setInputFiles([
      { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from(NOTES) },
      { name: 'extra.txt', mimeType: 'text/plain', buffer: Buffer.from('not this one') },
    ]);
    await eventually(
      'two chips',
      async () => (await zone.locator('[data-attach-chip]').count()) === 2,
    );
    await zone.getByRole('button', { name: 'Remove extra.txt' }).click();
    await eventually(
      'one chip',
      async () => (await zone.locator('[data-attach-chip]').count()) === 1,
    );
    expect(await zone.locator('[data-attach-chip]').first().textContent()).toContain('notes.md');

    await zone.getByLabel('Add a note (optional)').fill('Notes from today.');
    await zone.getByRole('button', { name: 'Send', exact: true }).click();
    await eventually('sent', async () => (await text(b.page)).includes('Sent to Ana.'));
    expect(await zone.locator('[data-attach-chip]').count()).toBe(0);

    // The copy in Bo's own Send folder, private to him.
    const copy = join(pcB.home, 'AgentLink', 'Send', 'notes.md');
    expect(await readFile(copy, 'utf8')).toBe(NOTES);
    if (process.platform !== 'win32') expect((await stat(copy)).mode & 0o777).toBe(0o600);

    // Ana's AI gets the message with the file, end to end.
    // One inbox read holds both (a read marks the message read for the AI).
    let inbox = '';
    await eventually(
      'Ana has the file',
      async () => {
        inbox = JSON.stringify((await mcpA.call('agentlink_inbox')).structured);
        return inbox.includes('notes.md');
      },
      60_000,
    );
    expect(inbox).toContain('Notes from today.');

    // Bo's thread shows what he sent, with the file chip.
    await eventually(
      'the sent chip',
      async () =>
        (await b.page.locator('.hm-msg.is-out .hm-chip').filter({ hasText: 'notes.md' }).count()) >
        0,
    );
  }, 240_000);
});
