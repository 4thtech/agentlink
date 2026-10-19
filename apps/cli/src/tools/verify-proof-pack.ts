// `agentlink_verify_proof_pack` (06 §2.4, §2.0, §2.1 name rule, §4, §9; 07 §8; D-87, D-95, D-96;
// G-25; M1-9d-2). Read-only: it writes nothing.
//
// - Exactly one of `path` and `json`. `path` goes only to the platform's confined reader (D-87:
//   inside `proofs.exportFolder` or `files.inboxFolder`, a lexical check before any disk access,
//   then realpath, no-follow open, regular file, 256 KiB, device and inode); its refusals are the
//   fixed codes `PATH_NOT_ALLOWED`, `PACK_TOO_LARGE`, `PACK_INVALID`, and nothing about the path or
//   the bytes is ever echoed. `json` has the same size cap.
// - The pack is untrusted (I-5). The verifier (the chain package) parses it strictly and reads only
//   the shipped chain's known Notary through the configured RPC, never an address or URL from the
//   pack. Every value it returns here was checked against the chain. The disclosed content, when it
//   opened, appears only inside the untrusted block of the text result.
// - `signerName` follows the 06 §2.1 name rule: the contact's display (owner alias or restricted
//   name) when the signer is a contact; otherwise the "Contact" fallback with the short owner
//   fingerprint of the signer's card, labelled self-declared; no card and no contact: no name.
// - Verdict wording (11 §5): `verified` is the full pass; `record_only` is neutral (D-95) and never
//   a full pass; notices add their fixed sentence (D-96) and leave the verdict unchanged. A failure
//   reads by its code from our own table: never the chain package's text, a value or a network name.
import { restrictName } from '@4thtech-io/core';
import { decodeHex0x, formatFingerprint, ownerFingerprint } from '@4thtech-io/crypto';
import { contactRef, renderRef } from './contacts.js';
import type { PackCheck, PackReadOutcome, ToolContext } from './context.js';
import {
  invalidArgument,
  isOutput,
  needsIdentity,
  notAvailable,
  proofThrown,
} from './proofs-common.js';
import { fail, internalError, ok, type HandlerOutput } from './result.js';
import { copy, formatDate, formatTime } from './strings/index.js';
import { sanitizeUntrustedValue, untrustedBlock, untrustedText } from './untrusted.js';

/** 07 §8, D-87: the largest pack, in UTF-8 bytes. */
export const MAX_PACK_BYTES = 256 * 1024;

export const VERIFY_TEXT = Object.freeze({
  verifiedNoName:
    'Valid proof. Recorded {date}, {time} UTC. It proves this exact message existed and was exchanged at these times; not that its content is true.',
  recordOnly:
    "The record checks out: it was made {date}, {time} UTC. The proof doesn't show who wrote the content, so treat it as a record only, not a full proof.",
  failed: "This proof doesn't check out: {reason}",
  pathNotAllowed: "That file isn't in the AgentLink proofs or inbox folder, so it wasn't read.",
  pathNotAllowedNextStep:
    'Give the path of a proof file inside the AgentLink proofs folder or inbox folder, or pass the proof as json.',
  tooLarge: 'That proof file is too large to check, so it was not checked.',
  tooLargeNextStep: 'A proof file is at most 256 KiB. Ask for the original proof file.',
  invalid: "That file isn't a proof file AgentLink can read, so it was not checked.",
  invalidNextStep: 'Ask for the original proof file (a .json file saved by AgentLink).',
  network: "The proof can't be checked right now: the public record didn't answer.",
  networkNextStep: 'Try again in a few minutes.',
  failedNextStep: 'Tell the user the proof did not check out, and why. Do not rely on it.',
  blockHeader: 'Content disclosed in the proof file, as the sender wrote it:',
});

