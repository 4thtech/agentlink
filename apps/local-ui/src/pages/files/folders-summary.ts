// What Home's Files panel and Settings › Files show about the two folders (D-152; 08 §1 "Home Files
// panel"; FILES-HOME-PANEL, FILES-SETTINGS-COPY). Reads only (GET), signs nothing:
//
// - Send: from `GET /api/ui/files` (the rules' folder list, each with its real location when found):
//   the ID's own Send folder is `~/AgentLink/Send` or `Send-2` ... `Send-9` (never another allowed
//   folder). `allowed` when listed and found, `not_found` when listed but missing, `not_allowed`
//   when none of them is listed.
// - Inbox: the folder of the received page's `autoSave` block (home shown as `~`).
// - "{n} new": the received files saved since the person last opened Files; a count only, never a
//   name (I-5). The time is remembered in `localStorage` under try/catch and works without it.
// Every value is read through an allowlist; paths are the owner's own two folders shown as text.
import { LIST_PATH, parseList } from './data.js';
import type { Answer } from './files-api.js';
import { RECEIVED_PATH, SENT_PATH, listPath, parseInboxFolder, parseReceived } from './io-api.js';

export type Getter = (path: string) => Promise<Answer>;

export type SendState = 'allowed' | 'not_allowed' | 'not_found';

export interface FilesSummary {
  readonly send: { readonly state: SendState; readonly folder: string | undefined };
  /** The Inbox folder with home as `~`; undefined when it can't be read. */
  readonly inbox: string | undefined;
  /** Saved files that arrived since Files was last opened. */
  readonly newCount: number;
  /** Nothing was ever sent or received. */
  readonly empty: boolean;
}

export type SummaryResult =
  | { readonly kind: 'ok'; readonly summary: FilesSummary }
  | { readonly kind: 'not_set_up' }
  | { readonly kind: 'error' };

/** The ID's own Send folder in the rules' words (08 §1; send-folder-file.ts candidates). */
const SEND_FOLDER = /^~\/AgentLink\/Send(?:-[2-9])?$/;

/** localStorage key: Unix seconds when Files was last opened (a convenience; never required). */
export const FILES_SEEN_KEY = 'agentlink.files.seen';

export function readSeen(): number {
  try {
    const raw = globalThis.localStorage?.getItem(FILES_SEEN_KEY);
    const n = raw === null || raw === undefined ? 0 : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function markSeen(nowSeconds: number = Math.floor(Date.now() / 1000)): void {
  try {
    globalThis.localStorage?.setItem(FILES_SEEN_KEY, String(nowSeconds));
  } catch {
    // Without storage, "new" counts everything on the first page.
  }
}

export async function loadFilesSummary(
  get: Getter,
  seen: number = readSeen(),
): Promise<SummaryResult> {
  const [folders, received, sent] = await Promise.all([
    get(LIST_PATH),
    get(listPath(RECEIVED_PATH, null)),
    get(listPath(SENT_PATH, null)),
  ]);
  if (folders.kind === 'offline') return { kind: 'error' };
  if (folders.status === 409) return { kind: 'not_set_up' };
  const list = folders.status === 200 ? parseList(folders.json) : undefined;
  if (list === undefined) return { kind: 'error' };

  const row = list.folders.find((r) => SEND_FOLDER.test(r.path));
  const send: FilesSummary['send'] =
    row === undefined
      ? { state: 'not_allowed', folder: undefined }
      : { state: row.resolved === null ? 'not_found' : 'allowed', folder: row.path };

  let inbox: string | undefined;
  let newCount = 0;
  let receivedCount = 0;
  if (received.kind === 'answer' && received.status === 200) {
    inbox = parseInboxFolder(received.json);
    const feed = parseReceived(received.json);
    if (feed !== undefined) {
      receivedCount = feed.items.length;
      newCount = feed.items.filter((i) => i.state === 'saved' && i.at > seen).length;
    }
  }
  const sentFeed = sent.kind === 'answer' && sent.status === 200 ? readCount(sent.json) : undefined;
  return {
    kind: 'ok',
    summary: {
      send,
      inbox,
      newCount,
      empty: receivedCount === 0 && (sentFeed ?? 0) === 0,
    },
  };
}

function readCount(json: unknown): number | undefined {
  const items = (json as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? items.length : undefined;
}
