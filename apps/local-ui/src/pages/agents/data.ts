// U3-h: the Agents read (GET /api/ui/agents, U3-c) parsed defensively, and the small rules the
// switcher and the page share (b11 §29). A label is plain text from an unsigned file: it is only ever
// rendered as text, and it is never used to authorise anything (the agent name and the generation
// travel with each request).
import { AGENTS_STRINGS as S } from './strings.js';

/** The page's path. The server serves pages under /settings (approval-server.ts APP_PAGE). */
export const AGENTS_PATH = '/settings/agents';

/** The AI apps page (card U3-i builds it); Connect links here. */
export const AGENTS_APPS_PATH = '/settings/apps';

export interface AgentRow {
  readonly name: string;
  readonly label: string;
  readonly current: boolean;
  readonly available: boolean;
  readonly removing: boolean;
  readonly contacts: number | null;
  readonly running: boolean;
  readonly apps: readonly string[];
}

export interface AgentsList {
  /** False outside the app host: the page is bound to its agent. */
  readonly switchable: boolean;
  readonly generation?: number;
  readonly current: string | null;
  readonly label: string | null;
  readonly agents: readonly AgentRow[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * W4-LIVE-STATUS (D-143, 08 §1): an AI app that runs this agent. The read now carries
 * `{app, state, ...}` per detected app; one runs this agent unless it is `not_set_up`. A plain id
 * (the earlier form) still reads as one. The live words come with U1-b.
 */
function appIdOf(a: unknown): string[] {
  if (typeof a === 'string') return [a];
  if (isObject(a) && typeof a['app'] === 'string' && a['state'] !== 'not_set_up') return [a['app']];
  return [];
}

function parseRow(v: unknown): AgentRow | undefined {
  if (!isObject(v) || typeof v['name'] !== 'string' || typeof v['label'] !== 'string') {
    return undefined;
  }
  const apps = Array.isArray(v['apps']) ? v['apps'].flatMap(appIdOf) : [];
  const contacts = v['contacts'];
  return {
    name: v['name'],
    label: v['label'],
    current: v['current'] === true,
    available: v['available'] !== false,
    removing: v['removing'] === true,
    contacts:
      typeof contacts === 'number' && Number.isSafeInteger(contacts) && contacts >= 0
        ? contacts
        : null,
    running: v['running'] === true,
    apps,
  };
}

export function parseAgents(value: unknown): AgentsList | undefined {
  if (!isObject(value)) return undefined;
  if (value['switchable'] === false) {
    return { switchable: false, current: null, label: null, agents: [] };
  }
  const generation = value['generation'];
  if (
    value['switchable'] !== true ||
    typeof generation !== 'number' ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    !Array.isArray(value['agents'])
  ) {
    return undefined;
  }
  return {
    switchable: true,
    generation,
    current: typeof value['current'] === 'string' ? value['current'] : null,
    label: typeof value['label'] === 'string' ? value['label'] : null,
    agents: value['agents'].map(parseRow).filter((r): r is AgentRow => r !== undefined),
  };
}

/** The open agent first, then by label; "Removal not finished" agents last. */
export function orderAgents(rows: readonly AgentRow[]): AgentRow[] {
  const rank = (r: AgentRow): number => (r.removing ? 2 : r.current ? 0 : 1);
  return [...rows].sort(
    (a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label) || a.name.localeCompare(b.name),
  );
}

/** The trigger's label: 20 characters at most. */
export function shortLabel(label: string, max = 20): string {
  const chars = [...label];
  return chars.length <= max ? label : `${chars.slice(0, max - 1).join('')}…`;
}

/** "Claude Code", "Claude Code +1", or the none case. */
export function appsText(row: AgentRow): string {
  const [first, ...rest] = row.apps;
  if (first === undefined) return S.notConnected;
  return rest.length === 0 ? first : `${first} +${rest.length}`;
}

/** Agents that serve no AI app and have no contacts; removal not finished does not count (§29.7). */
export function tidyCandidates(rows: readonly AgentRow[]): AgentRow[] {
  return rows.filter((r) => !r.removing && r.available && r.apps.length === 0 && r.contacts === 0);
}

export function stateWord(row: AgentRow): string {
  return row.running ? S.running : S.notRunning;
}
