// Test helpers for pairing (M1-7c). Not part of the build (tsconfig.json excludes src/testing).
// Real signed `handshake` / `handshake-ack` pairs (04 §3.6, §3.4.1, §3.6.1) made with both agents'
// keys, so a store can be given completion evidence that verifies as a transcript, or one that is
// deliberately broken in one place.
import {
  agentCardJcsHash,
  canonicalize,
  decodeHex0x,
  derivePairingProofKey,
  encodeBase64url,
  encodeHex,
  encodeHex0x,
  envelopeHash,
  pairingProof,
  randomBytes,
  safetyCodeCommit,
  type Envelope,
  type JsonValue,
  type KeyStore,
} from '@4thtech-io/crypto';
import type { SignedCard } from '../card.js';
import type { Row } from '../store/schema.js';
import { rowKeyOf, type Store, type StoreCipher } from '../store/store.js';
import { agentSigner, craft } from './envelopes.js';

export interface PairingParty {
  /** The agent's KeyStore at the epoch of `signed.card`. */
  readonly keyStore: KeyStore;
  readonly signed: SignedCard;
}

export interface CraftedTranscript {
  readonly handshake: Envelope;
  readonly handshakeHash: string;
  readonly handshakePayload: JsonValue;
  readonly ack: Envelope;
  readonly ackHash: string;
  readonly ackPayload: JsonValue;
}

export interface CraftTranscriptOptions {
  readonly inviter: PairingParty;
  readonly invitee: PairingParty;
  readonly createdAt: number;
  /** The handshake envelope id (the pairing ID). Default: random. */
  readonly handshakeId?: string;
  readonly inviteId?: Uint8Array;
  readonly nonceA?: Uint8Array;
  readonly nonceB?: Uint8Array;
  /** Changes the ack body before it is sealed and signed. */
  readonly mutateAck?: (body: Record<string, JsonValue>) => Record<string, JsonValue>;
  /** Changes the handshake body before it is sealed and signed. */
  readonly mutateHandshake?: (body: Record<string, JsonValue>) => Record<string, JsonValue>;
}

const card = (s: SignedCard): JsonValue => s.card as unknown as JsonValue;

let sequence = 0;
/**
 * A handshake `createdAt` that grows with each call, at or before `now`: a later pairing then wins
 * the 04 §2.9 tie-break as a real re-pair would, though the fake clock does not move.
 */
export function pairingTime(now: number): number {
  sequence += 1;
  return now - 100_000 + sequence;
}

/** The 04 §3.2 entries from `from` to `to`: to agent, to owner, from owner, from agent. */
function entries(from: SignedCard, to: SignedCard) {
  return [to.card.agentEnc, to.card.ownerEnc, from.card.ownerEnc, from.card.agentEnc]
    .filter((k, i, all) => all.indexOf(k) === i)
    .map((k) => ({ pk: decodeHex0x(k, { length: 32 }) }));
}

/** A real signed pair: B's handshake answering A's invite, and A's ack. */
export async function craftTranscript(options: CraftTranscriptOptions): Promise<CraftedTranscript> {
  const { inviter, invitee } = options;
  const inviteId = options.inviteId ?? randomBytes(16);
  const nonceA = options.nonceA ?? randomBytes(32);
  const nonceB = options.nonceB ?? randomBytes(32);
  const secret = randomBytes(32);
  const proofKey = derivePairingProofKey(secret);
  let hBody: Record<string, JsonValue> = {
    inviteId: encodeBase64url(inviteId),
    card: card(invitee.signed),
    cardSig: invitee.signed.cardSig,
    cardAgentSig: invitee.signed.cardAgentSig,
    name: invitee.signed.name,
    relays: [...invitee.signed.relays],
    proof: encodeBase64url(pairingProof(proofKey, inviteId, invitee.signed.card)),
    codeNonce: encodeBase64url(nonceB),
    codeCommit: encodeBase64url(safetyCodeCommit(inviteId, nonceA)),
    inviterCardHash: encodeHex(agentCardJcsHash(inviter.signed.card)),
  };
  if (options.mutateHandshake) hBody = options.mutateHandshake(hBody);
  const handshakePayload: JsonValue = { type: 'handshake', body: hBody, replyTo: null, files: [] };
  const handshake = await craft({
    signer: await agentSigner(invitee.keyStore),
    entries: entries(invitee.signed, inviter.signed),
    payload: handshakePayload,
    createdAt: options.createdAt,
    ...(options.handshakeId === undefined ? {} : { id: options.handshakeId }),
  });
  const handshakeHash = encodeHex0x(envelopeHash(handshake));
  let kBody: Record<string, JsonValue> = {
    inviteId: encodeBase64url(inviteId),
    handshakeId: handshake.id,
    handshakeHash,
    codeReveal: encodeBase64url(nonceA),
    card: card(inviter.signed),
    cardSig: inviter.signed.cardSig,
    relays: [...inviter.signed.relays],
  };
  if (options.mutateAck) kBody = options.mutateAck(kBody);
  const ackPayload: JsonValue = {
    type: 'handshake-ack',
    body: kBody,
    replyTo: handshake.id,
    files: [],
  };
  const ack = await craft({
    signer: await agentSigner(inviter.keyStore),
    entries: entries(inviter.signed, invitee.signed),
    payload: ackPayload,
    createdAt: options.createdAt,
    thread: handshake.thread,
  });
  return {
    handshake,
    handshakeHash,
    handshakePayload,
    ack,
    ackHash: encodeHex0x(envelopeHash(ack)),
    ackPayload,
  };
}

/** Stores a crafted pair in `self`'s store as its side `role` would hold it after processing. */
export async function storeTranscript(
  self: { readonly store: Store; readonly cipher: StoreCipher },
  t: CraftedTranscript,
  role: 'inviter' | 'invitee',
): Promise<{ readonly handshakeEnvelopeId: string; readonly handshakeAckEnvelopeId: string }> {
  const rows = [
    {
      env: t.handshake,
      hash: t.handshakeHash,
      payload: t.handshakePayload,
      type: 'handshake' as const,
      out: role === 'invitee',
    },
    {
      env: t.ack,
      hash: t.ackHash,
      payload: t.ackPayload,
      type: 'handshake-ack' as const,
      out: role === 'inviter',
    },
  ];
  const prepared: Row<'envelopes'>[] = [];
  for (const r of rows) {
    prepared.push({
      envelope_id: r.env.id,
      envelope_hash: r.hash,
      thread_id: r.env.thread,
      direction: r.out ? ('out' as const) : ('in' as const),
      contact_id: null,
      from_key: r.env.from,
      type: r.type,
      state: 'ok' as const,
      refused_reason: null,
      created_at: r.env.createdAt,
      envelope_json: canonicalize(r.env as unknown as JsonValue),
      payload_json: await self.cipher.seal(
        { table: 'envelopes', column: 'payload_json', rowKey: rowKeyOf([r.env.id]) },
        canonicalize(r.payload),
      ),
      read_at: null,
      delivery: r.out ? ('sent' as const) : null,
      refused_at: null,
      request_accepted_at: null,
    });
  }
  await self.store.transaction((tx) => {
    for (const row of prepared) tx.insert('envelopes', row);
  });
  return { handshakeEnvelopeId: t.handshake.id, handshakeAckEnvelopeId: t.ack.id };
}
