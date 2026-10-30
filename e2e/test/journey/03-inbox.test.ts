// W4-JOURNEY-E2E chapter 3, Home (W4-HOME; WAVE-4 build plan §1 steps 4–6; 08 §1 IA; b11 §34.4). Ana and Bo
// are paired through the app (the start state passes today). Messages are written by each side's AI
// app (its MCP server); the owners read, save and approve in the Inbox. See world.ts for the gesture
// counter and the no-reload probe.
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, rename, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { encodeHex, randomBytes, sha256 } from '@4thtech-io/crypto';
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
  type FakeDrop,
  type JourneyComputer,
} from './world.js';
import {
  CLS_BUDGET,
  emulateReducedMotion,
  expectFadesOnly,
  layoutShiftScore,
  shiftCount,
  shiftsSince,
  observeLayoutShift,
} from '../helpers/motion.js';

const ch = chapter();
beforeAll(() => ch.start(), 120_000);
afterAll(() => ch.stop());

const HELLO = 'Hello Bo, this is Ana';
const REPLY = 'Hi Ana, Bo here';
const FILE_NAME = 'brief.txt';

/**
 * A file in A's Send folder (first run allows ~/AgentLink/Send): a marker and random bytes, larger
 * than an inline file (MAX_INLINE_FILE_BYTES), so it goes through the drop.
 */
async function sendable(pc: JourneyComputer): Promise<{ path: string; bytes: Buffer }> {
  const folder = join(pc.home, 'AgentLink', 'Send');
  await mkdir(folder, { recursive: true });
  const bytes = Buffer.concat([
    Buffer.from('journey-file-marker '),
    Buffer.from(randomBytes(256 * 1024)),
  ]);
  const path = join(folder, FILE_NAME);
  await writeFile(path, bytes, { mode: 0o600 });
  return { path, bytes };
}

/** Zero access: the drop saw only ciphertext (never the file's bytes or the message text). */
function dropHoldsNoPlaintext(drop: FakeDrop, bytes: Buffer): void {
  const marker = bytes.subarray(0, 20);
  const middle = bytes.subarray(1000, 1064);
  for (const s of drop.seen) {
    const body = Buffer.from(s.body);
    expect(body.includes(marker)).toBe(false);
    expect(body.includes(middle)).toBe(false);
    expect(body.toString('latin1')).not.toContain(HELLO);
  }
  for (const o of drop.objects.values()) {
    if (o.bytes !== undefined) expect(Buffer.from(o.bytes).includes(middle)).toBe(false);
  }
}

