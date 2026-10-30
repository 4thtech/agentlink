// OwnerAction / SignedOwnerAction (04 §2.5.1, decided D-58). Strict at every level (SignedOwnerAction,
// OwnerAction, params): unknown keys are rejected, and every field must already be in its canonical
// encoding. Signing and verification live in @4thtech-io/crypto and the core; this file fixes the shape.
//
// What a schema cannot see: duplicate keys and textual number forms (`1.0`, `1e3`) in the JSON text
// are gone after JSON.parse. Parsing the wire bytes strictly (I-JSON) is the caller's job.
import { z } from 'zod';
import {
  AI_APP_IDS,
  APPROVAL_BATCH_MAX_ITEMS,
  APPROVAL_BATCH_MIN_ITEMS,
  APPROVAL_DECISIONS,
  BACKUP_KIT_CONTENTS,
  BACKUP_KIT_ID_BYTES,
  BYTE_LENGTHS,
  MAX_FILES_PER_PAYLOAD,
  PROTOCOL_VERSION,
  REVOKE_REASONS,
  STORAGE_ID_BYTES,
  STORAGE_PROVIDERS,
} from './constants.js';
import {
  approvalIdSchema,
  base64url,
  bip340SigHex,
  evmAddress,
  hexBytes,
  isStrictlyAscending,
  nostrPubkeyHex,
  sha256Hex,
  uint53,
} from './encoding.js';
import { policySchema } from './policy.js';

// --- params per op -------------------------------------------------------------------------------

export const approvalDecideParamsSchema = z.strictObject({
  approvalId: approvalIdSchema,
  actionDigest: sha256Hex,
  decision: z.enum(APPROVAL_DECISIONS),
});

/**
 * `approval.decideBatch` params (04 §2.5.1, §2.5.2; D-68): 2 to 20 items, each exactly the strict
 * `approval.decide` params, in strictly ascending `approvalId` order compared as byte strings (so a
 * batch has one encoding and no duplicates). Anything else is rejected, never sorted or deduplicated.
 * An `approvalId` that passes its schema is ASCII (`apr_` + base64url), so code-unit order is byte
 * order. That the expiry is within every item's pending request is the core's check (M1-7d).
 */
export const approvalDecideBatchParamsSchema = z.strictObject({
  items: z
    .array(approvalDecideParamsSchema)
    .min(APPROVAL_BATCH_MIN_ITEMS)
    .max(APPROVAL_BATCH_MAX_ITEMS)
    .refine(
      // Defensive: Zod may run this check on items that already failed their own schema.
      (items) =>
        isStrictlyAscending(
          items.map((item: unknown) =>
            item !== null && typeof item === 'object'
              ? (item as { approvalId?: unknown }).approvalId
              : undefined,
          ),
        ),
      'items must be in strictly ascending approvalId byte order, with no duplicates',
    ),
});

/** `approval.cancel` (D-55): voids unused parts of an approved commitment scope; it never approves. */
export const approvalCancelParamsSchema = z.strictObject({
  approvalId: approvalIdSchema,
});

/**
 * `policy.set` params: `policy` is the complete 06 §3 document in the strict policy JSON form
 * (policy.ts, G-32), never a partial patch. `version` ordering is the core's (04 §2.5.1).
 */
export const policySetParamsSchema = z.strictObject({
  version: uint53,
  policy: policySchema,
});

export const agentRevokeParamsSchema = z.strictObject({
  reason: z.enum(REVOKE_REASONS),
});

/**
 * `contact.check` params (04 §2.5.1, §3.6.1; G-28): the owner compared the safety code. `contact` is
 * the contact's agent ID (`0x` + 40 lowercase hex) and `pairingDigest` the transcript digest of its
 * current pairing (bare hex, 64 lowercase), each in its one encoding (04 §2.4.1); any other spelling
 * or key is rejected, never normalised. Matching both against a completed pairing, recomputed from
 * the signed `handshake` and `handshake-ack` on every load, is the core's (M1-7c).
 */
