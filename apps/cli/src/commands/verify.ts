// `agentlink verify <proof.json>` (M1-9h; 06 §8; 07 §8; 05 §9.1 (iv); 11 §5; D-71 (1), D-87, D-95,
// D-96, D-97, D-102, D-104, D-105). Read-only: it writes nothing, sends nothing and signs nothing.
//
// - The pack file is read only through the confined reader of src/runtime/proofs.ts (D-87): inside
//   `proofs.exportFolder` or `files.inboxFolder` of the verified rules, a lexical check before any
//   disk access, then realpath, no-follow open, regular file, device and inode, and the 256 KiB cap.
//   A relative path is taken from the current folder (a terminal user's expectation), joined
//   without normalising, so a `.` or `..` segment is still refused by the lexical check. Under rules
//   that fail closed no folder is allowed. Refusals are fixed text: never the path or the bytes.
// - The pack is untrusted (I-5). The chain package's verifier parses it strictly and reads only the
//   Notary of a shipped chain through the address-checked RPC fetch (04 §4); the user configures no
//   network. A failure is shown by its code, from our own table (never the verifier's text, a value
//   or a URL). Nothing here prints a URL, an RPC endpoint or a key.
// - The verdict comes first (IR-M1-4d-1 M-2): `verified` is the only full pass; `record_only` is
//   neutral (D-95) and never shown as a pass. A test-network proof is labelled right under the
//   verdict with its network ID and is never presented as a live proof (05 §9.1 (iv)).
// - Then one line per check the verifier made: the record, who recorded it (06 §2.1 name rule:
//   a contact's shown name, this agent, or the owner fingerprint; never a name from the pack),
//   receipts, the disclosed content, the owner approval, and the non-fatal notices (D-96).
// - The disclosed content, when it opened, is printed only inside the marked untrusted region
//   (06 §8), after the checks.
//
// Exit codes (proposed, owner confirms at merge): 0 verified; 3 record only (the record checks out,
// not a full proof); 1 the proof does not check out; 4 not checked (file not allowed, too large or
// unreadable, or the proof network did not answer); 2 usage.
import { homedir } from 'node:os';
import process from 'node:process';
import * as chain from '@4thtech-io/chain';
import { renderContactName } from '@4thtech-io/core';
import { decodeHex0x, formatFingerprint, ownerFingerprint } from '@4thtech-io/crypto';
import { DISPATCH_TEXT, EXIT_FAILED, EXIT_USAGE, type CommandHandler } from '../dispatch.js';
import { createPackVerifier } from '../runtime/pack-verifier.js';
import { nodeProofPacks } from '../runtime/proofs.js';
import { terminalOneLine, untrustedRegion } from '../terminal/sanitize.js';
import type { PackFolders, PackReadOutcome } from '../tools/context.js';
import { formatDate, formatTime } from '../tools/strings/index.js';
import { createDeps, fill, printAll, withAgent, type CommandDeps } from './shared.js';

/** Exit codes of `agentlink verify` (proposed, owner confirms at merge). */
export const VERIFY_EXIT = Object.freeze({
  verified: 0,
  failed: EXIT_FAILED,
  usage: EXIT_USAGE,
  recordOnly: 3,
  notChecked: 4,
});

/** Verifies the pack bytes (the chain package's `verifyProofPack` over the shipped chains). */
export type PackVerifier = (bytes: Uint8Array) => Promise<chain.ProofPackResult>;

/** Reads a pack file under D-87 (src/runtime/proofs.ts `readPack`). */
export type PackReader = (path: string, folders: PackFolders) => Promise<PackReadOutcome>;

export interface VerifyDeps extends CommandDeps {
  readonly verifyPack: PackVerifier;
  readonly readPack: PackReader;
  /** The folder a relative path is taken from. */
  readonly cwd: () => string;
}

export interface NodePackVerifierOptions {
  /** The address-checked RPC fetch. Default: `nodeRpcFetch()`. */
  readonly fetchFn?: chain.RpcFetchFn;
  /** The chains a pack may name. Default: every shipped chain (`chainRegistry()`). */
  readonly configs?: readonly chain.ChainConfig[];
}

/**
 * The verifier over the shipped chains. Every chain of this release is readable for verification,
 * Chiado included (it is held back only from automatic selection for paid actions, M1-3j-b); the
 * Notary address always comes from the shipped config, never from the pack.
 */
