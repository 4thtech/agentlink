// M1-PAY-CONFIRM-a: the ceremony that confirms a paid action on the owner's page (04 §2.5.3 rules
// 1 to 4, 6 and 7; 08 §1; 12 §4.6; D-132; I-1, I-4, I-5, I-7).
//
// What it is: the begin and finish holds of the local approval server's paid-action confirmation,
// and the checks of the WebAuthn `get` response the page sends back. The server (approval-server.ts,
// `payConfirmGate`) wires them to `POST /api/ui/pay-confirm/begin` and `/finish`.
//
// Rules (each has a test in pay-confirm.test.ts):
// - Begin fixes the exact owner flow and its objects to sign (core `buildPayConfirmFlow`: a proof
//   approval's pending action, a limits change's unsigned `policy.set`, or both for "Remember for
//   this contact") and derives the challenge of rule 2 from a fresh 32-byte nonce. The hold keeps
//   the challenge, the statement and body digests and the frozen objects; it is bound to the page
//   session that began it, valid PAY_CONFIRM_TTL_MS (120 s), and usable once.
// - Finish with the passkey consumes the hold whatever the outcome. It refuses unless
//   `clientDataJSON` is `webauthn.get` with exactly this hold's challenge and the page's origin (no
//   cross-origin, no top origin), the rpIdHash is SHA-256("localhost"), UP is set, the credential is
//   the stored owner passkey and the user handle the owner. Without UV it is `verification_required`,
//   never presence alone (rule 1).
// - Finish with the backup code (the owner code, rule 6) keeps the hold for at most
//   BACKUP_CODE_TRIES wrong entries; the third ends it and nothing is signed.
// - Before the owner store is opened the server rebuilds the flow from the store as it is now and
//   compares both digests with the hold's: any change of amount, limit, contact or expiry after
//   begin is `changed`, and needs a new begin and a new gesture (rule 3).
// - The gesture signs exactly the hold's objects (rule 3); nothing from the finish request reaches
//   what is signed. A hold that signs a proof approval cannot also sign a `policy.set`.
// - Rule 4: no MCP tool, CLI flag or URL reaches begin or finish. They are /api/ui/ routes behind the
//   page session cookie, the CSRF token, the page's Origin and same-origin fetch metadata.
// - I-7: no challenge, nonce, assertion, owner code or credential is logged, put in an event or an
//   error. Holds live in memory only and are wiped when used, expired, dropped or closed.
//
// Rule 5: the assertion signature over authenticatorData ‖ SHA-256(clientDataJSON) is verified
// (@4thtech-io/crypto verifyWebauthnSignature) with the credential public key kept at registration
// (owner-passkey.ts `owner-passkey-key`, bound to the credential ID). Without it a same-user process
// could send any clientDataJSON with the UV flag set; with it, only the authenticator can answer
// this challenge. A passkey registered before keys were kept (or with an unsupported key) has no
// stored key: its passkey path answers `key_missing` (the page offers the backup code and setting
// the passkey up again); it is never accepted on the PRF unlock alone. signCount is not checked
// (platform passkeys report 0; replay is stopped by the single-use challenge). The stored key is
// writable by the same OS user: the G-1 residual of 04 §2.5, unchanged.
import {
  canonicalize,
  decodeUtf8,
  encodeBase64url,
  encodeUtf8,
  equalBytes,
  randomBytes,
  sha256,
  verifyWebauthnSignature,
  wipe,
  type OwnerPublicKeys,
  type PasskeyBlobHeader,
} from '@4thtech-io/crypto';
import {
  PAY_CONFIRM_NONCE_BYTES,
  PAY_CONFIRM_TTL_MS,
  payConfirmChallenge,
  payConfirmDigests,
  type PayConfirmFlow,
  type PayConfirmStatement,
} from '@4thtech-io/core';
import { PASSKEY_RP_ID } from './owner-passkey.js';
import { checkGesture, type OwnerSignRequest } from './owner-operation.js';

