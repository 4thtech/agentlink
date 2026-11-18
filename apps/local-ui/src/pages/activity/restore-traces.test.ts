// RESTORE-TRACES (D-156; 11 §5): the restore entry in the spending history, and the quiet label on
// a message received again after a restore.
// - The Activity row says what happened and that paid actions asked for 24 hours. It is never a
//   charge: no amount, never counted with proofs, and it sits under Safety.
// - The conversation shows "From before the restore" under a message from the other side only.
import { describe, expect, it } from 'vitest';
import { receivedAgainWord } from '../home/delivery-word.js';
import { parsePage } from '../messages/api.js';
import { inCount, inFilter, parseItem, partsText, render, type ActivityItem } from './clean.js';

const nameOf = (): string | undefined => undefined;
const parsed = (raw: unknown): ActivityItem | undefined => parseItem(raw);

describe('Activity: the restore entry', () => {
  it('a restore and an update read as plain sentences, with no amount', () => {
    const restore = parsed({ kind: 'restore_guard', at: 100, reason: 'restore', until: 86_500 });
    const update = parsed({ kind: 'restore_guard', at: 100, reason: 'update', until: 86_500 });
    expect(restore).toEqual({ kind: 'restore_guard', at: 100, reason: 'restore', until: 86_500 });
    expect(update).toEqual({ kind: 'restore_guard', at: 100, reason: 'update', until: 86_500 });
    const r = render(restore!, nameOf, 'now');
    const u = render(update!, nameOf, 'now');
    expect(partsText(r.sentence)).toBe('This ID was restored from a backup');
    expect(partsText(u.sentence)).toBe('AgentLink was updated on this computer');
    for (const row of [r, u]) {
      expect(row.grey).not.toMatch(/Nothing was charged/);
      expect(row.grey).toContain('This entry is not a charge.');
      expect(JSON.stringify(row)).not.toMatch(/\$/);
    }
  });

  it('the tense follows `until`: open window "asks … (until {time})", closed "asked"', () => {
    const item = parsed({ kind: 'restore_guard', at: 100, reason: 'restore', until: 86_500 })!;
    const timeText = (t: number): string => `T${String(t)}`;
    expect(render(item, nameOf, 'now', { now: 200, timeText }).grey).toBe(
      'For 24 hours, AgentLink asks you before anything that costs money (until T86500). This entry is not a charge.',
    );
    expect(render(item, nameOf, 'now', { now: 86_500, timeText }).grey).toBe(
      'For 24 hours, AgentLink asked you before anything that cost money. This entry is not a charge.',
    );
    // Without a clock (search text), the past tense.
    expect(render(item, nameOf, 'now').grey).toBe(
      'For 24 hours, AgentLink asked you before anything that cost money. This entry is not a charge.',
    );
  });

  it('an unknown reason or an amount is not taken; a bad `until` falls back to 24 hours', () => {
    expect(parsed({ kind: 'restore_guard', at: 1, reason: 'charge' })).toBeUndefined();
    expect(parsed({ kind: 'restore_guard', at: 1, reason: 'restore', costUsd: '5' })).toEqual({
      kind: 'restore_guard',
      at: 1,
      reason: 'restore',
      until: 86_401,
    });
    expect(parsed({ kind: 'restore_guard', at: 1, reason: 'restore', until: 'x' })).toMatchObject({
      until: 86_401,
    });
  });

  it('is under Safety, never a proof and never counted', () => {
    const item = parsed({ kind: 'restore_guard', at: 1, reason: 'restore' })!;
    expect(inFilter(item, 'safety')).toBe(true);
    expect(inFilter(item, 'proofs')).toBe(false);
    for (const key of ['approved', 'rules', 'blocked', 'proofs'] as const) {
      expect(inCount(item, key)).toBe(false);
    }
  });
});

describe('Conversation: received again after restore', () => {
  const page = (item: Record<string, unknown>) =>
    parsePage({
      items: [
        {
          id: 'env_AAAAAAAAAAAAAAAAAAAAAA',
          at: 1,
          text: 'hi',
          files: [],
          proof: false,
          size: 2,
          ...item,
        },
      ],
    });

  it('the page keeps receivedAgain only when it is `true`', () => {
    expect(page({ receivedAgain: true })?.items[0]).toMatchObject({ receivedAgain: true });
    expect(page({ receivedAgain: 'yes' })?.items[0]).not.toHaveProperty('receivedAgain');
    expect(page({})?.items[0]).not.toHaveProperty('receivedAgain');
  });

  it('the label is quiet text for a message from the other side only', () => {
    expect(receivedAgainWord({ receivedAgain: true }, false)).toBe('From before the restore');
    expect(receivedAgainWord({ receivedAgain: true }, true)).toBeUndefined();
    expect(receivedAgainWord({}, false)).toBeUndefined();
  });
});