export const contactCheckParamsSchema = z.strictObject({
  contact: evmAddress,
  pairingDigest: sha256Hex,
});

/** At most 32 code points, as the restricted name (06 §2.1). */
export const CONTACT_ALIAS_MAX_CODE_POINTS = 32;

/**
 * `contact.rename` params (04 §2.5.1; 06 §2.1 rule 1; M1-9za): the owner's alias for one contact.
 * `contact` is the contact's agent ID in its one encoding. `alias` is a non-empty string of at most
 * 32 code points; that it is already its own restricted form (`restrictName`), so it carries no
 * label word, control, bidi or confusable character, is the core's rule.
 */
export const contactRenameParamsSchema = z.strictObject({
  contact: evmAddress,
  alias: z
    .string()
    .min(1)
    .refine(
      (alias) => Array.from(alias).length <= CONTACT_ALIAS_MAX_CODE_POINTS,
      'alias must be at most 32 code points',
    ),
});

/** `contact.remove` params (04 §2.5.1; 07 §3 `removed`; 02 F-14; M1-9za). */
export const contactRemoveParamsSchema = z.strictObject({
  contact: evmAddress,
});

// --- local owner actions: agent labels and AI app connections (U3-d, D-138) ----------------------

/** At most 32 code points, as the restricted name (06 §2.1, §6 labels). */
export const AGENT_LABEL_MAX_CODE_POINTS = 32;

/**
 * `agent.label` params (04 §2.5.1; 06 §6 labels; U3-d, D-138; proposed, owner confirms at merge):
 * `agent` is the agent's `agentId` in its one encoding and must equal the body's `agent` (checked
 * on the action below). `label` is a non-empty string of at most 32 code points; that it is already
 * its own restricted form (06 §2.1) is the core's rule (`label_invalid`), never normalised.
 */
export const agentLabelParamsSchema = z.strictObject({
  agent: evmAddress,
  label: z
    .string()
    .min(1)
    .refine(
      (label) => Array.from(label).length <= AGENT_LABEL_MAX_CODE_POINTS,
      'label must be at most 32 code points',
    ),
});

/**
 * `app.connect` / `app.disconnect` params (04 §2.5.1; 06 §7; U3-d schema, applied by U3-f): `app`
 * an id from the fixed harness table, `agent` the agent's `agentId` (equal to the body's `agent`),
 * `changeId` 64 lowercase hex (SHA-256 of JCS({app, path, oldEntry, newEntry, agent})). The path
 * and the entries are never params: apply recomputes `changeId` from the file as it is now.
 */
export const appChangeParamsSchema = z.strictObject({
  app: z.enum(AI_APP_IDS),
  agent: evmAddress,
  changeId: sha256Hex,
});

/**
 * `agent.resume` params (04 §2.5.1; 06 §6 "Paused agents"; W4-PAUSE, D-143 (5); proposed, owner
 * confirms at merge): exactly `{agent}`, the agent's `agentId` in its one encoding, equal to the
 * body's `agent` (checked on the action below). Pausing signs nothing, so there is no pause op.
 */
export const agentResumeParamsSchema = z.strictObject({
  agent: evmAddress,
});

/**
 * `file.save` params (W4-FILES-SAVE; 04 §2.5.1; proposed, owner confirms at merge): this agent, and
 * one file of one received message: the 16-byte envelope ID and the file's index in its `files[]`
 * (0 to MAX_FILES_PER_PAYLOAD − 1). Never a name, a folder or a path: the core saves with its own
 * fetch into the Inbox folder of the rules in force (04 §4).
 */
export const fileSaveParamsSchema = z.strictObject({
  agent: evmAddress,
  envelopeId: base64url(BYTE_LENGTHS.id),
  fileIndex: z
    .number()
    .int()
    .min(0)
    .max(MAX_FILES_PER_PAYLOAD - 1),
});

