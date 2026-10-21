// `agentlink policy show | allow-folder <path> | remove-folder <path> | recover` † (M1-9m, M1-9m-b; 04 §2.5, §4
// "Allowed folders"; 06 §3 `files.allowedFolders`, §8; 11 §5: the policy is "your rules").
//
// The owner's folders for sending files. Without one, `agentlink_send` with a path returns
// `needs_setup` (06 §2.3), so this is what makes sending files usable.
//
// - Owner operation (I-4): the dispatcher's owner-terminal guard runs first (interactive terminal,
//   no AI-app marker; a UX guard, not a security boundary, D-67). Then @4thtech-io/node shows the
//   fixed summary, reads the owner code once at its own TTY prompt and signs one `policy.set`
//   (04 §2.5.1). The core verifies the owner signature, the nonce and the version and applies it.
//   No MCP tool reaches this module (06 §1: src/tools/ and src/mcp/ never import commands/owner).
// - The new policy is the CURRENT verified policy (core's G-6 loader) with only
//   `files.allowedFolders` changed, at version + 1. When the rules can't be read (fail closed), the
//   command refuses: it never rebuilds the rules from the defaults, which could undo stricter rules.
// - A folder is checked before any owner code is asked (04 §4): a full path (`~/` is the home
//   folder); an existing folder; no symbolic link anywhere in it (its realpath must be the path
//   itself, and the refusal names the real path to use); not the root, the home folder or a folder
//   above it; not hidden and not under a protected folder (`~/.ssh`, `~/.agentlink`, keychains).
//   What is stored is that canonical realpath, never `~` and never a link. The core resolves it with
//   realpath again on every use (files/outgoing.ts), so a folder replaced by a link later still
//   only allows what its realpath allows.
// - D-99: a folder that CONTAINS a protected folder (for example `~/Library`, which holds
//   `~/Library/Keychains`) is refused too, before any owner code; the refusal names the protected
//   folder and asks for a narrower one. Each protected folder is compared in its lexical form and
//   its realpath (a `~/.ssh` that links elsewhere is found where it really is), ignoring case
//   (macOS and Windows volumes). Whether it exists doesn't matter: fail closed.
// - `policy recover` (D-100; 06 §3 G-6, §8): the deliberate way back from rules that fail closed.
//   It prints only the kind of failure; the owner then reviews, in full, the stored rules when they
//   parse and their signature verifies (`rolled_back`, `mark_mismatch`), otherwise the 06 §3
//   defaults; after an explicit `y` and the owner code it signs that complete policy at the version
//   the core needs (the mark + 1, or above the stored version when that is higher). It is refused
//   while the rules are valid, and nothing is ever rebuilt without that review.
// - The path is shown to the owner exactly as signed: one that terminal sanitizing would change
//   (control, bidi, zero-width characters) is refused, so what the owner reads is what is signed.
// - The owner code is never an argument, a variable or a pipe (deps.ts). A wrong code is refused by
//   the owner store (`presence_rejected`): nothing is signed, nothing changes, and the next run asks
//   again. There is one try per run.
import { lstat, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import process from 'node:process';
import {
  expandHome,
  isInsideFolder,
  parseAbsolutePath,
  protectedRoots,
  segmentsBelow,
  type EffectivePolicy,
  type PathFlavor,
  type PolicyProblem,
} from '@4thtech-io/core';
import {
  KeyStoreError,
  encodeBase64url,
  encodeHex,
  randomBytes,
  type JsonObject,
} from '@4thtech-io/crypto';
import {
  OWNER_ACTION_MAX_LIFETIME_SECONDS,
  POLICY_BOUNDS,
  defaultPolicy,
  policySchema,
  type Policy,
} from '@4thtech-io/types';
import {
  DISPATCH_TEXT,
  EXIT_FAILED,
  EXIT_OK,
  type CommandContext,
  type CommandHandler,
} from '../../dispatch.js';
import type { Output } from '../../output.js';
import { sanitizeTerminalText, terminalOneLine } from '../../terminal/sanitize.js';
import { badArguments, chooseAgent, ownerContext, ownerStep } from './common.js';
import type { OwnerAgent, OwnerCommandDeps } from './deps.js';
import { OWNER_TEXT } from './strings.js';

export interface PolicyCommandOptions {
  /** The home folder `~` stands for. Default: the OS user's. */
  readonly home?: string;
  /** The path flavour. Default: this platform's. */
  readonly flavor?: PathFlavor;
}

/** A signed policy.set lives at most this long before it must be applied (it is applied at once). */
const POLICY_SET_LIFETIME_SECONDS = Math.min(600, OWNER_ACTION_MAX_LIFETIME_SECONDS['policy.set']);

/** Fixed text (11 §5 vocabulary: "rules", never "policy"). Only checked paths are ever inserted. */
export const POLICY_TEXT = Object.freeze({
  notFullPath:
    'Use the full path of a folder, for example /Users/you/Documents/Shared or ~/Documents/Shared.',
  notShowable:
    "That folder's name has characters AgentLink can't show safely. Rename the folder, then try again.",
  missing: "That folder doesn't exist. Check the path, then try again.",
  notFolder: "That isn't a folder. Allow the folder that holds the file.",
  dotSegments: 'Use the folder’s path without `.` or `..` in it.',
  spelling: (real: string): string =>
    `That folder is spelled differently on disk (for example in upper or lower case). Use its exact path: ${real}`,
  link: (real: string): string =>
    `That path goes through a link. Use the folder's real path instead: ${real}`,
  tooBroad:
    "Your AI can't be allowed to send from your whole computer or your whole home folder. Choose a folder inside it, such as ~/Documents/Shared.",
  hidden: 'Hidden folders, and folders inside them, can’t be allowed for sending files.',
  protectedFolder:
    "Files in this folder can never be sent (it holds keys or AgentLink's own data). Choose another folder.",
  tooMany: `You can allow at most ${String(POLICY_BOUNDS.allowedFolders.max)} folders. Remove one first with \`agentlink policy remove-folder <path>\`.`,
  containsProtected: (shown: string): string =>
    `That folder contains ${shown}, which holds keys or AgentLink's own data, so it can't be allowed. Choose a narrower folder inside it that doesn't contain ${shown}.`,
  rulesUnreadable:
    "AgentLink can't use your rules right now, so it uses its strictest settings and no folder is allowed. Nothing was changed. To review and confirm your rules again, run `agentlink policy recover` in your own terminal.",
  alreadyAllowed: 'OK       That folder is already allowed. Nothing was changed.',
  notAllowed:
    "That folder isn't one of your allowed folders. Run `agentlink policy show` to see them.",
  codeHint:
    "Type your owner code only at the prompt below. It isn't a shell command, and never paste it into a chat.",
  allowSummary: (folder: string): string =>
    `Allow your AI to send files from ${folder} and its subfolders to your contacts. Hidden files are never sent.`,
  removeSummary: (folders: readonly string[]): string =>
    `Stop your AI from sending files from ${folders.join(', ')}.`,
  allowed: 'OK       Allowed. Your AI can now send files from this folder.',
  removed: 'OK       Removed. Your AI can no longer send files from this folder.',
  wrongCode: "That owner code didn't work. Nothing was changed. Run the command again to retry.",
  failed: "Problem  That didn't go through. Nothing was changed.",
  notConfirmed:
    "Problem  Your new rules were saved, but AgentLink couldn't confirm them, so it uses its strictest settings until they are set again. Run `agentlink doctor` in your own terminal.",

  // show
  header: (version: number | undefined): string =>
    version === undefined ? 'Your rules (the defaults)' : `Your rules (version ${String(version)})`,
  foldersHeader: 'Folders your AI can send files from:',
  noFolder:
    'No folder is allowed for sending files yet. Allow one with `agentlink policy allow-folder <path>`.',
  inbox: (folder: string): string => `Received files are saved in: ${folder}`,
  sizes: (send: number, receive: number): string =>
    `Largest file: ${String(send)} MB to send, ${String(receive)} MB to receive`,
  invites: (auto: boolean): string =>
    auto ? 'New contacts: accepted automatically' : 'New contacts: wait for your approval',

  // recover (D-100)
  nothingToRecover:
    'Your rules are in use, so there is nothing to recover. Nothing was changed. Run `agentlink policy show` to see them.',
  cannotRecover:
    "AgentLink can't recover your rules right now: it can't read what it needs on this computer. Nothing was changed. Run `agentlink doctor` in your own terminal.",
  whatHappened: (kind: string): string =>
    `Your rules can't be used, so AgentLink uses its strictest settings. What happened: ${kind}`,
  reviewStored:
    'Below are your saved rules, still signed by you. Review them in full. If you confirm, AgentLink uses them again.',
  reviewDefaults:
    "Your saved rules can't be trusted, so they aren't shown. Below are AgentLink's default rules. Review them in full. If you confirm, they replace your saved rules; allow your folders again afterwards.",
  confirmQuestion: 'Use these rules? Type y and press Enter to continue, or anything else to stop.',
  notConfirmedAnswer: 'Nothing was changed.',
  recoverSummary: (version: number): string =>
    `Sign the rules you just reviewed as your rules (version ${String(version)}), so AgentLink stops using its strictest settings.`,
  recovered: (version: number): string =>
    `OK       Your rules are in use again (version ${String(version)}).`,

  // M1-33a (06 §3 "Existing policies", D-109; 11 §5.6): delivery receipts on from an older default
  receiptsOlderDefault:
    'Delivery receipts are on from an older default. Each one shows publicly that a proof reached your agent, never the content.',
  keepReceiptsQuestion:
    'Keep delivery receipts on? Type y and press Enter to keep them on, or anything else to turn them off.',
  receiptsTurnOff: 'Delivery receipts turn off.',
});

/** The owner's answer about delivery receipts on from an older default (06 §3, D-109). */
type ReceiptsChoice = 'none' | 'keep' | 'off';

/**
 * 06 §3 "Existing policies" (D-109; M1-33a): before any `policy.set` signed from `rules`, asks the
 * owner whether to keep delivery receipts that are on from an older default. Anything but an explicit
 * `y` turns them off. A core that can't tell asks whenever they are on (the private side).
 */
async function receiptsChoice(
  deps: OwnerCommandDeps,
  agent: OwnerAgent,
  output: Output,
  rules: { readonly policy: Policy; readonly version: number },
): Promise<ReceiptsChoice> {
  const older = await Promise.resolve()
    .then(() => agent.client.ownerActions.receiptsOnFromOlderDefault(rules))
    .catch(() => rules.policy.receipts.autoDelivered);
  if (!older) return 'none';
  output.print(POLICY_TEXT.receiptsOlderDefault);
  const answer = await deps.ask(POLICY_TEXT.keepReceiptsQuestion);
  return answer.trim().toLowerCase() === 'y' ? 'keep' : 'off';
}

/** The policy with the owner's receipts choice applied (a copy; `off` signs `false`). */
function withReceiptsChoice(policy: Policy, choice: ReceiptsChoice): Policy {
  return choice === 'off'
    ? { ...policy, receipts: { ...policy.receipts, autoDelivered: false } }
    : policy;
}

/** After the kept policy was applied at `version`: remember the answer (best effort; else asked again). */
async function rememberKept(
  agent: OwnerAgent,
  choice: ReceiptsChoice,
  version: number,
): Promise<void> {
  if (choice !== 'keep') return;
  await Promise.resolve()
    .then(() => agent.client.ownerActions.recordReceiptsKept(version))
    .catch(() => false);
}

/** The kind of failure, in words (D-100: the command shows only this, never the stored data). */
const PROBLEM_TEXT: Readonly<Record<PolicyProblem, string>> = Object.freeze({
  rolled_back: 'an older version of your rules was put back.',
  mark_mismatch: "your saved rules don't match the version AgentLink last confirmed.",
  tampered: 'your saved rules were changed outside AgentLink.',
  missing: 'your saved rules are missing.',
  unreadable: "your saved rules can't be read.",
  invalid: "your saved rules aren't in a form this version of AgentLink accepts.",
  signature_invalid: "your saved rules aren't signed by you.",
  agent_mismatch: 'your saved rules belong to another agent.',
  owner_mismatch: "your saved rules aren't signed by you.",
  mark_unavailable: "AgentLink can't read the version it last confirmed.",
  identity_unavailable: "AgentLink can't read this agent's profile.",
});

type Leaf = string | number | boolean | null | readonly unknown[];

/** One rule of the review: its path in the 06 §3 document, its label (11 §5) and how it reads. */
export interface PolicyReviewRow {
  readonly path: string;
  readonly label: string;
  readonly read?: (value: Leaf) => string;
}

const usd = (value: Leaf): string => (value === null ? 'not set' : `$${String(value)}`);
const yesNo = (value: Leaf): string => (value === true ? 'yes' : 'no');
const mb = (value: Leaf): string => `${String(value)} MB`;
const RULE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  allow: 'allowed',
  approval: 'wait for your approval',
  deny: 'never',
  auto: 'accepted automatically',
});
const rule = (value: Leaf): string => RULE_WORDS[String(value)] ?? String(value);
const list =
  (none: string) =>
  (value: Leaf): string =>
    Array.isArray(value) && value.length > 0
      ? value.map((item) => `\n    ${typeof item === 'string' ? item : contactRule(item)}`).join('')
      : none;

