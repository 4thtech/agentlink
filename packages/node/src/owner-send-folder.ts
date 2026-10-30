// M1-36b-2-c (D-121 D6; 04 §2.5, §2.8; 06 §3): the Send folder for an agent that already has its
// card. Since M1-36b-2, `owner init` and `owner add-agent` sign the agent's first rules with
// `~/AgentLink/Send` allowed; an agent set up before that has none, so sending a file returns
// NO_ALLOWED_FOLDER. The owner runs `policy allow-send-folder` † in their own terminal and this
// module does the work, in one owner operation:
//
// - The folder, before any owner secret is asked: the same rules as the first rules
//   (owner-first-policy.ts `prepareSendFolder`): `<realpath(home)>/AgentLink/Send`, created 0700
//   when missing (never through a link), or an existing real, empty folder. A link at either level,
//   a non-folder, a path that isn't its own realpath, or a folder that already holds anything is not
//   used, so no existing file ever becomes sendable.
// - The rules only gain that one folder. The base is the verified policy in force (core's G-6
//   loader); while it fails closed nothing is done (never rebuilt from the defaults, D-100). Core
//   `preparePolicyEdit` builds the body with `baseVersion` = the version read, so a newer policy is
//   never overwritten. Node does not trust what was prepared: it signs only a `policy.set` for
//   exactly this agent and this owner whose policy is, byte for byte (JCS), the rules in force with
//   the folder appended to `files.allowedFolders`. The one other difference allowed is delivery
//   receipts turning off (D-109: only the owner's explicit answer keeps receipts on from an older
//   default), which only narrows. Anything else is not signed (policy widening).
// - The signature comes from `sign`: the CLI passes @4thtech-io/node's `performOwnerOperation` (the
//   owner code at this process's own TTY prompt, no AI-app marker, 04 §2.5). What it returns is
//   applied only when its body is exactly what was checked; core `apply()` then checks the owner
//   signature, the nonce and the version, as for every owner action.
// - No half-set state: whenever the rules are not applied, the folders this run created are removed
//   again (rmdir: only while empty). A wrong owner code is the caller's error (nothing signed).
// - One folder from the check to the rules (M1-36b-2-d, IR-M1-36b-2-c-1): the agent runs as the
//   same OS user and can rename, replace or link the folder at any moment. The folder checked is
//   pinned (allowed-path `pinFolder`: its real path, device and inode) and must still be that same
//   real, empty folder just before the owner code is asked AND after signing, just before the rules
//   are applied; otherwise nothing is applied. Once allowed, the stored real path is the pin: a
//   folder that later resolves anywhere else is not used for sending (allowed-path).
// - Already allowed: any entry in the rules that names this folder where it really is, `~/` form
//   included (`~/AgentLink/Send`, as sending reads it), means nothing is asked or signed.
// - I-4: nothing here is reachable from MCP (the CLI's src/tools/ and src/mcp/ never call it; fence
//   tests). Errors are never shown (I-5): fixed results only, no path in an error.
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { OwnerActions } from '@4thtech-io/core';
import {
  canonicalize,
  encodeHex,
  parseJson,
  type JsonObject,
  type OwnerPublicKeys,
} from '@4thtech-io/crypto';
import { AUTO_SAVE_DEFAULTS } from '@4thtech-io/types';
import { pinFolder, pinnedLocation, stillPinned, type FolderPin } from './allowed-path.js';
import { assertAllowedOwnerAction } from './owner-allowlist.js';
import {
  SEND_FOLDER_SEGMENTS,
  prepareSendFolder,
  removeCreated,
  stillReady,
  type SendFolderPlan,
} from './owner-first-policy.js';
import type { OwnerOperationItem, OwnerSignature } from './owner-operation.js';

/** What the setup needs of core's OwnerActions (`client.ownerActions`). */
export type SendFolderSetupActions = Pick<
  OwnerActions,
  'loadPolicy' | 'receiptsOnFromOlderDefault' | 'preparePolicyEdit' | 'apply' | 'recordReceiptsKept'
>;

export interface SendFolderSetupOptions {
  /** The agent (its EVM ID, as its card names it). */
  readonly agent: string;
  /** The owner the agent's card names. */
  readonly owner: OwnerPublicKeys;
  readonly actions: SendFolderSetupActions;
  /**
   * One owner operation that signs the one `policy.set` with owner presence. The CLI passes
   * `performOwnerOperation` (owner code at the TTY prompt).
   */
  readonly sign: (owner: OwnerPublicKeys, item: OwnerOperationItem) => Promise<OwnerSignature>;
  /**
   * Asked only when delivery receipts are on from an older default (06 §3, D-109), after the folder
   * is ready and before the owner code: true keeps them on, anything else turns them off.
   */
  readonly keepDeliveryReceipts?: () => Promise<boolean>;
  /** The home folder the Send folder is created in; default the OS user's (tests only). */
  readonly home?: string;
}

