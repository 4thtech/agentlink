// MSG-ORDER-1 (audit R2-UI-09): messages of the same second keep the order they were stored in,
// both ways. The core's local order `seq` breaks a tie of `at` (unix seconds).
import { describe, expect, it } from 'vitest';
import { parsePage, type MessageItem } from '../messages/api.js';
import { mergeThread } from './people-api.js';

const AT = 1_800_000_000;
const item = (id: string, seq: number | undefined, at = AT): MessageItem => ({
  id,
  at,
  text: `text ${id}`,
  files: [],
  receipt: false,
  proof: false,
  size: 1,
  ...(seq === undefined ? {} : { seq }),
});

describe('MSG-ORDER-1: the conversation order', () => {
  it('orders several messages of the same second, both ways, by the local order', () => {
    // Pages list newest first; the IDs sort against the stored order on purpose.
    const inbox = [item('in_c', 6), item('in_b', 5), item('in_a', 2)];
    const sent = [item('out_c', 4), item('out_b', 3), item('out_a', 1)];
    const thread = mergeThread(inbox, sent);
    expect(thread.map((t) => t.item.id)).toEqual([
      'out_a',
      'in_a',
      'out_b',
      'out_c',
      'in_b',
      'in_c',
    ]);
    expect(thread.map((t) => t.out)).toEqual([true, false, true, true, false, false]);
  });

  it('still orders by time first', () => {
    const thread = mergeThread([item('in_late', 1, AT + 1)], [item('out_early', 9, AT)]);
    expect(thread.map((t) => t.item.id)).toEqual(['out_early', 'in_late']);
  });

  it('reads `seq` from a page, and leaves out one that is not a whole number', () => {
    const page = parsePage({
      items: [
        { id: 'a', at: AT, text: '', files: [], proof: false, receipt: false, size: 1, seq: 4 },
        { id: 'b', at: AT, text: '', files: [], proof: false, receipt: false, size: 1, seq: 1.5 },
        { id: 'c', at: AT, text: '', files: [], proof: false, receipt: false, size: 1 },
      ],
    });
    expect(page?.items.map((i) => [i.id, i.seq])).toEqual([
      ['a', 4],
      ['c', undefined],
    ]);
  });
});