// --- own storage and the recovery kit (M1-9i-a, D-115) --------------------------------------------

const MAX_ENDPOINT_LENGTH = 256;
const ENDPOINT_RE = /^https:\/\/([^/:]+)(?::([1-9][0-9]{0,4}))?$/;
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const NUMERIC_LABEL_RE = /^(?:[0-9]+|0x[0-9a-f]*)$/;
const LAST_LABEL_RE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
const DENIED_SUFFIXES = ['localhost', 'localdomain', 'local', 'internal', 'home.arpa'];

/**
 * True only for an S3 endpoint in its one canonical form: exactly what the S3 adapter's endpoint
 * check (`validateS3Endpoint`, @4thtech-io/storage, the 04 §4 relay-URL grammar adapted to https)
 * returns: `https://host[:port]`, no trailing slash, path, user info, `%` or `\`, a lower-case DNS
 * name of at least two labels (no IP literal, numeric label or local name), a port in 1..65535
 * without a leading zero. Anything the adapter would refuse or rewrite is false, never normalised.
 * Kept in step with the adapter by a cross-check test in @4thtech-io/core (own-storage.test.ts).
 */
export function isCanonicalS3Endpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length > MAX_ENDPOINT_LENGTH) return false;
  if (!/^[\x21-\x7e]+$/.test(endpoint) || /[%\\]/.test(endpoint)) return false;
  const match = ENDPOINT_RE.exec(endpoint);
  if (match === null) return false;
  const host = match[1] ?? '';
  const port = match[2];
  if (host.length > 253 || host.endsWith('.')) return false;
  const labels = host.split('.');
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (!LABEL_RE.test(label) || NUMERIC_LABEL_RE.test(label)) return false;
  }
  if (!LAST_LABEL_RE.test(labels[labels.length - 1] ?? '')) return false;
  for (const suffix of DENIED_SUFFIXES) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return false;
  }
  return port === undefined || Number(port) <= 65_535;
}

/** `storage.set` / `storage.remove` `id`: 8 bytes as 16 lowercase hex; it names `s3:<id>` (04 §2.2). */
export const storageIdSchema = hexBytes(STORAGE_ID_BYTES);

/**
 * `storage.set` params (04 §2.5.1; 07 §5.2; M1-9i-a, D-115). Exactly `{id, provider, endpoint,
 * bucket, region, credentialDigest}`, each in its one form: `endpoint` is the S3 adapter's
 * canonical output (isCanonicalS3Endpoint); `bucket` is the S3 bucket rule the adapter applies
 * (3 to 63 of `[a-z0-9.-]`, starting and ending with a letter or digit, no `..`); `region` 1 to 32 of
 * `[a-z0-9-]`; `credentialDigest` 64 lowercase hex. No credential is ever a param (I-7): the signed
 * object is stored and may be shown. That `s3:<id>` exists with this digest is the core's rule.
 */
export const storageSetParamsSchema = z.strictObject({
  id: storageIdSchema,
  provider: z.enum(STORAGE_PROVIDERS),
  endpoint: z.string().refine(isCanonicalS3Endpoint, 'endpoint must be https://host[:port]'),
  bucket: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'bucket must follow the S3 bucket rule')
    .refine((bucket) => !bucket.includes('..'), 'bucket must not contain ".."'),
  region: z.string().regex(/^[a-z0-9-]{1,32}$/, 'region must be 1 to 32 of [a-z0-9-]'),
  credentialDigest: sha256Hex,
});

/** `storage.remove` params (04 §2.5.1): the active `storage.set` `id`; the core checks it is active. */
export const storageRemoveParamsSchema = z.strictObject({
  id: storageIdSchema,
});

