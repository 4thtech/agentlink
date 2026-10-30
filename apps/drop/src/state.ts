// The drop's Durable Object (07 §5.4 State, 08 §6): quota, nonce and rate counters, and the state of
// each object. One class, five kinds of instance, each named by the Worker:
//   `k:<drop key hex>`  nonces seen, signed-request and upload rates, rolling 7-day quota;
//   `i:<HMAC of the IP bucket>`  signed-request ceiling, reports and fresh-key admissions per IP
//     (IPv6 /64);
//   `global`  the global cap only (upload grants touch it, nothing else does);
//   `metrics:<0..7>`  shards of the aggregate counters (the only metrics the drop keeps);
//   `o:<object id>`  one object: owner key, size, expiry, part states, downloads;
//   `inv:<hex of the 16 lookupId bytes>`  one short-invite object (W4-SHORT-INVITE, D-139): owner
//     key, size, expiry, downloads;
//   `invite-fetches`  the global ceiling on unauthenticated invite fetches only.
// No account, file name, recipient or raw IP is stored. Every instance deletes its own storage when
// it is no longer needed (alarm), so key and IP counters do not outlive their windows.
import { DurableObject } from 'cloudflare:workers';
import type { Limits } from './config.js';

const HOUR = 3600;
const DAY = 86_400;
/** Nonces are kept well beyond the ±60 s signature window. */
const NONCE_RETENTION = 600;
/** A key's counters are deleted after 8 days without a request (the quota window is 7). */
const KEY_IDLE = 8 * DAY;
/** An IP's counters are deleted 25 hours after its last upload (the longest window is 24 h). */
const IP_IDLE = 25 * HOUR;
/** An expired object's tombstone is kept a day, so a late GET still reads `expired`. */
const TOMBSTONE = DAY;
/** A commit must start within a minute of the PUT targets' expiry. */
const COMMIT_WINDOW = 60;
/** How long a started commit may take before the upload counts as abandoned. */
const COMMIT_GRACE = HOUR;

/** The aggregate counters, a fixed set of names: never an ID, key, URL or IP (I-7). */
export const METRICS = [
  'upload_granted',
  'upload_refused',
  'put_stored',
  'put_refused',
  'commit_ok',
  'commit_mismatch',
  'download',
  'download_refused',
  'delete',
  'report',
  'unauthorized',
  'replayed',
  'rate_limited',
  'limit_refused',
  'unavailable',
  'bad_request',
  'internal_error',
  'invite_upload',
  'invite_refused',
  'invite_download',
  'invite_not_found',
  'invite_delete',
  'invite_report',
] as const;
export type Metric = (typeof METRICS)[number];

export type Refusal =
  | { readonly ok: false; readonly error: 'replayed' | 'quota' }
  | {
      readonly ok: false;
      readonly error: 'rate_limited' | 'unavailable';
      readonly retryAfter: number;
    };

export type ObjectRefusal = {
  readonly ok: false;
  readonly error: 'not_found' | 'forbidden' | 'conflict' | 'expired' | 'length_mismatch' | 'limit';
};

/** [window index, count] for a fixed-window counter. */
type Window = [number, number];

interface KeyState {
  readonly role: 'key';
  nonces: Record<string, number>;
  admitted: boolean;
  requests: Window;
  uploads: Window;
  /** Day index -> bytes reserved that day (the last 7 days). */
  days: Record<string, number>;
  lastSeen: number;
  /** Invite uploads this hour (W4-SHORT-INVITE). Optional: older stored states lack them. */
  inviteHour?: Window;
  /** Hour index -> invite uploads that hour (the last 24 hours). */
  inviteHours?: Record<string, number>;
  /** Invite objects of this key that are still live (not deleted, expired, reported or used up). */
  inviteLive?: number;
}

interface IpState {
  readonly role: 'ip';
  /** Minute index -> signed requests from this IP that minute (the last 60; the absolute ceiling). */
  requests: Record<string, number>;
  reports: Window;
  /** Hour index -> fresh keys admitted that hour (the last 24 hours). */
  newKeys: Record<string, number>;
  /** Minute index -> invite fetches from this IP that minute (the last 60). Optional, as above. */
  inviteFetches?: Record<string, number>;
  lastSeen: number;
}

