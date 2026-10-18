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
// - Not here (backlog M1-7h-b): voiding pending approvals and open commitment parts with the revoked
//   agent as counterparty (07 §3.4, 04 §3.4.2 void rule 3) and the Registry source (05 §4, M2-4b).
//
// I-4: nothing here takes presence or holds an owner key; the owner signature is the authority.
// I-5, I-7: refusals are fixed codes; nothing from the object is logged.
import { canonicalize, encodeHex } from '@4thtech-io/crypto';
import type { Payload } from '@4thtech-io/types';
import type { ContactBook } from './contacts.js';
import { nowOf, type CoreContext } from './context.js';
import type { InboundReason, PreparedRevoke, RevokeHandler } from './envelopes.js';
import type { IdentityService } from './identity.js';
import { verifyOwnerAction } from './owner-action.js';
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

/** Stops the `pending` outbox rows to `keys` (every row when `keys` is undefined), 07 §3.2. */
function stopOutboxTx(tx: StoreTx, keys: readonly string[] | undefined): void {
  const rows = tx
    .select('outbox', { state: 'pending' })
    .filter((r) => keys === undefined || keys.includes(r.recipient_key));
  for (const row of rows) {
    tx.update(
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
          stopOutboxTx(tx, undefined);
          return 'applied';
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
        stopOutboxTx(tx, keys);
        return 'applied';
      },
    };
  }
}