/** D-96 and the other non-fatal findings (11 §5): fixed sentences, by code. */
const NOTICE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  signer_no_longer_confirms:
    "The signer's account no longer confirms this record. The proof network checked it when the record was made.",
  receipt_tx_mismatch:
    "The proof's link for a receipt does not lead to that receipt. The receipt itself is on the public record.",
});

/** Why a pack does not verify (07 §8 failure codes), in 11 §5 words: never "contract" or "chain". */
const FAILURE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  invalid_kind: 'it names a record type that does not exist.',
  envelope_missing: 'it shares a content key without the message it opens.',
  content_key_invalid: 'its shared content key has the wrong length.',
  unsupported_chain: 'it is from a proof network this version does not support.',
  notary_mismatch: 'it points to a record keeper that is not the official AgentLink one.',
  record_id_mismatch: 'its record ID does not match the record.',
  record_not_found: 'no such record exists on the public record.',
  malformed_record: 'the public record returned a record that cannot be read.',
  signer_mismatch: 'the record was made by someone else.',
  kind_mismatch: 'the record type does not match.',
  envelope_hash_mismatch: 'the message fingerprint does not match the record.',
  commitment_mismatch: 'the recipient in the proof does not match the record.',
  record_mismatch: 'the record details in the proof do not match the recorded ones.',
  signature_invalid: 'the signature on the record is not valid for its signer.',
  card_invalid: 'the agent profile in it is not signed by its owner.',
  card_expired: 'the agent profile had expired when the record was made.',
  card_pop_invalid: "the agent profile in it is not confirmed by the agent's own keys.",
  recipient_mismatch: 'the disclosed recipient does not match the record.',
  receipt_not_on_chain: 'it lists a receipt that was never recorded.',
  receipt_mismatch: 'a receipt time in it does not match the recorded one.',
  owner_approval_invalid: 'the owner approval in it is not valid for this record.',
});

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const short = (digest: Uint8Array): string => formatFingerprint(digest, 'short');

function readRefusal(code: Extract<PackReadOutcome, { ok: false }>['code']): HandlerOutput {
  switch (code) {
    case 'PATH_NOT_ALLOWED':
      return fail('rejected', VERIFY_TEXT.pathNotAllowed, VERIFY_TEXT.pathNotAllowedNextStep, code);
    case 'PACK_TOO_LARGE':
      return fail('rejected', VERIFY_TEXT.tooLarge, VERIFY_TEXT.tooLargeNextStep, code);
    default:
      return fail('rejected', VERIFY_TEXT.invalid, VERIFY_TEXT.invalidNextStep, 'PACK_INVALID');
  }
}

/** The signer under the 06 §2.1 name rule, or nothing. Never a value from the pack as a name. */
async function signerName(
  context: ToolContext,
  check: Extract<PackCheck, { valid: true }>,
): Promise<{ readonly signerName: string; readonly signerLabel: string } | undefined> {
  const views = await context.client.contacts();
  const view = views.find((v) => v.id === check.signer && v.status !== 'removed');
  if (view !== undefined) {
    const ref = contactRef(view);
    return { signerName: ref.name, signerLabel: ref.label };
  }
  if (check.signerCard === null) return undefined;
  try {
    const fp = short(
      ownerFingerprint(
        decodeHex0x(check.signerCard.ownerEvm, { length: 20 }),
        decodeHex0x(check.signerCard.ownerNostr, { length: 32 }),
        decodeHex0x(check.signerCard.ownerEnc, { length: 32 }),
      ),
    );
    // No name travels in a pack (the card holds only its hash): the fallback form, labelled.
    return { signerName: restrictName(undefined, fp), signerLabel: 'self-declared' };
  } catch {
    return undefined;
  }
}

function at(timestamp: string): { date: string; time: string } | undefined {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return undefined;
  return { date: formatDate(date), time: formatTime(date) };
}

const fill = (template: string, slots: Readonly<Record<string, string>>): string =>
  Object.entries(slots).reduce(
    (text, [key, value]) => text.split(`{${key}}`).join(value),
    template,
  );