/**
 * `backup.export` params (04 §2.5.1, §2.3.3; D-115 A): `kitId` 16 bytes as base64url without
 * padding (also the kit manifest's `kitId`), `contents` `"full"` or `"identity"`. One action per
 * included agent; its nonce row is the audit record (07 §3.4).
 */
export const backupExportParamsSchema = z.strictObject({
  kitId: base64url(BACKUP_KIT_ID_BYTES),
  contents: z.enum(BACKUP_KIT_CONTENTS),
});

/**
 * A token amount in base units (M1-11c-a4c): a decimal string with no sign, leading zero, fraction
 * or exponent, from 1 to 2^256 - 1 (a uint256 the vault accepts). One spelling per value.
 */
const MAX_UINT256 = 2n ** 256n - 1n;
const BASE_UNITS = /^[1-9][0-9]{0,77}$/;
export const baseUnitsAmount = z
  .string()
  .regex(BASE_UNITS)
  // Defensive: Zod may run this check on a string that already failed the pattern.
  .refine((s) => BASE_UNITS.test(s) && BigInt(s) <= MAX_UINT256, 'amount: 1 to 2^256 - 1');

/** The fee-token symbols of 07 §6.2 (12 §3): `NATIVE` is xDAI on Gnosis. */
export const FEE_TOKEN_SYMBOLS = Object.freeze(['NATIVE', 'USDC', 'USDT'] as const);

/** A chain ID: a positive safe integer. Which chains are allowed is the core's rule. */
const chainIdSchema = uint53.refine((n) => n > 0, 'chainId must be positive');

/**
 * `credits.deposit` params (M1-11c-a4c; D-122, D-123; 12 §4.1; proposed, owner confirms at merge):
 * the agent deposits exactly `amount` base units of `token` that its own account holds on `chainId`
 * as its own credits there (`deposit`, 05 §2.5), paying the network cost itself. That the chain is a
 * top-up chain, the amount is there and a gas reserve stays are the core's rules.
 */
export const creditsDepositParamsSchema = z.strictObject({
  chainId: chainIdSchema,
  token: z.enum(FEE_TOKEN_SYMBOLS),
  amount: baseUnitsAmount,
});

/**
 * `credits.withdraw` params (M1-11c-a4c; 05 §2.5 `withdraw(token, amount, to)`; 12 §4.1; proposed,
 * owner confirms at merge): `amount` of the agent's credits in `token` on `chainId` go to `to`. The
 * core allows only the agent's own account as `to` until an owner-signed recipient grant exists
 * (IR-M1-4c-b-1 M-1); the KeyStore enforces the same (M1-4c-b).
 */
export const creditsWithdrawParamsSchema = z.strictObject({
  chainId: chainIdSchema,
  token: z.enum(FEE_TOKEN_SYMBOLS),
  amount: baseUnitsAmount,
  to: evmAddress,
});

// --- OwnerAction ---------------------------------------------------------------------------------

const head = {
  v: z.literal(PROTOCOL_VERSION),
  agent: evmAddress,
  owner: nostrPubkeyHex,
};
const tail = {
  nonce: base64url(BYTE_LENGTHS.nonce),
  issuedAt: uint53,
  expiresAt: uint53,
};

/** Every op but `agent.revoke` expires, after it was issued (04 §2.5.1). Lifetimes are G-7, in the core. */
const expiring = (a: { issuedAt: number; expiresAt: number }) =>
  a.expiresAt !== 0 && a.expiresAt > a.issuedAt;
const EXPIRING_MSG = {
  message: 'expiresAt must be non-zero and after issuedAt (0 is allowed only for agent.revoke)',
  path: ['expiresAt'],
};

export const approvalDecideActionSchema = z
  .strictObject({
    ...head,
    op: z.literal('approval.decide'),
    params: approvalDecideParamsSchema,
    ...tail,
  })
  .refine(expiring, EXPIRING_MSG);