export { PAY_CONFIRM_TTL_MS };
/** Rule 6: three wrong backup-code entries end the attempt (04 §2.8). */
export const BACKUP_CODE_TRIES = 3;
/** At most this many holds at a time (a few tabs); the oldest goes first. */
export const MAX_PAY_CONFIRM_HOLDS = 4;
/** The largest finish body: six length-prefixed fields. */
export const MAX_PAY_CONFIRM_ASSERTION_BYTES = 8192;

const MAX_CREDENTIAL_ID = 1023;
const MIN_AUTH_DATA = 37;
const MAX_AUTH_DATA = 1024;
const MAX_CLIENT_DATA = 2048;
const MAX_SIGNATURE = 512;
const MAX_USER_HANDLE = 64;
const PRF_LENGTH = 32;
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;

/** What the page sends after `navigator.credentials.get` with the begin's challenge. */
export interface PayConfirmAssertion {
  readonly credentialId: Uint8Array;
  readonly authenticatorData: Uint8Array;
  /** `response.clientDataJSON`, as the browser produced it. */
  readonly clientDataJSON: Uint8Array;
  /** `response.signature` (rule 5: carried, verified by the follow-up card). */
  readonly signature: Uint8Array;
  readonly userHandle: Uint8Array;
  /** The 32-byte PRF output for the owner's PRF salt. */
  readonly prfOutput: Uint8Array;
}

/** Why a finish is refused. Fixed codes (I-7). */
export type PayConfirmAssertionCheck =
  | 'ok'
  | 'verification_required'
  | 'presence_rejected'
  /** No credential public key is kept for this passkey (rule 5): never accepted without it. */
  | 'key_missing';

function u16(value: number): Uint8Array {
  return new Uint8Array([value >> 8, value & 0xff]);
}

/** The finish body: each field after its 16-bit big-endian length. The page builds the same. */
export function encodePayConfirmAssertion(a: PayConfirmAssertion): Uint8Array {
  const fields = [
    a.credentialId,
    a.authenticatorData,
    a.clientDataJSON,
    a.signature,
    a.userHandle,
    a.prfOutput,
  ];
  const out = new Uint8Array(fields.reduce((n, f) => n + 2 + f.length, 0));
  let at = 0;
  for (const field of fields) {
    out.set(u16(field.length), at);
    out.set(field, at + 2);
    at += 2 + field.length;
  }
  return out;
}

/** Parses a finish body into fresh copies, or undefined when malformed or out of bounds. */
export function parsePayConfirmAssertion(bytes: Uint8Array): PayConfirmAssertion | undefined {
  const out: Uint8Array[] = [];
  let at = 0;
  for (let i = 0; i < 6; i += 1) {
    if (at + 2 > bytes.length) {
      wipe(...out);
      return undefined;
    }
    const length = ((bytes[at] as number) << 8) | (bytes[at + 1] as number);
    at += 2;
    if (at + length > bytes.length) {
      wipe(...out);
      return undefined;
    }
    out.push(bytes.slice(at, at + length));
    at += length;
  }
  const [credentialId, authenticatorData, clientDataJSON, signature, userHandle, prfOutput] =
    out as [Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array, Uint8Array];
  if (
    at !== bytes.length ||
    credentialId.length < 1 ||
    credentialId.length > MAX_CREDENTIAL_ID ||
    authenticatorData.length < MIN_AUTH_DATA ||
    authenticatorData.length > MAX_AUTH_DATA ||
    clientDataJSON.length < 1 ||
    clientDataJSON.length > MAX_CLIENT_DATA ||
    signature.length > MAX_SIGNATURE ||
    userHandle.length > MAX_USER_HANDLE ||
    prfOutput.length !== PRF_LENGTH
  ) {
    wipe(...out);
    return undefined;
  }
  return Object.freeze({
    credentialId,
    authenticatorData,
    clientDataJSON,
    signature,
    userHandle,
    prfOutput,
  });
}

/**
 * Rule 1: the checks of a finish's assertion against its hold, before the PRF output is used.
 * `verification_required` when every other check passes but UV is not set.
 */
