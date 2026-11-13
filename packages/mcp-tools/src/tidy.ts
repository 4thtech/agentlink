// RET-7 (S2; D-148 (3) OD-3; 06 §1, §2.0, §4; 04 §4.2 "The AI proposes, the owner approves"; I-4,
// I-5, I-7; proposed, owner confirms at merge): `agentlink_tidy`.
//
// The AI can only PROPOSE a cleanup on this computer:
// - Input is a filter only: `olderThanDays` (30, 90 or 365), `kinds` (`files`, or
//   `messages_and_files`) and an optional `contact`, resolved like every other tool's (06 §2.1).
//   Never message IDs, never "everything", never a retention setting.
// - The handler asks core what that filter would remove now (`tidyPreview`: a plan, read-only) and
//   ALWAYS answers `pending_approval` with the exact counts and sizes. Its `approvalId` names this
//   proposal only: there is no approval row, the tool takes no `approvalId`, and nothing in the MCP
//   server can apply it (the client surface has no apply).
// - The owner reviews it in the app: the link opens Settings › Storage with the same filter
//   (`/settings/storage?tidy=files|both&days=…[&contact=0x…]`), where the server plans again, shows
//   the counts, and deletes only after the owner's presence gesture and the 10-second Undo (RET-4).
// - Summary and nextStep are our fixed text with numbers (06 §4): no contact name, no inbound
//   content, no error text. A link that is not exactly the local UI origin plus the fixed page is
//   never used (fail closed to the text-only answer).
import { encodeBase64url, randomBytes } from '@4thtech-io/crypto';
import type { AllowFolderLink, TidyCounts, ToolContext } from './context.js';
import { resolveContact } from './contacts.js';
import { notAvailable, resultIsValid, type HandlerOutput } from './result.js';

export type TidyKinds = 'files' | 'messages_and_files';

/** The ages the app's Free up space offers (RET-4), in days. */
export const TIDY_DAYS: readonly number[] = Object.freeze([30, 90, 365]);
export const TIDY_KINDS: readonly TidyKinds[] = Object.freeze(['files', 'messages_and_files']);

const DAY_SECONDS = 86_400;
const AGENT_ID = /^0x[0-9a-f]{40}$/;
const UI_ORIGIN = /^http:\/\/localhost:([1-9][0-9]{0,4})$/;

/** The only page a tidy link may name. */
export const TIDY_PAGE_PATTERN =
  /^\/settings\/storage\?tidy=(files|both)&days=(30|90|365)(&contact=0x[0-9a-f]{40})?$/;

/** The Settings › Storage page with this filter (the app fills Free up space with it). */
export function tidyPage(filter: {
  readonly olderThanDays: number;
  readonly kinds: TidyKinds;
  readonly contactId?: string;
}): string | undefined {
  const tidy = filter.kinds === 'files' ? 'files' : 'both';
  // IR-RET-67-1 Low 4: a contact the link cannot name gives no link (never "everyone").
  if (filter.contactId !== undefined && !AGENT_ID.test(filter.contactId)) return undefined;
  const contact = filter.contactId === undefined ? '' : `&contact=${filter.contactId}`;
  return `/settings/storage?tidy=${tidy}&days=${String(filter.olderThanDays)}${contact}`;
}

