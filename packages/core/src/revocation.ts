// Applying a `revoke` envelope (M1-7h; 04 §2.5.1, §3.4.1; 07 §3.2 "Revocation", §3.4; D-58;
// IR-M1-7h-1 F01).
//
// - Authority is the carried `agent.revoke` SignedOwnerAction, whatever the envelope's `from`
//   (04 §3.4.1). It is verified per 04 §2.5.1 against the named agent's stored card: a contact's
//   card for a contact, the own card for the own agent (`agent`, `owner` as bytes, `sig`, `v`,
//   `expiresAt` = 0, `issuedAt` not beyond the skew, strict params). `agent.revoke` has no nonce
//   (07 §3.4: it writes `revoked_agents` instead). Anything else drops the envelope (fail closed).
// - Effects, in the store transaction that stores the revoke envelope (07 §3.4): insert the
//   `revoked_agents` row with every known key of that agent; set the contact's status to `revoked`
//   (or `identity.revoked_at` for the own agent); stop the `pending` outbox rows to that agent's
//   keys (all of them for the own agent) as `not_delivered` with reason `revoked` (07 §3.2). A
//   re-published copy is a no-op. From then on screenInboundTx drops that agent's envelopes, and
//   card-update and handshake for it are refused (contacts.ts, M1-7a).
// - Void rule 3 (04 §3.4.2; 07 §3.4 "Transaction"; M1-7h-b): in that same transaction, every
//   `pending` approval and every `unclaimed` or `claimed` commitment part with the revoked contact
//   as counterparty becomes `void` (parts with void_reason `void`, APPROVAL_VOID). The counterparty
//   is read from the sealed action (`context.counterparty`, or `context.scope.counterparty` for a
//   commitment), opened in `prepare` because the transaction cannot decrypt (07 §3.1), and from the
//   clear `scope_json` inside the transaction. An approved scope keeps its row (only an owner
//   signature ends what an owner approved, 07 §3.5); its open parts end. If a pending approval
//   without a scope appeared after `prepare` read the approvals, the effect writes nothing
//   (`stale`) and the next pass applies the revoke, so none is missed. An action that cannot be
//   opened is decided by its scope alone: it authorises nothing anyway (approvals.ts, fail closed).
// - The activity line (07 §3.2): the counts of stopped outbox rows, voided approvals and voided
//   parts, in the envelope's report and one log line (envelopes.ts).
// - Not here: the Registry source (05 §4, M2-4b).
//
// I-4: nothing here takes presence or holds an owner key; the owner signature is the authority.
// I-5, I-7: refusals are fixed codes; nothing from the object is logged.
import { canonicalize, encodeHex } from '@4thtech-io/crypto';
import type { Payload } from '@4thtech-io/types';
import type { ContactBook } from './contacts.js';
import { nowOf, open, type CoreContext } from './context.js';
import type { InboundReason, PreparedRevoke, RevokeActivity, RevokeHandler } from './envelopes.js';
import type { IdentityService } from './identity.js';
import { verifyOwnerAction } from './owner-action.js';
import type { Row } from './store/schema.js';
import type { StoreTx } from './store/store.js';

const NOSTR_KEY = /^[0-9a-f]{64}$/;

function keyList(text: string | null | undefined): string[] {
  if (text === null || text === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed)
      ? parsed.filter((k): k is string => typeof k === 'string' && NOSTR_KEY.test(k))
      : [];
  } catch {
    return [];
  }
}

/**
 * Stops the `pending` outbox rows to `keys` (every row when `keys` is undefined), 07 §3.2. Returns
 * how many rows it stopped.
 */
function stopOutboxTx(tx: StoreTx, keys: readonly string[] | undefined): number {
  const rows = tx
    .select('outbox', { state: 'pending' })
    .filter((r) => keys === undefined || keys.includes(r.recipient_key));
  let stopped = 0;
  for (const row of rows) {
    stopped += tx.update(
      'outbox',
      { wrap_id: row.wrap_id, state: 'pending' },
      { state: 'not_delivered', reason: 'revoked', wrap_json: null },
    );
    if (row.role === 'contact' || keys === undefined) {
      tx.update(
        'envelopes',
        { envelope_id: row.envelope_id, delivery: { ne: 'not_delivered' } },
        { delivery: 'not_delivered' },
      );
    }
  }
  return stopped;
}

/** Part states that a void rule ends (07 §3.5 "Done and void": `done` and `void` are final). */
const OPEN_PARTS = ['unclaimed', 'claimed'] as const;

