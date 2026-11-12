// REL051-RET1: the Storage page's read (`GET /api/ui/storage`, node api/storage.ts). Every value is
// checked before use; anything shaped wrong is dropped, never guessed. Sizes only: no delete call
// exists on this page.
export const STORAGE_PATH = '/api/ui/storage';

export interface Sizes {
  readonly messageBytes: number;
  readonly fileCount: number;
  readonly fileBytes: number;
}

export interface PersonUse extends Sizes {
  /** A name another person chose (untrusted text: render as text only). */
  readonly name: string;
}

export interface IdUse extends Sizes {
  readonly name: string;
  readonly label: string;
  readonly current: boolean;
  readonly storeBytes: number;
  readonly walBytes: number;
  readonly drop?: { readonly usedBytes: number; readonly quotaBytes: number };
  /** The open ID only. */
  readonly people?: readonly PersonUse[];
  readonly other?: Sizes;
}

export interface IdUnavailable {
  readonly name: string;
  readonly label: string;
  readonly current: boolean;
  readonly unavailable: true;
}

export interface InboxUse {
  /** The folder as the owner set it, home shown as `~`. */
  readonly folder: string;
  readonly files: number;
  readonly bytes: number;
  readonly truncated: boolean;
}

export interface StorageView {
  readonly ids: readonly (IdUse | IdUnavailable)[];
  readonly inbox: InboxUse | undefined;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const whole = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const text = (v: unknown, max = 128): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max;

function sizes(v: unknown): Sizes | undefined {
  if (!isObject(v)) return undefined;
  const { messageBytes, fileCount, fileBytes } = v;
  if (!whole(messageBytes) || !whole(fileCount) || !whole(fileBytes)) return undefined;
  return { messageBytes, fileCount, fileBytes };
}

function idUse(v: unknown): IdUse | IdUnavailable | undefined {
  if (!isObject(v) || !text(v['name']) || !text(v['label'])) return undefined;
  const head = { name: v['name'], label: v['label'], current: v['current'] === true };
  if (v['status'] !== 'ok') return { ...head, unavailable: true };
  const total = sizes(v);
  const { storeBytes, walBytes } = v;
  if (total === undefined || !whole(storeBytes) || !whole(walBytes)) {
    return { ...head, unavailable: true };
  }
  const people: PersonUse[] = [];
  if (Array.isArray(v['people'])) {
    for (const p of v['people'] as unknown[]) {
      const s = sizes(p);
      const name = isObject(p) ? p['name'] : undefined;
      if (s !== undefined && text(name)) people.push({ ...s, name });
    }
  }
  const other = sizes(v['other']);
  const drop = v['drop'];
  return {
    ...head,
    ...total,
    storeBytes,
    walBytes,
    ...(isObject(drop) && whole(drop['usedBytes']) && whole(drop['quotaBytes'])
      ? { drop: { usedBytes: drop['usedBytes'], quotaBytes: drop['quotaBytes'] } }
      : {}),
    ...(Array.isArray(v['people']) ? { people } : {}),
    ...(other === undefined ? {} : { other }),
  };
}

/** The view of an answer, or undefined when it is not one. */
export function parseStorage(data: unknown): StorageView | undefined {
  if (!isObject(data) || data['status'] !== 'ok' || !Array.isArray(data['ids'])) return undefined;
  const ids: (IdUse | IdUnavailable)[] = [];
  for (const raw of data['ids'] as unknown[]) {
    const one = idUse(raw);
    if (one !== undefined) ids.push(one);
  }
  const i = data['inbox'];
  const inbox: InboxUse | undefined =
    isObject(i) && text(i['folder'], 512) && whole(i['files']) && whole(i['bytes'])
      ? {
          folder: i['folder'],
          files: i['files'],
          bytes: i['bytes'],
          truncated: i['truncated'] === true,
        }
      : undefined;
  return { ids, inbox };
}

/**
 * The Inbox files AgentLink no longer tracks: what the folder holds beyond the saved files the IDs
 * still index (never below zero). Undefined when the folder is not known.
 */
export function unassignedIn(view: StorageView): { files: number; bytes: number } | undefined {
  if (view.inbox === undefined) return undefined;
  let files = 0;
  let bytes = 0;
  for (const id of view.ids) {
    if ('unavailable' in id) continue;
    files += id.fileCount;
    bytes += id.fileBytes;
  }
  return {
    files: Math.max(0, view.inbox.files - files),
    bytes: Math.max(0, view.inbox.bytes - bytes),
  };
}

/** Bytes as people read them (the way the computer's own file manager counts: 1 KB = 1000 bytes). */
export function sizeWords(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1000) return `${String(bytes)} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let i = 0;
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000;
    i += 1;
  }
  return `${value.toFixed(1).replace(/\.0$/, '')} ${units[i] as string}`;
}
