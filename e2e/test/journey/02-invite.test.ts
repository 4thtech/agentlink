// W4-JOURNEY-E2E chapter 2, Contacts and invites (WAVE-4 build plan §1 steps 2–3; D-139 short invite
// links; 08 §4). Two computers on one relay and one drop, each with its owner's real passkey (the
// virtual authenticator). See world.ts for the gesture counter and the no-reload probe.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { until } from '../app-world.js';
import {
  acceptInviteInApp,
  chapter,
  checkInviteInApp,
  createInviteInApp,
  eventually,
  journeyWorld,
  navTo,
  pairedWith,
  SHORT_INVITE,
  text,
  twoOwners,
  WAVE4,
  type JourneyPage,
} from './world.js';

const ch = chapter();
beforeAll(() => ch.start(), 120_000);
afterAll(() => ch.stop());

const contactList = (page: JourneyPage['page']) =>
  page.getByRole('list', { name: 'Your contacts' });

/** The contact row appears in the list by itself; its detail shows the safety code. */
async function seesSafetyCode(jp: JourneyPage, name: string): Promise<void> {
  const { page } = jp;
  await eventually(
    `the contact list shows ${name}`,
    async () => (await contactList(page).getByText(name).count()) > 0,
    30_000,
  );
  await contactList(page).getByText(name).first().click();
  await page.getByText('Safety code', { exact: true }).first().waitFor({ timeout: 30_000 });
}

describe('chapter 2: contacts and invites', () => {
  // Passes today. Accepts a long or a short link, so it stays green when W4-SHORT-INVITE lands.
  it('an invite accepted on computer 2 pairs both agents, with one Touch ID and no reload', async (ctx) => {
    const ready = ch.need(ctx);
    if (ready === undefined) return;
    const world = journeyWorld();
    const { a, b, mcpA, mcpB } = await twoOwners(ready.browser, ready.files, world, ch.closers);
    const aProbe = await a.arm();
    const bProbe = await b.arm();
    const aBefore = a.gestures.total();
    const bBefore = b.gestures.total();

    const link = await createInviteInApp(a);
    expect(link).not.toBe('');
    await acceptInviteInApp(b, link, 'Ana');
    // Both agents complete the pairing over the shared relay (the pages: see the next test).
    await until('Bo is paired with Ana', () => pairedWith(mcpB, 'Ana'), 30_000);
    await until('Ana is paired with Bo', () => pairedWith(mcpA, 'Bo'), 30_000);

    // Gestures: creating an invite needs none; accepting needs one.
    expect(a.gestures.total() - aBefore).toBe(0);
    expect(b.gestures.total() - bBefore).toBe(1);
    await aProbe.check();
    await bProbe.check();
    // Zero access: the relay never holds the link's secret.
    expect(JSON.stringify(world.relays.events())).not.toContain(link.split('#')[1] ?? '?');
  }, 180_000);

  // Gate (still): W4-INVITES-LIST made both Contacts pages follow (the inviter while its invite is
  // open, the accepter for two minutes after Connect), but in this run neither agent completes the
  // pairing within 30 s when nothing calls the AI app's MCP server: computer 1 keeps "Waiting for them
  // to accept" and computer 2 "Connecting to …" (checked 29 Oct on w4-short-invite). The host pass
  // and the idle MCP server's publisher lease need a look (06 §6); the orchestrator routes it.
  it.runIf(WAVE4)(
    'both Contacts pages reach the safety code by themselves, with no navigation (30 s)',
    async (ctx) => {
      const ready = ch.need(ctx);
      if (ready === undefined) return;
      const world = journeyWorld();
      const { a, b } = await twoOwners(ready.browser, ready.files, world, ch.closers);
      const aProbe = await a.arm();
      const bProbe = await b.arm();
      const link = await createInviteInApp(a);
      await a.page.getByText('Waiting for them to accept').first().waitFor();
      await acceptInviteInApp(b, link, 'Ana');
      await seesSafetyCode(b, 'Ana');
      await seesSafetyCode(a, 'Bo');
      await aProbe.check();
      await bProbe.check();
    },
    180_000,
  );

  // W4-SHORT-INVITE (link, drop object) and W4-INVITES-LIST (pending row read from the server,
  // Cancel).
  it('a short invite link; a pending row that survives leaving the page; Cancel (D-139)', async (ctx) => {
    const ready = ch.need(ctx);
    if (ready === undefined) return;
    const world = journeyWorld();
    const { a, b } = await twoOwners(ready.browser, ready.files, world, ch.closers);
    const aProbe = await a.arm();

    // The link is short: `https://<host>/i#2.<43>`, at most 80 characters.
    const link = await createInviteInApp(a);
    expect(link).toMatch(SHORT_INVITE);
    expect(link.length).toBeLessThanOrEqual(80);
    // The drop holds only the ALI1 ciphertext: never the link secret.
    const secret = link.split('#')[1] ?? '?';
    const dropDump = JSON.stringify(
      world.drop.seen.map((s) => ({ ...s, body: Buffer.from(s.body).toString('latin1') })),
    );
    expect(dropDump).not.toContain(secret);
    expect(dropDump).not.toContain(secret.slice(2));

    // The open invite is a pending row, read from the server (it survives leaving the page).
    // (Inbox goes through Go to in the wave-4 shell: world.ts INTERIM.)
    await navTo(a.page, 'Inbox');
    await navTo(a.page, 'Contacts');
    await a.page.getByText('Waiting for them to accept').first().waitFor();
    await a.page.getByRole('button', { name: 'Cancel' }).first().click();
    await eventually(
      'the pending row goes',
      async () => !(await text(a.page)).includes('Waiting for them to accept'),
    );

    // A cancelled invite cannot be used on computer 2.
    await checkInviteInApp(b, link);
    await eventually('the invite is refused', async () =>
      /expired|already used|can't be used|isn't a complete/.test(await text(b.page)),
    );
    await aProbe.check();
  }, 180_000);
});