/**
 * The approvals a revoke may void: every `pending` one, and every other one with an open
 * commitment part (an approved scope or a policy grant).
 */
function voidCandidatesTx(tx: StoreTx): Row<'approvals'>[] {
  const pending = tx.select('approvals', { status: 'pending' });
  const withParts = new Set(
    tx.select('commitment_parts', { state: { in: [...OPEN_PARTS] } }).map((p) => p.approval_id),
  );
  for (const row of pending) withParts.delete(row.approval_id);
  const others = [...withParts]
    .sort()
    .map((id) => tx.get('approvals', { approval_id: id }))
    .filter((row): row is Row<'approvals'> => row !== undefined);
  return [...pending, ...others];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** `counterparty.agentId` of a parsed object, if it is a string (a defensive read). */
function agentIdOf(holder: unknown): string | undefined {
  if (!isRecord(holder)) return undefined;
  const counterparty = holder.counterparty;
  if (!isRecord(counterparty)) return undefined;
  return typeof counterparty.agentId === 'string' ? counterparty.agentId : undefined;
}

/** The counterparty of a stored commitment scope (`approvals.scope_json`, in clear), if any. */
function scopeCounterparty(scopeJson: string | null): string | undefined {
  if (scopeJson === null) return undefined;
  try {
    return agentIdOf(JSON.parse(scopeJson) as unknown);
  } catch {
    return undefined;
  }
}

/** The counterparty an approval action names (04 §3.4.1 `context`), if any. */
function actionCounterparty(actionText: string): string | undefined {
  let action: unknown;
  try {
    action = JSON.parse(actionText) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(action) || !isRecord(action.context)) return undefined;
  return agentIdOf(action.context) ?? agentIdOf(action.context.scope);
}

/** What `prepare` read of the approvals (outside the transaction, which cannot decrypt). */
interface ApprovalsRead {
  /** Every candidate approval that was read. */
  readonly seen: ReadonlySet<string>;
  /** Those whose sealed action names the revoked agent as counterparty. */
  readonly named: ReadonlySet<string>;
}

/**
 * Void rule 3 for a revoked contact (04 §3.4.2; 07 §3.4), inside the revoke transaction. Returns
 * `stale` (and writes nothing) when a pending approval without a scope appeared after `read`.
 */
function voidForCounterpartyTx(
  tx: StoreTx,
  agent: string,
  read: ApprovalsRead,
  now: number,
): { readonly approvals: number; readonly parts: number } | 'stale' {
  const candidates = voidCandidatesTx(tx);
  const hits: Row<'approvals'>[] = [];
  for (const row of candidates) {
    const scoped = scopeCounterparty(row.scope_json);
    if (!read.seen.has(row.approval_id) && scoped === undefined) return 'stale';
    if (read.named.has(row.approval_id) || scoped === agent) hits.push(row);
  }
  let approvals = 0;
  let parts = 0;
  for (const row of hits) {
    if (row.status === 'pending') {
      approvals += tx.update(
        'approvals',
        { approval_id: row.approval_id, status: 'pending' },
        { status: 'void', decided_at: now },
      );
    }
    parts += tx.update(
      'commitment_parts',
      { approval_id: row.approval_id, state: { in: [...OPEN_PARTS] } },
      { state: 'void', void_reason: 'void', updated_at: now },
    );
  }
  return { approvals, parts };
}

export class RevocationService implements RevokeHandler {
  readonly #ctx: CoreContext;
  readonly #identity: IdentityService;
  readonly #contacts: ContactBook;

  constructor(ctx: CoreContext, identity: IdentityService, contacts: ContactBook) {
    this.#ctx = ctx;
    this.#identity = identity;
    this.#contacts = contacts;
  }

  async prepare(payload: Payload): Promise<PreparedRevoke | { readonly reason: InboundReason }> {
    if (payload.type !== 'revoke') return { reason: 'revoke_invalid' };
    const signed: unknown = payload.body.signed;
    const agent = payload.body.signed.body.agent;
    const self = await this.#identity.get();
    if (self === undefined) return { reason: 'revoke_invalid' };
    const now = nowOf(this.#ctx);

    if (agent === self.agentId) {
      const verdict = verifyOwnerAction(signed, {
        agent: self.agentId,
        ownerNostr: self.card.ownerNostr,
        now,
      });
      if (!verdict.ok || verdict.signed.body.op !== 'agent.revoke') {
        return { reason: 'revoke_invalid' };
      }
      const { body } = verdict.signed;
      const current = await this.#ctx.keyStore.getPublicBundle();
      const keys: string[] = [];
      for (let epoch = 0; epoch <= current.keyEpoch; epoch += 1) {
        keys.push(encodeHex((await this.#ctx.keyStore.getPublicBundle({ epoch })).agentNostr));
      }
      const signedJson = canonicalize(verdict.signed as never);
      return {
        effect: (tx) => {
          const row = tx.select('identity')[0];
          if (tx.get('revoked_agents', { agent_evm: agent }) !== undefined) {
            if (row !== undefined && row.revoked_at === null) {
              tx.update('identity', { agent_id: row.agent_id }, { revoked_at: now });
            }
            return 'noop';
          }
          tx.insert('revoked_agents', {
            agent_evm: agent,
            nostr_keys: JSON.stringify(keys),
            signed_json: signedJson,
            reason: body.params.reason,
            source: 'envelope',
            chain_id: null,
            registry_ref: null,
            applied_at: now,
          });
          if (row !== undefined) {
            tx.update('identity', { agent_id: row.agent_id }, { revoked_at: now, updated_at: now });
          }
          // 07 §3.2: for the own agent, every pending row stops.
          const outboxStopped = stopOutboxTx(tx, undefined);
          return { self: true, outboxStopped, approvalsVoided: 0, partsVoided: 0 };
        },
      };
    }

    let ownerNostr: string;
    try {
      ownerNostr = (await this.#contacts.get(agent)).card.ownerNostr;
    } catch {
      return { reason: 'revoke_invalid' };
    }
    const verdict = verifyOwnerAction(signed, { agent, ownerNostr, now });
    if (!verdict.ok || verdict.signed.body.op !== 'agent.revoke') {
      return { reason: 'revoke_invalid' };
    }
    const { body } = verdict.signed;
    const signedJson = canonicalize(verdict.signed as never);
    const read = await this.#readApprovals(agent);
    return {
      contactId: agent,
      effect: (tx) => {
        const contact = tx.get('contacts', { contact_id: agent });
        if (tx.get('revoked_agents', { agent_evm: agent }) !== undefined) {
          if (contact !== undefined && contact.status !== 'revoked') {
            tx.update('contacts', { contact_id: agent }, { status: 'revoked', updated_at: now });
          }
          return 'noop';
        }
        // Before any write: a pending approval this read missed defers the whole revoke.
        const voided = voidForCounterpartyTx(tx, agent, read, now);
        if (voided === 'stale') return 'stale';
        const keys = [
          ...new Set([
            ...keyList(contact?.nostr_keys),
            ...(contact === undefined ? [] : [contact.agent_nostr]),
          ]),
        ];
        tx.insert('revoked_agents', {
          agent_evm: agent,
          nostr_keys: JSON.stringify(keys),
          signed_json: signedJson,
          reason: body.params.reason,
          source: 'envelope',
          chain_id: null,
          registry_ref: null,
          applied_at: now,
        });
        if (contact !== undefined) {
          tx.update('contacts', { contact_id: agent }, { status: 'revoked', updated_at: now });
        }
        const outboxStopped = stopOutboxTx(tx, keys);
        const activity: RevokeActivity = {
          self: false,
          outboxStopped,
          approvalsVoided: voided.approvals,
          partsVoided: voided.parts,
        };
        return activity;
      },
    };
  }

  /**
   * Opens the action of every approval a revoke may void and notes those that name `agent` as
   * counterparty. A row whose action does not open is decided by its scope alone (it authorises
   * nothing, approvals.ts). A store read error throws (fail closed: the revoke is not dropped).
   */
  async #readApprovals(agent: string): Promise<ApprovalsRead> {
    const ctx = this.#ctx;
    // A re-published copy of an applied revoke is a no-op in its transaction: nothing to read.
    const rows = await ctx.store.transaction((tx) =>
      tx.get('revoked_agents', { agent_evm: agent }) === undefined ? voidCandidatesTx(tx) : [],
    );
    const seen = new Set<string>();
    const named = new Set<string>();
    for (const row of rows) {
      seen.add(row.approval_id);
      let text: string;
      try {
        text = await open(ctx, 'approvals', 'action_json', [row.approval_id], row.action_json);
      } catch {
        continue;
      }
      if (actionCounterparty(text) === agent) named.add(row.approval_id);
    }
    return { seen, named };
  }
}
