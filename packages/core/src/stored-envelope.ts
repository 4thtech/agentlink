// Opens a stored pairing envelope with the agent's own key (04 §3.6.1: the code and the completion
// check come from the signed envelopes, never from a stored payload or digest). The agent is a
// recipient of every pairing message it sent or received (04 §3.2 entries 1 and 4), so its own
// `enc` key at some epoch unwraps the CEK; the plaintext is then authenticated by the AEAD against
// the signed header. The sealed `payload_json` column is never the source.
import {
  ENVELOPE_ID_LENGTH,
  HPKE_ENC_LENGTH,
  WRAPPED_CEK_LENGTH,
  decodeBase64url,
  encodeBase64url,
  parseEnvelope,
  parseJson,
  wipe,
  type AgentCard,
  type Envelope,
  type EnvelopeRecipient,
} from '@agentlink/crypto';
import { open, type CoreContext } from './context.js';
import { CoreError } from './errors.js';
import {
  openPairingMessage,
  verifyPairingTranscript,
  type OpenedPairingMessage,
  type PairingTranscript,
} from './safety-code.js';

const unavailable = (): CoreError =>
  new CoreError('safety_code_unavailable', "Can't show the safety code for this pairing.");

/** The agent's own `kid` (base64url) to epoch, every epoch up to the KeyStore's. */
export async function ownKids(ctx: CoreContext): Promise<ReadonlyMap<string, number>> {
  const current = await ctx.keyStore.getPublicBundle();
  const kids = new Map<string, number>();
  for (let epoch = 0; epoch <= current.keyEpoch; epoch += 1) {
    const bundle = await ctx.keyStore.getPublicBundle({ epoch });
    kids.set(encodeBase64url(bundle.kid), epoch);
  }
  return kids;
}

/** Opens a stored envelope's JSON text with the agent's own key. Throws `safety_code_unavailable`. */
export async function openStoredPairingMessage(
  ctx: CoreContext,
  envelopeJson: string | null | undefined,
  kids?: ReadonlyMap<string, number>,
): Promise<OpenedPairingMessage> {
  if (typeof envelopeJson !== 'string') throw unavailable();
  let envelope: Envelope;
  try {
    envelope = parseEnvelope(parseJson(envelopeJson));
  } catch {
    throw unavailable();
  }
  const own = kids ?? (await ownKids(ctx));
  let pick: { readonly entry: EnvelopeRecipient; readonly epoch: number } | undefined;
  for (const entry of envelope.recipients) {
    const epoch = own.get(entry.kid);
    if (epoch !== undefined && (pick === undefined || epoch > pick.epoch)) pick = { entry, epoch };
  }
  if (pick === undefined) throw unavailable();
  let cek: Uint8Array;
  try {
    cek = await ctx.keyStore.unwrapCek(
      {
        enc: decodeBase64url(pick.entry.enc, { length: HPKE_ENC_LENGTH }),
        wk: decodeBase64url(pick.entry.wk, { length: WRAPPED_CEK_LENGTH }),
      },
      decodeBase64url(envelope.id, { length: ENVELOPE_ID_LENGTH }),
      { epoch: pick.epoch },
    );
  } catch {
    throw unavailable();
  }
  try {
    return await openPairingMessage(envelope, cek);
  } finally {
    wipe(cek);
  }
}

/**
 * A contact's current pairing, recomputed from its stored signed `handshake` and `handshake-ack`
 * (04 §3.6.1 steps 1-5), with the envelope IDs it was computed from so a writer can check, in its
 * transaction, that the contact still points at the same pair. `code` is for owner surfaces only.
 */
export type StoredPairingCode =
  | {
      readonly status: 'ok';
      readonly code: string;
      readonly pairingDigest: string;
      readonly handshakeEnvelopeId: string;
      readonly ackEnvelopeId: string;
    }
  | { readonly status: 'unavailable'; readonly reason: 'not_paired' | 'invalid' | 'conflict' };

/**
 * Recomputes the code and digest of `contactId`'s completed pairing for the contact's current card,
 * never from a stored code, digest or column. Two different handshakes, or two different acks,
 * stored for the pairing's invite give no code (`conflict`, 04 §3.6.1).
 */
export async function recomputeStoredPairing(
  ctx: CoreContext,
  contactId: string,
  card: AgentCard,
): Promise<StoredPairingCode> {
  const notPaired: StoredPairingCode = { status: 'unavailable', reason: 'not_paired' };
  const rows = await ctx.store.transaction((tx) => {
    const row = tx.get('contacts', { contact_id: contactId });
    if (
      row?.pairing !== 'complete' ||
      row.handshake_envelope_id === null ||
      row.handshake_ack_envelope_id === null
    ) {
      return undefined;
    }
    return {
      handshakeEnvelopeId: row.handshake_envelope_id,
      ackEnvelopeId: row.handshake_ack_envelope_id,
      handshake: tx.get('envelopes', { envelope_id: row.handshake_envelope_id }),
      ack: tx.get('envelopes', { envelope_id: row.handshake_ack_envelope_id }),
      others: tx.select('envelopes', {
        type: { in: ['handshake', 'handshake-ack'] },
        state: 'ok',
      }),
    };
  });
  if (rows === undefined) return notPaired;
  let transcript: PairingTranscript;
  try {
    const kids = await ownKids(ctx);
    transcript = verifyPairingTranscript({
      self: (await ctx.keyStore.getPublicBundle()).agentId,
      contactCard: card,
      handshake: await openStoredPairingMessage(ctx, rows.handshake?.envelope_json, kids),
      ack: await openStoredPairingMessage(ctx, rows.ack?.envelope_json, kids),
    });
  } catch (error) {
    if (error instanceof CoreError && error.code === 'safety_code_unavailable') {
      return { status: 'unavailable', reason: 'invalid' };
    }
    throw error;
  }
  // Conflicting messages for one invite (04 §3.6.1): no code, and the owner is told to re-pair.
  const inviteId = transcript.handshake.body.inviteId;
  const used = new Set([transcript.handshake.hash, transcript.ack.hash]);
  for (const other of rows.others) {
    if (used.has(other.envelope_hash) || other.payload_json === null) continue;
    let body: unknown;
    try {
      const text = await open(
        ctx,
        'envelopes',
        'payload_json',
        [other.envelope_id],
        other.payload_json,
      );
      body = (parseJson(text) as { readonly body?: unknown }).body;
    } catch {
      continue;
    }
    if ((body as { readonly inviteId?: unknown } | undefined)?.inviteId === inviteId) {
      return { status: 'unavailable', reason: 'conflict' };
    }
  }
  return {
    status: 'ok',
    code: transcript.code,
    pairingDigest: transcript.pairingDigest,
    handshakeEnvelopeId: rows.handshakeEnvelopeId,
    ackEnvelopeId: rows.ackEnvelopeId,
  };
}