function contactRule(item: unknown): string {
  const { contact, proofs, receipts } = item as {
    contact: string;
    proofs?: { notarize?: string; perActionMaxUSD?: string };
    receipts?: { autoDelivered: boolean };
  };
  const parts: string[] = [];
  if (proofs?.notarize !== undefined) parts.push(`add proof: ${rule(proofs.notarize)}`);
  if (proofs?.perActionMaxUSD !== undefined) {
    parts.push(`each proof at most ${usd(proofs.perActionMaxUSD)}`);
  }
  if (receipts !== undefined) {
    parts.push(`tell the sender a message arrived: ${yesNo(receipts.autoDelivered)}`);
  }
  return `${contact}: ${parts.join(', ')}`;
}

/** Every rule of the 06 §3 document, in order: the review shows the policy in full (D-100). */
export const POLICY_REVIEW_ROWS: readonly PolicyReviewRow[] = Object.freeze([
  { path: 'contacts.acceptInvites', label: 'New contacts', read: rule },
  {
    path: 'contacts.unknownSenders',
    label: 'Requests from unknown senders',
    read: (v) => (v === 'drop' ? 'dropped' : 'kept for you to review'),
  },
  {
    path: 'contacts.allowed',
    label: 'Who can message your agent',
    read: (v) => (v === 'paired' ? 'your contacts' : list('nobody')(v)),
  },
  { path: 'contacts.rateLimitPerContactPerHour', label: 'Messages per contact per hour, at most' },
  {
    path: 'files.allowedFolders',
    label: 'Folders your AI can send files from',
    read: list('none'),
  },
  { path: 'files.inboxFolder', label: 'Received files are saved in' },
  { path: 'files.maxSendSizeMB', label: 'Largest file to send', read: mb },
  { path: 'files.maxReceiveSizeMB', label: 'Largest file to receive', read: mb },
  { path: 'files.storage', label: 'Where sent files are stored' },
  { path: 'files.defaultExpiryDays', label: 'Sent files are kept for, in days' },
  {
    path: 'files.deleteAfter',
    label: 'Sent files are deleted after',
    // 06 §3 (D-109, M1-33d): without a delivery confirmation, deletion falls back to expiry.
    read: (v) =>
      v === 'receipt'
        ? 'the contact confirms delivery (if they never do, when they expire)'
        : 'they expire',
  },
  { path: 'files.ownerArchive', label: 'Keep a copy of sent files for you', read: yesNo },
  { path: 'envelopes.maxEnvelopeKB', label: 'Largest message', read: (v) => `${String(v)} KB` },
  { path: 'proofs.notarize', label: 'Adding proof', read: rule },
  { path: 'proofs.dailyBudgetUSD', label: 'Spent on proofs in 24 hours, at most', read: usd },
  { path: 'proofs.perActionMaxUSD', label: 'Each proof, at most', read: usd },
  {
    path: 'proofs.allowKeyDisclosure',
    label: "Including a message's content in a proof file",
    read: rule,
  },
  { path: 'proofs.exportFolder', label: 'Proof files are saved in' },
  { path: 'proofs.defaultChain', label: 'Proof network (Advanced)' },
  { path: 'receipts.autoDelivered', label: 'Tell the sender a message arrived', read: yesNo },
  { path: 'receipts.autoOpened', label: 'Tell the sender a message was opened', read: yesNo },
  { path: 'commitments.accept', label: 'Accepting terms', read: rule },
  {
    path: 'commitments.autoAcceptContacts',
    label: 'Contacts whose terms can be accepted automatically',
    read: list('none'),
  },
  { path: 'commitments.autoAcceptMaxUSD', label: 'Terms accepted automatically up to', read: usd },
  {
    path: 'commitments.autoAcceptDirection',
    label: 'Terms accepted automatically only when you are',
    read: (v) => (v === 'sell' ? 'selling' : 'buying'),
  },
  { path: 'commitments.autoAcceptMinUSD', label: 'Selling accepted automatically from', read: usd },
  { path: 'contactRules', label: 'Rules for single contacts', read: list('none') },
]);

