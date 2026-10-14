// Test helpers for the envelope tests (M1-7b). Not part of the build (tsconfig.json excludes
// src/testing). Two paired agents with their own stores, and a way to craft envelopes that an honest
// core would never build (wrong wraps, a wrong commitment, a tampered ciphertext, a chosen id or
// time), signed by a real key so they pass steps 3 and 4 (04 §3.1.1).
import {
  canonicalize,
  decodeBase64url,
  encodeBase64url,
  encodeHex,
  encodeUtf8,
  encryptPayload,
  envelopeHash,
  generateCek,
  kidFromEncPublicKey,
  parseEnvelope,
  randomBytes,
  wrapCek,
  type Envelope,
  type EnvelopeHeader,
  type EnvelopeRecipient,
  type JsonValue,
  type KeyEpochControl,
  type KeyStore,
  type OwnerKeyStore,
} from '@agentlink/crypto';
import { AgentLinkClient } from '../client.js';
import { MemoryStore } from '../store/memory-store.js';
import {
  FakeClock,
  RELAYS,
  RecordingApprovalChannel,
  TestStoreCipher,
  passphrase,
  storePairingEnvelope,
} from './fixtures.js';

export interface TestAgent {
  readonly client: AgentLinkClient;
  readonly store: MemoryStore;
  readonly cipher: TestStoreCipher;
  readonly keyStore: KeyStore;
  readonly owner: TestOwner;
  /** The agentId. */
  readonly id: string;
}

/** An owner key store with an epoch control (MemoryOwnerKeyStore, from the test seam). */
export interface TestOwner extends OwnerKeyStore {
  epochControl(keyStore: KeyStore): KeyEpochControl;
}

export async function makeAgent(
  clock: FakeClock,
  keyStore: KeyStore,
  owner: TestOwner,
  name: string,
): Promise<TestAgent> {
  const store = new MemoryStore();
  const cipher = new TestStoreCipher();
  const client = await AgentLinkClient.create({
    keyStore,
    store,
    cipher,
    approvals: new RecordingApprovalChannel(),
    clock: clock.now,
  });
  await client.identity.init({
    owner: await owner.unlock(passphrase()),
    ownerKeys: await owner.getPublicKeys(),
    name,
    relays: RELAYS,
  });
  return { client, store, cipher, keyStore, owner, id: client.agentId };
}

/** `self` adds `peer` as a contact through a staged, completed pairing (04 §2.9). */
export async function pairWith(clock: FakeClock, self: TestAgent, peer: TestAgent): Promise<void> {
  const card = await peer.client.identity.signedCard();
  const { pairingId } = await self.client.contacts.stagePairing({
    ...card,
    role: 'invitee',
    expiresAt: clock.t + 3_600,
  });
  const own = (await self.client.identity.signedCard()).card.agentNostr.slice(2);
  const handshakeEnvelopeId = await storePairingEnvelope(self.store, {
    type: 'handshake',
    direction: 'out',
    from: own,
  });
  const handshakeAckEnvelopeId = await storePairingEnvelope(self.store, {
    type: 'handshake-ack',
    direction: 'in',
    from: card.card.agentNostr.slice(2),
  });
  await self.client.contacts.completePairing({
    pairingId,
    handshakeEnvelopeId,
    handshakeAckEnvelopeId,
  });
}

/** Rotates an agent to its next key epoch with its owner (04 §2.6, M1-1g-d). */
export async function rotate(agent: TestAgent): Promise<void> {
  await agent.client.identity.rotate({
    owner: await agent.owner.unlock(passphrase()),
    ownerKeys: await agent.owner.getPublicKeys(),
    epochControl: agent.owner.epochControl(agent.keyStore),
  });
}

export const textPayload = (body = 'hello'): JsonValue => ({
  type: 'text',
  body,
  replyTo: null,
  files: [],
});