export function checkPayConfirmAssertion(
  assertion: PayConfirmAssertion,
  expected: {
    readonly challenge: Uint8Array;
    readonly origin: string;
    readonly passkey: PasskeyBlobHeader;
    /** The stored credential public key (COSE_Key) for that passkey, or null (rule 5). */
    readonly publicKey: Uint8Array | null;
    readonly owner: OwnerPublicKeys;
  },
): PayConfirmAssertionCheck {
  let clientData: unknown;
  try {
    clientData = JSON.parse(decodeUtf8(assertion.clientDataJSON));
  } catch {
    return 'presence_rejected';
  }
  if (typeof clientData !== 'object' || clientData === null || Array.isArray(clientData)) {
    return 'presence_rejected';
  }
  const data = clientData as Record<string, unknown>;
  if (
    data['type'] !== 'webauthn.get' ||
    data['challenge'] !== encodeBase64url(expected.challenge) ||
    data['origin'] !== expected.origin ||
    (data['crossOrigin'] !== undefined && data['crossOrigin'] !== false) ||
    data['topOrigin'] !== undefined
  ) {
    return 'presence_rejected';
  }
  const auth = assertion.authenticatorData;
  if (auth.length < MIN_AUTH_DATA) return 'presence_rejected';
  const flags = auth[32] as number;
  if (
    !equalBytes(auth.subarray(0, 32), sha256(encodeUtf8(PASSKEY_RP_ID))) ||
    (flags & FLAG_UP) === 0 ||
    !equalBytes(assertion.credentialId, expected.passkey.credentialId) ||
    !equalBytes(expected.passkey.ownerNostr, expected.owner.ownerNostr) ||
    !equalBytes(assertion.userHandle, expected.owner.ownerNostr) ||
    assertion.prfOutput.length !== PRF_LENGTH
  ) {
    return 'presence_rejected';
  }
  // Rule 5: the authenticator's own signature over exactly this response.
  if (expected.publicKey === null) return 'key_missing';
  if (
    !verifyWebauthnSignature(
      expected.publicKey,
      assertion.authenticatorData,
      assertion.clientDataJSON,
      assertion.signature,
    )
  ) {
    return 'presence_rejected';
  }
  // Rule 1: never downgraded to presence alone.
  if ((flags & FLAG_UV) === 0) return 'verification_required';
  return 'ok';
}

/** How the server rebuilds a hold's flow from the store at finish (rule 3). */
export type PayConfirmTarget =
  | { readonly kind: 'proof'; readonly approvalId: string }
  | {
      readonly kind: 'limits';
      /** The version the policy.set signs. */
      readonly version: number;
      /** D-109: record the receipts-kept marker after it applies (as a rules save does). */
      readonly keepDeliveryReceipts: boolean;
    };

/** One begin, held for its finish. In memory only. */
export interface PayConfirmHold {
  readonly id: string;
  readonly target: PayConfirmTarget;
  readonly statement: PayConfirmStatement;
  /** The objects this gesture signs, checked and frozen at begin (rule 3). */
  readonly requests: readonly OwnerSignRequest[];
  readonly challenge: Uint8Array;
  readonly statementDigest: Uint8Array;
  readonly bodyDigest: Uint8Array;
  readonly session: Uint8Array;
  readonly expiresAt: number;
  backupFailures: number;
}

/** The objects a flow may sign: exactly those whose bodies are in the challenge (rule 3). */
function assertRequestsMatchFlow(
  flow: PayConfirmFlow,
  requests: readonly OwnerSignRequest[],
): void {
  const ops = requests.map((r) => (r.kind === 'owner-action' ? r.action['op'] : undefined));
  const kind = flow.statement.kind;
  const ok =
    (kind === 'proof' && ops.length === 1 && ops[0] === 'approval.decide') ||
    (kind === 'limits' && ops.length === 1 && ops[0] === 'policy.set') ||
    (kind === 'proof_remember' &&
      ops.length === 2 &&
      ops[0] === 'approval.decide' &&
      ops[1] === 'policy.set');
  if (!ok) throw new Error('pay-confirm: the objects do not fit the flow');
  const policySet = ops.indexOf('policy.set');
  if (policySet >= 0) {
    // The policy.set signed must be the very body in the challenge.
    const body = kind === 'limits' ? flow.body : (flow.body as readonly unknown[])[1];
    const signed = (requests[policySet] as { action: unknown }).action;
    if (canonicalize(signed as never) !== canonicalize(body as never)) {
      throw new Error('pay-confirm: the rule change is not the one in the challenge');
    }
  }
}