describe('chapter 3: inbox', () => {
  // Passes today: the harness's shared relay and drop carry a hello, a reply and a file between the
  // two computers (agent level; Home is the last test below).
  it('hello, reply and a file travel between the two computers; the drop holds ciphertext only', async (ctx) => {
    const ready = ch.need(ctx);
    if (ready === undefined) return;
    const world = journeyWorld();
    const { pcA, mcpA, mcpB } = await pairedOwners(ready.browser, ready.files, world, ch.closers);

    expect(
      (await mcpA.call('agentlink_send', { to: 'Bo', text: HELLO })).structured['status'],
    ).toBe('ok');
    await until('the hello reaches Bo', () => inboxHas(mcpB, HELLO), 30_000);
    expect(
      (await mcpB.call('agentlink_send', { to: 'Ana', text: REPLY })).structured['status'],
    ).toBe('ok');
    await until('the reply reaches Ana', () => inboxHas(mcpA, REPLY), 30_000);

    const file = await sendable(pcA);
    const sent = await mcpA.call('agentlink_send', {
      to: 'Bo',
      text: 'The brief',
      path: file.path,
    });
    expect(sent.structured['status']).toBe('ok');
    await until('the file reaches Bo', () => inboxHas(mcpB, FILE_NAME), 30_000);
    expect([...world.drop.objects.values()].some((o) => o.committed)).toBe(true);
    dropHoldsNoPlaintext(world.drop, file.bytes);
  }, 180_000);

  // W4-FILES-SAVE (un-gated): a received file is saved from the app with one Touch ID, from the
  // sender's Files on Home (W4-HOME). Real host, real decrypt, fake drop; the page sends only the
  // item ID.
  it('a received file: Arrived · not saved, then Save with one Touch ID lands it in the Inbox folder; traversal and links are refused', async (ctx) => {
    const ready = ch.need(ctx);
    if (ready === undefined) return;
    const world = journeyWorld();
    const { pcA, pcB, b, mcpA, mcpB } = await pairedOwners(
      ready.browser,
      ready.files,
      world,
      ch.closers,
    );
    const bProbe = await b.arm();
    const inboxFolder = join(pcB.home, 'AgentLink', 'Inbox');
    const sha = (bytes: Uint8Array): string => encodeHex(sha256(bytes));

    // A link in place of the Inbox folder, pointing into a hidden folder, before the file arrives:
    // the automatic save (W4-AUTO-SAVE, D-142) refuses the folder, so the file waits for Save.
    const planted = join(pcB.home, '.agentlink', 'planted-inbox');
    await mkdir(planted, { recursive: true });
    await mkdir(inboxFolder, { recursive: true });
    await rename(inboxFolder, `${inboxFolder}-real`);
    await symlink(planted, inboxFolder);

    const file = await sendable(pcA);
    await mcpA.call('agentlink_send', { to: 'Bo', text: 'The brief', path: file.path });
    await until('the file reaches Bo', () => inboxHas(mcpB, FILE_NAME), 30_000);
    await navTo(b.page, 'Home');
    await b.page
      .getByRole('button', { name: /^A(na)?\b/ })
      .filter({ hasText: 'Ana' })
      .first()
      .click();
    await b.page.getByText(FILE_NAME).first().waitFor({ timeout: 30_000 });
    await b.page
      .getByText(/Arrived · not saved/)
      .first()
      .waitFor();
    expect(await text(b.page)).not.toContain('Ask your AI to fetch it');
    expect(await b.page.locator('[role="progressbar"]').count()).toBe(0);

    // Traversal: the route takes only `{id}`; anything else is refused before presence, no gesture.
    const before0 = b.gestures.total();
    const refusedStatuses = await b.page.evaluate(async () => {
      const csrf =
        document.querySelector('meta[name="agentlink-csrf"]')?.getAttribute('content') ?? '';
      const b64 = (v: unknown): string =>
        btoa(JSON.stringify(v)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const out: number[] = [];
      for (const input of [
        { id: '../../../.ssh/id_ed25519' },
        { id: 'AQEBAQEBAQEBAQEBAQEBAQ.00/../../x' },
        { id: 'AQEBAQEBAQEBAQEBAQEBAQ.00', path: '/tmp/x' },
        { id: 'AQEBAQEBAQEBAQEBAQEBAQ.00', name: '../x' },
      ]) {
        const res = await fetch('/api/ui/files/save', {
          method: 'POST',
          headers: {
            'X-AgentLink-CSRF': csrf,
            'content-type': 'application/octet-stream',
            'X-AgentLink-Input': b64(input),
          },
          body: new Uint8Array([1]),
        });
        out.push(res.status);
      }
      return out;
    });
    expect(refusedStatuses).toEqual([400, 400, 400, 400]);
    expect(b.gestures.total()).toBe(before0);

    // Save into the linked folder: refused, nothing written.
    expect(readdirSync(planted)).toEqual([]);
    const before1 = b.gestures.total();
    await b.page.getByRole('button', { name: 'Save to Inbox' }).first().click();
    await b.page.getByRole('button', { name: CONFIRM_PASSKEY }).click();
    await b.page
      .getByText(/Inbox folder can't take files/)
      .first()
      .waitFor({ timeout: 30_000 });
    expect(b.gestures.total() - before1).toBe(1);
    expect(readdirSync(planted)).toEqual([]);

    // The real folder back, with a link planted at the file's name: never followed or overwritten.
    await rename(inboxFolder, `${inboxFolder}-link`);
    await rename(`${inboxFolder}-real`, inboxFolder);
    const outside = join(pcB.home, 'outside-target.txt');
    await symlink(outside, join(inboxFolder, FILE_NAME));
    const before2 = b.gestures.total();
    await b.page.getByRole('button', { name: 'Save to Inbox' }).first().click();
    await b.page.getByRole('button', { name: CONFIRM_PASSKEY }).click();
    await eventually('the file is saved', async () => (await text(b.page)).includes('Saved as'));
    expect(b.gestures.total() - before2).toBe(1);
    expect(existsSync(outside)).toBe(false);
    expect(lstatSync(join(inboxFolder, FILE_NAME)).isSymbolicLink()).toBe(true);
    // 04 §4.1 (D-142): the next free name is "{stem} (2){ext}".
    const savedName = 'brief (2).txt';
    expect(sha(readFileSync(join(inboxFolder, savedName)))).toBe(sha(file.bytes));
    expect(await text(b.page)).toContain(savedName);
    // Saved once: no Save button for it any more.
    expect(await b.page.getByRole('button', { name: 'Save to Inbox' }).count()).toBe(0);
    dropHoldsNoPlaintext(world.drop, file.bytes);
    await bProbe.check();
  }, 240_000);

  // W4-HOME (un-gated): Home at `/` holds what the Inbox held. A person row opens in place to the
  // conversation (both ways, the other side's words in the untrusted box) and the files (Save with
  // one Touch ID, then Show in Finder / Explorer / folder); the approval card sits on top of Home.
  // Motion (U0 helper): reduced motion runs fades only, and Home's first load does not shift.
  it('Home: hello → reply in the person row; a file arrives and is saved by itself; the approval card on top takes one Touch ID', async (ctx) => {
    const ready = ch.need(ctx);
    if (ready === undefined) return;
    const world = journeyWorld();
    const { pcA, pcB, a, b, mcpA, mcpB } = await pairedOwners(
      ready.browser,
      ready.files,
      world,
      ch.closers,
    );
    await emulateReducedMotion(b.page);
    await observeLayoutShift(b.page);
    const aProbe = await a.arm();
    const bProbe = await b.arm();
    await navTo(a.page, 'Home');
    // Home's own first load moves nothing, and neither does the shell around it. W4-WIRE: the
    // "Switch to Touch ID" next step (registered while accepting the invite) left at registration,
    // on the page where it happened, so it is not there when Home opens and never leaves under it
    // (that move once cost Home 0.024–0.037). The score counts from before Home's first load.
    expect(await b.page.locator('main a[href="/first-run"]').count()).toBe(0);
    await b.page.waitForTimeout(500);
    const clsBeforeHome = await layoutShiftScore(b.page);
    const seenBefore = await shiftCount(b.page);
    await navTo(b.page, 'Home');
    await b.page.getByRole('heading', { name: 'People' }).waitFor();
    await b.page.waitForTimeout(500);
    expect(
      (await layoutShiftScore(b.page)) - clsBeforeHome,
      `Home's first load shifted: ${await shiftsSince(b.page, seenBefore)}`,
    ).toBeLessThanOrEqual(CLS_BUDGET);
    const clsBefore = await layoutShiftScore(b.page);
    await navTo(b.page, 'Agents');
    await navTo(b.page, 'Home');
    await b.page.getByRole('heading', { name: 'People' }).waitFor();
    await b.page.waitForTimeout(500);
    expect((await layoutShiftScore(b.page)) - clsBefore).toBeLessThanOrEqual(CLS_BUDGET);

    // Hello (A's AI app): Bo's Home shows Ana with the last activity; the row opens in place.
    await mcpA.call('agentlink_send', { to: 'Bo', text: HELLO });
    const anaRow = b.page
      .getByRole('button', { name: /^A(na)?\b/ })
      .filter({ hasText: 'Ana' })
      .first();
    await anaRow.waitFor({ timeout: 30_000 });
    await eventually('Ana shows a last message', async () =>
      ((await anaRow.textContent()) ?? '').includes('Last message'),
    );
    await anaRow.click();
    await eventually(
      'the row opens in place',
      async () => (await anaRow.getAttribute('aria-expanded')) === 'true',
    );
    await b.page.locator('figure.al-untrusted').filter({ hasText: HELLO }).first().waitFor();
    await expectFadesOnly(b.page);
    await mcpB.call('agentlink_send', { to: 'Ana', text: REPLY });
    const boRow = a.page
      .getByRole('button', { name: /^B(o)?\b/ })
      .filter({ hasText: 'Bo' })
      .first();
    await boRow.waitFor({ timeout: 30_000 });
    await boRow.click();
    await a.page.getByText(REPLY).first().waitFor({ timeout: 30_000 });
    await a.page.getByText('Sent', { exact: true }).first().waitFor({ timeout: 30_000 });

    // A file: W4-AUTO-SAVE (D-142) saves a paired contact's file by itself; Ana's Files on Home
    // shows one light row (W4-WIRE-3): the name, "Saved to ~/AgentLink/Inbox" and Show in Finder /
    // Explorer / folder, with no Touch ID; the name in the compact untrusted container. (Save with one Touch
    // ID, when the automatic save cannot run, is the test above.)
    const file = await sendable(pcA);
    const before = b.gestures.total();
    await mcpA.call('agentlink_send', { to: 'Bo', text: 'The brief', path: file.path });
    await b.page.getByText(FILE_NAME).first().waitFor({ timeout: 30_000 });
    await eventually('the file is saved', async () =>
      (await text(b.page)).includes('Saved to ~/AgentLink/Inbox'),
    );
    // D-133 (4): the name only inside the compact untrusted container; the folder outside it.
    await b.page
      .locator('.hm-file .al-untrusted.is-compact')
      .filter({ hasText: FILE_NAME })
      .first()
      .waitFor();
    expect(
      await b.page.locator('.hm-file .al-untrusted').filter({ hasText: 'Saved to' }).count(),
    ).toBe(0);
    expect(await b.page.locator('[role="progressbar"]').count()).toBe(0);
    expect(b.gestures.total() - before).toBe(0);
    await b.page
      .getByRole('button', { name: /^Show in (Finder|Explorer|folder)$/ })
      .first()
      .waitFor({ timeout: 30_000 });
    const inboxFolder = join(pcB.home, 'AgentLink', 'Inbox');
    const saved = readdirSync(inboxFolder, { recursive: true }).map(String);
    const savedPath = saved.find((n) => n.endsWith(FILE_NAME));
    expect(savedPath).toBeDefined();
    const sha = (bytes: Uint8Array): string => encodeHex(sha256(bytes));
    expect(sha(readFileSync(join(inboxFolder, savedPath ?? '')))).toBe(sha(file.bytes));
    dropHoldsNoPlaintext(world.drop, file.bytes);

    // The approval card on top of Home, confirmed with one Touch ID: Ana offers terms, Bo's AI
    // accepts, the default policy asks Bo, and Bo approves on Home.
    const offer = await mcpA.call('agentlink_propose_terms', {
      to: 'Bo',
      terms: {
        subject: 'Logo design',
        deliverables: [{ description: 'Three logo drafts', by: 'me' }],
        price: { amount: '500.00', currency: 'USD', payer: 'them' },
        deadlines: [{ ref: 'd1', due: '2027-01-30T17:00:00Z' }],
      },
    });
    expect(offer.structured['status']).toBe('ok');
    const envelopeId = await until(
      'the offer reaches Bo',
      async () => {
        const inbox = (await mcpB.call('agentlink_inbox')).structured;
        const messages = (inbox['messages'] ?? []) as Record<string, unknown>[];
        return messages.find((m) => m['type'] === 'offer')?.['envelopeId'];
      },
      30_000,
    );
    const asked = await mcpB.call('agentlink_respond_to_terms', {
      envelopeId,
      decision: 'accept',
    });
    expect(asked.structured['status']).toBe('pending_approval');
    const card = b.page
      .getByRole('region', { name: 'Waiting for your approval' })
      .filter({ hasText: 'Logo design' })
      .first();
    await card.waitFor({ timeout: 30_000 });
    const beforeApprove = b.gestures.total();
    await card
      .getByRole('button', { name: /^Approve/ })
      .first()
      .click();
    await b.page.getByRole('button', { name: CONFIRM_PASSKEY }).click();
    await eventually(
      'the approval is recorded',
      async () =>
        (
          await mcpB.call('agentlink_respond_to_terms', {
            envelopeId,
            decision: 'accept',
            approvalId: asked.structured['approvalId'],
          })
        ).structured['status'] === 'ok',
    );
    expect(b.gestures.total() - beforeApprove).toBe(1);
    // There is no Approvals page in the menu: approvals live on Home.
    expect(
      await b.page.getByRole('navigation').getByRole('link', { name: 'Approvals' }).count(),
    ).toBe(0);
    await aProbe.check();
    await bProbe.check();
  }, 240_000);
});
