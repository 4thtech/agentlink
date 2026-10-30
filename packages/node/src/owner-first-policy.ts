// M1-36b-2 (D-121 D6; 04 §2.5, §2.8; 06 §3): the agent's first rules, signed with its first card in
// the same owner-code entry of `owner init` and `owner add-agent`.
//
// The first rules are exactly the 06 §3 defaults with `files.allowedFolders` = [the real path of
// `~/AgentLink/Send`], so the agent can send files the owner puts there and nothing else becomes
// sendable. The 06 §3 defaults themselves are unchanged (an agent without these rules still allows no
// folder).
//
// - The folder, before any owner secret is asked: `<realpath(home)>/AgentLink/Send`, created 0700
//   when missing (never through a link), or an existing real, empty folder. A link at either level,
//   a non-folder, a path that isn't its own realpath, or a folder that already holds anything is not
//   used: then no rules are signed, so no existing file ever becomes sendable.
// - After the card is stored and verified, still inside the one unlocked owner session: core
//   `preparePolicyEdit` builds the body on the defaults (`baseVersion` 0). Node does not trust what
//   was prepared: it signs only a `policy.set` for exactly this agent and this owner whose policy is,
//   byte for byte (JCS), the defaults plus the one folder. Anything else is not signed (policy
//   widening). The body is then applied through core `apply()`, which checks the owner signature,
//   the nonce (replay) and the version, as for every owner action.
// - No half-set state: whenever the rules are not applied, the folders this run created are removed
//   again (rmdir: only while empty), and the agent keeps the 06 §3 defaults. A store that applied the
//   rules but could not confirm them is reported with the `policy recover` way back (D-100).
// - One folder from the check to the rules (M1-UX-FIRSTRUN-V2-b, IR-M1-36b-2-d-1): the agent runs
//   as the same OS user and can rename, replace or link the folder at any moment. The folder checked
//   is pinned (allowed-path `pinFolder`: its real path, device and inode; the plan's `pin`) and must
//   still be that same real, empty folder just before signing AND after signing, just before the
//   rules are applied; otherwise nothing is applied. This holds for `owner init`, `owner add-agent`
//   and the first run, which all sign through signFirstPolicy.
// - I-4: nothing here is reachable from MCP. The owner session never leaves node; core only receives
//   the signed object. Errors are never shown (I-5): fixed results only, no path in an error.
import { lstat, mkdir, readdir, realpath, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { POLICY_DEFAULTS_EFFECTIVE } from '@4thtech-io/core';
import { AUTO_SAVE_DEFAULTS } from '@4thtech-io/types';
import {
  canonicalize,
  encodeHex,
  encodeHex0x,
  parseJson,
  verifyAgentCard,
  type JsonObject,
  type OwnerPublicKeys,
  type OwnerSession,
} from '@4thtech-io/crypto';
import { pinFolder, stillPinned, type FolderPin } from './allowed-path.js';
import { CLI_COMMAND } from './cli-command.js';
import { assertAllowedOwnerAction } from './owner-allowlist.js';
import type { FirstAgentCard, FirstPolicy } from './owner-first-card.js';

/** Where the Send folder lives under the home folder (D-121 D6). */
export const SEND_FOLDER_SEGMENTS: readonly string[] = Object.freeze(['AgentLink', 'Send']);

/** What happened to the first rules (the Send folder). */
export type SendFolderResult =
  /** The rules are in force: the agent can send files from `folder`. */
  | { readonly status: 'allowed'; readonly folder: string }
  /** The rules were applied but the store could not confirm them (fail closed until recovered). */
  | { readonly status: 'not_confirmed'; readonly folder: string }
  /** No rules were applied; the agent keeps the 06 §3 defaults. */
  | {
      readonly status: 'not_allowed';
      readonly reason: 'folder_unavailable' | 'folder_not_empty' | 'failed';
    };

/** The folder checked before the owner secret is asked. */
export type SendFolderPlan =
  | {
      readonly status: 'ready';
      readonly folder: string;
      /** The folders this run created, outermost first (removed again unless the rules apply). */
      readonly created: readonly string[];
      /** M1-UX-FIRSTRUN-V2-b: the folder as checked (real path, device, inode). */
      readonly pin: FolderPin;
    }
  | { readonly status: 'unavailable'; readonly reason: 'folder_unavailable' | 'folder_not_empty' };

// Fixed copy (11 §5: "your rules", "your AI"; the path is local data shown only when printable).
const COPY = {
  review: (folder: string): string =>
    `Your owner code also sets your first rule: your AI can send files you put in ${folder} (empty for now). Nothing else on this computer can be sent. To remove it later, run \`${CLI_COMMAND} policy remove-folder ${folder}\`.`,
  notEmpty: `The folder AgentLink/Send in your home folder already holds files, so it is not allowed for sending. To send files later, run \`${CLI_COMMAND} policy allow-folder <path>\` yourself.`,
  unavailable: `AgentLink couldn't set up the folder AgentLink/Send in your home folder, so no folder is allowed for sending. To send files later, run \`${CLI_COMMAND} policy allow-folder <path>\` yourself.`,
  allowed: (folder: string): string => `OK       Your AI can send files you put in ${folder}.`,
  failed: `Problem  Your first rule couldn't be set, so no folder is allowed for sending. Everything else is set up. To send files later, run \`${CLI_COMMAND} policy allow-folder <path>\` yourself.`,
  notConfirmed: `Problem  Your first rule was saved, but AgentLink couldn't confirm it, so it uses its strictest settings until your rules are set again. Run \`${CLI_COMMAND} policy recover\` in your own terminal.`,
} as const;

// eslint-disable-next-line no-control-regex -- terminal control characters make a path unusable here
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/u;

const isMissing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';

/** Removes the folders a plan created, innermost first; only while empty (rmdir). Never throws. */
export async function removeCreated(plan: SendFolderPlan | undefined): Promise<void> {
  if (plan?.status !== 'ready') return;
  await removeFolders(plan.created);
}

/** Removes `created` (outermost first), innermost first; only while empty (rmdir). Never throws. */
async function removeFolders(created: readonly string[]): Promise<void> {
  for (const folder of [...created].reverse()) {
    try {
      await rmdir(folder);
    } catch {
      // Not empty any more, or already gone: never remove anything else.
    }
  }
}

/**
 * The Send folder under `home` (default: the OS user's), checked or created before the owner secret
 * is asked (see the header). Never follows a link, never deletes anything it did not create.
 */
export async function prepareSendFolder(home: string = homedir()): Promise<SendFolderPlan> {
  const unavailable = { status: 'unavailable', reason: 'folder_unavailable' } as const;
  let base: string;
  try {
    base = await realpath(home);
  } catch {
    return unavailable;
  }
  const created: string[] = [];
  const giveUp = async (
    result: Extract<SendFolderPlan, { status: 'unavailable' }>,
  ): Promise<SendFolderPlan> => {
    await removeFolders(created);
    return result;
  };
  let current = base;
  for (const segment of SEND_FOLDER_SEGMENTS) {
    current = path.join(current, segment);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) return giveUp(unavailable);
      continue;
    } catch (error) {
      if (!isMissing(error)) return giveUp(unavailable);
    }
    try {
      // Not recursive: each level is created here, so none is ever a link this run followed.
      await mkdir(current, { mode: 0o700 });
      created.push(current);
    } catch {
      return giveUp(unavailable);
    }
  }
  const folder = current;
  // M1-UX-FIRSTRUN-V2-b: pinned here, before the owner secret is asked; also its realpath check.
  const pin = await pinFolder(folder);
  if (pin === undefined) return giveUp(unavailable);
  try {
    if ((await readdir(folder)).length > 0) {
      return giveUp({ status: 'unavailable', reason: 'folder_not_empty' });
    }
  } catch {
    return giveUp(unavailable);
  }
  if (UNPRINTABLE.test(folder)) return giveUp(unavailable);
  return Object.freeze({ status: 'ready', folder, created: Object.freeze(created), pin });
}