export function nodePackVerifier(options: NodePackVerifierOptions = {}): PackVerifier {
  const verify = createPackVerifier(options);
  return (bytes) => verify(bytes);
}

/** Fixed text (11 §5: "public record", "proof network" only in proof details; no chain words). */
export const VERIFY_CLI_TEXT = Object.freeze({
  verified: 'Verified  The proof checks out.',
  recordOnly:
    "Record only  The record checks out, but the proof doesn't show who wrote the content. Treat it as a record only, not a full proof.",
  failed: "Failed  This proof doesn't check out: {reason}",
  testNetwork:
    'Test network  This proof was recorded on a test network (ID {chainId}). It is not a live proof.',
  liveNetwork: 'Proof network ID {chainId}.',
  checksHeader: 'Checks:',
  record: 'OK       Record found on the public record, made {date}, {time} UTC{finality}',
  finalityFinal: ' (final)',
  finalityLatest: ' (recent, not final yet)',
  byThisAgent: 'OK       Recorded by this agent',
  byContact: 'OK       Recorded by {name}',
  byOwner: 'OK       Recorded by an agent outside your contacts, owner {fingerprint}',
  byUnknown: 'OK       Recorded by an agent outside your contacts (its agent ID is below)',
  byAccount: '         Its agent ID is an account with its own approval rules.',
  noReceipts: 'OK       Receipts: none recorded',
  receipt: 'OK       {type} {date}, {time} UTC',
  receiptLinkChecked: '         Its link on the public record checks out.',
  contentNotIncluded: '--       Content: not included in this proof',
  contentVerified: 'OK       Content: included, opened, and sent by the agent that made the record',
  contentUnattributed: 'Warning  Content: {message}',
  contentFailed: 'Warning  Content not proven: {message}',
  approvalNone: '--       Owner approval: none included',
  approvalRule: "OK       Owner approval: approved by the owner's standing rule",
  approvalSigned: 'OK       Owner approval: the owner {who} approved {what}',
  approvalUnbound:
    "Warning  Owner approval: genuine, but this proof doesn't show it is for this record",
  approvalOwnerUnknown:
    "Warning  Owner approval: genuine, but this proof doesn't show whose owner gave it",
  notice: 'Warning  {message}',
  details: 'Details:',
  detailRecord: '  Record ID: {recordId}',
  detailAgent: '  Agent ID: {agentId}',
  regionWho: 'the proof file',
  pathNotAllowed:
    "That file isn't in your AgentLink proofs or inbox folder, so it wasn't read. Move it into one of them and run the command again.",
  tooLarge: 'That proof file is too large to check (at most 256 KiB), so it was not checked.',
  unreadable: "That file isn't a proof file AgentLink can read, so it was not checked.",
  network:
    "The proof can't be checked right now: the public record didn't answer. Try again in a few minutes.",
});

/** Why a pack does not verify, by the 07 §8 code (11 §5 words: never chain, contract or hash). */
export const VERIFY_FAILURE_TEXT: Readonly<Record<chain.ProofPackFailure, string>> = Object.freeze({
  pack_too_large: 'it is too large to check.',
  malformed_pack: 'it is not in the expected format, or it was changed.',
  unsupported_pack: 'this kind or version of proof file is not supported.',
  invalid_kind: 'it names a record type that does not exist.',
  envelope_missing: 'it shares a content key without the message it opens.',
  content_key_invalid: 'its shared content key has the wrong length.',
  unsupported_chain: 'it is from a proof network this version does not support.',
  notary_mismatch: 'it points to a record keeper that is not the official AgentLink one.',
  record_id_mismatch: 'its record ID does not match the record.',
  chain_unavailable: "the public record didn't answer.",
  record_not_found: 'no such record exists on the public record.',
  malformed_record: 'the public record returned a record that cannot be read.',
  signer_mismatch: 'the record was made by someone else.',
  kind_mismatch: 'the record type does not match.',
  envelope_hash_mismatch: 'the message fingerprint does not match the record.',
  commitment_mismatch: 'the recipient in the proof does not match the record.',
  record_mismatch: 'the record details in the proof do not match the recorded ones.',
  signature_invalid: 'the record is not validly signed by the agent that made it.',
  card_invalid: 'the agent profile in it is not signed by its owner.',
  card_expired: 'the agent profile had expired when the record was made.',
  card_pop_invalid: "the agent profile in it is not confirmed by the agent's own keys.",
  recipient_mismatch: 'the disclosed recipient does not match the record.',
  receipt_not_on_chain: 'it lists a receipt that was never recorded.',
  receipt_mismatch: 'a receipt time in it does not match the recorded one.',
  owner_approval_invalid: 'the owner approval in it is not valid for this record.',
});

