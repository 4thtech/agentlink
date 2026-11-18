// DEVICES-INTERIM: the notification centre's `devices` item, "This ID is also in use on another
// computer". A state item like `update` and `network`: one item, no ref, no content, gone once the
// other computer has not been seen for a week (core devices.ts).
import {
  isNotificationId,
  readNotificationItem,
} from '@4thtech-io/types/ui-contract/notifications';
import { describe, expect, it } from 'vitest';
import { createNotificationStore, memoryNotificationPersistence } from './notifications.js';

const T0 = 1_800_000_000;

describe('the devices notification', () => {
  it('is a kind of its own with no ref', () => {
    const item = { id: 'devices', kind: 'devices', count: 1, at: T0, read: false };
    expect(readNotificationItem(item)).toEqual(item);
    expect(isNotificationId('devices')).toBe(true);
    expect(readNotificationItem({ ...item, ref: `0x${'a'.repeat(40)}` })).toBeUndefined();
    expect(readNotificationItem({ ...item, text: 'another computer' })).toBeUndefined();
  });

  it('is one item while another computer uses this ID, gone when no longer true', async () => {
    let t = T0;
    const store = createNotificationStore(memoryNotificationPersistence(), { now: () => t });
    await store.observe({ otherComputer: true });
    expect(await store.list()).toEqual([
      { id: 'devices', kind: 'devices', count: 1, at: T0, read: false },
    ]);
    t += 60;
    await store.observe({ otherComputer: true });
    expect(await store.list()).toHaveLength(1);
    expect((await store.list())[0]?.at).toBe(T0);
    await store.observe({});
    expect(await store.list()).toHaveLength(1);
    await store.observe({ otherComputer: false });
    expect(await store.list()).toEqual([]);
  });
});
