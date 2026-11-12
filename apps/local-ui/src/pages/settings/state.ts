// What each Settings row says about where it stands, from reads the app already has (design-1112
// §3.1). Every value is checked before use; a read that fails or is shaped wrong gives nothing and
// the row falls back to plain words. Nothing is invented, and nothing here is a key or address of
// this computer (the Files row shows only the folder name the owner chose).
import type { ApiResult } from '../../api/client.js';
import { HEALTH_PATH, parseHealth } from '../../layout/health.js';
import { parseApps, type AppsList } from '../apps/data.js';
import { parseKitStatus } from '../backup/status.js';
import { setKitRecordState } from '../../states/recovery-kit.js';
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
      /** The covered IDs' names (the record's `covers` entries are `{name, label}`). */
      readonly covers: readonly string[];
      /** The server's word: `out_of_date` when an ID or person joined since the kit was saved. */
      readonly stale: boolean;
      /** UX1113-QA2 N14: saved, but the kit never opened with its code. */
      readonly unfinished?: true;
      readonly missingIds: number;
      readonly missingPeople: number;
    };

/**
 * The kit record from `GET /api/ui/backup` (`{export, record, state, lastKit, missing}`; WP-R2), read
 * through the Backup page's own strict parser so both pages agree. A record the app cannot read
 * (`state: 'unknown'`) gives undefined: the row falls back to plain words and invents nothing.
 */
export function parseBackup(data: unknown): BackupState | undefined {
  const k = parseKitStatus(data);
  if (k.state === 'none') return { kind: 'none' };
  if (k.state === 'unknown' || k.at === undefined) return undefined;
  return {
    kind: 'saved',
    at: k.at,
    covers: k.covers.slice(0, 6),
    stale: k.state === 'out_of_date',
    ...(k.state === 'unfinished' ? { unfinished: true as const } : {}),
    missingIds: k.missingIds.length,
    missingPeople: k.missingPeople,
  };
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
  // WP-R4: the server's record is what the kit reminder (Home, first run) reads from now on.
  if (backup.kind === 'ok') {
    const k = parseKitStatus(backup.data).state;
    setKitRecordState(k === 'unknown' ? undefined : k);
  }
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
    // REL051-CF2: no relay reachable is never "All working".
    else if (h.state === 'not_running' || h.state === 'unreachable') out.health = 'reconnecting';
    if (h.version !== undefined) out.version = h.version;
  }
  return out;
}