/** Why disclosed content is not proven or not attributed (07 §8), by code. */
export const VERIFY_CONTENT_TEXT: Readonly<Record<chain.ProofContentFailure, string>> =
  Object.freeze({
    envelope_invalid: 'the included message is not in the expected format.',
    envelope_hash_mismatch: 'the included message is not the one recorded.',
    envelope_signature_invalid: 'the included message is not signed by its sender.',
    sender_mismatch:
      'the included message was sent by someone other than the agent that made the record.',
    sender_not_bound:
      "included and opened, but the proof doesn't show that the agent that made the record sent it.",
    card_pop_missing:
      "included and opened, but the proof doesn't confirm that the agent that made the record sent it.",
    key_commitment_mismatch: 'the shared content key is not the key this message was sealed with.',
    decrypt_failed: 'the included message could not be opened with the shared key.',
    payload_invalid: 'the opened message is not in the expected format.',
    kind_mismatch: 'the included message is not the kind the record names.',
  });

/** D-96 and the other non-fatal findings: fixed sentences; the verdict is unchanged. */
export const VERIFY_NOTICE_TEXT: Readonly<Record<chain.ProofNoticeCode, string>> = Object.freeze({
  signer_no_longer_confirms:
    "The signer's account no longer confirms this record. The proof network checked it when the record was made.",
  receipt_tx_mismatch:
    "The proof's link for a receipt does not lead to that receipt. The receipt itself is on the public record.",
});

const RECEIPT_WORD: Readonly<Record<string, string>> = Object.freeze({
  DELIVERED: 'Delivered',
  OPENED: 'Opened',
  ACCEPTED: 'Accepted',
  REJECTED: 'Rejected',
});

const DECISION_WORD: Readonly<Record<string, string>> = Object.freeze({
  offer: 'making this offer',
  accept: 'accepting these terms',
  confirm: 'confirming these terms',
  reject: 'rejecting these terms',
});

const AGENT_ID = /^0x[0-9a-f]{40}$/;
const RECORD_ID = /^0x[0-9a-f]{64}$/;

function when(timestamp: string): { date: string; time: string } {
  const at = new Date(timestamp);
  if (Number.isNaN(at.getTime())) return { date: '?', time: '?' };
  return { date: formatDate(at), time: formatTime(at) };
}

/**
 * The path the confined reader gets. `~/` and absolute paths as given; a relative path joined to
 * the current folder WITHOUT normalising (a leading `./` is dropped), so `.` and `..` segments
 * still reach the lexical check and are refused there (D-87).
 */
export function packPathFromArgument(argument: string, cwd: string): string {
  if (argument.startsWith('~') || argument.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(argument)) {
    return argument;
  }
  if (argument.startsWith('\\')) return argument;
  const rest = argument.replace(/^\.[\\/]/, '');
  const sep = process.platform === 'win32' ? '\\' : '/';
  return `${cwd.replace(/[\\/]+$/, '')}${sep}${rest}`;
}

/** Who made the record, under the 06 §2.1 name rule. Never a name from the pack. */
async function recordedBy(
  result: chain.ProofPackValid,
  agentId: string,
  contacts: () => Promise<readonly { id: string; status: string; display: unknown }[]>,
): Promise<string> {
  const signer = result.signer.toLowerCase();
  if (signer === agentId.toLowerCase()) return VERIFY_CLI_TEXT.byThisAgent;
  const list = await contacts().catch(() => []);
  const contact = list.find((c) => c.id.toLowerCase() === signer && c.status !== 'removed');
  if (contact !== undefined) {
    return fill(VERIFY_CLI_TEXT.byContact, {
      name: terminalOneLine(
        renderContactName(contact.display as Parameters<typeof renderContactName>[0]),
      ),
    });
  }
  const card = result.signerCard;
  if (card !== null) {
    try {
      const fp = formatFingerprint(
        ownerFingerprint(
          decodeHex0x(card.ownerEvm, { length: 20 }),
          decodeHex0x(card.ownerNostr, { length: 32 }),
          decodeHex0x(card.ownerEnc, { length: 32 }),
        ),
        'short',
      );
      return fill(VERIFY_CLI_TEXT.byOwner, { fingerprint: terminalOneLine(fp) });
    } catch {
      // Fall through to the agent ID.
    }
  }
  return VERIFY_CLI_TEXT.byUnknown;
}

