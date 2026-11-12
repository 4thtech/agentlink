// UX1113-QA2-ACTIVITY (QA finding N7; design-1112 spec §7): the feed against approval actions as the
// store really holds them, and the owner's own events the second QA round found missing or wrong.
//
// - Recorded approval actions (testing/recorded-approval-actions.ts, read from a real journey-harness
//   run, not hand-made) give their action type and contact reference, and nothing from `args`.
// - "Work is now called Work": a contact whose name went A → B → A before the owner saw the note has
//   no net change, so no rename entry.
// - First run is part of creating the ID: the label the first run signs right after creation and the
//   first rules (version 1) signed with the first card are not listed as a rename and a rules change;
//   the creation entry carries the label while it is still the stored one.
// - Blocks and unblocks are listed from the signed owner actions (`contact.block`, `contact.unblock`),
//   so a block stays listed after an unblock or a remove; a block of a contact that is still blocked
//   is listed once, by the contact's row. A Contact check (`contact.check`) is listed with the contact
//   whose stored check carries that nonce.
// All of it is an allowlist: IDs, times, the owner's own label; never a summary, signature or args.
import { MemoryKeyStore, MemoryOwnerKeyStore } from '@4thtech-io/crypto/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ActivityEntry } from './activity.js';
import { seal, type CoreContext } from './context.js';
import { makeAgent, pairWith, type TestAgent, type TestOwner } from './testing/envelopes.js';
import { FakeClock, passphrase, seed } from './testing/fixtures.js';
import { RECORDED_APPROVAL_ACTIONS } from './testing/recorded-approval-actions.js';

const asOwner = (o: MemoryOwnerKeyStore): TestOwner => o as unknown as TestOwner;
const T0 = 1_800_000_000;
const hex64 = (n: number): string => n.toString(16).padStart(64, '0');

function ctxOf(agent: TestAgent): CoreContext {
  return {
    keyStore: agent.keyStore,
    store: agent.store,
    cipher: agent.cipher,
    now: () => 0,
    log: undefined as never,
  };
}

let clock: FakeClock;
let a: TestAgent;
let b: TestAgent;

beforeEach(async () => {
  clock = new FakeClock(T0);
  a = await makeAgent(
    clock,
    new MemoryKeyStore(seed(81)),
    asOwner(new MemoryOwnerKeyStore(seed(181), passphrase())),
    'Alpha',
  );
  b = await makeAgent(
    clock,
    new MemoryKeyStore(seed(82)),
    asOwner(new MemoryOwnerKeyStore(seed(182), passphrase())),
    'Bravo',
  );
  clock.t = T0 + 1_000;
  await pairWith(clock, a, b);
});

async function insertApproval(agent: TestAgent, id: string, at: number, action: unknown) {
  const c = ctxOf(agent);
  const sealed = await seal(c, 'approvals', 'action_json', [id], JSON.stringify(action));
  const summary = await seal(c, 'approvals', 'summary', [id], 'SUMMARY-MUST-NOT-LEAK');
  await agent.store.transaction((tx) =>
    tx.insert('approvals', {
      approval_id: id,
      action_json: sealed,
      scope_json: null,
      answers_envelope_id: null,
      scope_key: null,
      source: 'owner',
      policy_hash: null,
      signed_decision: '{"sig":"SIGNED-MUST-NOT-LEAK"}',
      signed_cancel: null,
      summary,
      status: 'approved',
      expires_at: 2_000_000_000,
      created_at: at - 1,
      decided_at: at,
    }),
  );
}

async function insertOwnerAction(
  agent: TestAgent,
  row: { nonce: string; op: string; at: number; label?: string },
): Promise<void> {
  const signed =
    row.label === undefined
      ? undefined
      : await seal(
          ctxOf(agent),
          'local_owner_actions',
          'signed_json',
          ['agent.label'],
          JSON.stringify({
            body: {
              op: row.op,
              nonce: row.nonce,
              params: { agent: agent.id, label: row.label },
            },
            sig: 'SIG-MUST-NOT-LEAK',
          }),
        );
  await agent.store.transaction((tx) => {
    tx.insert('owner_action_nonces', {
      nonce: row.nonce,
      op: row.op,
      action_hash: hex64(row.at),
      issued_at: row.at,
      expires_at: row.at + 300,
      applied_at: row.at,
    });
    if (signed !== undefined) {
      const fields = { op: 'agent.label' as const, signed_json: signed, applied_at: row.at };
      if (tx.get('local_owner_actions', { record: 'agent.label' }) === undefined) {
        tx.insert('local_owner_actions', { record: 'agent.label', ...fields });
      } else {
        tx.update('local_owner_actions', { record: 'agent.label' }, fields);
      }
    }
  });
}