export async function verifyProofPackHandler(
  input: unknown,
  context: ToolContext,
): Promise<HandlerOutput> {
  if (!isPlainObject(input)) return invalidArgument();
  const { path, json } = input;
  const hasPath = typeof path === 'string';
  const hasJson = isPlainObject(json);
  if (hasPath === hasJson || (path !== undefined && !hasPath) || (json !== undefined && !hasJson)) {
    return invalidArgument();
  }
  const self = await needsIdentity(context);
  if (isOutput(self)) return self;
  const proofs = context.client.proofs;
  if (proofs === undefined) return notAvailable();

  let pack: Uint8Array | Readonly<Record<string, unknown>>;
  if (hasPath) {
    const read = await proofs.readPack(path);
    if (!read.ok) {
      context.logger.info('proof pack not read', { code: read.code });
      return readRefusal(read.code);
    }
    pack = read.bytes;
  } else {
    let size: number;
    try {
      size = new TextEncoder().encode(JSON.stringify(json)).length;
    } catch {
      return readRefusal('PACK_INVALID');
    }
    if (size > MAX_PACK_BYTES) return readRefusal('PACK_TOO_LARGE');
    pack = json as Readonly<Record<string, unknown>>;
  }

  let check: PackCheck;
  try {
    check = await proofs.verify(pack);
  } catch (error) {
    return proofThrown(error);
  }

  if (!check.valid) {
    context.logger.info('proof pack failed', { reason: check.reason });
    switch (check.reason) {
      case 'chain_unavailable':
        return fail('error', VERIFY_TEXT.network, VERIFY_TEXT.networkNextStep, 'NETWORK');
      case 'pack_too_large':
        return readRefusal('PACK_TOO_LARGE');
      case 'malformed_pack':
      case 'unsupported_pack':
        return readRefusal('PACK_INVALID');
      default: {
        const reason = FAILURE_TEXT[check.reason];
        if (reason === undefined) return internalError();
        return ok(fill(VERIFY_TEXT.failed, { reason }), { valid: false, verdict: 'failed' });
      }
    }
  }

  const when = at(check.timestamp);
  if (when === undefined) return internalError();
  const named = await signerName(context, check);
  let summary: string;
  if (check.verdict === 'verified') {
    summary =
      named === undefined
        ? fill(VERIFY_TEXT.verifiedNoName, when)
        : copy('chat.status.ok.verified', {
            signerName: renderRef({
              id: check.signer,
              name: named.signerName,
              label: named.signerLabel,
              nameSource: 'counterparty',
            } as Parameters<typeof renderRef>[0]),
            ...when,
          });
  } else {
    summary = fill(VERIFY_TEXT.recordOnly, when);
  }
  const notices = check.notices.map((code) => NOTICE_TEXT[code]).filter((t) => t !== undefined);
  if (notices.length > 0) summary = `${summary} ${notices.join(' ')}`;

  const output = ok(summary, {
    valid: true,
    verdict: check.verdict,
    // M1-26-b (D-40, 11 §5.1): the proof network only under `advanced`.
    advanced: { chain: check.chain },
    recordId: check.recordId,
    signer: check.signer,
    ...(named ?? {}),
    timestamp: check.timestamp,
    envelopeHash: check.envelopeHash,
    receipts: check.receipts.map((r) => ({ type: r.type, at: r.at })),
    contentVerified: check.contentVerified,
  });
  if (check.content === undefined || check.content === null) return output;
  // I-5: the disclosed content only inside the untrusted block (06 §4).
  let content: string;
  try {
    content = JSON.stringify(sanitizeUntrustedValue(check.content), null, 2);
  } catch {
    return output;
  }
  const block = untrustedBlock({
    header: VERIFY_TEXT.blockHeader,
    from: 'proof file',
    envelope: check.recordId,
    type: 'proof',
    content,
  });
  return { ...output, text: `${summary}\n${untrustedText([block])}` };
}