/** One owner signature over exactly the items the owner reviewed (04 §2.5.2). */
export const approvalDecideBatchActionSchema = z
  .strictObject({
    ...head,
    op: z.literal('approval.decideBatch'),
    params: approvalDecideBatchParamsSchema,
    ...tail,
  })
  .refine(expiring, EXPIRING_MSG);

export const approvalCancelActionSchema = z
  .strictObject({
    ...head,
    op: z.literal('approval.cancel'),
    params: approvalCancelParamsSchema,
    ...tail,
  })
  .refine(expiring, EXPIRING_MSG);

export const policySetActionSchema = z
  .strictObject({
    ...head,
    op: z.literal('policy.set'),
    params: policySetParamsSchema,
    ...tail,
  })
  .refine(expiring, EXPIRING_MSG);

/** "Safety code checked" for one contact and one pairing (04 §2.5.1). No envelope carries it yet (M2-2e). */
export const contactCheckActionSchema = z
  .strictObject({
    ...head,
    op: z.literal('contact.check'),
    params: contactCheckParamsSchema,
    ...tail,
  })
  .refine(expiring, EXPIRING_MSG);

/** The owner's alias for a contact (M1-9za). Applied only on the agent's own machine: no envelope. */
export const contactRenameActionSchema = z
  .strictObject({
    ...head,
    op: z.literal('contact.rename'),
    params: contactRenameParamsSchema,
    ...tail,
  })
  .refine(expiring, EXPIRING_MSG);

/** Removes a contact (tombstone, 07 §3) (M1-9za). Applied only on the agent's own machine. */
export const contactRemoveActionSchema = z
  .strictObject({
    ...head,
    op: z.literal('contact.remove'),
    params: contactRemoveParamsSchema,
    ...tail,
  })
  .refine(expiring, EXPIRING_MSG);

/** Connects the agent's own S3-compatible storage (M1-9i-a, D-115). Own machine only: no envelope. */
export const storageSetActionSchema = z
  .strictObject({
    ...head,
    op: z.literal('storage.set'),
    params: storageSetParamsSchema,
    ...tail,
  })
  .refine(expiring, EXPIRING_MSG);

/** Disconnects the active own storage (M1-9i-a). Own machine only: no envelope. */
export const storageRemoveActionSchema = z
  .strictObject({
    ...head,
    op: z.literal('storage.remove'),
    params: storageRemoveParamsSchema,
    ...tail,
  })
  .refine(expiring, EXPIRING_MSG);

/** Authorises one agent's part of a recovery kit export (M1-9i-a). Own machine only: no envelope. */
export const backupExportActionSchema = z
  .strictObject({
    ...head,
    op: z.literal('backup.export'),
    params: backupExportParamsSchema,
    ...tail,
  })
  .refine(expiring, EXPIRING_MSG);

/** Turns funds the agent's account holds into its credits (M1-11c-a4c). Applied only on its machine. */
export const creditsDepositActionSchema = z
  .strictObject({
    ...head,
    op: z.literal('credits.deposit'),
    params: creditsDepositParamsSchema,
    ...tail,
  })
  .refine(expiring, EXPIRING_MSG);

/** Withdraws the agent's credits (M1-11c-a4c). Applied only on the agent's own machine. */
export const creditsWithdrawActionSchema = z
  .strictObject({
    ...head,
    op: z.literal('credits.withdraw'),
    params: creditsWithdrawParamsSchema,
    ...tail,
  })
  .refine(expiring, EXPIRING_MSG);

/** `params.agent` names the body's own agent (04 §2.5.1): anything else is refused, never mapped. */
const selfBound = (a: { agent: string; params: { agent: string } }) => a.params.agent === a.agent;
const SELF_BOUND_MSG = { message: 'params.agent must equal agent', path: ['params', 'agent'] };