export type SendFolderSetupResult =
  /** The rules now allow the folder (signed at `version`). */
  | {
      readonly status: 'allowed';
      readonly folder: string;
      readonly version: number;
      readonly keptReceipts: boolean;
    }
  /** The folder is already allowed: nothing was asked or signed. */
  | { readonly status: 'already_allowed'; readonly folder: string }
  /** The rules were applied but the store could not confirm them (fail closed until recovered). */
  | { readonly status: 'not_confirmed'; readonly folder: string }
  /** Nothing was applied. */
  | {
      readonly status: 'not_allowed';
      readonly reason:
        'rules_unreadable' | 'too_many' | 'folder_unavailable' | 'folder_not_empty' | 'failed';
    };

/**
 * 06 §3 bound on `files.allowedFolders` (types POLICY_BOUNDS.allowedFolders.max). Checked here only
 * to refuse before anything is created; core refuses a 33rd folder on its own (`patch_invalid`).
 */
const MAX_ALLOWED_FOLDERS = 32;

const COPY = {
  summary: (folder: string, receiptsOff: boolean): string =>
    `Allow your AI to send files you put in ${folder} (empty for now) to your contacts.${
      receiptsOff ? ' Delivery receipts turn off.' : ''
    } Nothing else in your rules changes.`,
} as const;

type Plain = { [key: string]: unknown };
type OlderDefaultRules = NonNullable<
  Parameters<SendFolderSetupActions['receiptsOnFromOlderDefault']>[0]
>;

const BODY_KEYS = 'agent,expiresAt,issuedAt,nonce,op,owner,params,v';
const PARAMS_KEYS = 'policy,version';

const keysOf = (value: JsonObject): string => Object.keys(value).sort().join(',');
const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The JCS forms the signed policy may have: the base plus the folder (receipts off, if allowed).
 * A base signed before D-142 gets the `files.autoSave` defaults, as every new policy.set does.
 */
function expectedPolicies(base: Plain, folder: string, keepReceipts: boolean): readonly string[] {
  const files = base['files'] as Plain;
  const added = {
    ...base,
    files: {
      ...files,
      allowedFolders: [...(files['allowedFolders'] as string[]), folder],
      autoSave: (files['autoSave'] ?? { ...AUTO_SAVE_DEFAULTS }) as Plain,
    },
  };
  const out = [canonicalize(added as JsonObject)];
  if (!keepReceipts) {
    const receipts = base['receipts'] as Plain;
    out.push(
      canonicalize({ ...added, receipts: { ...receipts, autoDelivered: false } } as JsonObject),
    );
  }
  return out;
}

/** Exactly the rules in force plus the one folder, for this agent and this owner (see the header). */
export function isSendFolderBody(
  body: JsonObject,
  expected: {
    readonly agent: string;
    readonly owner: OwnerPublicKeys;
    readonly baseVersion: number;
    readonly policies: readonly string[];
  },
): boolean {
  if (keysOf(body) !== BODY_KEYS) return false;
  if (body['v'] !== 1 || body['op'] !== 'policy.set') return false;
  if (body['agent'] !== expected.agent) return false;
  if (body['owner'] !== encodeHex(expected.owner.ownerNostr)) return false;
  const params = body['params'];
  if (!isObject(params) || keysOf(params) !== PARAMS_KEYS) return false;
  const version = params['version'];
  if (typeof version !== 'number' || !Number.isSafeInteger(version)) return false;
  if (version <= expected.baseVersion) return false;
  return expected.policies.includes(canonicalize(params['policy']));
}

const notAllowed = (reason: Extract<SendFolderSetupResult, { status: 'not_allowed' }>['reason']) =>
  ({ status: 'not_allowed', reason }) as const;

/**
 * Creates (or checks) `~/AgentLink/Send` and signs one `policy.set` that adds only that folder to
 * the agent's rules in force (see the header). A wrong owner code or a cancelled prompt is thrown
 * by `sign`, after the folders this run created are removed.
 */
