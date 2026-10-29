// W4-ONE-TOUCH (S2; D-140; 04 §2.3.1, §2.5 "One entry", §2.5.1 `app.connect`, §2.8 "Create an
// agent and connect its AI app with one gesture"; 06 §7; 08 §1; 11 §5.8; I-4, I-7; one gesture
// decided by the owner, Decision 43 W5; details proposed, owner confirms at merge).
//
// The plan of "create an agent and connect its AI app with one gesture": what `begin` fixes before the
// gesture and what `finish` signs after it. It holds no secret: the new agent's seed is held by its
// HeldAgentSeed (keychain-keystore.ts) and the owner's by the server's setup hold.
//
// - The plan is the ordered list of unsigned bodies [first AgentCard, first policy.set, first
//   agent.label, app.connect]: the policy only when the Send folder is ready (as today: otherwise the
//   agent keeps the 06 §3 defaults), the app.connect only when an app was picked. The card is built by
//   core's IdentityService from the agent's KeyStore when it is signed (its creation time and relay
//   list are core's), so its entry carries exactly what the restricted session checks: the agent,
//   the owner and the name. Every SignedOwnerAction body is built here once (core
//   buildOwnerActionBody: its one encoding, a fresh nonce, `expiresAt` = `issuedAt` + 600 s) for this
//   agentId and this owner, and later signed byte for byte.
// - The challenge binds the statement the page shows and the plan:
//   SHA-256("agentlink-create-connect-v1" ‖ nonce ‖ SHA-256(JCS(statement)) ‖ SHA-256(JCS(plan))),
//   with a fresh 32-byte nonce (usable once, 120 s, bound to the page session by the holder).
// - PlanOwnerSession is the restricted owner session of `finish`: it signs exactly the plan's bodies,
//   in plan order, each at most once and byte for byte, and refuses everything else (another op,
//   another agent or owner, a second app.connect, a changed body). So a plan cannot be extended
//   (no body can be added), split (the order is fixed and finish takes no subset) or replayed (each
//   body once; the nonce dies with the hold; core checks each object's own nonce).
//
// Nothing here logs; a refusal is a fixed error with no input text (I-7). No MCP tool reaches it
// (I-4): only the approval server's setup and create-agent gates use it.
import {
  PREPARED_OWNER_ACTION_LIFETIME_SECONDS,
  buildOwnerActionBody,
  newOwnerActionNonce,
} from '@4thtech-io/core';
import {
  KeyStoreError,
  agentFingerprint,
  canonicalize,
  concatBytes,
  decodeHex0x,
  encodeHex,
  encodeHex0x,
  encodeUtf8,
  formatFingerprint,
  parseJson,
  sha256,
  type JsonObject,
  type NostrEvent,
  type OwnerPublicKeys,
  type OwnerSession,
  type TypedData,
} from '@4thtech-io/crypto';
import { allowedTypedData, ownerOperationRefused } from './owner-allowlist.js';
import { firstPolicyDocument } from './owner-first-policy.js';

/** The challenge's domain tag (04 §2.8). */
export const CREATE_CONNECT_DOMAIN = 'agentlink-create-connect-v1';
/** How long a held plan, its seed and its challenge live (04 §2.8, as §2.3.1): 120 s. */
export const CREATE_CONNECT_HOLD_MS = 120_000;
/** Wrong presence proofs one held plan takes before it ends (04 §2.8 owner-code prompts). */
export const CREATE_CONNECT_TRIES = 3;
/** The begin nonce: 32 random bytes. */
export const CREATE_CONNECT_NONCE_BYTES = 32;

/** The AI app part of the statement: what the screen shows of the entry change (11 §5.8). */
export interface PlanStatementApp {
  readonly app: string;
  readonly name: string;
  readonly kind: 'connect' | 'move';
  /** The config file as shown (`~/…`). */
  readonly path: string;
  readonly oldEntry: JsonObject | null;
  readonly newEntry: JsonObject | null;
  /** For a move, the folder name of the agent the app leaves. */
  readonly oldAgent: string | null;
}