interface GlobalState {
  readonly role: 'global';
  uploads: Window;
  /** Hour index -> bytes granted that hour (the last 24 hours). */
  bytes: Record<string, number>;
}

interface InviteGlobalState {
  readonly role: 'inviteGlobal';
  fetches: Window;
}

interface InviteState {
  readonly role: 'invite';
  readonly r2Key: string;
  readonly owner: string;
  readonly size: number;
  readonly expiresAt: number;
  /** `live` until the download limit is used up; `used` until the alarm deletes the bytes. */
  status: 'live' | 'used';
  downloads: number;
}

/** After the last allowed download, the bytes are deleted this long later (the read can finish). */
const USED_UP_GRACE = 60;

interface MetricsState {
  readonly role: 'metrics';
  counts: Record<string, number>;
}

interface PartState {
  readonly size: number;
  status: 'open' | 'uploading' | 'done' | 'failed';
  etag?: string;
}

export interface NewObject {
  readonly r2Key: string;
  readonly owner: string;
  readonly size: number;
  readonly expiresAt: number;
  readonly putExpiresAt: number;
  readonly partSizes: readonly number[];
  readonly multipart: boolean;
  readonly uploadId?: string;
}

interface ObjectState {
  readonly role: 'object';
  readonly r2Key: string;
  readonly owner: string;
  readonly size: number;
  readonly expiresAt: number;
  readonly putExpiresAt: number;
  readonly multipart: boolean;
  readonly uploadId?: string;
  parts: PartState[];
  status: 'uploading' | 'committing' | 'committed' | 'expired';
  downloads: number;
}

type State =
  KeyState | IpState | GlobalState | InviteGlobalState | MetricsState | ObjectState | InviteState;

interface Env {
  readonly DROP_BUCKET: R2Bucket;
  readonly DROP_STATE: DurableObjectNamespace<DropState>;
}

function tick(window: Window, index: number): Window {
  return window[0] === index ? window : [index, 0];
}

function sumRecent(record: Record<string, number>, oldest: number): number {
  let total = 0;
  for (const [index, value] of Object.entries(record)) {
    if (Number(index) < oldest) delete record[index];
    else total += value;
  }
  return total;
}

export class DropState extends DurableObject<Env> {
  private async load<T extends State>(role: T['role']): Promise<T | undefined> {
    const state = await this.ctx.storage.get<State>('state');
    return state?.role === role ? (state as T) : undefined;
  }

  private async save(state: State, alarmAt?: number): Promise<void> {
    await this.ctx.storage.put('state', state);
    if (alarmAt !== undefined) await this.ctx.storage.setAlarm(alarmAt * 1000);
  }

  // --- drop key ---------------------------------------------------------------------------------

