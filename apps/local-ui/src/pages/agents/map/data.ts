// U3-map: the flow answer parsed defensively, and the map's rules as pure functions (b11 §32). The
// model holds names, words, counts and directions only: nothing here ever carries a message, a
// subject, a file name or a link (I-5). Contact names are the owner-confirmed ones; the other side's
// own name is never drawn ("Unnamed contact").
import { formatContactName } from '@4thtech-io/ui';
import type { ContactRow } from '../../contacts/data.js';
import {
  activityRank,
  compareMostActive,
  totalOf,
  type Activity,
  type Pulse,
} from '../../pulse/data.js';
import type { AgentRow } from '../data.js';
import { MAP_STRINGS as S } from './strings.js';

export const FLOW_PATH = '/api/ui/flow';
export const MAX_AGENTS = 8;
export const MAX_CONTACTS = 12;
export const MAX_STREAMS = 6;
export const MAX_ANIMATED = 2;
/** A stream runs for an exchange in the last minute (b11 §32.3). */
export const STREAM_SECONDS = 60;

export const flowPath = (since?: number): string =>
  since === undefined ? FLOW_PATH : `${FLOW_PATH}?since=${String(since)}`;

export interface FlowItem {
  readonly contactId: string;
  readonly direction: 'in' | 'out';
  readonly kind: 'message' | 'file';
  readonly state: 'received' | 'queued' | 'sent' | 'not_delivered';
  readonly at: number;
}
export interface Flow {
  readonly now: number;
  readonly cursor: number;
  readonly items: readonly FlowItem[];
  readonly partial: boolean;
}
/** The newest item per direction for one contact. */
export interface ContactFlow {
  readonly in?: FlowItem;
  readonly out?: FlowItem;
}

const CONTACT = /^0x[0-9a-f]{40}$/;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isTime = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function parseItem(raw: unknown): FlowItem | undefined {
  if (!isRecord(raw)) return undefined;
  const { contactId, direction, kind, state, at } = raw;
  if (typeof contactId !== 'string' || !CONTACT.test(contactId)) return undefined;
  if (direction !== 'in' && direction !== 'out') return undefined;
  if (kind !== 'message' && kind !== 'file') return undefined;
  const states = direction === 'in' ? ['received'] : ['queued', 'sent', 'not_delivered'];
  if (typeof state !== 'string' || !states.includes(state)) return undefined;
  if (!isTime(at)) return undefined;
  return { contactId, direction, kind, state: state as FlowItem['state'], at };
}

/** An allowlisted copy: a field the server should not send never reaches the page. */
export function parseFlow(data: unknown): Flow | undefined {
  if (!isRecord(data) || !isTime(data['now']) || !Array.isArray(data['items'])) return undefined;
  const cursor = typeof data['cursor'] === 'string' ? Number(data['cursor']) : NaN;
  if (!isTime(cursor)) return undefined;
  const items: FlowItem[] = [];
  for (const raw of (data['items'] as unknown[]).slice(0, 500)) {
    const item = parseItem(raw);
    if (item !== undefined) items.push(item);
  }
  return { now: data['now'], cursor, items, partial: data['partial'] === true };
}

/** Keeps the newest item per contact and direction (the boundary second may come twice). */
export function mergeFlow(
  prev: ReadonlyMap<string, ContactFlow>,
  items: readonly FlowItem[],
): Map<string, ContactFlow> {
  const next = new Map(prev);
  for (const item of items) {
    const cf = next.get(item.contactId) ?? {};
    const held = cf[item.direction];
    if (held === undefined || item.at >= held.at) {
      next.set(item.contactId, { ...cf, [item.direction]: item });
    }
  }
  return next;
}

export type Direction = 'both' | 'out' | 'in' | 'unknown';

export interface MapContact {
  readonly ref: string;
  readonly name: string;
  readonly activity: Activity | undefined;
  readonly total: number;
  readonly lastAt: number;
  /** Line weight 1 to 3 from the pulse count. */
  readonly weight: 1 | 2 | 3;
  /** Exchanged something in the last 24 hours. */
  readonly line: boolean;
  readonly direction: Direction;
  /** Moving now: the newest direction, the kind and the time of the newest moving item. */
  readonly moving: 'out' | 'in' | undefined;
  readonly movingKind: 'message' | 'file' | undefined;
  readonly movingAt: number;
  /** Drawn as a stream (at most 6 at once). */
  readonly stream: boolean;
  /** The dash travels (at most 2 at once). */
  readonly animate: boolean;
  /** Both directions moved in the last minute. */
  readonly bothMoving: boolean;
}

export interface MapModel {
  readonly agents: readonly AgentRow[];
  readonly moreAgents: number;
  readonly current: AgentRow | undefined;
  readonly contacts: readonly MapContact[];
  readonly moreContacts: number;
  readonly quietHidden: number;
  readonly streams: number;
  readonly summary: string;
  /** The open agent has no contacts at all. */
  readonly empty: boolean;
  /** It has contacts, and none exchanged anything in 24 hours. */
  readonly noRecent: boolean;
}