/** Decimal sizes, as the app shows them ("410 MB"). */
function sizeWords(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1000) return `${String(Math.max(0, bytes))} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let i = 0;
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000;
    i += 1;
  }
  return `${value.toFixed(1).replace(/\.0$/, '')} ${units[i] as string}`;
}

const plural = (n: number, one: string, many: string): string =>
  `${String(n)} ${n === 1 ? one : many}`;

/** Fixed text with numbers only (06 §4). */
export function tidySummary(
  counts: TidyCounts,
  kinds: TidyKinds,
  days: number,
  oneContact: boolean,
): string {
  const files = plural(counts.files.count, 'file', 'files');
  const what =
    kinds === 'files'
      ? `${files} (${sizeWords(counts.files.bytes)})`
      : `${plural(counts.messages.count, 'message', 'messages')} and ${files} (${sizeWords(
          counts.messages.bytes + counts.files.bytes,
        )})`;
  const whose = oneContact ? ' with this contact' : '';
  const about = counts.truncated === true ? 'about ' : '';
  return `Proposed cleanup, nothing is deleted yet: ${about}${what} older than ${String(days)} days${whose}, on this computer only.`;
}

const NEVER_FETCH = 'Never open or fetch this link yourself. ';
const CANT = "Tell the user: you can't delete anything yourself; ";
const AFTER =
  ' They confirm it themselves and can undo it for 10 seconds. There is nothing to check or call again.';

/** The nextStep with the app link (the url is checked by the caller). */
export function tidyLinkNextStep(url: string): string {
  return `${NEVER_FETCH}${CANT}they review this cleanup in the AgentLink app at ${url}.${AFTER}`;
}

/** The nextStep without a link: fixed words to the page. */
export const TIDY_NEXT_STEP = `${CANT}they review this cleanup in the AgentLink app, in Settings, Storage, Free up space.${AFTER}`;

/** A fresh ID for this proposal (`apr_` + 16 random bytes; no approval row is written). */
const proposalId = (): string => `apr_${encodeBase64url(randomBytes(16))}`;

interface TidyInput {
  readonly olderThanDays: number;
  readonly kinds: TidyKinds;
  readonly contact?: string;
}

/** The validated input (the registry schema checked it already; checked again here). */
function checkInput(input: unknown): TidyInput | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const o = input as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (key !== 'olderThanDays' && key !== 'kinds' && key !== 'contact') return undefined;
  }
  const days = o['olderThanDays'];
  const kinds = o['kinds'];
  const contact = o['contact'];
  if (typeof days !== 'number' || !TIDY_DAYS.includes(days)) return undefined;
  if (typeof kinds !== 'string' || !(TIDY_KINDS as readonly string[]).includes(kinds)) {
    return undefined;
  }
  if (contact !== undefined && typeof contact !== 'string') return undefined;
  return {
    olderThanDays: days,
    kinds: kinds as TidyKinds,
    ...(contact === undefined ? {} : { contact }),
  };
}

/** The origin of a tidy link, when it is exactly the local UI origin plus `page`. */
function linkOrigin(link: AllowFolderLink | undefined, page: string): string | undefined {
  if (link === undefined || typeof link.url !== 'string' || typeof link.origin !== 'string') {
    return undefined;
  }
  const port = UI_ORIGIN.exec(link.origin)?.[1];
  if (port === undefined || Number(port) > 65_535) return undefined;
  return link.url === `${link.origin}${page}` ? link.origin : undefined;
}

/**
 * One `agentlink_tidy` call: the result and the origins its `url` may use (the context's plus the
 * local UI origin of a checked link). Never throws for a bad link: it answers without one.
 */
export async function runTidy(
  input: unknown,
  context: ToolContext,
): Promise<{ readonly output: HandlerOutput; readonly origins: readonly string[] }> {
  const unchanged = (output: HandlerOutput) => ({ output, origins: context.urlOrigins });
  const checked = checkInput(input);
  const preview = context.client.tidyPreview?.bind(context.client);
  if (checked === undefined || preview === undefined) return unchanged(notAvailable());
  let contactId: string | undefined;
  if (checked.contact !== undefined) {
    const resolved = resolveContact(checked.contact, await context.client.contacts());
    if (!resolved.ok) return unchanged(resolved.output);
    contactId = resolved.contact.id;
  }
  const include = checked.kinds === 'files' ? 'files' : 'both';
  const before = Math.max(0, context.clock() - checked.olderThanDays * DAY_SECONDS);
  const raw = await preview({
    before,
    include,
    ...(contactId === undefined ? {} : { contactId }),
  });
  const n = (v: unknown): number =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0;
  const counts: TidyCounts = {
    // Files only: the messages stay, so none are counted.
    messages:
      include === 'files'
        ? { count: 0, bytes: 0 }
        : { count: n(raw.messages.count), bytes: n(raw.messages.bytes) },
    files: { count: n(raw.files.count), bytes: n(raw.files.bytes) },
    // Files only: no message would go, so none is "kept" (IR-RET-67-1 Low 5).
    kept: include === 'files' ? 0 : n(raw.kept),
    truncated: raw.truncated === true,
  };
  const result = {
    status: 'pending_approval' as const,
    summary: tidySummary(counts, checked.kinds, checked.olderThanDays, contactId !== undefined),
    approvalId: proposalId(),
    nextStep: TIDY_NEXT_STEP,
    proposal: {
      olderThanDays: checked.olderThanDays,
      kinds: checked.kinds,
      messages: counts.messages,
      files: counts.files,
      kept: counts.kept,
    },
  };
  const plain: HandlerOutput = { result };
  if (context.tidyLink === undefined) return unchanged(plain);
  const page = tidyPage({
    olderThanDays: checked.olderThanDays,
    kinds: checked.kinds,
    ...(contactId === undefined ? {} : { contactId }),
  });
  if (page === undefined || !TIDY_PAGE_PATTERN.test(page)) return unchanged(plain);
  let link: AllowFolderLink | undefined;
  try {
    link = await context.tidyLink(page);
  } catch {
    // The error could carry a value (I-7): never logged or returned.
    return unchanged(plain);
  }
  const origin = linkOrigin(link, page);
  if (origin === undefined || link === undefined) return unchanged(plain);
  const linked: HandlerOutput = {
    result: { ...result, url: link.url, nextStep: tidyLinkNextStep(link.url) },
  };
  const origins = [...context.urlOrigins, origin];
  return resultIsValid(linked.result, origins) ? { output: linked, origins } : unchanged(plain);
}

/** The handler (HANDLERS): the result without the link step's origins (callTool uses runTidy). */
export async function tidyHandler(input: unknown, context: ToolContext): Promise<HandlerOutput> {
  return (await runTidy(input, context)).output;
}