const leafAt = (policy: Policy, path: string): Leaf =>
  path
    .split('.')
    .reduce<unknown>((at, key) => (at as Record<string, unknown>)[key], policy) as Leaf;

/**
 * The policy in full, one line per rule, or undefined when a value would read differently on the
 * terminal than it is signed (06 §8: what the owner reads is what is signed). Values are owner-signed
 * and passed the 06 §3 strict form; they are shown whole, never cut short.
 */
function reviewLines(policy: Policy): readonly string[] | undefined {
  const lines: string[] = [];
  for (const row of POLICY_REVIEW_ROWS) {
    const value = leafAt(policy, row.path);
    const text = row.read === undefined ? String(value) : row.read(value);
    for (const part of text.split('\n')) {
      if (sanitizeTerminalText(part) !== part) return undefined;
    }
    lines.push(`  ${row.label}: ${text}`);
  }
  return lines;
}

/**
 * A wrong owner code (`presence_rejected`). By name and code as well as by class: the owner store
 * may come from another copy of @4thtech-io/crypto than this module's.
 */
function isPresenceRejected(error: unknown): boolean {
  if (error instanceof KeyStoreError) return error.code === 'presence_rejected';
  return (
    error instanceof Error &&
    error.name === 'KeyStoreError' &&
    (error as { code?: unknown }).code === 'presence_rejected'
  );
}