async function insertPolicy(agent: TestAgent, version: number, at: number): Promise<void> {
  const c = ctxOf(agent);
  const signed = await seal(c, 'policies', 'signed_json', ['current'], '{}');
  const hash = await seal(c, 'policies', 'policy_hash', ['current'], hex64(1));
  await agent.store.transaction((tx) => {
    tx.delete('policies', {});
    tx.insert('policies', {
      slot: 'current',
      version,
      signed_json: signed,
      policy_hash: hash,
      applied_at: at,
    });
  });
}

async function all(agent: TestAgent): Promise<ActivityEntry[]> {
  const out: ActivityEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await agent.client.activity.list({
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    out.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return out;
}

const createdAt = async (agent: TestAgent): Promise<number> =>
  (await agent.store.transaction((tx) => tx.select('identity', {}, { limit: 1 })))[0]!.created_at;

describe('activity: recorded approval actions (QA2 N7)', () => {
  it.each(RECORDED_APPROVAL_ACTIONS.map((r) => [r.action.tool, r] as const))(
    '%s as the store held it gives its type and contact reference',
    async (_tool, recorded) => {
      await insertApproval(a, 'apr_rec', 5_000, recorded.action);
      const entry = (await all(a)).find((i) => i.id === 'approval_decided:apr_rec');
      expect(entry).toMatchObject({ kind: 'approval_decided', action: recorded.expected });
      const text = JSON.stringify(entry);
      for (const hidden of ['REDACTED', 'Logo design', 'SUMMARY', 'SIGNED-MUST-NOT-LEAK']) {
        expect(text).not.toContain(hidden);
      }
    },
  );
});

describe('activity: a contact rename with no net change (QA2 N7)', () => {
  it('a name that went A → B → A before the owner saw it is no rename entry', async () => {
    const c = ctxOf(a);
    const former = await seal(c, 'contacts', 'former_name', [b.id], 'Bravo');
    await a.store.transaction((tx) =>
      tx.update(
        'contacts',
        { contact_id: b.id },
        { former_name: former, name_changed_at: T0 + 2_000, name_change_seen: 0 },
      ),
    );
    const items = await all(a);
    expect(items.some((i) => i.kind === 'contact_renamed')).toBe(false);
  });

  it('a real change is still listed with both names', async () => {
    const c = ctxOf(a);
    const former = await seal(c, 'contacts', 'former_name', [b.id], 'Work');
    await a.store.transaction((tx) =>
      tx.update(
        'contacts',
        { contact_id: b.id },
        { former_name: former, name_changed_at: T0 + 2_000, name_change_seen: 0 },
      ),
    );
    expect((await all(a)).find((i) => i.kind === 'contact_renamed')).toMatchObject({
      formerName: 'Work',
      newName: 'Bravo',
    });
  });
});

describe('activity: first run is part of creating the ID (QA2 N7)', () => {
  it('the first label right after creation is not a rename; the creation carries it', async () => {
    const created = await createdAt(a);
    await insertOwnerAction(a, { nonce: 'n-first', op: 'agent.label', at: created, label: 'Ana' });
    const items = await all(a);
    expect(items.some((i) => i.kind === 'id_renamed')).toBe(false);
    expect(items.find((i) => i.kind === 'id_created')).toMatchObject({ name: 'Ana' });
  });

  it('a later rename is listed; the creation then has no name (only the latest label is kept)', async () => {
    const created = await createdAt(a);
    await insertOwnerAction(a, { nonce: 'n-first', op: 'agent.label', at: created, label: 'Ana' });
    await insertOwnerAction(a, {
      nonce: 'n-later',
      op: 'agent.label',
      at: created + 5_000,
      label: 'Work',
    });
    const items = await all(a);
    expect(items.filter((i) => i.kind === 'id_renamed')).toEqual([
      { kind: 'id_renamed', id: 'owner_action:n-later', at: created + 5_000, name: 'Work' },
    ]);
    expect(items.find((i) => i.kind === 'id_created')).toMatchObject({ name: null });
  });

  it('a first label long after creation is a rename', async () => {
    const created = await createdAt(a);
    await insertOwnerAction(a, {
      nonce: 'n-late',
      op: 'agent.label',
      at: created + 3_600,
      label: 'Ana',
    });
    expect((await all(a)).find((i) => i.kind === 'id_renamed')).toMatchObject({ name: 'Ana' });
  });

  it('the first rules signed with the first card are not a rules change; a later version is', async () => {
    const created = await createdAt(a);
    await insertPolicy(a, 1, created);
    expect((await all(a)).some((i) => i.kind === 'rules_changed')).toBe(false);
    await insertPolicy(a, 2, created + 600);
    expect((await all(a)).find((i) => i.kind === 'rules_changed')).toMatchObject({
      version: 2,
      at: created + 600,
    });
  });

  it('a version 1 saved long after creation (no first rules) is a rules change', async () => {
    const created = await createdAt(a);
    await insertPolicy(a, 1, created + 3_600);
    expect((await all(a)).find((i) => i.kind === 'rules_changed')).toMatchObject({ version: 1 });
  });
});

describe('activity: blocks, unblocks and Contact checks from signed owner actions (QA2 N7)', () => {
  it('a block that was later undone stays listed, and the unblock is listed', async () => {
    await insertOwnerAction(a, { nonce: 'n-block', op: 'contact.block', at: T0 + 2_000 });
    await insertOwnerAction(a, { nonce: 'n-unblock', op: 'contact.unblock', at: T0 + 2_100 });
    await a.store.transaction((tx) =>
      tx.update('contacts', { contact_id: b.id }, { status: 'active', updated_at: T0 + 2_100 }),
    );
    const items = await all(a);
    expect(items.find((i) => i.id === 'owner_action:n-block')).toEqual({
      kind: 'contact_blocked',
      id: 'owner_action:n-block',
      at: T0 + 2_000,
      contactId: null,
      contact: null,
    });
    expect(items.find((i) => i.id === 'owner_action:n-unblock')).toEqual({
      kind: 'contact_unblocked',
      id: 'owner_action:n-unblock',
      at: T0 + 2_100,
      contactId: b.id,
    });
  });

  it('a block of a contact that is still blocked is listed once, with the contact', async () => {
    await insertOwnerAction(a, { nonce: 'n-block', op: 'contact.block', at: T0 + 2_000 });
    await a.store.transaction((tx) =>
      tx.update('contacts', { contact_id: b.id }, { status: 'blocked', updated_at: T0 + 2_000 }),
    );
    const blocks = (await all(a)).filter((i) => i.kind === 'contact_blocked');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ contactId: b.id });
  });

  it('a Contact check names the contact whose stored check has that nonce', async () => {
    await insertOwnerAction(a, { nonce: 'n-check', op: 'contact.check', at: T0 + 3_000 });
    await a.store.transaction((tx) =>
      tx.update(
        'contacts',
        { contact_id: b.id },
        {
          safety_check: JSON.stringify({
            body: { op: 'contact.check', nonce: 'n-check', params: { contact: b.id } },
            sig: 'SIG-MUST-NOT-LEAK',
          }),
          safety_code_checked: 1,
        },
      ),
    );
    const items = await all(a);
    expect(items.find((i) => i.id === 'owner_action:n-check')).toEqual({
      kind: 'contact_checked',
      id: 'owner_action:n-check',
      at: T0 + 3_000,
      contactId: b.id,
    });
    expect(JSON.stringify(items)).not.toContain('SIG-MUST-NOT-LEAK');
  });

  it('a Contact check whose stored check was replaced has no contact reference', async () => {
    await insertOwnerAction(a, { nonce: 'n-check-old', op: 'contact.check', at: T0 + 3_000 });
    expect((await all(a)).find((i) => i.id === 'owner_action:n-check-old')).toEqual({
      kind: 'contact_checked',
      id: 'owner_action:n-check-old',
      at: T0 + 3_000,
      contactId: null,
    });
  });
});
