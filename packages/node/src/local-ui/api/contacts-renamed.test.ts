// W4-RENAME-REACHES-CONTACTS (S2; D-141; 07 §3 "Former name"; 08 §1 "A contact's rename"; 11 §5.8):
// the API the Contacts and Messages pages (C2) render "{new} (was {old})" from.
//
// - `GET /api/ui/contacts`: a contact whose `card-update` changed its name, and whose note the
//   owner has not seen yet, carries `formerName`: the former name under the name rule (core's
//   restricted form), never the raw text. Nothing else changes: the label, the fingerprint and
//   "Safety code checked" stay as core says (no key warning).
// - `GET /api/ui/contacts/:ref/name-seen`: the page says it showed the note; core sets
//   `name_change_seen` (display state only, 07 §3: nothing is decided from it). An unknown ref is
//   not_found; nothing is signed.
import type { ContactView } from '@4thtech-io/core';
import { describe, expect, it } from 'vitest';
import { readOnlyClient, type LocalUiContext, type LocalUiReadClient } from '../context.js';
import type { LocalUiReadRoute, LocalUiRequest } from '../route-types.js';
import { createLocalUiRoutes } from '../routes.js';
import { contactsRoutes } from './contacts.js';
import { contactNamesRoutes } from './contacts-renamed.js';

const SELF = '0x71c4000000000000000000000000000000009a2e';
const MARKO = '0x7f3a19c200000000000000000000000000000001';

function view(over: Partial<ContactView> = {}): ContactView {
  return {
    id: MARKO,
    name: { value: 'Mark', source: 'counterparty', selfDeclared: true },
    display: { name: 'Mark', label: 'safety-code-checked', nameSource: 'counterparty' },
    card: { agentEvm: MARKO },
    keyEpoch: 1,
    ownerFingerprint: { short: '7F3A·19C2', long: '7f3a19c2' },
    status: 'active',
    pairing: 'complete',
    safetyCodeChecked: true,
    createdAt: 1_759_449_600,
    updatedAt: 1_759_449_700,
    ...over,
  } as unknown as ContactView;
}

const req = (params: Record<string, string> = {}): LocalUiRequest => ({
  params,
  query: new URLSearchParams(),
});

function client(views: ContactView[], seen: string[] = []): LocalUiReadClient {
  return {
    agentId: SELF,
    contacts: { list: () => Promise.resolve(views) },
    contactNames: {
      markSeen: (id: string) => {
        seen.push(id);
        return Promise.resolve(views.some((v) => v.id === id && v.nameChange !== undefined));
      },
    },
  } as unknown as LocalUiReadClient;
}

const ctx = (c: LocalUiReadClient | undefined): LocalUiContext =>
  ({ client: c }) as unknown as LocalUiContext;

const list = contactsRoutes.find(
  (r) => r.method === 'GET' && r.path === '/api/ui/contacts',
) as LocalUiReadRoute;
const seenRoute = contactNamesRoutes.find(
  (r) => r.method === 'GET' && r.path === '/api/ui/contacts/:ref/name-seen',
) as LocalUiReadRoute;

describe('GET /api/ui/contacts: formerName (D-141)', () => {
  it('carries the restricted former name while the note is unseen; the label stays', async () => {
    const r = await list.handler(
      ctx(client([view({ nameChange: { formerName: 'Marko', at: 1_759_449_700 } })])),
      req(),
    );
    expect(r.status).toBe(200);
    const [row] = (r.body as { contacts: Record<string, unknown>[] }).contacts;
    expect(row).toMatchObject({
      ref: MARKO,
      name: 'Mark',
      formerName: 'Marko',
      label: 'safety-code-checked',
    });
  });

  it('no note: no formerName key at all', async () => {
    const r = await list.handler(ctx(client([view()])), req());
    const [row] = (r.body as { contacts: Record<string, unknown>[] }).contacts;
    expect(row !== undefined && 'formerName' in row).toBe(false);
  });

  it('a former name that is not plain short text is left out (never raw text)', async () => {
    const r = await list.handler(
      ctx(client([view({ nameChange: { formerName: 'x'.repeat(200), at: 1 } })])),
      req(),
    );
    const [row] = (r.body as { contacts: Record<string, unknown>[] }).contacts;
    expect(row !== undefined && 'formerName' in row).toBe(false);
  });
});

describe('GET /api/ui/contacts/:ref/name-seen', () => {
  it('is registered once as a read and marks the note seen', async () => {
    const all = createLocalUiRoutes().routes();
    expect(
      all.filter((r) => r.method === 'GET' && r.path === '/api/ui/contacts/:ref/name-seen'),
    ).toHaveLength(1);
    expect(seenRoute.presence).toBe(false);
    const seen: string[] = [];
    const r = await seenRoute.handler(
      ctx(client([view({ nameChange: { formerName: 'Marko', at: 1 } })], seen)),
      req({ ref: MARKO }),
    );
    expect(r).toEqual({ status: 200, body: { status: 'done' } });
    expect(seen).toEqual([MARKO]);
  });

  it('refuses a ref that is not a contact ID, and an unknown contact', async () => {
    const seen: string[] = [];
    const bad = await seenRoute.handler(ctx(client([view()], seen)), req({ ref: 'x' }));
    expect(bad.status).toBe(404);
    const unknown = await seenRoute.handler(
      ctx(client([], seen)),
      req({ ref: '0x' + '12'.repeat(20) }),
    );
    expect(unknown.status).toBe(404);
  });

  it('the read-only client exposes only markSeen of the name notes', () => {
    const calls: string[] = [];
    const full = {
      agentId: SELF,
      contacts: {
        markNameChangeSeen: (id: string) => {
          calls.push(id);
          return Promise.resolve(true);
        },
      },
    };
    const view = readOnlyClient(full as unknown as Parameters<typeof readOnlyClient>[0]);
    expect(Object.keys(view.contactNames ?? {})).toEqual(['markSeen']);
    expect(Object.isFrozen(view.contactNames)).toBe(true);
  });
});