const defaultFlavor = (): PathFlavor => (process.platform === 'win32' ? 'win32' : 'posix');

type Checked =
  { readonly ok: true; readonly path: string } | { readonly ok: false; readonly message: string };

const refuse = (message: string): Checked => ({ ok: false, message });

/** `~` expanded, one trailing separator removed; a full, clean, showable path or a refusal. */
function lexical(typed: string, home: string, flavor: PathFlavor): Checked {
  // Shown exactly as signed: nothing terminal sanitizing would remove (06 §8).
  if (typed.length === 0 || sanitizeTerminalText(typed) !== typed) {
    return refuse(POLICY_TEXT.notShowable);
  }
  let path = expandHome(typed, home, flavor);
  // `.` and `..` get their own message (parseAbsolutePath refuses them too, as malformed).
  if (path.split(flavor === 'posix' ? '/' : /[\\/]/).some((s) => s === '.' || s === '..')) {
    return refuse(POLICY_TEXT.dotSegments);
  }
  const sep = flavor === 'posix' ? /[/]$/ : /[\\/]$/;
  if (path.length > 1 && sep.test(path) && parseAbsolutePath(path.slice(0, -1), flavor)) {
    path = path.slice(0, -1);
  }
  if (parseAbsolutePath(path, flavor) === undefined) return refuse(POLICY_TEXT.notFullPath);
  return { ok: true, path };
}