/** The line the owner reads before the owner secret is asked. */
export function sendFolderReview(plan: SendFolderPlan): string {
  if (plan.status === 'ready') return COPY.review(plan.folder);
  return plan.reason === 'folder_not_empty' ? COPY.notEmpty : COPY.unavailable;
}

/** The line the owner reads once the operation is done. */
export function sendFolderOutcome(result: SendFolderResult): string | undefined {
  if (result.status === 'allowed') return COPY.allowed(result.folder);
  if (result.status === 'not_confirmed') return COPY.notConfirmed;
  // A folder refused before the code was already explained by sendFolderReview.
  return result.reason === 'failed' ? COPY.failed : undefined;
}

/** The plan's result when no rules were attempted (the folder was refused before the code). */
export function notAttempted(plan: SendFolderPlan): SendFolderResult | undefined {
  return plan.status === 'unavailable' ? { status: 'not_allowed', reason: plan.reason } : undefined;
}

/** True when the rules took effect (or may have): the folder is then kept. */
export function keepsFolder(result: SendFolderResult | undefined): boolean {
  return result !== undefined && result.status !== 'not_allowed';
}

/**
 * W4-ONE-TOUCH: the first rules document (the 06 §3 defaults with only `files.allowedFolders` =
 * [folder]), as the plan fixed at begin carries it in its `policy.set` body.
 */
export function firstPolicyDocument(folder: string): JsonObject {
  return parseJson(expectedPolicyJcs(folder)) as JsonObject;
}

/**
 * JCS of the 06 §3 defaults with only `files.allowedFolders` = [folder]. `files.autoSave` is the
 * defaults too: every policy.set this core signs carries it (D-142, 06 §3).
 */
function expectedPolicyJcs(folder: string): string {
  const effective = POLICY_DEFAULTS_EFFECTIVE;
  // Always 'defaults' (core constant); anything else matches no body, so nothing is signed.
  if (effective.mode !== 'defaults') return '';
  const defaults = parseJson(canonicalize(effective.policy as unknown as JsonObject)) as JsonObject;
  const files = defaults['files'] as JsonObject;
  return canonicalize({
    ...defaults,
    files: { ...files, allowedFolders: [folder], autoSave: { ...AUTO_SAVE_DEFAULTS } },
  });
}