/** Names one agent for its owner (U3-d, D-138). Applied only on the agent's own machine: no envelope. */
export const agentLabelActionSchema = z
  .strictObject({
    ...head,
    op: z.literal('agent.label'),
    params: agentLabelParamsSchema,
    ...tail,
  })
  .refine(expiring, EXPIRING_MSG)
  .refine(selfBound, SELF_BOUND_MSG);

/** Writes the one AgentLink entry of an AI app config for this agent (U3-f). Own machine only. */
export const appConnectActionSchema = z
  .strictObject({
    ...head,
    op: z.literal('app.connect'),
    params: appChangeParamsSchema,
    ...tail,
  })
  .refine(expiring, EXPIRING_MSG)
  .refine(selfBound, SELF_BOUND_MSG);

/** Removes this agent's AgentLink entry from an AI app config (U3-f). Own machine only. */
export const appDisconnectActionSchema = z
  .strictObject({
    ...head,
    op: z.literal('app.disconnect'),
    params: appChangeParamsSchema,
    ...tail,
  })
  .refine(expiring, EXPIRING_MSG)
  .refine(selfBound, SELF_BOUND_MSG);

/** Ends a pause of this agent (W4-PAUSE, D-143 (5)). Applied only on the agent's own machine. */
export const agentResumeActionSchema = z
  .strictObject({
    ...head,
    op: z.literal('agent.resume'),
    params: agentResumeParamsSchema,
    ...tail,
  })
  .refine(expiring, EXPIRING_MSG)
  .refine(selfBound, SELF_BOUND_MSG);

/** Saves one received file into the Inbox folder (W4-FILES-SAVE). Own machine only: no envelope. */
export const fileSaveActionSchema = z
  .strictObject({
    ...head,
    op: z.literal('file.save'),
    params: fileSaveParamsSchema,
    ...tail,
  })
  .refine(expiring, EXPIRING_MSG)
  .refine(selfBound, SELF_BOUND_MSG);

/** `agent.revoke`: `expiresAt` is exactly 0 (permanent; the core skips expiry and lifetime checks). */
export const agentRevokeActionSchema = z.strictObject({
  ...head,
  op: z.literal('agent.revoke'),
  params: agentRevokeParamsSchema,
  ...tail,
  expiresAt: z.literal(0),
});

/**
 * Discriminated by `op`: each op has its own strict `params`, so an `approval.decide` body with batch
 * params, or a batch body with single-decision params, matches no member (04 §2.5.2).
 */
export const ownerActionSchema = z.discriminatedUnion('op', [
  approvalDecideActionSchema,
  approvalDecideBatchActionSchema,
  approvalCancelActionSchema,
  policySetActionSchema,
  contactCheckActionSchema,
  contactRenameActionSchema,
  contactRemoveActionSchema,
  storageSetActionSchema,
  storageRemoveActionSchema,
  backupExportActionSchema,
  creditsDepositActionSchema,
  creditsWithdrawActionSchema,
  agentLabelActionSchema,
  appConnectActionSchema,
  appDisconnectActionSchema,
  agentResumeActionSchema,
  fileSaveActionSchema,
  agentRevokeActionSchema,
]);

// --- SignedOwnerAction ---------------------------------------------------------------------------

const signedOf = <T extends z.ZodType>(body: T) => z.strictObject({ body, sig: bip340SigHex });

export const signedOwnerActionSchema = signedOf(ownerActionSchema);
export const signedApprovalDecideSchema = signedOf(approvalDecideActionSchema);
export const signedApprovalDecideBatchSchema = signedOf(approvalDecideBatchActionSchema);
export const signedApprovalCancelSchema = signedOf(approvalCancelActionSchema);
export const signedPolicySetSchema = signedOf(policySetActionSchema);
export const signedAgentRevokeSchema = signedOf(agentRevokeActionSchema);
/** What `contacts.safety_check` stores (07 §3), re-verified on every load (04 §2.5.1, §3.6.1). */
export const signedContactCheckSchema = signedOf(contactCheckActionSchema);
/** What `local_owner_actions.signed_json` stores for the label (07 §3.4), re-verified on load. */
export const signedAgentLabelSchema = signedOf(agentLabelActionSchema);
/** What `own_storage.signed_json` stores (07 §3.4), re-verified on every load (04 §2.5.1). */
export const signedStorageSetSchema = signedOf(storageSetActionSchema);
/**
 * What an `approval` envelope carries: `approval.decide`, `approval.decideBatch` or `approval.cancel`
 * (04 §3.4.1; D-55, D-68). Any other op is dropped.
 */
