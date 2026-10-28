// The reads Start here adds in v2 (U3-j; B-11 §27.1; 08 §1 "Agents and AI apps in the app"): the open
// agent (GET /api/ui/agents, with GET /api/ui/apps for the app's fixed name) and whether a message
// from a contact is stored (GET /api/ui/messages). Plain GETs; nothing here writes.
//
// A tick comes only from an answer. `not_available`, an empty list, a failed read or a shape that
// does not parse is "no answer" or "not connected", never "done". Everything shown is plain text, cut
// to a short length (I-5); a path or any other field of the AI apps list is never copied.
import { createApiClient, type ApiClient } from '../../api/client.js';
import { createMessagesApi } from '../messages/api.js';
import type { AgentSignal } from './start-here.js';

export const AGENTS_READ = '/api/ui/agents';
export const APPS_READ = '/api/ui/apps';

/** The fixed names of the AI apps (06 §7); the lists answer ids, or these names. */
const APP_NAMES: Readonly<Record<string, string>> = Object.freeze({
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  codex: 'Codex',
  'gemini-cli': 'Gemini CLI',
  opencode: 'OpenCode',
  antigravity: 'Antigravity',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
});
const MAX_NAME = 40;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A fixed name for a known id, else the text itself, cut short. Control characters are dropped. */
function appName(raw: string): string | null {
  const known = Object.hasOwn(APP_NAMES, raw) ? APP_NAMES[raw] : undefined;
  if (known !== undefined) return known;
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (text === '') return null;
  const chars = [...text];
  return chars.length <= MAX_NAME ? text : `${chars.slice(0, MAX_NAME - 1).join('')}…`;
}

/**
 * The open agent's signal from the two answers, or undefined when the agents answer does not name an
 * open agent (outside the app host, or a shape that does not parse). `apps` is optional: the agents
 * list already carries each agent's apps; the AI apps list adds entries that run this agent.
 */
export function parseAgentSignal(agents: unknown, apps: unknown): AgentSignal | undefined {
  if (!isRecord(agents) || agents['switchable'] !== true || !Array.isArray(agents['agents'])) {
    return undefined;
  }
  const current = agents['current'];
  if (typeof current !== 'string' || current === '') return undefined;
  const row = (agents['agents'] as unknown[]).find(
    (a): a is Record<string, unknown> => isRecord(a) && a['name'] === current,
  );
  if (row === undefined) return undefined;
  const label = typeof row['label'] === 'string' ? row['label'].trim() : '';
  const names: string[] = [];
  const add = (raw: unknown): void => {
    if (typeof raw !== 'string') return;
    const name = appName(raw);
    if (name !== null && !names.includes(name)) names.push(name);
  };
  if (Array.isArray(row['apps'])) for (const a of row['apps'] as unknown[]) add(a);
  if (isRecord(apps) && Array.isArray(apps['apps'])) {
    for (const entry of apps['apps'] as unknown[]) {
      if (!isRecord(entry) || entry['state'] !== 'connected' || entry['agent'] !== current) {
        continue;
      }
      add(typeof entry['name'] === 'string' ? entry['name'] : entry['app']);
    }
  }
  return {
    // An agent with no label of its own is listed under its folder name.
    named: label !== '' && label !== current,
    connected: names.length > 0,
    appName: names[0] ?? null,
    running: row['running'] === true,
  };
}

/** The open agent's signal, or undefined when the agents read has no answer. */
export async function readAgentSignal(
  client: ApiClient = createApiClient(),
): Promise<AgentSignal | undefined> {
  const [agents, apps] = await Promise.all([
    client.get<unknown>(AGENTS_READ),
    client.get<unknown>(APPS_READ),
  ]);
  if (agents.kind !== 'ok') return undefined;
  return parseAgentSignal(agents.data, apps.kind === 'ok' ? apps.data : undefined);
}

/** True when a stored message from a contact exists. Undefined when the read gave no answer. */
export async function readReplied(
  client: ApiClient = createApiClient(),
): Promise<boolean | undefined> {
  const list = await createMessagesApi(client).conversations();
  if (!list.ok) return undefined;
  return list.value.some((c) => c.lastInAt > 0);
}
