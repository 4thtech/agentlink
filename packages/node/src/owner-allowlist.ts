// M1-8h (IR-M1-9b-1 M-1, IR-M1-8c-1 F-4): what the owner key may sign. Every owner operation reads
// its request through here before the owner is shown anything, so an object outside the list never
// reaches a prompt or a signature (fail closed, one fixed text).
//
// - EIP-712 by the owner EVM key: only the agent card `cardSig` (04 §2.4): the chain-agnostic domain
//   {name: "OCC AgentCard", version: "1"} exactly, primary type `AgentCard`, exactly the AgentCard
//   types of 04 §2.4 in their order, and a message that is a strict card (parseAgentCard). The OCC v2
//   `Registration` (05 §4, `regOwnerSig`) is not signed by any M1 owner flow yet: the card that adds
//   one widens this list, with its domain.
// - SignedOwnerAction by the owner Nostr key: only the ops 04 §2.5.1 defines (`OWNER_ACTION_OPS` of
//   @4thtech-io/types, repeated here because node does not depend on types; the strict params schema
//   and every binding check stay with core, M1-7d). Later ops (storage credentials, key export,
//   content-key disclosure) are added by the tasks that define them.
//
// The request is copied through JCS and parsed back, so what was checked is plain data and is what
// gets signed: no getter or Proxy can show one value to the check and another to the signer.
import {
  AGENT_CARD_DOMAIN,
  AGENT_CARD_TYPES,
  canonicalize,
  parseAgentCard,
  parseJson,
  type JsonObject,
  type TypedData,
} from '@4thtech-io/crypto';
import { NodeKeyStoreError } from './errors.js';

/** The fixed refusal (I-5: no part of the request is ever echoed). */
export const OWNER_OPERATION_REFUSED =
  "AgentLink doesn't sign this with your owner key. Nothing was signed.";

/** 04 §2.5.1: the owner-action ops an owner flow signs. */
export const OWNER_ACTION_OPS: readonly string[] = Object.freeze([
  'approval.decide',
  'approval.decideBatch',
  'approval.cancel',
  'policy.set',
  'agent.revoke',
  'contact.check',
  // M1-9za: the owner renames or removes a contact (`agentlink contacts rename | remove`).
  'contact.rename',
  'contact.remove',
  // M1-11c-a4c: the owner turns received funds into credits, or withdraws credits (local UI).
  'credits.deposit',
  'credits.withdraw',
]);

export const ownerOperationRefused = (): NodeKeyStoreError =>
  new NodeKeyStoreError('owner_operation_refused', OWNER_OPERATION_REFUSED);

const DOMAIN_JCS = canonicalize(AGENT_CARD_DOMAIN);
const TYPES_JCS = canonicalize(AGENT_CARD_TYPES);
const TYPED_DATA_KEYS = 'domain,message,primaryType,types';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/** A plain-data copy through JCS, or the refusal. */
function plainCopy(value: unknown): unknown {
  try {
    return parseJson(canonicalize(value));
  } catch {
    throw ownerOperationRefused();
  }
}

/**
 * The agent card typed data, as a frozen plain copy, or `owner_operation_refused`. The only EIP-712
 * object the owner key signs (04 §2.4).
 */
export function allowedTypedData(value: unknown): TypedData {
  const copy = plainCopy(value);
  if (!isObject(copy) || Object.keys(copy).sort().join(',') !== TYPED_DATA_KEYS) {
    throw ownerOperationRefused();
  }
  if (copy['primaryType'] !== 'AgentCard') throw ownerOperationRefused();
  if (canonicalize(copy['domain']) !== DOMAIN_JCS) throw ownerOperationRefused();
  if (canonicalize(copy['types']) !== TYPES_JCS) throw ownerOperationRefused();
  try {
    parseAgentCard(copy['message']);
  } catch {
    throw ownerOperationRefused();
  }
  return deepFreeze(copy) as unknown as TypedData;
}

/** Refuses an owner action whose `op` 04 §2.5.1 does not define. `action` is already plain data. */
export function assertAllowedOwnerAction(action: JsonObject): void {
  const op = action['op'];
  if (typeof op !== 'string' || !OWNER_ACTION_OPS.includes(op)) throw ownerOperationRefused();
}
