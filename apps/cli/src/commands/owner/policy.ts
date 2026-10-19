// `agentlink policy show | allow-folder <path> | remove-folder <path>` † (M1-9m; 04 §2.5, §4
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
  rulesUnreadable:
    "AgentLink can't read your rules right now, so it uses its strictest settings and no folder is allowed. Nothing was changed. Run `agentlink doctor` in your own terminal.",
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
});

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
  if (segmentsOf(real, flavor).some((s) => s.startsWith('.'))) return refuse(POLICY_TEXT.hidden);
  return { ok: true, path: real };
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
  const policy: Policy = {
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
    params: { version: (rules.version ?? 0) + 1, policy: policy as unknown as JsonObject },
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
  output.print(done);
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
    (sub === 'show' && arg === undefined) ||
    ((sub === 'allow-folder' || sub === 'remove-folder') && arg !== undefined);
  if (!known) return badArguments(output);

  const home = options.home ?? homedir();
  const flavor = options.flavor ?? defaultFlavor();
  const opened = await chooseAgent(deps, output, context.parsed.agent);
  if (!opened.ok) return opened.exit;
  const { agent } = opened;
  try {
    if (sub === 'show') return await show(agent, output);
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
