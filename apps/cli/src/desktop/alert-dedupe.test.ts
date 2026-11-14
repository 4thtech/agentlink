// NOTIFY-DEDUPE (S1): one alert, not two, for a file plus its message.
import { describe, expect, it } from 'vitest';
import { FILE_MESSAGE_WINDOW_MS, dedupeFileAndMessage, type RecentAlerts } from './alert-dedupe.js';

const A = `0x${'a'.repeat(40)}`;
const B = `0x${'b'.repeat(40)}`;
const all = (): boolean => true;
const msg = (ref: string, count = 1) => ({ kind: 'messages' as const, count, ref });
const file = (ref: string, count = 1) => ({ kind: 'files' as const, count, ref });

describe('dedupeFileAndMessage', () => {
  it('in one look: the file and its message from one person are one alert (the file)', () => {
    const recent: RecentAlerts = new Map();
    expect(dedupeFileAndMessage([msg(A), file(A)], all, recent, 1000)).toEqual([file(A)]);
  });

  it('across looks, in either order, within the window', () => {
    const recent: RecentAlerts = new Map();
    expect(dedupeFileAndMessage([file(A)], all, recent, 1000)).toEqual([file(A)]);
    expect(dedupeFileAndMessage([msg(A)], all, recent, 1000 + 5_000)).toEqual([]);
    const other: RecentAlerts = new Map();
    expect(dedupeFileAndMessage([msg(A)], all, other, 1000)).toEqual([msg(A)]);
    expect(dedupeFileAndMessage([file(A)], all, other, 1000 + 5_000)).toEqual([]);
  });

  it('after the window each alerts on its own again', () => {
    const recent: RecentAlerts = new Map();
    dedupeFileAndMessage([file(A)], all, recent, 1000);
    expect(dedupeFileAndMessage([msg(A)], all, recent, 1000 + FILE_MESSAGE_WINDOW_MS)).toEqual([
      msg(A),
    ]);
  });

  it('different people never hide each other; two of one kind both stand', () => {
    const recent: RecentAlerts = new Map();
    expect(dedupeFileAndMessage([file(A), msg(B)], all, recent, 1000)).toEqual([file(A), msg(B)]);
    expect(dedupeFileAndMessage([file(A, 2)], all, recent, 2000)).toEqual([file(A, 2)]);
  });

  it('a switch that is off never hides the other kind', () => {
    const recent: RecentAlerts = new Map();
    const onlyMessages = (kind: 'messages' | 'files'): boolean => kind === 'messages';
    expect(dedupeFileAndMessage([file(A), msg(A)], onlyMessages, recent, 1000)).toEqual([
      file(A),
      msg(A),
    ]);
  });

  it('news without a person (approvals, update) is never touched', () => {
    const recent: RecentAlerts = new Map();
    const approvals = { kind: 'approvals' as const, count: 1 };
    expect(dedupeFileAndMessage([approvals, file(A), msg(A)], all, recent, 1000)).toEqual([
      approvals,
      file(A),
    ]);
  });
});