/** The holds of one server. */
export class PayConfirmHolds {
  readonly #now: () => number;
  readonly #holds = new Map<string, PayConfirmHold>();

  constructor(now: () => number) {
    this.#now = now;
  }

  /**
   * Holds a new flow for `session` and returns it (its `challenge` goes to the page). `requests`
   * are checked as one gesture and must be exactly the flow's objects.
   */
  begin(
    session: Uint8Array,
    target: PayConfirmTarget,
    flow: PayConfirmFlow,
    requests: readonly OwnerSignRequest[],
  ): PayConfirmHold {
    this.sweep();
    const frozen = checkGesture({ lines: ['Confirm a paid action.'] }, requests);
    assertRequestsMatchFlow(flow, frozen);
    while (this.#holds.size >= MAX_PAY_CONFIRM_HOLDS) {
      const oldest = this.#holds.keys().next();
      if (oldest.done === true) break;
      this.drop(oldest.value);
    }
    const nonce = randomBytes(PAY_CONFIRM_NONCE_BYTES);
    const digests = payConfirmDigests(flow);
    const hold: PayConfirmHold = {
      id: encodeBase64url(randomBytes(16)),
      target,
      statement: flow.statement,
      requests: frozen,
      challenge: payConfirmChallenge(nonce, flow),
      statementDigest: digests.statement,
      bodyDigest: digests.body,
      session: session.slice(),
      expiresAt: this.#now() + PAY_CONFIRM_TTL_MS,
      backupFailures: 0,
    };
    wipe(nonce);
    this.#holds.set(hold.id, hold);
    return hold;
  }

  /**
   * The hold `id` for `session`: `unknown` when there is none for this session (another session
   * neither sees nor consumes it), `expired` (and dropped) after 120 s. `take` removes it (a passkey
   * finish: single use whatever the outcome); otherwise it stays for the backup-code tries.
   */
  get(id: unknown, session: Uint8Array, take: boolean): PayConfirmHold | 'unknown' | 'expired' {
    if (typeof id !== 'string') return 'unknown';
    const hold = this.#holds.get(id);
    if (hold === undefined || !equalBytes(hold.session, session)) return 'unknown';
    if (this.#now() >= hold.expiresAt) {
      this.drop(id);
      return 'expired';
    }
    if (take) this.#holds.delete(id);
    return hold;
  }

  /** Rule 6: one wrong backup code; true when that was the last try (the hold is gone). */
  backupFailed(hold: PayConfirmHold): boolean {
    hold.backupFailures += 1;
    if (hold.backupFailures >= BACKUP_CODE_TRIES) {
      this.drop(hold.id);
      return true;
    }
    return false;
  }

  /** True when the flow rebuilt now is exactly the one held (rule 3). */
  static sameFlow(hold: PayConfirmHold, flow: PayConfirmFlow): boolean {
    const d = payConfirmDigests(flow);
    return equalBytes(d.statement, hold.statementDigest) && equalBytes(d.body, hold.bodyDigest);
  }

  /** Removes and wipes a hold. */
  drop(id: string): void {
    const hold = this.#holds.get(id);
    if (hold === undefined) return;
    this.#holds.delete(id);
    PayConfirmHolds.wipe(hold);
  }

  /** Wipes a hold's secrets (after it was taken). */
  static wipe(hold: PayConfirmHold): void {
    wipe(hold.challenge, hold.session, hold.statementDigest, hold.bodyDigest);
  }

  /**
   * Drops the holds of sessions no longer open (`open`), or, without it, the expired holds. A
   * finish sweeps by session only, so its own expired hold still answers `expired`.
   */
  sweep(open?: (session: Uint8Array) => boolean): void {
    const now = this.#now();
    for (const [id, hold] of [...this.#holds]) {
      if (open === undefined ? now >= hold.expiresAt : !open(hold.session)) this.drop(id);
    }
  }

  /** Drops every hold (the server closes). */
  clear(): void {
    for (const id of [...this.#holds.keys()]) this.drop(id);
  }

  get size(): number {
    return this.#holds.size;
  }
}