/** What the screen shows before the gesture, rendered only from begin's answer (04 §2.8). */
export interface PlanStatement {
  readonly label: string;
  readonly agentFingerprint: string;
  /** With an existing owner, the owner the local cards name; on first run the new owner. */
  readonly ownerFingerprint: string;
  readonly folder: string;
  readonly app?: PlanStatementApp;
}

/** The plan fixed at begin (see the header). */
export interface CreateConnectPlan {
  readonly agentId: string;
  readonly owner: OwnerPublicKeys;
  readonly label: string;
  readonly folder: string;
  readonly card: JsonObject;
  readonly policy?: JsonObject;
  readonly labelBody: JsonObject;
  readonly connect?: JsonObject;
  /** The ordered entries (card, policy?, label, connect?), as the challenge binds them. */
  readonly entries: readonly JsonObject[];
}

export interface CreateConnectPlanInput {
  readonly agentId: string;
  readonly owner: OwnerPublicKeys;
  readonly label: string;
  readonly folder: string;
  /** The ready Send folder's real path, for the first policy; absent: no policy in the plan. */
  readonly sendFolder?: string;
  /** The picked app's id and the `changeId` computed for this agentId; absent: no app.connect. */
  readonly app?: { readonly app: string; readonly changeId: string };
  /** Unix seconds: every body's `issuedAt`. */
  readonly nowSeconds: number;
}

/** A frozen plain copy of a JSON value, in its JCS form. */
const frozenCopy = (value: unknown): JsonObject =>
  Object.freeze(parseJson(canonicalize(value as JsonObject)) as JsonObject);

/** Builds the plan (see the header). Throws a fixed error when a body is not canonical. */
export function buildCreateConnectPlan(input: CreateConnectPlanInput): CreateConnectPlan {
  const { agentId, owner, label, folder, nowSeconds } = input;
  const ownerHex = encodeHex(owner.ownerNostr);
  const timing = (): { nonce: string; issuedAt: number; expiresAt: number } => ({
    nonce: newOwnerActionNonce(),
    issuedAt: nowSeconds,
    expiresAt: nowSeconds + PREPARED_OWNER_ACTION_LIFETIME_SECONDS,
  });
  const card = frozenCopy({
    kind: 'card',
    agentEvm: agentId,
    ownerEvm: encodeHex0x(owner.ownerEvm),
    ownerNostr: encodeHex0x(owner.ownerNostr),
    ownerEnc: encodeHex0x(owner.ownerEnc),
    name: label,
  });
  const policy =
    input.sendFolder === undefined
      ? undefined
      : frozenCopy(
          buildOwnerActionBody({
            agent: agentId,
            owner: ownerHex,
            op: 'policy.set',
            params: { version: 1, policy: firstPolicyDocument(input.sendFolder) as never },
            ...timing(),
          }).body,
        );
  const labelBody = frozenCopy(
    buildOwnerActionBody({
      agent: agentId,
      owner: ownerHex,
      op: 'agent.label',
      params: { agent: agentId, label },
      ...timing(),
    }).body,
  );
  const connect =
    input.app === undefined
      ? undefined
      : frozenCopy(
          buildOwnerActionBody({
            agent: agentId,
            owner: ownerHex,
            op: 'app.connect',
            params: { app: input.app.app as never, agent: agentId, changeId: input.app.changeId },
            ...timing(),
          }).body,
        );
  const entries = Object.freeze(
    [card, policy, labelBody, connect].filter((e): e is JsonObject => e !== undefined),
  );
  return Object.freeze({
    agentId,
    owner,
    label,
    folder,
    card,
    ...(policy === undefined ? {} : { policy }),
    labelBody,
    ...(connect === undefined ? {} : { connect }),
    entries,
  });
}