export async function setUpSendFolder(
  options: SendFolderSetupOptions,
): Promise<SendFolderSetupResult> {
  const { actions } = options;
  const home = options.home ?? homedir();

  // The rules in force, read once as a plain copy: what is checked is what is signed.
  let effective: Awaited<ReturnType<SendFolderSetupActions['loadPolicy']>>;
  try {
    effective = await actions.loadPolicy();
  } catch {
    return notAllowed('rules_unreadable');
  }
  if (effective.mode === 'fail_closed') return notAllowed('rules_unreadable');
  const base = parseJson(canonicalize(effective.policy as unknown as JsonObject)) as Plain;
  const baseVersion = effective.mode === 'signed' ? effective.version : 0;
  const existing = (base['files'] as Plain)['allowedFolders'] as string[];

  let realHome: string;
  try {
    realHome = await realpath(home);
  } catch {
    return notAllowed('folder_unavailable');
  }
  const candidate = path.join(realHome, ...SEND_FOLDER_SEGMENTS);
  // The same test sending uses (allowed-path): the entry names this folder where it really is.
  const allowed = existing.some(
    (entry) => typeof entry === 'string' && pinnedLocation(entry, realHome) === candidate,
  );
  if (allowed) return { status: 'already_allowed', folder: candidate };
  if (existing.length >= MAX_ALLOWED_FOLDERS) return notAllowed('too_many');

  const plan: SendFolderPlan = await prepareSendFolder(home);
  if (plan.status !== 'ready') return notAllowed(plan.reason);
  let result: SendFolderSetupResult | undefined;
  try {
    const pin = await pinFolder(plan.folder);
    if (pin === undefined) return notAllowed('folder_unavailable');
    result = await signAndApply(options, plan, pin, base, baseVersion);
    return result;
  } finally {
    const kept = result !== undefined && result.status !== 'not_allowed';
    if (!kept) await removeCreated(plan);
  }
}

async function signAndApply(
  options: SendFolderSetupOptions,
  plan: Extract<SendFolderPlan, { status: 'ready' }>,
  pin: FolderPin,
  base: Plain,
  baseVersion: number,
): Promise<SendFolderSetupResult> {
  const { actions, agent, owner } = options;
  const { folder } = plan;
  const failed = notAllowed('failed');
  /** Still the pinned folder: the same real folder (path, device, inode), and still empty. */
  const unchanged = async (): Promise<boolean> =>
    (await stillPinned(pin)) && (await stillReady(folder));

  // D-109: asked only when the rules in force have delivery receipts on from an older default.
  let keepReceipts = false;
  if (baseVersion > 0) {
    let older: boolean;
    try {
      older = await actions.receiptsOnFromOlderDefault({
        policy: base as unknown as OlderDefaultRules['policy'],
        version: baseVersion,
      });
    } catch {
      // The private side: ask whenever receipts are on.
      older = (base['receipts'] as Plain)['autoDelivered'] === true;
    }
    if (older && options.keepDeliveryReceipts !== undefined) {
      keepReceipts = (await options.keepDeliveryReceipts()) === true;
    }
  }

  let body: JsonObject;
  try {
    const existing = (base['files'] as Plain)['allowedFolders'] as string[];
    const prepared = await actions.preparePolicyEdit(
      { files: { allowedFolders: [...existing, folder] } },
      { baseVersion, keepDeliveryReceipts: keepReceipts },
    );
    if (prepared.status !== 'prepared') return failed;
    // A plain copy, read once: what is checked is what is signed and applied.
    body = parseJson(canonicalize(prepared.body as unknown as JsonObject)) as JsonObject;
  } catch {
    return failed;
  }
  const policies = expectedPolicies(base, folder, keepReceipts);
  if (!isSendFolderBody(body, { agent, owner, baseVersion, policies })) return failed;
  const receiptsOff =
    (base['receipts'] as Plain)['autoDelivered'] === true &&
    ((body['params'] as Plain)['policy'] as { receipts: Plain }).receipts['autoDelivered'] ===
      false;
  try {
    assertAllowedOwnerAction(body);
  } catch {
    return failed;
  }
  if (!(await unchanged())) return failed;

  // The owner reads the summary and types the owner code once (a wrong code is thrown).
  const signature = await options.sign(owner, {
    kind: 'owner-action',
    action: body,
    summary: COPY.summary(folder, receiptsOff),
  });
  if (signature.kind !== 'owner-action') return failed;
  const signed = signature.signed;
  if (canonicalize(signed.body) !== canonicalize(body)) return failed;
  // Checked again after signing (L1): the owner code may take a while, and the folder must still be
  // the one the owner read about when the rules take effect.
  if (!(await unchanged())) return failed;

  let outcome: Awaited<ReturnType<SendFolderSetupActions['apply']>>;
  try {
    outcome = await actions.apply({ body: signed.body, sig: signed.sig });
  } catch {
    // Whether the store committed is unknown: keep the folder and point to the way back.
    return { status: 'not_confirmed', folder };
  }
  if (outcome.status !== 'applied' || outcome.op !== 'policy.set') return failed;
  if (outcome.markRaised !== true) return { status: 'not_confirmed', folder };
  const version = (body['params'] as Plain)['version'] as number;
  const keptReceipts =
    keepReceipts &&
    ((body['params'] as Plain)['policy'] as { receipts: Plain }).receipts['autoDelivered'] === true;
  if (keptReceipts) {
    // Best effort: without the marker the owner is asked again next time (D-109).
    await Promise.resolve()
      .then(() => actions.recordReceiptsKept(version))
      .catch(() => false);
  }
  return { status: 'allowed', folder, version, keptReceipts };
}