const segmentsOf = (path: string, flavor: PathFlavor): readonly string[] =>
  parseAbsolutePath(path, flavor)?.segments ?? [];

/** True when the path itself or any folder on the way to it is a symbolic link. */
async function hasLink(path: string, flavor: PathFlavor): Promise<boolean> {
  const parsed = parseAbsolutePath(path, flavor);
  if (parsed === undefined) return false;
  const sep = flavor === 'posix' ? '/' : '\\';
  const start = flavor === 'posix' ? '' : parsed.root;
  let prefix = start;
  for (const segment of parsed.segments) {
    prefix = `${prefix}${sep}${segment}`;
    try {
      if ((await lstat(prefix)).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** The checks of 04 §4 for a folder the owner allows (see the header). */
async function checkFolder(typed: string, home: string, flavor: PathFlavor): Promise<Checked> {
  const shaped = lexical(typed, home, flavor);
  if (!shaped.ok) return shaped;
  const { path } = shaped;
  try {
    if (!(await stat(path)).isDirectory()) return refuse(POLICY_TEXT.notFolder);
  } catch {
    return refuse(POLICY_TEXT.missing);
  }
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    return refuse(POLICY_TEXT.missing);
  }
  if (real !== path) {
    // The real path is local data the owner can use; shown only when it is safe to show.
    if (sanitizeTerminalText(real) !== real) return refuse(POLICY_TEXT.notShowable);
    // A link somewhere in the path, or only a different spelling of the same folder (a
    // case-insensitive volume, another Unicode form). Either way the real path is what is stored.
    return refuse(
      (await hasLink(path, flavor)) ? POLICY_TEXT.link(real) : POLICY_TEXT.spelling(real),
    );
  }
  const homes = [home];
  try {
    homes.push(await realpath(home));
  } catch {
    // The lexical home is checked either way.
  }
  const inside = { flavor, self: 'inside' } as const;
  if (segmentsOf(real, flavor).length === 0 || homes.some((h) => isInsideFolder(h, real, inside))) {
    return refuse(POLICY_TEXT.tooBroad);
  }
  const roots = homes.flatMap((h) => protectedRoots(h, flavor));
  if (roots.some((r) => segmentsBelow(real, r, flavor, { caseInsensitive: true }) !== undefined)) {
    return refuse(POLICY_TEXT.protectedFolder);
  }
  // D-99: a folder that holds a protected folder, in either of its forms.
  for (const root of await protectedForms(roots, home, flavor)) {
    const holds = root.forms.some(
      (form) => segmentsBelow(form, real, flavor, { caseInsensitive: true }) !== undefined,
    );
    if (holds) {
      return refuse(
        sanitizeTerminalText(root.shown) === root.shown
          ? POLICY_TEXT.containsProtected(root.shown)
          : POLICY_TEXT.protectedFolder,
      );
    }
  }
  if (segmentsOf(real, flavor).some((s) => s.startsWith('.'))) return refuse(POLICY_TEXT.hidden);
  return { ok: true, path: real };
}

/**
 * Each protected folder (04 §4) as the owner reads it (`~/…` under the home folder) and the forms
 * it is compared in: as written, and its realpath when it resolves (D-99).
 */
async function protectedForms(
  roots: readonly string[],
  home: string,
  flavor: PathFlavor,
): Promise<readonly { readonly shown: string; readonly forms: readonly string[] }[]> {
  const sep = flavor === 'posix' ? '/' : '\\';
  const out: { shown: string; forms: string[] }[] = [];
  for (const root of roots) {
    const forms = [root];
    try {
      const real = await realpath(root);
      if (real !== root) forms.push(real);
    } catch {
      // It doesn't exist (yet): the folder that would hold it is refused all the same.
    }
    const below = segmentsBelow(root, home, flavor);
    const shown = below === undefined ? root : ['~', ...below].join(sep);
    out.push({ shown, forms });
  }
  return out;
}

/** The current verified rules, or undefined when they can't be read (G-6 fail closed). */
function current(
  effective: EffectivePolicy,
): { readonly policy: Policy; readonly version: number | undefined } | undefined {
  if (effective.mode === 'fail_closed') return undefined;
  // A deep, plain copy: the loader's document is never changed in place.
  const policy = JSON.parse(JSON.stringify(effective.policy)) as Policy;
  return { policy, version: effective.mode === 'signed' ? effective.version : undefined };
}

async function show(agent: OwnerAgent, output: Output): Promise<number> {
  const rules = current(await agent.client.ownerActions.loadPolicy());
  if (rules === undefined) {
    output.printError(POLICY_TEXT.rulesUnreadable);
    return EXIT_FAILED;
  }
  const { policy, version } = rules;
  const lines = [POLICY_TEXT.header(version), '', POLICY_TEXT.foldersHeader];
  if (policy.files.allowedFolders.length === 0) lines.push(`  ${POLICY_TEXT.noFolder}`);
  for (const folder of policy.files.allowedFolders) lines.push(`  ${terminalOneLine(folder)}`);
  lines.push(
    '',
    POLICY_TEXT.inbox(terminalOneLine(policy.files.inboxFolder)),
    POLICY_TEXT.sizes(policy.files.maxSendSizeMB, policy.files.maxReceiveSizeMB),
    POLICY_TEXT.invites(policy.contacts.acceptInvites === 'auto'),
  );
  output.print(lines.join('\n'));
  return EXIT_OK;
}

/** Signs and applies one `policy.set` with the given folders; prints the outcome. */
async function setFolders(
  deps: OwnerCommandDeps,
  agent: OwnerAgent,
  output: Output,
  rules: { readonly policy: Policy; readonly version: number | undefined },
  folders: readonly string[],
  summary: string,
  done: string,
): Promise<number> {
  let policy: Policy = {
    ...rules.policy,
    files: { ...rules.policy.files, allowedFolders: [...folders] },
  };
  if (folders.length > POLICY_BOUNDS.allowedFolders.max) {
    output.printError(POLICY_TEXT.tooMany);
    return EXIT_FAILED;
  }
  // The document must be one the core accepts (06 §3 strict form) before the owner is asked.
  if (!policySchema.safeParse(policy).success) {
    output.printError(POLICY_TEXT.notShowable);
    return EXIT_FAILED;
  }
  // The defaults (no version applied) have delivery receipts off: nothing to ask.
  const choice =
    rules.version === undefined
      ? 'none'
      : await receiptsChoice(deps, agent, output, { policy: rules.policy, version: rules.version });
  policy = withReceiptsChoice(policy, choice);
  const version = (rules.version ?? 0) + 1;
  const shown = choice === 'off' ? `${summary} ${POLICY_TEXT.receiptsTurnOff}` : summary;
  const signed = await signAndApply(deps, agent, output, policy, version, shown);
  if (signed !== EXIT_OK) return signed;
  await rememberKept(agent, choice, version);
  output.print(done);
  return EXIT_OK;
}

/**
 * Signs one complete `policy.set` at `version` (one owner-code entry at @4thtech-io/node's own TTY
 * prompt, which shows `summary`), has the core verify and apply it, and prints any failure. EXIT_OK
 * only when it was applied and the mark was raised to it.
 */
async function signAndApply(
  deps: OwnerCommandDeps,
  agent: OwnerAgent,
  output: Output,
  policy: Policy,
  version: number,
  summary: string,
): Promise<number> {
  const owner = await ownerContext(agent);
  if (owner === undefined) {
    output.printError(OWNER_TEXT.noIdentity);
    return EXIT_FAILED;
  }
  const issuedAt = deps.now();
  const body: JsonObject = {
    v: 1,
    agent: owner.agent,
    owner: encodeHex(owner.owner.ownerNostr),
    op: 'policy.set',
    params: { version, policy: policy as unknown as JsonObject },
    nonce: encodeBase64url(randomBytes(16)),
    issuedAt,
    expiresAt: issuedAt + POLICY_SET_LIFETIME_SECONDS,
  };
  output.print(POLICY_TEXT.codeHint);
  let signature;
  try {
    signature = await deps.signOwnerAction(owner.owner, {
      kind: 'owner-action',
      action: body,
      summary,
    });
  } catch (error) {
    if (isPresenceRejected(error)) {
      output.printError(POLICY_TEXT.wrongCode);
      return EXIT_FAILED;
    }
    throw error;
  }
  if (signature.kind !== 'owner-action') {
    output.printError(POLICY_TEXT.failed);
    return EXIT_FAILED;
  }
  const outcome = await agent.client.ownerActions.apply(signature.signed);
  if (outcome.status !== 'applied') {
    output.printError(POLICY_TEXT.failed);
    return EXIT_FAILED;
  }
  if (outcome.op === 'policy.set' && outcome.markRaised === false) {
    output.printError(POLICY_TEXT.notConfirmed);
    return EXIT_FAILED;
  }
  return EXIT_OK;
}

/**
 * `policy recover` † (D-100). Only while the rules fail closed: prints the kind of failure, shows
 * the stored rules (rolled_back, mark_mismatch, signature verified) or the 06 §3 defaults in full,
 * asks for an explicit `y`, then one owner-code entry signs that complete policy.
 */
async function recover(deps: OwnerCommandDeps, agent: OwnerAgent, output: Output): Promise<number> {
  const view = await agent.client.ownerActions.policyRecovery();
  if (view.status === 'valid') {
    output.printError(POLICY_TEXT.nothingToRecover);
    return EXIT_FAILED;
  }
  if (view.status === 'unavailable') {
    output.printError(POLICY_TEXT.whatHappened(PROBLEM_TEXT[view.problem]));
    output.printError(POLICY_TEXT.cannotRecover);
    return EXIT_FAILED;
  }
  // A deep, plain copy of what is reviewed: exactly this document is signed.
  let policy = JSON.parse(
    JSON.stringify(view.stored === undefined ? defaultPolicy() : view.stored.policy),
  ) as Policy;
  if (reviewLines(policy) === undefined || !policySchema.safeParse(policy).success) {
    output.printError(POLICY_TEXT.notShowable);
    return EXIT_FAILED;
  }
  output.print(POLICY_TEXT.whatHappened(PROBLEM_TEXT[view.problem]));
  // 06 §3 (D-109): the stored rules may have delivery receipts on from an older default. Asked
  // before the review, so the review shows exactly what is signed. The defaults have them off.
  const choice =
    view.stored === undefined
      ? 'none'
      : await receiptsChoice(deps, agent, output, {
          policy: view.stored.policy,
          version: view.stored.version,
        });
  policy = withReceiptsChoice(policy, choice);
  const lines = reviewLines(policy);
  if (lines === undefined) {
    output.printError(POLICY_TEXT.notShowable);
    return EXIT_FAILED;
  }
  output.print(
    [
      '',
      view.stored === undefined ? POLICY_TEXT.reviewDefaults : POLICY_TEXT.reviewStored,
      '',
      ...lines,
      '',
    ].join('\n'),
  );
  const answer = await deps.ask(POLICY_TEXT.confirmQuestion);
  if (answer.trim().toLowerCase() !== 'y') {
    output.printError(POLICY_TEXT.notConfirmedAnswer);
    return EXIT_FAILED;
  }
  const signed = await signAndApply(
    deps,
    agent,
    output,
    policy,
    view.nextVersion,
    POLICY_TEXT.recoverSummary(view.nextVersion),
  );
  if (signed !== EXIT_OK) return signed;
  await rememberKept(agent, choice, view.nextVersion);
  output.print(POLICY_TEXT.recovered(view.nextVersion));
  return EXIT_OK;
}

async function allowFolder(
  deps: OwnerCommandDeps,
  agent: OwnerAgent,
  output: Output,
  typed: string,
  home: string,
  flavor: PathFlavor,
): Promise<number> {
  const checked = await checkFolder(typed, home, flavor);
  if (!checked.ok) {
    output.printError(checked.message);
    return EXIT_FAILED;
  }
  const rules = current(await agent.client.ownerActions.loadPolicy());
  if (rules === undefined) {
    output.printError(POLICY_TEXT.rulesUnreadable);
    return EXIT_FAILED;
  }
  const existing = rules.policy.files.allowedFolders;
  if (existing.includes(checked.path)) {
    output.print(POLICY_TEXT.alreadyAllowed);
    return EXIT_OK;
  }
  return setFolders(
    deps,
    agent,
    output,
    rules,
    [...existing, checked.path],
    POLICY_TEXT.allowSummary(checked.path),
    POLICY_TEXT.allowed,
  );
}

async function removeFolder(
  deps: OwnerCommandDeps,
  agent: OwnerAgent,
  output: Output,
  typed: string,
  home: string,
  flavor: PathFlavor,
): Promise<number> {
  const shaped = lexical(typed, home, flavor);
  if (!shaped.ok) {
    output.printError(shaped.message);
    return EXIT_FAILED;
  }
  // The folder as typed, and its realpath when it still exists: either names a stored entry.
  const names = new Set([shaped.path]);
  try {
    names.add(await realpath(shaped.path));
  } catch {
    // A folder that no longer exists is removed by its path.
  }
  const rules = current(await agent.client.ownerActions.loadPolicy());
  if (rules === undefined) {
    output.printError(POLICY_TEXT.rulesUnreadable);
    return EXIT_FAILED;
  }
  const existing = rules.policy.files.allowedFolders;
  const matches = (entry: string): boolean =>
    names.has(entry) || names.has(expandHome(entry, home, flavor));
  const removed = existing.filter(matches);
  if (removed.length === 0) {
    output.printError(POLICY_TEXT.notAllowed);
    return EXIT_FAILED;
  }
  // Every stored entry that matches is removed, and all of them are shown (IR-M1-9m-1 L4). The stored entry is what the owner sees: it passed the 06 §3 path rule when it was signed.
  const shown = removed.map((entry) => terminalOneLine(entry));
  return setFolders(
    deps,
    agent,
    output,
    rules,
    existing.filter((entry) => !matches(entry)),
    POLICY_TEXT.removeSummary(shown),
    POLICY_TEXT.removed,
  );
}

async function runPolicy(
  deps: OwnerCommandDeps,
  context: CommandContext,
  options: PolicyCommandOptions,
): Promise<number> {
  const { output } = context;
  const [sub, arg, ...extra] = context.parsed.positionals;
  if (extra.length > 0) return badArguments(output);
  if (sub === 'set') {
    // `policy set <key> <value>` (06 §8) is a later task: commitments limits and the sell warning.
    output.printError(DISPATCH_TEXT.notAvailable);
    return EXIT_FAILED;
  }
  const known =
    ((sub === 'show' || sub === 'recover') && arg === undefined) ||
    ((sub === 'allow-folder' || sub === 'remove-folder') && arg !== undefined);
  if (!known) return badArguments(output);

  const home = options.home ?? homedir();
  const flavor = options.flavor ?? defaultFlavor();
  const opened = await chooseAgent(deps, output, context.parsed.agent);
  if (!opened.ok) return opened.exit;
  const { agent } = opened;
  try {
    if (sub === 'show') return await show(agent, output);
    if (sub === 'recover') return await recover(deps, agent, output);
    if (sub === 'allow-folder') {
      return await allowFolder(deps, agent, output, arg as string, home, flavor);
    }
    return await removeFolder(deps, agent, output, arg as string, home, flavor);
  } finally {
    await agent.close();
  }
}

/** `agentlink policy …` †. The dispatcher's owner-terminal guard has already run. */
export function policyHandler(
  deps: OwnerCommandDeps,
  options: PolicyCommandOptions = {},
): CommandHandler {
  return (context) => ownerStep(context, () => runPolicy(deps, context, options));
}