  /**
   * Records `nonce` (a replay is refused), counts one signed request and, for an upload, one upload
   * and `size` bytes against the rolling 7-day quota. `known` is true when the key had been admitted
   * before this request (it then skips the per-IP fresh-key limit).
   */
  async keyRequest(input: {
    nonce: string;
    now: number;
    limits: Limits;
    uploadSize?: number;
    /** An invite upload of this many bytes (W4-SHORT-INVITE): the invite limits and the quota. */
    inviteSize?: number;
  }): Promise<{ ok: true; known: boolean } | Refusal> {
    const { nonce, now, limits, uploadSize, inviteSize } = input;
    const s: KeyState = (await this.load<KeyState>('key')) ?? {
      role: 'key',
      nonces: {},
      admitted: false,
      requests: [0, 0],
      uploads: [0, 0],
      days: {},
      lastSeen: now,
    };
    for (const [seen, at] of Object.entries(s.nonces)) {
      if (at < now - NONCE_RETENTION) delete s.nonces[seen];
    }
    if (Object.hasOwn(s.nonces, nonce)) return { ok: false, error: 'replayed' };
    s.nonces[nonce] = now;
    s.lastSeen = now;
    const hour = Math.floor(now / HOUR);
    const retryAfter = (hour + 1) * HOUR - now;
    s.requests = tick(s.requests, hour);
    if (s.requests[1] >= limits.keyRequestsPerHour) {
      await this.save(s, now + KEY_IDLE);
      return { ok: false, error: 'rate_limited', retryAfter };
    }
    s.requests[1] += 1;
    const known = s.admitted;
    if (uploadSize !== undefined) {
      s.uploads = tick(s.uploads, hour);
      if (s.uploads[1] >= limits.keyUploadsPerHour) {
        await this.save(s, now + KEY_IDLE);
        return { ok: false, error: 'rate_limited', retryAfter };
      }
      const day = Math.floor(now / DAY);
      const used = sumRecent(s.days, day - 6);
      if (used + uploadSize > limits.weeklyQuota) {
        await this.save(s, now + KEY_IDLE);
        return { ok: false, error: 'quota' };
      }
      s.days[String(day)] = (s.days[String(day)] ?? 0) + uploadSize;
      s.uploads[1] += 1;
      s.admitted = true;
    } else if (inviteSize !== undefined) {
      const refusal = this.takeInvite(s, now, limits, inviteSize);
      if (refusal !== null) {
        await this.save(s, now + KEY_IDLE);
        return refusal;
      }
    }
    await this.save(s, now + KEY_IDLE);
    return { ok: true, known };
  }

  /**
   * The per-key invite limits (07 §5.4 Limits, "Invite objects"): uploads per hour and per rolling
   * 24 hours, live objects, and the weekly quota the invite counts toward. All are checked before
   * any is taken, so a refusal takes nothing.
   */
  private takeInvite(s: KeyState, now: number, limits: Limits, size: number): Refusal | null {
    const hour = Math.floor(now / HOUR);
    s.inviteHour = tick(s.inviteHour ?? [0, 0], hour);
    s.inviteHours ??= {};
    s.inviteLive ??= 0;
    if (s.inviteHour[1] >= limits.inviteKeyUploadsPerHour) {
      return { ok: false, error: 'rate_limited', retryAfter: (hour + 1) * HOUR - now };
    }
    if (sumRecent(s.inviteHours, hour - 23) >= limits.inviteKeyUploadsPerDay) {
      const oldest = Math.min(...Object.keys(s.inviteHours).map(Number));
      return {
        ok: false,
        error: 'rate_limited',
        retryAfter: Math.max(1, (oldest + 24) * HOUR - now),
      };
    }
    if (s.inviteLive >= limits.inviteKeyLive) {
      // A slot frees when one of the key's invites is deleted, reported, expires or is used up.
      return { ok: false, error: 'rate_limited', retryAfter: HOUR };
    }
    const day = Math.floor(now / DAY);
    if (sumRecent(s.days, day - 6) + size > limits.weeklyQuota)
      return { ok: false, error: 'quota' };
    s.days[String(day)] = (s.days[String(day)] ?? 0) + size;
    s.inviteHour[1] += 1;
    s.inviteHours[String(hour)] = (s.inviteHours[String(hour)] ?? 0) + 1;
    s.inviteLive += 1;
    s.admitted = true;
    return null;
  }

  /** Undoes the invite part of keyRequest (a later check refused the invite upload). */
  async keyInviteRefund(input: { now: number; size: number; known: boolean }): Promise<void> {
    const s = await this.load<KeyState>('key');
    if (!s) return;
    const day = String(Math.floor(input.now / DAY));
    const hour = Math.floor(input.now / HOUR);
    s.days[day] = Math.max(0, (s.days[day] ?? 0) - input.size);
    if (s.inviteHour?.[0] === hour) s.inviteHour[1] = Math.max(0, s.inviteHour[1] - 1);
    if (s.inviteHours) {
      s.inviteHours[String(hour)] = Math.max(0, (s.inviteHours[String(hour)] ?? 0) - 1);
    }
    s.inviteLive = Math.max(0, (s.inviteLive ?? 0) - 1);
    if (!input.known) s.admitted = false;
    await this.save(s);
  }