const BODY_KEYS = 'agent,expiresAt,issuedAt,nonce,op,owner,params,v';
const PARAMS_KEYS = 'policy,version';

const keysOf = (value: JsonObject): string => Object.keys(value).sort().join(',');
const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Exactly the first rules for this agent and this owner, and nothing wider (see the header). */
function isFirstPolicyBody(
  body: JsonObject,
  agent: string,
  owner: OwnerPublicKeys,
  folder: string,
): boolean {
  if (keysOf(body) !== BODY_KEYS) return false;
  if (body['v'] !== 1 || body['op'] !== 'policy.set') return false;
  if (body['agent'] !== agent || body['owner'] !== encodeHex(owner.ownerNostr)) return false;
  const params = body['params'];
  if (!isObject(params) || keysOf(params) !== PARAMS_KEYS) return false;
  const version = params['version'];
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) return false;
  return canonicalize(params['policy']) === expectedPolicyJcs(folder);
}

/** The folder is still a real, empty folder at its own real path (see stillTheCheckedFolder). */
export async function stillReady(folder: string): Promise<boolean> {
  try {
    const stats = await lstat(folder);
    if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
    if ((await realpath(folder)) !== folder) return false;
    return (await readdir(folder)).length === 0;
  } catch {
    return false;
  }
}

/**
 * M1-UX-FIRSTRUN-V2-b: still the folder that was checked: the pinned one (same real path, device
 * and inode, so not another folder swapped in at the same path) and still real and empty.
 */
async function stillTheCheckedFolder(
  plan: Extract<SendFolderPlan, { status: 'ready' }>,
): Promise<boolean> {
  return (await stillPinned(plan.pin)) && (await stillReady(plan.folder));
}

/** A verified stored card for exactly this agent naming exactly this owner. */
export async function cardNamesOwner(
  first: FirstAgentCard,
  owner: OwnerPublicKeys,
): Promise<boolean> {
  try {
    const stored = await first.identity.get();
    return (
      stored !== undefined &&
      stored.card.agentEvm === first.agent &&
      stored.card.ownerEvm === encodeHex0x(owner.ownerEvm) &&
      stored.card.ownerNostr === encodeHex0x(owner.ownerNostr) &&
      stored.card.ownerEnc === encodeHex0x(owner.ownerEnc) &&
      verifyAgentCard(stored.card, stored.cardSig, stored.cardAgentSig)
    );
  } catch {
    return false;
  }
}

/**
 * After the first card: signs and applies the first rules with `inner`, the owner session the one
 * owner-code entry unlocked (the caller closes it). Only when the card is stored and verified, the
 * folder is still the one checked (pinned; before and after signing), and what core prepared is
 * exactly the first rules (see the header).
 */
export async function signFirstPolicy(
  inner: OwnerSession,
  first: FirstAgentCard & { readonly firstPolicy: FirstPolicy },
  plan: Extract<SendFolderPlan, { status: 'ready' }>,
  owner: OwnerPublicKeys,
): Promise<SendFolderResult> {
  const failed = { status: 'not_allowed', reason: 'failed' } as const;
  if (!(await cardNamesOwner(first, owner))) return failed;
  const { actions } = first.firstPolicy;
  let body: JsonObject;
  try {
    // W4-ONE-TOUCH: the body fixed at begin (in the challenge), checked below like a prepared one.
    const fixedBody = first.firstPolicy.body;
    if (fixedBody !== undefined) {
      body = parseJson(canonicalize(fixedBody)) as JsonObject;
    } else {
      const prepared = await actions.preparePolicyEdit(
        { files: { allowedFolders: [plan.folder] } },
        { baseVersion: 0 },
      );
      if (prepared.status !== 'prepared') return failed;
      // A plain copy, read once: what is checked is what is signed and applied.
      body = parseJson(canonicalize(prepared.body as unknown as JsonObject)) as JsonObject;
    }
  } catch {
    return failed;
  }
  if (!isFirstPolicyBody(body, first.agent, owner, plan.folder)) return failed;
  if (!(await stillTheCheckedFolder(plan))) return failed;
  let sig: string;
  try {
    assertAllowedOwnerAction(body);
    sig = await inner.signOwnerAction(body);
  } catch {
    return failed;
  }
  // M1-UX-FIRSTRUN-V2-b: and again after signing, just before the rules are applied.
  if (!(await stillTheCheckedFolder(plan))) return failed;
  let outcome: Awaited<ReturnType<typeof actions.apply>>;
  try {
    outcome = await actions.apply({ body, sig });
  } catch {
    // Whether the store committed is unknown: keep the folder and point to the way back.
    return { status: 'not_confirmed', folder: plan.folder };
  }
  if (outcome.status !== 'applied' || outcome.op !== 'policy.set') return failed;
  if (outcome.markRaised !== true) return { status: 'not_confirmed', folder: plan.folder };
  return { status: 'allowed', folder: plan.folder };
}
