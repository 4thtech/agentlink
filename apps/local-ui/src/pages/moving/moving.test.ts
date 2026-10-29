// U3-map-2: the moving-row rules (b11 §32.1, §32.3): who has a stream now, from the flow read.
import { describe, expect, it } from 'vitest';
import type { ContactFlow, FlowItem } from '../agents/map/data.js';
import { fileMarks, movingRows, namesToIds } from './data.js';

const NOW = 1_800_000_000;
const id = (n: number): string => `0x${String(n).repeat(40)}`;
const item = (
  contactId: string,
  direction: 'in' | 'out',
  kind: 'message' | 'file',
  ago: number,
  state: FlowItem['state'] = direction === 'in' ? 'received' : 'sent',
): FlowItem => ({ contactId, direction, kind, state, at: NOW - ago });
const flowOf = (...items: FlowItem[]): Map<string, ContactFlow> => {
  const m = new Map<string, ContactFlow>();
  for (const i of items) m.set(i.contactId, { ...m.get(i.contactId), [i.direction]: i });
  return m;
};

describe('movingRows', () => {
  it('marks a contact whose message or file moved in the last minute, with its direction', () => {
    const m = movingRows(
      flowOf(item(id(1), 'out', 'file', 10), item(id(2), 'in', 'message', 5)),
      NOW,
    );
    expect(m.get(id(1))).toMatchObject({ direction: 'out', kind: 'file' });
    expect(m.get(id(2))).toMatchObject({ direction: 'in', kind: 'message' });
  });

  it('leaves out anything older than a minute and anything that failed to send', () => {
    const m = movingRows(
      flowOf(item(id(1), 'out', 'file', 61), item(id(2), 'out', 'message', 3, 'not_delivered')),
      NOW,
    );
    expect(m.size).toBe(0);
  });

  it('takes the newest direction when both moved', () => {
    const m = movingRows(flowOf(item(id(1), 'out', 'message', 30), item(id(1), 'in', 'message', 4)), NOW);
    expect(m.get(id(1))?.direction).toBe('in');
  });

  it('Files only counts a file that moves', () => {
    const f = flowOf(item(id(1), 'out', 'message', 3), item(id(2), 'out', 'file', 3));
    const m = movingRows(f, NOW, ['file']);
    expect([...m.keys()]).toEqual([id(2)]);
  });

  it('a failing flow read shows nothing moving', () => {
    expect(movingRows(flowOf(item(id(1), 'out', 'file', 1)), NOW, ['file'], false).size).toBe(0);
  });

  it('keeps every mark but lets at most two dashes travel, the newest first', () => {
    const f = flowOf(
      item(id(1), 'out', 'message', 9),
      item(id(2), 'out', 'message', 1),
      item(id(3), 'out', 'message', 5),
    );
    const m = movingRows(f, NOW);
    expect(m.size).toBe(3);
    expect(m.get(id(2))?.animate).toBe(true);
    expect(m.get(id(3))?.animate).toBe(true);
    expect(m.get(id(1))?.animate).toBe(false);
  });

  it('carries words and directions only: no name, text, file name or link field', () => {
    const m = movingRows(flowOf(item(id(1), 'out', 'file', 2)), NOW);
    expect(Object.keys(m.get(id(1)) ?? {}).sort()).toEqual(['animate', 'at', 'direction', 'kind']);
  });
});

describe('Files rows (matched by an owner-confirmed, unique name)', () => {
  const contacts = [
    { ref: id(1), name: 'Marko', nameSource: 'owner', status: 'active' },
    { ref: id(2), name: 'Ana', nameSource: 'owner', status: 'active' },
    { ref: id(3), name: 'Ana', nameSource: 'owner', status: 'active' },
    { ref: id(4), name: 'Ivo', nameSource: 'counterparty', status: 'active' },
    { ref: id(5), name: 'Dana', nameSource: 'owner', status: 'removed' },
  ];
  it('uses only a name one active contact holds, chosen by the owner', () => {
    expect([...namesToIds(contacts)]).toEqual([['Marko', id(1)]]);
  });
  it('marks the newest row on the moving side, once per contact', () => {
    const ids = namesToIds(contacts);
    const moving = movingRows(flowOf(item(id(1), 'out', 'file', 4)), NOW, ['file']);
    const rows = [
      { id: 'a.00', who: 'Marko', at: NOW - 500 },
      { id: 'b.00', who: 'Marko', at: NOW - 5 },
      { id: 'c.00', who: 'Ivo', at: NOW - 5 },
    ];
    expect([...fileMarks('out', rows, ids, moving).keys()]).toEqual(['b.00']);
    expect(fileMarks('in', rows, ids, moving).size).toBe(0);
  });
});