export const signedApprovalOpSchema = signedOf(
  z.discriminatedUnion('op', [
    approvalDecideActionSchema,
    approvalDecideBatchActionSchema,
    approvalCancelActionSchema,
  ]),
);

export type ApprovalDecideParams = z.infer<typeof approvalDecideParamsSchema>;
export type ApprovalDecideBatchParams = z.infer<typeof approvalDecideBatchParamsSchema>;
export type ApprovalCancelParams = z.infer<typeof approvalCancelParamsSchema>;
export type PolicySetParams = z.infer<typeof policySetParamsSchema>;
export type AgentRevokeParams = z.infer<typeof agentRevokeParamsSchema>;
export type ContactCheckParams = z.infer<typeof contactCheckParamsSchema>;
export type ContactRenameParams = z.infer<typeof contactRenameParamsSchema>;
export type ContactRemoveParams = z.infer<typeof contactRemoveParamsSchema>;
export type StorageSetParams = z.infer<typeof storageSetParamsSchema>;
export type StorageRemoveParams = z.infer<typeof storageRemoveParamsSchema>;
export type BackupExportParams = z.infer<typeof backupExportParamsSchema>;
export type StorageSetAction = z.infer<typeof storageSetActionSchema>;
export type SignedStorageSet = z.infer<typeof signedStorageSetSchema>;
export type CreditsDepositParams = z.infer<typeof creditsDepositParamsSchema>;
export type AgentLabelParams = z.infer<typeof agentLabelParamsSchema>;
export type AppChangeParams = z.infer<typeof appChangeParamsSchema>;
export type AgentResumeParams = z.infer<typeof agentResumeParamsSchema>;
export type FileSaveParams = z.infer<typeof fileSaveParamsSchema>;
export type AgentLabelAction = z.infer<typeof agentLabelActionSchema>;
export type SignedAgentLabel = z.infer<typeof signedAgentLabelSchema>;
export type CreditsWithdrawParams = z.infer<typeof creditsWithdrawParamsSchema>;
export type ApprovalDecideAction = z.infer<typeof approvalDecideActionSchema>;
export type ApprovalDecideBatchAction = z.infer<typeof approvalDecideBatchActionSchema>;
export type ApprovalCancelAction = z.infer<typeof approvalCancelActionSchema>;
export type PolicySetAction = z.infer<typeof policySetActionSchema>;
export type AgentRevokeAction = z.infer<typeof agentRevokeActionSchema>;
export type ContactCheckAction = z.infer<typeof contactCheckActionSchema>;
export type OwnerAction = z.infer<typeof ownerActionSchema>;
export type SignedOwnerAction = z.infer<typeof signedOwnerActionSchema>;
export type SignedApprovalDecide = z.infer<typeof signedApprovalDecideSchema>;
export type SignedApprovalDecideBatch = z.infer<typeof signedApprovalDecideBatchSchema>;
export type SignedApprovalCancel = z.infer<typeof signedApprovalCancelSchema>;
export type SignedPolicySet = z.infer<typeof signedPolicySetSchema>;
export type SignedAgentRevoke = z.infer<typeof signedAgentRevokeSchema>;
export type SignedContactCheck = z.infer<typeof signedContactCheckSchema>;
export type SignedApprovalOp = z.infer<typeof signedApprovalOpSchema>;
