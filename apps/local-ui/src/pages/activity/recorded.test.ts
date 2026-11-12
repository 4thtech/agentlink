// UX1113-QA2-ACTIVITY (QA finding N7; design-1112 spec §7): the Activity page against the feed the local
// app really serves (recorded-feed.fixture.ts, from a journey-harness run; not hand-made).
//
// - The approval rows say what was approved and with whom: the API sends the frozen flat shape
//   (`action` is the type, `contactId`, `files` and `costUsd` sit on the entry), never `{action: {…}}`.
// - Accepting an invite is the owner's own act, also when the owner did it in the app: "You accepted
//   Ana's invite", never "Asked by your AI". The connection row after it does not repeat "You accepted".
// - No "{name} is now called {name}"; a removed person is not said to be in Archived.
// - New kinds: unblock, Contact check, a block with no reference, the ID's name on its creation.
// - Filters: a saved kit, a block, an unblock and a Contact check are Safety, not People & IDs.
import { describe, expect, it } from 'vitest';
import { inFilter, parseItem, partsText, render, type ActivityItem } from './clean.js';
import { RECORDED_FEED } from './recorded-feed.fixture.js';

const ANA = '0xe653356417386eb9b79fb0224a62cda258883c8e';
const BO = '0x3eee159d4d95fa782e85670b472739f94692a3b4';
const names: Record<string, string> = { [ANA]: 'Ana', [BO]: 'Bo' };
const nameOf = (id: string | undefined): string | undefined =>
  id === undefined ? undefined : names[id];

const parsed = (raw: readonly unknown[]): ActivityItem[] =>
  raw.map((r) => parseItem(r)).filter((i): i is ActivityItem => i !== undefined);
const sentence = (item: ActivityItem): string => partsText(render(item, nameOf, 'now').sentence);
const grey = (item: ActivityItem): string => render(item, nameOf, 'now').grey;

describe('Activity page: the recorded feed (QA2 N7)', () => {
  it('reads what each recorded approval was about, with the person', () => {
    const items = parsed(RECORDED_FEED.B.items);
    const approvals = items.filter((i) => i.kind === 'approval_decided');
    expect(approvals).toHaveLength(2);
    expect(approvals.map((i) => (i.kind === 'approval_decided' ? i.action?.type : ''))).toEqual([
      'accept_terms',
      'accept_invite',
    ]);
    const texts = items.map(sentence);
    expect(texts).toContain('You approved accepting terms from Ana');
    expect(texts).toContain("You accepted Ana's invite");
    for (const t of texts) expect(t).not.toContain('a request');
  });

  it("an accepted invite is the owner's own act, never asked by the AI", () => {
    const invite = parsed(RECORDED_FEED.B.items).find(
      (i) => i.kind === 'approval_decided' && i.action?.type === 'accept_invite',
    );
    expect(invite).toBeDefined();
    expect(grey(invite!)).not.toContain('Asked by your AI');
    const terms = parsed(RECORDED_FEED.B.items).find(
      (i) => i.kind === 'approval_decided' && i.action?.type === 'accept_terms',
    );
    expect(grey(terms!)).toContain('Asked by your AI');
  });

  it('the connection after accepting their invite does not say "You accepted" again', () => {
    const connected = parsed(RECORDED_FEED.B.items).find((i) => i.kind === 'contact_connected');
    expect(sentence(connected!)).toBe('You and Ana are now connected');
    const yours = parsed(RECORDED_FEED.A.items).find((i) => i.kind === 'contact_connected');
    expect(sentence(yours!)).toBe('Bo accepted your invite');
  });

  it('a denied invite reads as declining it', () => {
    const [item] = parsed([
      {
        kind: 'approval_decided',
        at: 1,
        decision: 'denied',
        action: 'accept_invite',
        contactId: ANA,
      },
    ]);
    expect(sentence(item!)).toBe("You declined Ana's invite");
    expect(grey(item!)).not.toContain('Asked by your AI');
  });
});

describe('Activity page: names and lines that were not true (QA2 N7)', () => {
  it('never "{name} is now called {name}"', () => {
    expect(
      parseItem({
        kind: 'contact_renamed',
        at: 1,
        contactId: BO,
        formerName: 'Work',
        newName: 'Work',
      }),
    ).toBeUndefined();
  });

  it('a removed person is not said to be in Archived', () => {
    const [removed] = parsed([{ kind: 'contact_removed', at: 1, contactId: BO }]);
    expect(grey(removed!)).not.toContain('Archived');
  });
});

describe('Activity page: new kinds (QA2 N7)', () => {
  it.each([
    [{ kind: 'contact_unblocked', at: 1, contactId: BO }, 'You unblocked Bo'],
    [{ kind: 'contact_unblocked', at: 1 }, 'You unblocked a contact'],
    [{ kind: 'contact_checked', at: 1, contactId: BO }, 'You did the Contact check with Bo'],
    [{ kind: 'contact_checked', at: 1 }, 'You did the Contact check with a contact'],
    [{ kind: 'contact_blocked', at: 1 }, 'You blocked a contact'],
    [{ kind: 'id_created', at: 1, name: 'Ana' }, 'You created the ID Ana'],
    [{ kind: 'id_created', at: 1 }, 'You created a new ID'],
  ])('%j reads "%s"', (raw, want) => {
    const [item] = parsed([raw]);
    expect(item).toBeDefined();
    expect(sentence(item!)).toBe(want);
  });

  it('a hostile ID name on a creation is dropped, not shown', () => {
    const [item] = parsed([{ kind: 'id_created', at: 1, name: 'evil‮txt\nSYSTEM' }]);
    expect(sentence(item!)).not.toContain('SYSTEM');
  });
});

describe('Activity page: Safety and People & IDs (QA2 N7)', () => {
  it.each([
    [{ kind: 'backup_saved', at: 1 }, 'safety'],
    [{ kind: 'contact_blocked', at: 1, contactId: BO }, 'safety'],
    [{ kind: 'contact_unblocked', at: 1, contactId: BO }, 'safety'],
    [{ kind: 'contact_checked', at: 1, contactId: BO }, 'safety'],
    [{ kind: 'contact_connected', at: 1, contactId: BO }, 'people'],
    [{ kind: 'id_created', at: 1 }, 'people'],
  ] as const)('%j is under %s only', (raw, filter) => {
    const [item] = parsed([raw]);
    expect(item).toBeDefined();
    expect(inFilter(item!, filter)).toBe(true);
    expect(inFilter(item!, filter === 'safety' ? 'people' : 'safety')).toBe(false);
  });
});