function approvalLine(approval: chain.OwnerApprovalResult): string {
  switch (approval.status) {
    case 'none':
      return VERIFY_CLI_TEXT.approvalNone;
    case 'standing_rule':
      return VERIFY_CLI_TEXT.approvalRule;
    case 'signed':
      if (!approval.ownerBound) return VERIFY_CLI_TEXT.approvalOwnerUnknown;
      if (!approval.recordBound) return VERIFY_CLI_TEXT.approvalUnbound;
      return fill(VERIFY_CLI_TEXT.approvalSigned, {
        who:
          approval.approver === 'signer' ? 'of the agent that made the record' : 'of the recipient',
        what: DECISION_WORD[approval.decision] ?? 'this',
      });
  }
}

/** The lines `verify` prints for a verifier result, the content region last. */
export async function renderVerifyResult(
  result: chain.ProofPackResult,
  agentId: string,
  contacts: () => Promise<readonly { id: string; status: string; display: unknown }[]>,
): Promise<{ lines: string[]; exit: number }> {
  if (!result.valid) {
    if (result.reason === 'chain_unavailable') {
      return { lines: [VERIFY_CLI_TEXT.network], exit: VERIFY_EXIT.notChecked };
    }
    if (result.reason === 'pack_too_large') {
      return { lines: [VERIFY_CLI_TEXT.tooLarge], exit: VERIFY_EXIT.notChecked };
    }
    const reason = VERIFY_FAILURE_TEXT[result.reason] ?? VERIFY_FAILURE_TEXT.malformed_pack;
    return { lines: [fill(VERIFY_CLI_TEXT.failed, { reason })], exit: VERIFY_EXIT.failed };
  }

  const lines: string[] = [];
  lines.push(result.verdict === 'verified' ? VERIFY_CLI_TEXT.verified : VERIFY_CLI_TEXT.recordOnly);
  const chainId = Number.isSafeInteger(result.chainId) ? result.chainId : 0;
  const config = chain.getChainConfig(chainId);
  // A shipped chain marked testnet, or any chain that is not a known public mainnet ID, is shown
  // as a test network: a testnet proof is never presented as a live proof (05 §9.1 (iv)).
  const testnet = config?.testnet !== false || !chain.KNOWN_MAINNET_CHAIN_IDS.has(chainId);
  lines.push(
    fill(testnet ? VERIFY_CLI_TEXT.testNetwork : VERIFY_CLI_TEXT.liveNetwork, { chainId }),
  );

  lines.push('', VERIFY_CLI_TEXT.checksHeader);
  lines.push(
    fill(VERIFY_CLI_TEXT.record, {
      ...when(result.timestamp),
      finality:
        result.finality === 'finalized'
          ? VERIFY_CLI_TEXT.finalityFinal
          : VERIFY_CLI_TEXT.finalityLatest,
    }),
  );
  lines.push(await recordedBy(result, agentId, contacts));
  if (result.signerType === 'contract') lines.push(VERIFY_CLI_TEXT.byAccount);

  if (result.receipts.length === 0) lines.push(VERIFY_CLI_TEXT.noReceipts);
  for (const receipt of result.receipts) {
    lines.push(
      fill(VERIFY_CLI_TEXT.receipt, {
        type: RECEIPT_WORD[receipt.type] ?? 'Receipt',
        ...when(receipt.at),
      }),
    );
    if (receipt.tx.status === 'confirmed') lines.push(VERIFY_CLI_TEXT.receiptLinkChecked);
  }

  const content = result.content;
  let payload: unknown;
  switch (content.status) {
    case 'not_disclosed':
      lines.push(VERIFY_CLI_TEXT.contentNotIncluded);
      break;
    case 'verified':
      lines.push(VERIFY_CLI_TEXT.contentVerified);
      payload = content.payload;
      break;
    case 'unattributed':
      lines.push(
        fill(VERIFY_CLI_TEXT.contentUnattributed, {
          message: VERIFY_CONTENT_TEXT[content.reason] ?? VERIFY_CONTENT_TEXT.payload_invalid,
        }),
      );
      payload = content.payload;
      break;
    case 'failed':
      lines.push(
        fill(VERIFY_CLI_TEXT.contentFailed, {
          message: VERIFY_CONTENT_TEXT[content.reason] ?? VERIFY_CONTENT_TEXT.payload_invalid,
        }),
      );
      break;
  }
  lines.push(approvalLine(result.ownerApproval));
  for (const notice of result.notices) {
    const text = VERIFY_NOTICE_TEXT[notice.code];
    if (text !== undefined) lines.push(fill(VERIFY_CLI_TEXT.notice, { message: text }));
  }

  lines.push('', VERIFY_CLI_TEXT.details);
  lines.push(
    fill(VERIFY_CLI_TEXT.detailRecord, {
      recordId: RECORD_ID.test(result.recordId) ? result.recordId : '?',
    }),
    fill(VERIFY_CLI_TEXT.detailAgent, {
      agentId: AGENT_ID.test(result.signer) ? result.signer : '?',
    }),
  );

  if (payload !== undefined && payload !== null) {
    // I-5: the disclosed content only inside the marked region (06 §8), after the fixed lines.
    let text: string | undefined;
    try {
      text = JSON.stringify(payload, null, 2);
    } catch {
      text = undefined;
    }
    if (text !== undefined) lines.push('', ...untrustedRegion(VERIFY_CLI_TEXT.regionWho, [text]));
  }

  return {
    lines,
    exit: result.verdict === 'verified' ? VERIFY_EXIT.verified : VERIFY_EXIT.recordOnly,
  };
}

