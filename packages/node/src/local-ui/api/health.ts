// M1-11s-a-d: the local UI health read (08 §1; 04 §2.5, §4; I-4, I-5, I-7).
//
// `GET /api/ui/health` tells the app's status bar (and later the Home tiles) whether the agent is
// running. It is a read route (presence: false) behind the server's session cookie, CSRF header and
// fetch-metadata checks, like every /api/ui/ route; it is not an MCP tool and no tool reaches it.
//
// One fixed, allowlisted answer, built field by field (nothing of the source object is passed on):
//   { agent: 'running' | 'paused' | 'not_running' | 'needs_setup',
//     relays: { connected, total } | null,   // counts only: never an address
//     lastSyncAt: number | null,             // unix seconds
//     version: string | null }               // a plain x.y.z[-pre] version
// Never a relay address, key, token, path, agent ID or error text, whatever the source holds.
//
// Cheap and bounded: the source (in-process state the caller already keeps, never a network read
// per request) is asked at most once per HEALTH_CACHE_MS, one read in flight shared by every
// concurrent request, and a read that takes longer than HEALTH_SOURCE_TIMEOUT_MS or throws answers
// `not_running` (fail closed: never "running" without evidence). With no agent set up the answer is
// `needs_setup` and the source is not asked. With no source wired, an opened agent is `running`:
// the agent is open in the process that answers.
import type { JsonObject } from '@4thtech-io/crypto';
import type { LocalUiContext } from '../context.js';
import type { LocalUiReadRoute, LocalUiResult, LocalUiRoute } from '../route-types.js';

/** The agent states the route answers. */
export type LocalUiAgentState = 'running' | 'paused' | 'not_running' | 'needs_setup';

/** What a caller's health source returns (in-process state only; untrusted shape, checked here). */
export interface LocalUiHealthSnapshot {
  readonly agent: 'running' | 'paused' | 'not_running';
  readonly relays?: { readonly connected: number; readonly total: number };
  /** Unix seconds of the last completed sync. */
  readonly lastSyncAt?: number;
}

/** The caller's health source (LocalUiOptions.health). */
export type LocalUiHealthSource = () => LocalUiHealthSnapshot | Promise<LocalUiHealthSnapshot>;

/** The route's answer body. */
export interface LocalUiHealthBody extends JsonObject {
  readonly agent: LocalUiAgentState;
  readonly relays: { readonly connected: number; readonly total: number } | null;
  readonly lastSyncAt: number | null;
  readonly version: string | null;
}

/** The source is asked at most this often; requests in between get the cached answer. */
export const HEALTH_CACHE_MS = 3_000;
/** A source that has not answered by then counts as not running. */
export const HEALTH_SOURCE_TIMEOUT_MS = 1_000;
/** At most this many relays are counted (07 §4.3: a relay list holds at most 32). */
const MAX_RELAYS = 32;
/** A lastSyncAt further ahead than this (clock skew) is dropped. */
const FUTURE_SLACK_SECONDS = 300;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,31})?$/;
const SOURCE_STATES: ReadonlySet<string> = new Set(['running', 'paused', 'not_running']);

const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_RELAYS;

function relaysOf(value: unknown): LocalUiHealthBody['relays'] {
  if (typeof value !== 'object' || value === null) return null;
  const { connected, total } = value as { connected?: unknown; total?: unknown };
  if (!count(connected) || !count(total) || connected > total) return null;
  return Object.freeze({ connected, total });
}

function lastSyncOf(value: unknown, nowMs: number): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return value > Math.floor(nowMs / 1000) + FUTURE_SLACK_SECONDS ? null : value;
}

/** The plain version, or null for anything else. */
export function healthVersion(value: unknown): string | null {
  return typeof value === 'string' && VERSION.test(value) ? value : null;
}

const body = (
  agent: LocalUiAgentState,
  relays: LocalUiHealthBody['relays'] = null,
  lastSyncAt: number | null = null,
  version: string | null = null,
): LocalUiHealthBody => Object.freeze({ agent, relays, lastSyncAt, version });

export interface HealthReaderOptions {
  /** The caller's in-process health state; absent: an opened agent is `running`. */
  readonly source?: LocalUiHealthSource;
  /** Whether an agent is opened (LocalUiOptions.client); false answers `needs_setup`. */
  readonly hasClient: boolean;
  /** The app version (checked; anything but a plain version is null). */
  readonly version?: string;
  /** The clock in milliseconds. */
  readonly now: () => number;
}

/** One bounded, cached, single-flight health read (see the header). Never rejects. */
export function createHealthReader(options: HealthReaderOptions): () => Promise<LocalUiHealthBody> {
  const version = healthVersion(options.version);
  const { source, now } = options;
  let cached: { readonly at: number; readonly value: LocalUiHealthBody } | undefined;
  let inFlight: Promise<LocalUiHealthBody> | undefined;

  const readSource = async (): Promise<LocalUiHealthBody> => {
    if (!options.hasClient) return body('needs_setup', null, null, version);
    if (source === undefined) return body('running', null, null, version);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), HEALTH_SOURCE_TIMEOUT_MS);
      });
      const snapshot: unknown = await Promise.race([
        Promise.resolve().then(() => source()),
        timeout,
      ]);
      if (typeof snapshot !== 'object' || snapshot === null) {
        return body('not_running', null, null, version);
      }
      const { agent, relays, lastSyncAt } = snapshot as Record<string, unknown>;
      if (typeof agent !== 'string' || !SOURCE_STATES.has(agent)) {
        return body('not_running', null, null, version);
      }
      return body(
        agent as LocalUiAgentState,
        relaysOf(relays),
        lastSyncOf(lastSyncAt, now()),
        version,
      );
    } catch {
      // Fixed answer: the error (and its text) is never passed on.
      return body('not_running', null, null, version);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  return () => {
    const at = now();
    if (cached !== undefined && at - cached.at < HEALTH_CACHE_MS && at >= cached.at) {
      return Promise.resolve(cached.value);
    }
    inFlight ??= readSource().then((value) => {
      cached = { at: now(), value };
      inFlight = undefined;
      return value;
    });
    return inFlight;
  };
}

/** GET /api/ui/health. */
export async function healthStatus(context: LocalUiContext): Promise<LocalUiResult> {
  if (context.health === undefined) return { status: 200, body: body('needs_setup') };
  return { status: 200, body: await context.health() };
}

const healthRoute: LocalUiReadRoute = Object.freeze({
  method: 'GET',
  path: '/api/ui/health',
  presence: false,
  handler: (context: LocalUiContext) => healthStatus(context),
});

export const healthRoutes: readonly LocalUiRoute[] = Object.freeze([healthRoute]);