  /** One of this key's invite objects is gone (deleted, reported, expired or used up). */
  async keyInviteReleased(): Promise<void> {
    const s = await this.load<KeyState>('key');
    if (!s) return;
    s.inviteLive = Math.max(0, (s.inviteLive ?? 0) - 1);
    await this.save(s);
  }

  /** Undoes the upload part of keyRequest (a later check refused the upload). */
  async keyRefund(input: { now: number; size: number; known: boolean }): Promise<void> {
    const s = await this.load<KeyState>('key');
    if (!s) return;
    const day = String(Math.floor(input.now / DAY));
    s.days[day] = Math.max(0, (s.days[day] ?? 0) - input.size);
    if (s.uploads[0] === Math.floor(input.now / HOUR)) s.uploads[1] = Math.max(0, s.uploads[1] - 1);
    if (!input.known) s.admitted = false;
    await this.save(s);
  }

  // --- IP bucket --------------------------------------------------------------------------------

  private async loadIp(now: number): Promise<IpState> {
    return (
      (await this.load<IpState>('ip')) ?? {
        role: 'ip',
        requests: {},
        reports: [0, 0],
        newKeys: {},
        lastSeen: now,
      }
    );
  }

  /**
   * Counts one signed request (upload, commit, DELETE) from this IP against the absolute per-IP
   * ceiling. Runs before any drop key's state is touched. The ceiling is generous: it is an abuse
   * backstop, not the limit that shares an address fairly (that is the fresh-key admission below).
   */
  async ipRequest(input: { now: number; limits: Limits }): Promise<{ ok: true } | Refusal> {
    const { now, limits } = input;
    const s = await this.loadIp(now);
    // Rolling hour in one-minute buckets: no window edge where twice the ceiling gets through.
    const minute = Math.floor(now / 60);
    const recent = sumRecent(s.requests, minute - 59);
    if (recent >= limits.ipRequestsPerHour) {
      const oldest = Math.min(...Object.keys(s.requests).map(Number));
      return {
        ok: false,
        error: 'rate_limited',
        retryAfter: Math.max(1, (oldest + 60) * 60 - now),
      };
    }
    s.requests[String(minute)] = (s.requests[String(minute)] ?? 0) + 1;
    s.lastSeen = now;
    await this.save(s, now + IP_IDLE);
    return { ok: true };
  }

  /**
   * Admits a drop key that has never been admitted before (its first upload) from this IP, at most
   * `ipNewKeysPerDay` in any rolling 24 hours. A key admitted before never comes here, so users
   * behind a shared address keep working with their own keys when new keys are limited.
   */
  async ipAdmitFreshKey(input: { now: number; limits: Limits }): Promise<{ ok: true } | Refusal> {
    const { now, limits } = input;
    const s = await this.loadIp(now);
    const hour = Math.floor(now / HOUR);
    const admitted = sumRecent(s.newKeys, hour - 23);
    if (admitted >= limits.ipNewKeysPerDay) {
      const oldest = Math.min(...Object.keys(s.newKeys).map(Number));
      await this.save(s, now + IP_IDLE);
      return {
        ok: false,
        error: 'rate_limited',
        retryAfter: Math.max(1, (oldest + 24) * HOUR - now),
      };
    }
    s.newKeys[String(hour)] = (s.newKeys[String(hour)] ?? 0) + 1;
    s.lastSeen = now;
    await this.save(s, now + IP_IDLE);
    return { ok: true };
  }

  /** Undoes ipAdmitFreshKey (a later check refused the upload). */
  async ipUnadmitFreshKey(input: { now: number }): Promise<void> {
    const s = await this.load<IpState>('ip');
    if (!s) return;
    const hour = String(Math.floor(input.now / HOUR));
    s.newKeys[hour] = Math.max(0, (s.newKeys[hour] ?? 0) - 1);
    await this.save(s);
  }

