// SEC-CARD-FULLTEXT (08 §1 "What the card shows"; 11 §5, §6.2.1): the exact content an approval
// request is about, decoded by the app from the digest-bound stored action (a paid send's
// `args.text` or `args.body`) or from the stored envelope it names (core `proofs.approvalContent`,
// which checks the envelope hash or record). Full, inert text (never cut), files and check codes
// (>= 80 bits). Anything that does not decode is `contentMissing`: the local UI and `agentlink
// approve` then never approve it (fail closed). Shared by the UI source and the terminal card.
import type { AgentLinkClient } from '@4thtech-io/core';
import { canonicalize, type JsonObject, type JsonValue } from '@4thtech-io/crypto';
import { FILE_KIND_LABELS, fileKindOf } from '@4thtech-io/types';
import {
  APPROVAL_CONTENT_FILES_MAX,
  APPROVAL_CONTENT_MAX,
  checkCode,
  inertText,
  textLength,
  type ApprovalContent,
  type ApprovalContentFile,
} from '@4thtech-io/types/ui-contract/approval-content';

const asObject = (value: JsonValue | undefined): JsonObject | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;

/** The fixed label of the content block, by tool (11 §5). */
const CONTENT_LABEL: Readonly<Record<string, string>> = Object.freeze({
  agentlink_send: 'Exactly what will be sent',
  agentlink_notarize: 'The message this proof is for',
  agentlink_acknowledge: 'The message your receipt answers',
  agentlink_export_proof_pack: 'The message whose content will be shared',
});

/** "980 bytes", "12 KB", "3.4 MB": exact enough to compare, never "about". */
function sizeText(bytes: number): string {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${String(bytes)} bytes`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : String(Math.round(value))} ${units[unit] ?? 'GB'}`;
}

/** A file name as one inert line. */
const nameLine = (name: string): string => inertText(name).replace(/[\n\t]/g, ' ');

function fileView(name: string, size: number, sha256: string): ApprovalContentFile {
  return {
    name: nameLine(name),
    size: sizeText(size),
    // From the name alone: the sender's media type is never trusted (file-kind.ts).
    type: FILE_KIND_LABELS[fileKindOf(name)],
    checkCode: checkCode(sha256),
  };
}

export type ContentFacts =
  { readonly content: ApprovalContent } | { readonly contentMissing: true } | Record<string, never>;

/** The basename of a path argument, for a file not sent yet (the content holds no path). */
const baseName = (path: unknown): string =>
  typeof path === 'string' ? (path.split(/[\\/]/).pop() ?? '') : '';

/** The card's content block (see the file header); fails closed to `contentMissing`. */
export async function contentOf(
  client: AgentLinkClient,
  action: JsonObject,
): Promise<ContentFacts> {
  const tool = action['tool'];
  if (typeof tool !== 'string') return {};
  const label = CONTENT_LABEL[tool];
  if (label === undefined) return {};
  try {
    if (tool === 'agentlink_send') {
      const args = asObject(action['args']);
      const text = args?.['text'];
      const body = args?.['body'];
      // The core sends exactly one of `text` and `body` (send.ts readInput; the other is null in
      // the stored args), so the card never has to choose: both, or a value of the wrong kind,
      // fails closed. Neither is not a send the core runs; the card then has no content block.
      const hasText = typeof text === 'string';
      const hasBody = typeof body === 'object' && body !== null && !Array.isArray(body);
      if (hasText && hasBody) return { contentMissing: true };
      if (!hasText && text !== undefined && text !== null) return { contentMissing: true };
      if (!hasBody && body !== undefined && body !== null) return { contentMissing: true };
      if (!hasText && !hasBody) return {};
      const raw = hasText ? text : canonicalize(body as JsonValue);
      const file = asObject(asObject(action['context'])?.['file']);
      const sha = file?.['plaintextSha256'];
      const size = file?.['size'];
      const files =
        typeof sha === 'string' && typeof size === 'number'
          ? [fileView(baseName(args?.['path']) || 'File', size, sha)]
          : [];
      if (raw.length > APPROVAL_CONTENT_MAX) return { contentMissing: true };
      return { content: { label, text: inertText(raw), length: textLength(raw), files } };
    }
    const found = await client.proofs.approvalContent(action);
    if (found === undefined) return {};
    if (found === 'missing') return { contentMissing: true };
    if (found.text.length > APPROVAL_CONTENT_MAX) return { contentMissing: true };
    if (found.files.length > APPROVAL_CONTENT_FILES_MAX) return { contentMissing: true };
    return {
      content: {
        label,
        text: inertText(found.text),
        length: textLength(found.text),
        checkCode: checkCode(found.envelopeHash),
        files: found.files.map((f) => fileView(f.name, f.size, f.plaintextSha256)),
      },
    };
  } catch {
    // Anything that does not decode is never shown as if it were the content.
    return { contentMissing: true };
  }
}