/** The short agent fingerprint of 04 §2.9. */
export function agentFingerprintOf(agentId: string): string {
  return formatFingerprint(agentFingerprint(decodeHex0x(agentId, { length: 20 })), 'short');
}

/** The challenge of 04 §2.8 for `nonce`, `statement` and `plan`. */
export function createConnectChallenge(
  nonce: Uint8Array,
  statement: PlanStatement,
  plan: CreateConnectPlan,
): Uint8Array {
  return sha256(
    concatBytes(
      encodeUtf8(CREATE_CONNECT_DOMAIN),
      nonce,
      sha256(encodeUtf8(canonicalize(statement as unknown as JsonObject))),
      sha256(encodeUtf8(canonicalize(plan.entries as unknown as JsonObject))),
    ),
  );
}

/**
 * The restricted owner session of `finish` (04 §2.8): signs the plan's entries in order, each once
 * and byte for byte. The card entry is signed only as an AgentCard for exactly its agent and owner
 * (core builds the typed data); every other entry only as exactly that SignedOwnerAction body.
 * Everything else is `owner_operation_refused`. Closing it closes the session it wraps.
 */
export class PlanOwnerSession implements OwnerSession {
  #inner: OwnerSession | null;
  readonly #entries: readonly string[];
  readonly #card: JsonObject | undefined;
  #next = 0;

  constructor(inner: OwnerSession, entries: readonly JsonObject[]) {
    this.#inner = inner;
    this.#entries = entries.map((e) => canonicalize(e));
    const first = entries[0];
    this.#card = first?.['kind'] === 'card' ? first : undefined;
  }

  get expiresAt(): number {
    return this.#inner?.expiresAt ?? 0;
  }

  isActive(): boolean {
    return this.#inner?.isActive() ?? false;
  }

  #open(): OwnerSession {
    const inner = this.#inner;
    if (inner === null) throw new KeyStoreError('owner_locked', 'owner session: closed');
    return inner;
  }

  sign712(typedData: TypedData): Promise<string> {
    return Promise.resolve().then(() => {
      const inner = this.#open();
      const card = this.#card;
      // The card is the plan's first entry, signed first and once.
      if (card === undefined || this.#next !== 0) throw ownerOperationRefused();
      const typed = allowedTypedData(typedData);
      const message = typed.message;
      if (
        message['agentEvm'] !== card['agentEvm'] ||
        message['ownerEvm'] !== card['ownerEvm'] ||
        message['ownerNostr'] !== card['ownerNostr'] ||
        message['ownerEnc'] !== card['ownerEnc']
      ) {
        throw ownerOperationRefused();
      }
      this.#next = 1;
      return inner.sign712(typed);
    });
  }

  signOwnerAction(body: unknown): Promise<string> {
    return Promise.resolve().then(() => {
      const inner = this.#open();
      let text: string;
      try {
        text = canonicalize(body as JsonObject);
      } catch {
        throw ownerOperationRefused();
      }
      // The card first; then exactly the next body of the plan, in order.
      if (this.#card !== undefined && this.#next === 0) throw ownerOperationRefused();
      const expected = this.#entries[this.#next];
      if (expected === undefined || expected !== text) throw ownerOperationRefused();
      this.#next += 1;
      return inner.signOwnerAction(body as never);
    });
  }

  signEnvelopeHash(): Promise<string> {
    return Promise.reject(ownerOperationRefused());
  }

  signNostr(): Promise<NostrEvent> {
    return Promise.reject(ownerOperationRefused());
  }

  nip44Encrypt(): Promise<string> {
    return Promise.reject(ownerOperationRefused());
  }

  nip44Decrypt(): Promise<string> {
    return Promise.reject(ownerOperationRefused());
  }

  unwrapCek(): Promise<Uint8Array> {
    return Promise.reject(ownerOperationRefused());
  }

  close(): Promise<void> {
    const inner = this.#inner;
    this.#inner = null;
    return inner === null ? Promise.resolve() : inner.close();
  }
}