  /**
   * Counts one unauthenticated invite fetch from this IP, 404s included, in a rolling hour. Runs
   * before any invite object is looked up.
   */
  async ipInviteFetch(input: { now: number; limits: Limits }): Promise<{ ok: true } | Refusal> {
    const { now, limits } = input;
    const s = await this.loadIp(now);
    s.inviteFetches ??= {};
    const minute = Math.floor(now / 60);
    if (sumRecent(s.inviteFetches, minute - 59) >= limits.inviteIpFetchesPerHour) {
      const oldest = Math.min(...Object.keys(s.inviteFetches).map(Number));
      return {
        ok: false,
        error: 'rate_limited',
        retryAfter: Math.max(1, (oldest + 60) * 60 - now),
      };
    }
    s.inviteFetches[String(minute)] = (s.inviteFetches[String(minute)] ?? 0) + 1;
    s.lastSeen = now;
    await this.save(s, now + IP_IDLE);
    return { ok: true };
  }

  /** Counts one abuse report from this IP. */
  async ipReport(input: { now: number; limits: Limits }): Promise<{ ok: true } | Refusal> {
    const { now, limits } = input;
    const s = await this.loadIp(now);
    const hour = Math.floor(now / HOUR);
    s.reports = tick(s.reports, hour);
    if (s.reports[1] >= limits.ipReportsPerHour) {
      return { ok: false, error: 'rate_limited', retryAfter: (hour + 1) * HOUR - now };
    }
    s.reports[1] += 1;
    s.lastSeen = now;
    await this.save(s, now + IP_IDLE);
    return { ok: true };
  }

  // --- global cap and counters ------------------------------------------------------------------

  private async loadGlobal(): Promise<GlobalState> {
    return (
      (await this.load<GlobalState>('global')) ?? {
        role: 'global',
        uploads: [0, 0],
        bytes: {},
      }
    );
  }

  /** Reserves `size` bytes and one upload under the global cap; refuses with `unavailable`. */
  async globalReserve(input: {
    now: number;
    size: number;
    limits: Limits;
  }): Promise<{ ok: true } | Refusal> {
    const { now, size, limits } = input;
    const s = await this.loadGlobal();
    const hour = Math.floor(now / HOUR);
    s.uploads = tick(s.uploads, hour);
    const granted = sumRecent(s.bytes, hour - 23);
    if (s.uploads[1] >= limits.globalUploadsPerHour || granted + size > limits.globalBytesPerDay) {
      await this.save(s);
      return { ok: false, error: 'unavailable', retryAfter: (hour + 1) * HOUR - now };
    }
    s.uploads[1] += 1;
    s.bytes[String(hour)] = (s.bytes[String(hour)] ?? 0) + size;
    await this.save(s);
    return { ok: true };
  }

  /** Undoes globalReserve. */
  async globalRefund(input: { now: number; size: number }): Promise<void> {
    const s = await this.loadGlobal();
    const hour = Math.floor(input.now / HOUR);
    if (s.uploads[0] === hour) s.uploads[1] = Math.max(0, s.uploads[1] - 1);
    s.bytes[String(hour)] = Math.max(0, (s.bytes[String(hour)] ?? 0) - input.size);
    await this.save(s);
  }

  /** Counts one invite fetch under the global ceiling (`invite-fetches`); refuses `unavailable`. */
  async inviteFetchReserve(input: {
    now: number;
    limits: Limits;
  }): Promise<{ ok: true } | Refusal> {
    const { now, limits } = input;
    const s: InviteGlobalState = (await this.load<InviteGlobalState>('inviteGlobal')) ?? {
      role: 'inviteGlobal',
      fetches: [0, 0],
    };
    const hour = Math.floor(now / HOUR);
    s.fetches = tick(s.fetches, hour);
    if (s.fetches[1] >= limits.inviteFetchesPerHour) {
      await this.save(s);
      return { ok: false, error: 'unavailable', retryAfter: (hour + 1) * HOUR - now };
    }
    s.fetches[1] += 1;
    await this.save(s);
    return { ok: true };
  }

  // --- aggregate counters (sharded: `metrics:<n>`, never the `global` instance) -------------------

