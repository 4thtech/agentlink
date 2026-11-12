// What each Settings row says about where it stands, from reads the app already has (design-1112
// §3.1). Every value is checked before use; a read that fails or is shaped wrong gives nothing and
// the row falls back to plain words. Nothing is invented, and nothing here is a key or address of
// this computer (the Files row shows only the folder name the owner chose).
import type { ApiResult } from '../../api/client.js';
import { HEALTH_PATH, parseHealth } from '../../layout/health.js';
import { parseApps, type AppsList } from '../apps/data.js';
import { LIST_PATH as FILES_PATH, parseList as parseFolders } from '../files/data.js';
import { parseInboxFolder, RECEIVED_PATH } from '../files/io-api.js';
import { CREDITS_PATH, parseCredits, type CreditsAnswer } from '../proofs/data.js';
import { parseRules, RULES_PATH, type RulesView } from '../rules/data.js';

export type Get = (path: string) => Promise<ApiResult<unknown>>;

export const BACKUP_READ = '/api/ui/backup';
export const OWNER_PASSKEY_READ = '/api/owner/passkey';
export const APPS_READ = '/api/ui/apps';

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const okData = (r: ApiResult<unknown>): unknown => (r.kind === 'ok' ? r.data : undefined);

// --- backup -------------------------------------------------------------------------------------

export type BackupState =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'saved';
      /** Milliseconds. */
      readonly at: number;
      readonly covers: readonly string[];
      readonly missingIds: number;
      readonly missingPeople: number;
    };

const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

/**
 * The kit record, when the server sends one (`{lastKit: {at, covers[]} | null, missing: {ids[],
 * people}}`, the Backup page's read). Without a `lastKit` key the app does not know: undefined.
 */
export function parseBackup(data: unknown): BackupState | undefined {
  if (!isObject(data) || !('lastKit' in data)) return undefined;
  const kit = data['lastKit'];
  if (kit === null) return { kind: 'none' };
  if (!isObject(kit)) return undefined;
  const rawAt = kit['at'];
  let at: number | undefined;
  if (typeof rawAt === 'number' && Number.isFinite(rawAt) && rawAt > 0) {
    at = rawAt < 1e11 ? rawAt * 1000 : rawAt;
  } else if (typeof rawAt === 'string' && !Number.isNaN(Date.parse(rawAt))) {
    at = Date.parse(rawAt);
  }
  const covers = kit['covers'];
  if (at === undefined || !Array.isArray(covers)) return undefined;
  const names = covers.filter((n): n is string => typeof n === 'string' && NAME.test(n));
  const missing = isObject(data['missing']) ? data['missing'] : {};
  const ids = Array.isArray(missing['ids']) ? missing['ids'].length : 0;
  const p = missing['people'];
  const people = typeof p === 'number' && Number.isSafeInteger(p) && p >= 0 ? p : 0;
  return { kind: 'saved', at, covers: names.slice(0, 6), missingIds: ids, missingPeople: people };
}

// --- Touch ID ------------------------------------------------------------------------------------

/** True when a passkey is registered for approvals; false when not; undefined when unknown. */
export function parseTouchId(r: ApiResult<unknown>): boolean | undefined {
  if (r.kind !== 'ok' || !isObject(r.data)) return undefined;
  const p = r.data['passkey'];
  return isObject(p) && p['registered'] === true;
}

// --- rules ---------------------------------------------------------------------------------------

/** The things the Rules page lets the owner decide, and how many of them ask first. */
export function askCounts(v: RulesView): { readonly asks: number; readonly total: number } {
  const flags = [
    v.proofs.notarize === 'approval',
    v.commitments.accept === 'approval',
    v.contacts.acceptInvites === 'approval',
    v.proofs.allowKeyDisclosure === 'approval',
  ];
  return { asks: flags.filter(Boolean).length, total: flags.length };
}

// --- all reads -----------------------------------------------------------------------------------

export interface SettingsState {
  readonly backup?: BackupState;
  readonly touchId?: boolean;
  readonly rules?: { readonly asks: number; readonly total: number };
  readonly apps?: AppsList;
  readonly folders?: number;
  readonly inbox?: string;
  readonly credits?: Extract<CreditsAnswer, { kind: 'ok' }>;
  readonly health?: 'working' | 'reconnecting';
  /** The running package's version, from the health read. */
  readonly version?: string;
}

const safe = (get: Get, path: string): Promise<ApiResult<unknown>> =>
  get(path).catch((): ApiResult<unknown> => ({ kind: 'offline' }));

/** Reads everything once; every read is independent and a failure only blanks its own row. */
export async function readSettingsState(get: Get): Promise<SettingsState> {
  const [backup, owner, rules, apps, files, received, credits, health] = await Promise.all([
    safe(get, BACKUP_READ),
    safe(get, OWNER_PASSKEY_READ),
    safe(get, RULES_PATH),
    safe(get, APPS_READ),
    safe(get, FILES_PATH),
    safe(get, `${RECEIVED_PATH}?limit=1`),
    safe(get, CREDITS_PATH),
    safe(get, HEALTH_PATH),
  ]);
  const out: { -readonly [K in keyof SettingsState]: SettingsState[K] } = {};
  const b = parseBackup(okData(backup));
  if (b !== undefined) out.backup = b;
  const t = parseTouchId(owner);
  if (t !== undefined) out.touchId = t;
  const r = parseRules(okData(rules));
  if (r.kind === 'ok') out.rules = askCounts(r.rules);
  const a = parseApps(okData(apps));
  if (a !== undefined) out.apps = a;
  const f = parseFolders(okData(files));
  if (f !== undefined) out.folders = f.folders.length;
  const inbox = parseInboxFolder(okData(received));
  if (inbox !== undefined) out.inbox = inbox;
  const c = parseCredits(okData(credits));
  if (c.kind === 'ok') out.credits = c;
  const h = parseHealth(health);
  if (h !== undefined) {
    if (h.state === 'connected') out.health = 'working';
    else if (h.state === 'not_running') out.health = 'reconnecting';
    if (h.version !== undefined) out.version = h.version;
  }
  return out;
}