export async function cardUpdatePayload(agent: TestAgent): Promise<JsonValue> {
  const signed = await agent.client.identity.signedCard();
  return {
    type: 'card-update',
    body: {
      card: signed.card as unknown as JsonValue,
      cardSig: signed.cardSig,
      name: signed.name,
      relays: [...signed.relays],
    },
    replyTo: null,
    files: [],
  };
}

export const agentEnc = async (agent: TestAgent, epoch?: number): Promise<Uint8Array> =>
  (await agent.keyStore.getPublicBundle(epoch === undefined ? {} : { epoch })).agentEnc;
export const ownerEnc = async (owner: OwnerKeyStore): Promise<Uint8Array> =>
  (await owner.getPublicKeys()).ownerEnc;
export const kid64 = (pk: Uint8Array): string => encodeBase64url(kidFromEncPublicKey(pk));
export const giftWrapId = (): string => encodeHex(randomBytes(32));

/** Who signs a crafted envelope: `from` and its envelope signature. */
export interface Signer {
  readonly from: string;
  sign(hash: Uint8Array): Promise<string>;
}

export async function agentSigner(keyStore: KeyStore): Promise<Signer> {
  const bundle = await keyStore.getPublicBundle();
  return { from: encodeHex(bundle.agentNostr), sign: (h) => keyStore.signEnvelopeHash(h) };
}

export async function ownerSigner(owner: OwnerKeyStore): Promise<Signer> {
  const keys = await owner.getPublicKeys();
  return {
    from: encodeHex(keys.ownerNostr),
    sign: async (h) => (await owner.unlock(passphrase())).signEnvelopeHash(h),
  };
}

export interface CraftEntry {
  readonly pk: Uint8Array;
  /** Seal this CEK instead of the payload's (a wrap that carries another key). */
  readonly cek?: Uint8Array;
}

export interface CraftOptions {
  readonly signer: Signer;
  readonly entries: readonly CraftEntry[];
  readonly payload?: JsonValue;
  readonly payloadBytes?: Uint8Array;
  readonly cek?: Uint8Array;
  readonly createdAt: number;
  readonly id?: string;
  readonly thread?: string;
  /** Flip one ciphertext byte before signing: `kc` still matches, the tag fails. */
  readonly tamperCt?: boolean;
  /** Changes the entries after wrapping and before the AEAD and the signature. */
  readonly mutateRecipients?: (list: EnvelopeRecipient[]) => EnvelopeRecipient[];
}

/** Builds and signs an envelope exactly as the options say, with no core-side rule applied. */
export async function craft(options: CraftOptions): Promise<Envelope> {
  const id = options.id ?? encodeBase64url(randomBytes(16));
  const rawId = decodeBase64url(id, { length: 16 });
  const cek = options.cek ?? generateCek();
  let recipients: EnvelopeRecipient[] = [];
  for (const entry of options.entries) {
    const wrapped = await wrapCek(entry.pk, rawId, entry.cek ?? cek);
    recipients.push({
      kid: kid64(entry.pk),
      enc: encodeBase64url(wrapped.enc),
      wk: encodeBase64url(wrapped.wk),
    });
  }
  if (options.mutateRecipients) recipients = options.mutateRecipients(recipients);
  const header: EnvelopeHeader = {
    v: 1,
    id,
    thread: options.thread ?? encodeBase64url(randomBytes(16)),
    from: options.signer.from,
    createdAt: options.createdAt,
    recipients,
  };
  const plaintext =
    options.payloadBytes ?? encodeUtf8(canonicalize(options.payload ?? textPayload()));
  let aead = await encryptPayload(header, cek, plaintext);
  if (options.tamperCt === true) {
    const ct = decodeBase64url(aead.ct);
    ct[0] = (ct[0] ?? 0) ^ 0x01;
    aead = { ...aead, ct: encodeBase64url(ct) };
  }
  const unsigned = { ...header, aead };
  const sig = await options.signer.sign(envelopeHash(unsigned));
  return parseEnvelope({ ...unsigned, sig });
}

export { FakeClock };