  /** Adds the given counts to this shard's counters. Unknown names and bad counts are ignored. */
  async bump(counts: Partial<Record<Metric, number>>): Promise<void> {
    const s: MetricsState = (await this.load<MetricsState>('metrics')) ?? {
      role: 'metrics',
      counts: {},
    };
    for (const [name, count] of Object.entries(counts)) {
      if (!(METRICS as readonly string[]).includes(name)) continue;
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0) continue;
      s.counts[name] = (s.counts[name] ?? 0) + count;
    }
    await this.save(s);
  }

  /** This shard's counters (internal: never served by the health endpoint). */
  async metrics(): Promise<Record<string, number>> {
    return { ...((await this.load<MetricsState>('metrics'))?.counts ?? {}) };
  }

  // --- one object -------------------------------------------------------------------------------

  async objCreate(input: NewObject): Promise<void> {
    const s: ObjectState = {
      role: 'object',
      r2Key: input.r2Key,
      owner: input.owner,
      size: input.size,
      expiresAt: input.expiresAt,
      putExpiresAt: input.putExpiresAt,
      multipart: input.multipart,
      ...(input.uploadId === undefined ? {} : { uploadId: input.uploadId }),
      parts: input.partSizes.map((size) => ({ size, status: 'open' })),
      status: 'uploading',
      downloads: 0,
    };
    await this.save(s, input.putExpiresAt + COMMIT_WINDOW);
  }

  private partOf(s: ObjectState, part: number): PartState | undefined {
    const index = s.multipart ? part - 1 : part;
    if (s.multipart ? part < 1 : part !== 0) return undefined;
    return s.parts[index];
  }

  /** Claims a PUT target: single use, before its expiry, for exactly the declared part size. */
  async objBeginPut(input: {
    part: number;
    contentLength: number;
    now: number;
  }): Promise<{ ok: true; r2Key: string; multipart: boolean; uploadId?: string } | ObjectRefusal> {
    const s = await this.load<ObjectState>('object');
    if (!s) return { ok: false, error: 'not_found' };
    const target = this.partOf(s, input.part);
    if (!target) return { ok: false, error: 'not_found' };
    if (s.status !== 'uploading' || target.status !== 'open')
      return { ok: false, error: 'conflict' };
    if (input.now >= s.putExpiresAt) return { ok: false, error: 'expired' };
    if (input.contentLength !== target.size) return { ok: false, error: 'length_mismatch' };
    target.status = 'uploading';
    await this.save(s);
    return {
      ok: true,
      r2Key: s.r2Key,
      multipart: s.multipart,
      ...(s.uploadId === undefined ? {} : { uploadId: s.uploadId }),
    };
  }

  /** Records the outcome of a claimed PUT. A failed part leaves the object uncommittable. */
  async objFinishPut(input: { part: number; etag: string | null }): Promise<void> {
    const s = await this.load<ObjectState>('object');
    if (!s) return;
    const target = this.partOf(s, input.part);
    if (!target || target.status !== 'uploading') return;
    if (input.etag === null) {
      target.status = 'failed';
    } else {
      target.status = 'done';
      target.etag = input.etag;
    }
    await this.save(s);
  }

  /** Starts the commit: the uploading key only, once, after every part is stored. */
  async objBeginCommit(input: { owner: string; now: number }): Promise<
    | {
        ok: true;
        r2Key: string;
        size: number;
        expiresAt: number;
        multipart: boolean;
        uploadId?: string;
        parts: { partNumber: number; etag: string }[];
      }
    | ObjectRefusal
  > {
    const s = await this.load<ObjectState>('object');
    if (!s) return { ok: false, error: 'not_found' };
    if (s.owner !== input.owner) return { ok: false, error: 'forbidden' };
    if (s.status !== 'uploading') return { ok: false, error: 'conflict' };
    if (input.now >= s.expiresAt || input.now >= s.putExpiresAt + COMMIT_WINDOW) {
      return { ok: false, error: 'expired' };
    }
    if (s.parts.some((part) => part.status !== 'done')) return { ok: false, error: 'conflict' };
    s.status = 'committing';
    await this.save(s);
    return {
      ok: true,
      r2Key: s.r2Key,
      size: s.size,
      expiresAt: s.expiresAt,
      multipart: s.multipart,
      ...(s.uploadId === undefined ? {} : { uploadId: s.uploadId }),
      parts: s.parts.map((part, i) => ({ partNumber: i + 1, etag: part.etag ?? '' })),
    };
  }

  /** Finishes the commit: readable until expiry, or forgotten entirely (the bytes are deleted). */
  async objFinishCommit(input: { ok: boolean }): Promise<void> {
    const s = await this.load<ObjectState>('object');
    if (!s || s.status !== 'committing') return;
    if (!input.ok) {
      await this.ctx.storage.deleteAll();
      await this.ctx.storage.deleteAlarm();
      return;
    }
    s.status = 'committed';
    await this.save(s, s.expiresAt);
  }

  /** Counts one download: committed objects only, before expiry, up to the download limit. */
  async objDownload(input: {
    now: number;
    limit: number;
  }): Promise<{ ok: true; r2Key: string } | ObjectRefusal> {
    const s = await this.load<ObjectState>('object');
    if (!s) return { ok: false, error: 'not_found' };
    if (s.status === 'expired' || input.now >= s.expiresAt) return { ok: false, error: 'expired' };
    if (s.status !== 'committed') return { ok: false, error: 'not_found' };
    if (s.downloads >= input.limit) return { ok: false, error: 'limit' };
    s.downloads += 1;
    await this.save(s);
    return { ok: true, r2Key: s.r2Key };
  }

  /**
   * Forgets the object and returns what the Worker must delete from R2. `owner` must be the
   * uploading key; null is the abuse-report path, which needs no key.
   */
  async objDelete(input: {
    owner: string | null;
  }): Promise<
    | { ok: true; r2Key: string; multipart: boolean; uploadId?: string; committed: boolean }
    | ObjectRefusal
  > {
    const s = await this.load<ObjectState>('object');
    if (!s || s.status === 'expired') return { ok: false, error: 'not_found' };
    if (input.owner !== null && s.owner !== input.owner) return { ok: false, error: 'forbidden' };
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
    return {
      ok: true,
      r2Key: s.r2Key,
      multipart: s.multipart,
      ...(s.uploadId === undefined ? {} : { uploadId: s.uploadId }),
      committed: s.status === 'committed',
    };
  }

  // --- one short-invite object (W4-SHORT-INVITE) ------------------------------------------------

  /**
   * Claims this lookupId for a new invite object. Refuses `conflict` when anything exists under it,
   * so an object is never overwritten. The alarm deletes it at its hard expiry.
   */
  async invCreate(input: {
    r2Key: string;
    owner: string;
    size: number;
    expiresAt: number;
  }): Promise<{ ok: true } | ObjectRefusal> {
    if ((await this.ctx.storage.get<State>('state')) !== undefined) {
      return { ok: false, error: 'conflict' };
    }
    const s: InviteState = {
      role: 'invite',
      r2Key: input.r2Key,
      owner: input.owner,
      size: input.size,
      expiresAt: input.expiresAt,
      status: 'live',
      downloads: 0,
    };
    await this.save(s, input.expiresAt);
    return { ok: true };
  }

  /** Forgets a claim whose bytes could not be stored. */
  async invAbort(): Promise<void> {
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }

  /**
   * Counts one download: live objects only, before expiry, up to the download limit. The download
   * that reaches the limit marks the object used up (`release`: the owner's live count drops) and
   * schedules the bytes' deletion. Every refusal is `not_found` (the uniform 404).
   */
  async invDownload(input: {
    now: number;
    limit: number;
  }): Promise<{ ok: true; release: boolean; owner: string } | ObjectRefusal> {
    const s = await this.load<InviteState>('invite');
    if (!s || s.status !== 'live' || input.now >= s.expiresAt || s.downloads >= input.limit) {
      return { ok: false, error: 'not_found' };
    }
    s.downloads += 1;
    if (s.downloads < input.limit) {
      await this.save(s);
      return { ok: true, release: false, owner: s.owner };
    }
    s.status = 'used';
    await this.save(s, Math.min(input.now + USED_UP_GRACE, s.expiresAt));
    return { ok: true, release: true, owner: s.owner };
  }

  /**
   * Forgets the invite object and returns what the Worker must delete from R2. `owner` must be the
   * uploading key; null is the abuse-report path. `release` is true while the owner's live count
   * still includes it.
   */
  async invDelete(input: {
    owner: string | null;
  }): Promise<{ ok: true; r2Key: string; owner: string; release: boolean } | ObjectRefusal> {
    const s = await this.load<InviteState>('invite');
    if (!s) return { ok: false, error: 'not_found' };
    if (input.owner !== null && s.owner !== input.owner) return { ok: false, error: 'forbidden' };
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
    return { ok: true, r2Key: s.r2Key, owner: s.owner, release: s.status === 'live' };
  }

  private async inviteAlarm(s: InviteState, now: number): Promise<void> {
    if (s.status === 'live' && now < s.expiresAt) {
      await this.ctx.storage.setAlarm(s.expiresAt * 1000);
      return;
    }
    // Hard expiry, or used up: the bytes go, then the object is forgotten (the uniform 404 needs no
    // tombstone). The R2 lifecycle rule is the backstop.
    await this.env.DROP_BUCKET.delete(s.r2Key);
    if (s.status === 'live') {
      const key = this.env.DROP_STATE.get(this.env.DROP_STATE.idFromName(`k:${s.owner}`));
      await key.keyInviteReleased();
    }
    await this.ctx.storage.deleteAll();
  }

  // --- cleanup ----------------------------------------------------------------------------------

  async alarm(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const s = await this.ctx.storage.get<State>('state');
    if (!s) {
      await this.ctx.storage.deleteAll();
      return;
    }
    switch (s.role) {
      case 'key':
        if (now >= s.lastSeen + KEY_IDLE) await this.ctx.storage.deleteAll();
        else await this.ctx.storage.setAlarm((s.lastSeen + KEY_IDLE) * 1000);
        return;
      case 'ip':
        if (now >= s.lastSeen + IP_IDLE) await this.ctx.storage.deleteAll();
        else await this.ctx.storage.setAlarm((s.lastSeen + IP_IDLE) * 1000);
        return;
      case 'global':
      case 'inviteGlobal':
      case 'metrics':
        return;
      case 'invite':
        await this.inviteAlarm(s, now);
        return;
      case 'object':
        await this.objectAlarm(s, now);
        return;
    }
  }

  private async objectAlarm(s: ObjectState, now: number): Promise<void> {
    const bucket = this.env.DROP_BUCKET;
    if (s.status === 'expired') {
      await this.ctx.storage.deleteAll();
      return;
    }
    if (s.status === 'committing' && now < s.putExpiresAt + COMMIT_GRACE) {
      // A commit is hashing the stored bytes: give it time before treating the upload as abandoned.
      await this.ctx.storage.setAlarm((s.putExpiresAt + COMMIT_GRACE) * 1000);
      return;
    }
    if (s.status !== 'committed' && now >= s.putExpiresAt) {
      // Never committed in time: remove whatever was stored and forget the object.
      if (s.multipart && s.uploadId !== undefined) {
        await bucket
          .resumeMultipartUpload(s.r2Key, s.uploadId)
          .abort()
          .catch(() => undefined);
      }
      await bucket.delete(s.r2Key);
      await this.ctx.storage.deleteAll();
      return;
    }
    if (s.status === 'committed' && now >= s.expiresAt) {
      // Hard expiry (the R2 lifecycle rule is the backstop): delete the bytes, keep a tombstone.
      await bucket.delete(s.r2Key);
      s.status = 'expired';
      await this.save(s, now + TOMBSTONE);
      return;
    }
    await this.ctx.storage.setAlarm(
      (s.status === 'committed' ? s.expiresAt : s.putExpiresAt + COMMIT_WINDOW) * 1000,
    );
  }
}