const NOT_ALLOWED: PackReadOutcome = Object.freeze({ ok: false, code: 'PATH_NOT_ALLOWED' });

export function createVerifyHandler(deps: VerifyDeps): CommandHandler {
  return (context) => {
    const { positionals } = context.parsed;
    const argument = positionals[0];
    if (positionals.length !== 1 || argument === undefined || argument === '') {
      context.output.printError(DISPATCH_TEXT.badArguments);
      return Promise.resolve(VERIFY_EXIT.usage);
    }
    return withAgent(context, deps, async ({ client, agentId }) => {
      // D-87: the folders come from the verified rules only; under fail-closed none is allowed.
      const effective = await Promise.resolve()
        .then(() => client.ownerActions.loadPolicy())
        .catch(() => undefined);
      const read =
        effective === undefined || effective.mode === 'fail_closed'
          ? NOT_ALLOWED
          : await deps
              .readPack(packPathFromArgument(argument, deps.cwd()), {
                exportFolder: effective.policy.proofs.exportFolder,
                inboxFolder: effective.policy.files.inboxFolder,
              })
              .catch((): PackReadOutcome => ({ ok: false, code: 'PACK_INVALID' }));
      if (!read.ok) {
        context.output.printError(
          read.code === 'PATH_NOT_ALLOWED'
            ? VERIFY_CLI_TEXT.pathNotAllowed
            : read.code === 'PACK_TOO_LARGE'
              ? VERIFY_CLI_TEXT.tooLarge
              : VERIFY_CLI_TEXT.unreadable,
        );
        return VERIFY_EXIT.notChecked;
      }

      let result: chain.ProofPackResult;
      try {
        result = await deps.verifyPack(read.bytes);
      } catch {
        // The error could carry an RPC URL (I-7): never printed.
        context.output.printError(VERIFY_CLI_TEXT.network);
        return VERIFY_EXIT.notChecked;
      }
      const rendered = await renderVerifyResult(result, agentId, () => client.contacts.list());
      printAll(context, rendered.lines);
      return rendered.exit;
    });
  };
}

export function nodeVerifyDeps(over: Partial<VerifyDeps> = {}): VerifyDeps {
  const base = createDeps();
  const home = over.home ?? homedir();
  return Object.freeze({
    ...base,
    home,
    verifyPack: nodePackVerifier(),
    readPack: nodeProofPacks({ home }).readPack,
    cwd: () => process.cwd(),
    ...over,
  });
}

export const verifyHandler: CommandHandler = (context) =>
  createVerifyHandler(nodeVerifyDeps())(context);
