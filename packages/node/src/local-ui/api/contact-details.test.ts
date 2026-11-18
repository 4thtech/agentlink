// RELAY-CARD-MIGRATION (S2; 04 §2.5, §2.6; 08 §1; I-4): the app's "Update your contact details".
//
// - `GET /api/ui/contact-details` (read): `{status: 'needed'}` while the open ID's card lists a
//   relay the release no longer uses; `{status: 'current'}` otherwise. Signs and writes nothing.
// - `POST /api/ui/contact-details` (presence): the owner's gesture runs the migration through the
//   gate's one-use `updateContactDetails` (owner-relay-migration.ts). Without it nothing is signed.
// - After the migration the read answers `current`: the notice disappears.
import { describe, expect, it } from 'vitest';
import type { LocalUiContext, LocalUiReadClient } from '../context.js';
import type { LocalUiOwnerOperation, LocalUiOwnerRoute, LocalUiReadRoute } from '../route-types.js';
import { createLocalUiRoutes } from '../routes.js';
import type { OwnerReview } from '../../owner-operation.js';
import { contactDetailsRoutes, CONTACT_DETAILS_PATH } from './contact-details.js';

const find = (method: string) => {
  const found = contactDetailsRoutes.find(
    (r) => r.method === method && r.path === CONTACT_DETAILS_PATH,
  );
  if (found === undefined) throw new Error(`no route ${method}`);
  return found;
};
const read = find('GET') as LocalUiReadRoute;
const update = find('POST') as LocalUiOwnerRoute;

function world(initial: 'needed' | 'current', sendState = 'ready') {
  let state: 'needed' | 'current' = initial;
  const client = {
    agentId: '0x71c4000000000000000000000000000000009a2e',
    agent: {
      relayMigration: () =>
        Promise.resolve(
          state === 'needed'
            ? { status: 'needed', relays: ['wss://relay.primal.net', 'wss://offchain.pub'] }
            : { status: 'current' },
        ),
      sendState: () => Promise.resolve(sendState),
    },
  } as unknown as LocalUiReadClient;
  const context = { client, now: () => 0 } as unknown as LocalUiContext;
  return {
    context,
    migrated: () => {
      state = 'current';
    },
  };
}

const q = { params: {}, query: new URLSearchParams() };

describe('GET /api/ui/contact-details', () => {
  it('needed while the card lists an old server, current otherwise; a read only', async () => {
    expect(read.presence).toBe(false);
    expect(await read.handler(world('needed').context, q)).toEqual({
      status: 200,
      body: { status: 'needed' },
    });
    expect(await read.handler(world('current').context, q)).toEqual({
      status: 200,
      body: { status: 'current' },
    });
  });

  it('refuses a query', async () => {
    const r = await read.handler(world('needed').context, {
      params: {},
      query: new URLSearchParams('x=1'),
    });
    expect(r.status).toBe(400);
  });
});

describe('POST /api/ui/contact-details (owner presence)', () => {
  it('declares presence, so the gate asks for the gesture first', () => {
    expect(update.presence).toBe(true);
  });

  it('runs the gesture once and the notice disappears afterwards', async () => {
    const w = world('needed');
    const reviews: OwnerReview[] = [];
    const owner: LocalUiOwnerOperation = {
      sign: () => Promise.reject(new Error('never sign here')),
      updateContactDetails: (review) => {
        reviews.push(review);
        w.migrated();
        return Promise.resolve({ status: 'migrated', contacts: 3 });
      },
    };
    const result = await update.handler(w.context, { ...q, input: {} as never }, owner);
    expect(result).toEqual({ status: 200, body: { status: 'done', contacts: 3 } });
    expect(reviews).toHaveLength(1);
    // 11 §5: no "relay" in what the owner reads.
    expect(reviews[0]?.lines.join(' ')).not.toMatch(/relay/i);
    expect(await read.handler(w.context, q)).toEqual({
      status: 200,
      body: { status: 'current' },
    });
  });

  it('without the gate operation nothing is signed (not available)', async () => {
    const w = world('needed');
    const owner: LocalUiOwnerOperation = {
      sign: () => Promise.reject(new Error('never sign here')),
    };
    const result = await update.handler(w.context, { ...q, input: {} as never }, owner);
    // 501 `not_available`, as for a rename without its gate operation (the page says to reopen).
    expect(result.status).toBe(501);
  });

  it('precheck refuses before the gesture when nothing is needed or a change is unfinished', async () => {
    const request = { ...q, input: {} as never };
    expect(await update.precheck?.(world('current').context, request)).toMatchObject({
      status: 409,
      body: { error: 'current' },
    });
    expect(
      await update.precheck?.(world('needed', 'rotation_pending').context, request),
    ).toMatchObject({ status: 409, body: { error: 'rotation_pending' } });
    expect(await update.precheck?.(world('needed').context, request)).toBeUndefined();
  });

  it('is one of the app routes', () => {
    const all = createLocalUiRoutes().routes();
    expect(all.some((r) => r.method === 'POST' && r.path === CONTACT_DETAILS_PATH)).toBe(true);
    expect(all.some((r) => r.method === 'GET' && r.path === CONTACT_DETAILS_PATH)).toBe(true);
  });
});