export interface MapInput {
  readonly agents: readonly AgentRow[];
  readonly contacts: readonly ContactRow[];
  readonly pulse: Pulse | undefined;
  readonly flow: ReadonlyMap<string, ContactFlow>;
  readonly nowSec: number;
  readonly showQuiet: boolean;
  /** False when the flow read is failing: no stream runs (b11 §32.3). */
  readonly live?: boolean;
}

/** The owner-confirmed name, or "Unnamed contact" (b11 §32.1). */
export function mapName(c: ContactRow): string {
  return c.nameSource === 'owner' && c.name.trim() !== ''
    ? formatContactName({ alias: c.name }).text
    : S.unnamed;
}

/** As the pulse module's `activityOf`: unlisted is Quiet unless the answer is partial (unknown). */
function activityOf(pulse: Pulse | undefined, id: string): Activity | undefined {
  if (pulse === undefined) return undefined;
  const found = pulse.contacts.get(id);
  if (found !== undefined) return found.activity;
  return pulse.partial ? undefined : 'quiet';
}

const rankOf = (a: Activity | undefined): number => (a === undefined ? 1.5 : activityRank(a));

export function buildMap(input: MapInput): MapModel {
  const live = input.live !== false;
  const usable = input.agents.filter((a) => !a.removing && a.available);
  const agents = usable.slice(0, MAX_AGENTS);
  const current = usable.find((a) => a.current);
  const active = input.contacts.filter((c) => c.status === 'active');

  const rows = active.map((c) => {
    const entry = input.pulse?.contacts.get(c.ref);
    const total = entry === undefined ? 0 : totalOf(entry.counts);
    const cf = input.flow.get(c.ref);
    const recent = (i: FlowItem | undefined): FlowItem | undefined =>
      live &&
      i !== undefined &&
      i.state !== 'not_delivered' &&
      i.at >= input.nowSec - STREAM_SECONDS
        ? i
        : undefined;
    const mo = recent(cf?.out);
    const mi = recent(cf?.in);
    const newest = mo !== undefined && (mi === undefined || mo.at >= mi.at) ? mo : mi;
    const lastAt = Math.max(entry?.lastAt ?? 0, cf?.out?.at ?? 0, cf?.in?.at ?? 0);
    const activity: Activity | undefined =
      newest !== undefined ? 'active_now' : activityOf(input.pulse, c.ref);
    const line = total > 0 || cf?.out !== undefined || cf?.in !== undefined;
    const direction: Direction =
      cf?.out !== undefined && cf.in !== undefined
        ? 'both'
        : cf?.out !== undefined
          ? 'out'
          : cf?.in !== undefined
            ? 'in'
            : 'unknown';
    return {
      c,
      total,
      lastAt,
      activity,
      line,
      direction,
      newest,
      bothMoving: mo !== undefined && mi !== undefined,
    };
  });

  const quiet = (r: (typeof rows)[number]): boolean =>
    r.activity === 'quiet' && r.newest === undefined;
  const visible = rows
    .filter((r) => input.showQuiet || !quiet(r))
    .sort(
      (a, b) =>
        rankOf(a.activity) - rankOf(b.activity) ||
        compareMostActive(a, b) ||
        mapName(a.c).localeCompare(mapName(b.c)) ||
        a.c.ref.localeCompare(b.c.ref),
    );
  const shown = visible.slice(0, MAX_CONTACTS);
  const scale = Math.max(4, ...shown.map((r) => r.total));
  // The newest moving items become streams (at most 6); the first two animate.
  const movers = shown
    .filter((r) => r.newest !== undefined)
    .sort((a, b) => (b.newest?.at ?? 0) - (a.newest?.at ?? 0));
  const streamRefs = new Set(movers.slice(0, MAX_STREAMS).map((r) => r.c.ref));
  const animRefs = new Set(movers.slice(0, MAX_ANIMATED).map((r) => r.c.ref));

  const contacts: MapContact[] = shown.map((r) => ({
    ref: r.c.ref,
    name: mapName(r.c),
    activity: r.activity,
    total: r.total,
    lastAt: r.lastAt,
    weight: Math.min(3, Math.max(1, Math.ceil((r.total / scale) * 3))) as 1 | 2 | 3,
    line: r.line,
    direction: r.direction,
    moving: r.newest?.direction,
    movingKind: r.newest?.kind,
    movingAt: r.newest?.at ?? 0,
    stream: streamRefs.has(r.c.ref),
    animate: animRefs.has(r.c.ref),
    bothMoving: r.bothMoving,
  }));

  const others = usable.filter((a) => !a.current).reduce((n, a) => n + (a.contacts ?? 0), 0);
  const talking = contacts.find((c) => c.moving !== undefined);
  return {
    agents,
    moreAgents: Math.max(0, usable.length - agents.length),
    current,
    contacts,
    moreContacts: Math.max(0, visible.length - shown.length),
    quietHidden: rows.length - rows.filter((r) => input.showQuiet || !quiet(r)).length,
    streams: streamRefs.size,
    summary: S.summary(
      usable.length,
      active.length + others,
      talking === undefined || current === undefined
        ? undefined
        : { name: talking.name, agent: current.label },
    ),
    empty: active.length === 0,
    noRecent: active.length > 0 && !rows.some((r) => r.line),
  };
}
