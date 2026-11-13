// UX1113-QA2-ACTIVITY (QA finding N7; design-1112 spec §7): Activity on two real computers. Bo accepts
// Ana's invite in the app (the owner's own act), Ana's AI offers terms, Bo's AI accepts them and Bo
// approves on Home with one Touch ID. Bo's Activity then says what each approval was about and with
// whom, never "You approved a request"; the invite reads as his own act, not "Asked by your AI"; first
// run reads as creating the ID, not as a rename and a rules change.
//
// The harness has no proof network (app-world `proofs: () => undefined`), so a message or file sent
// with proof (an `agentlink_notarize` approval) cannot be approved here; that path is covered by the
// feed's unit tests (packages/core activity-kinds, apps/local-ui activity).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { until } from '../app-world.js';
import {
  chapter,
  eventually,
  journeyWorld,
  navTo,
  pairedOwners,
  text,
} from './world.js';

const ch = chapter();
beforeAll(() => ch.start(), 120_000);
afterAll(() => ch.stop());

describe('chapter 9: activity', () => {
  it('approvals say what they were about and with whom; the invite and first run are the owner’s own', async (ctx) => {
    const ready = ch.need(ctx);
    if (ready === undefined) return;
    const world = journeyWorld();
    const { a, b, mcpA, mcpB } = await pairedOwners(ready.browser, ready.files, world, ch.closers);

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
    const asked = await mcpB.call('agentlink_respond_to_terms', { envelopeId, decision: 'accept' });
    expect(asked.structured['status']).toBe('pending_approval');
    await navTo(b.page, 'Home');
    const card = b.page
      .getByRole('region', { name: 'Waiting for your approval' })
      .filter({ hasText: 'Logo design' })
      .first();
    await card.waitFor({ timeout: 30_000 });
    await card
      .getByRole('button', { name: /^Approve/ })
      .first()
      .click();
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

    await navTo(b.page, 'Activity');
    const rowsB = b.page.locator('li.al-act-row');
    // The list refreshes on its own (live updates): read it once it holds the rows.
    let bText = '';
    await eventually('Bo’s activity lists both approvals', async () => {
      bText = await text(b.page);
      return bText.includes('accepting terms') && bText.includes('invite');
    });
    expect(bText).toContain('You approved accepting terms from Ana');
    expect(bText).toContain("You accepted Ana's invite");
    expect(bText).toContain('You and Ana are now connected');
    expect(bText).toContain('You created the ID Bo');
    expect(bText).not.toContain('You approved a request');
    expect(bText).not.toContain('A request from your AI');
    expect(bText).not.toContain('You accepted the invite from Ana');
    expect(bText).not.toContain('You renamed an ID');
    expect(bText).not.toContain('You changed your rules');
    expect(bText).not.toMatch(/(\S+) is now called \1\b/);
    const invite = rowsB.filter({ hasText: "You accepted Ana's invite" }).first();
    expect(await invite.innerText()).not.toContain('Asked by your AI');
    const terms = rowsB.filter({ hasText: 'accepting terms from Ana' }).first();
    expect(await terms.innerText()).toContain('Asked by your AI');

    await navTo(a.page, 'Activity');
    // The list refreshes on its own (live updates): read it once it holds the rows.
    let aText = '';
    await eventually('Ana’s activity lists the connection and the ID', async () => {
      aText = await text(a.page);
      return aText.includes('Bo accepted your invite') && aText.includes('You created the ID');
    });
    expect(aText).toContain('Bo accepted your invite');
    expect(aText).toContain('You created the ID Ana');
    expect(aText).not.toContain('You renamed an ID');
    expect(aText).not.toContain('You changed your rules');
  }, 300_000);
});
