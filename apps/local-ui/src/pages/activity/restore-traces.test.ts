// RESTORE-TRACES (D-156; 11 §5): the restore entry in the spending history, and the quiet label on
// a message received again after a restore.
// - The Activity row says what happened and that paid actions asked for 24 hours. It is never a
//   charge: no amount, never counted with proofs, and it sits under Safety.
// - The conversation shows "Received again after restore" under a message from the other side only.
import { describe, expect, it } from 'vitest';
import { receivedAgainWord } from '../home/delivery-word.js';
import { parsePage } from '../messages/api.js';
import { inCount, inFilter, parseItem, partsText, render, type ActivityItem } from './clean.js';

const nameOf = (): string | undefined => undefined;
const parsed = (raw: unknown): ActivityItem | undefined => parseItem(raw);

describe('Activity: the restore entry', () => {
  it('a restore and an update read as plain sentences, with no amount', () => {
    const restore = parsed({ kind: 'restore_guard', at: 100, reason: 'restore' });
    const update = parsed({ kind: 'restore_guard', at: 100, reason: 'update' });
    expect(restore).toEqual({ kind: 'restore_guard', at: 100, reason: 'restore' });
    expect(update).toEqual({ kind: 'restore_guard', at: 100, reason: 'update' });
    const r = render(restore!, nameOf, 'now');
    const u = render(update!, nameOf, 'now');
    expect(partsText(r.sentence)).toBe('This ID was restored from a backup');
    expect(partsText(u.sentence)).toBe('AgentLink was updated on this computer');
    for (const row of [r, u]) {
      expect(row.grey).toBe(
        'For 24 hours, AgentLink asked you before anything that cost money. Nothing was charged.',
      );
      expect(JSON.stringify(row)).not.toMatch(/\$/);
    }
  });

  it('an unknown reason or an amount is not taken: an unknown reason drops the row', () => {
    expect(parsed({ kind: 'restore_guard', at: 1, reason: 'charge' })).toBeUndefined();
    expect(parsed({ kind: 'restore_guard', at: 1, reason: 'restore', costUsd: '5' })).toEqual({
      kind: 'restore_guard',
      at: 1,
      reason: 'restore',
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
    expect(receivedAgainWord({ receivedAgain: true }, false)).toBe('Received again after restore');
    expect(receivedAgainWord({ receivedAgain: true }, true)).toBeUndefined();
    expect(receivedAgainWord({}, false)).toBeUndefined();
  });
});
