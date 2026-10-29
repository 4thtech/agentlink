// U3-map: Live connections (b11 §32), the Map view of the Agents page. The List stays the text
// alternative; the picture is decoration over buttons that carry every fact. Names, words and
// directions only: no message, subject, file name or link, and no hover preview (owner decision 8).
// Two fixed columns (agents left, contacts right), sorted by activity, no physics. One SVG layer for
// the lines; the boxes are buttons in list order. A click opens that conversation in Messages.
import { Button, EmptyState, LiveDot, Switch, useReducedMotion } from '@4thtech-io/ui';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { createApiClient, type ApiClient } from '../../../api/client.js';
import { navigate } from '../../../router.js';
import { ADD_CONTACT_HREF } from '../../contacts/add-contact-link.js';
import type { ContactRow } from '../../contacts/data.js';
import { usePulse } from '../../pulse/use-pulse.js';
import { AppMark } from '../app-mark.js';
import { stateWord, type AgentRow } from '../data.js';
import { createFlowApi } from './api.js';
import { buildMap, type MapContact } from './data.js';
import { MAP_STRINGS as S } from './strings.js';
import { useFlow } from './use-flow.js';
import './map.css';

export interface AgentsMapProps {
  readonly agents: readonly AgentRow[];
  /** Tests pass their own client. */
  readonly client?: ApiClient;
  /** "+N more agents" shows the List. */
  readonly onShowList?: () => void;
  /** Another agent's box: switch to it (it reloads every page for that agent). */
  readonly onSwitch?: (row: AgentRow) => void;
}

// Fixed geometry, so the picture needs no measuring: agent boxes 72 px, contact boxes 44 px, 12 px gaps.
const AGENT_H = 72;
const ROW_H = 44;
const GAP = 12;
const LINES_W = 96;
const rowY = (i: number): number => i * (ROW_H + GAP) + ROW_H / 2;
const FROM_Y = AGENT_H / 2;

const QUIET_KEY = 'agentlink:map-show-quiet';
function readQuiet(): boolean {
  try {
    return localStorage.getItem(QUIET_KEY) === '1';
  } catch {
    return false;
  }
}
function writeQuiet(on: boolean): void {
  try {
    localStorage.setItem(QUIET_KEY, on ? '1' : '0');
  } catch {
    /* storage failed: the choice is kept for this visit only */
  }
}

export const openConversation = (ref: string): void =>
  navigate(`/settings/messages?contact=${encodeURIComponent(ref)}`);

const ACTIVITY_WORD = { active_now: 'Active now', today: 'Today', quiet: 'Quiet' } as const;

/** The word for a contact: what is moving, else its activity. */
function wordOf(c: MapContact): string | undefined {
  if (c.moving !== undefined) return c.moving === 'out' ? S.sending : S.receiving;
  return c.activity === undefined ? undefined : ACTIVITY_WORD[c.activity];
}

/** One polite line at most every 10 s (b11 §32.5); never a content word. */
function useAnnouncer(): [string, (line: string) => void] {
  const [line, setLine] = useState('');
  const last = useRef(0);
  const pending = useRef<string | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const say = useCallback((next: string): void => {
    const wait = last.current + 10_000 - Date.now();
    if (wait <= 0) {
      last.current = Date.now();
      setLine(next);
      return;
    }
    pending.current = next;
    if (timer.current !== undefined) return;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      last.current = Date.now();
      if (pending.current !== undefined) setLine(pending.current);
      pending.current = undefined;
    }, wait);
  }, []);
  return [line, say];
}

function announcement(c: MapContact, agent: string): string {
  if (c.moving === 'in') {
    return c.movingKind === 'file' ? S.fileFrom(c.name, agent) : S.reply(c.name);
  }
  return c.movingKind === 'file' ? S.fileTo(c.name) : S.messageTo(c.name);
}

function AgentBox({
  row,
  current,
  onSwitch,
}: {
  row: AgentRow;
  current: boolean;
  onSwitch: ((row: AgentRow) => void) | undefined;
}): ReactElement {
  const apps = row.apps.length === 0 ? S.notConnected : row.apps.join(', ');
  return (
    <li>
      <button
        type="button"
        className={`mp-agent${current ? ' mp-agent-open' : ''}`}
        aria-label={S.agentBox(row.label, apps)}
        onClick={() => (current ? navigate('/settings/messages') : onSwitch?.(row))}
      >
        <span className="mp-agent-head">
          <span className="mp-agent-label al-text-title-3">{row.label}</span>
          <LiveDot state={row.running ? 'connected' : 'not-running'} label={stateWord(row)} />
        </span>
        {row.apps.length === 0 ? (
          <span className="mp-agent-sub al-text-body-sm al-muted">{S.notConnected}</span>
        ) : (
          <span className="mp-agent-sub al-text-body-sm">
            {row.apps.map((app) => (
              <AppMark key={app} name={app} />
            ))}
          </span>
        )}
        {current ? null : (
          <span className="mp-agent-hint al-text-label al-muted">{S.switchToSee}</span>
        )}
      </button>
    </li>
  );
}

function ContactBox({
  c,
  agent,
  reduced,
}: {
  c: MapContact;
  agent: string;
  reduced: boolean;
}): ReactElement {
  const word = wordOf(c);
  const file = c.movingKind === 'file' && c.moving !== undefined;
  return (
    <li>
      <button
        type="button"
        className={`mp-contact${c.moving !== undefined ? ' mp-moving' : ''}${c.stream ? ' mp-streaming' : ''}`}
        aria-label={S.contactBox(agent, c.name, word)}
        onClick={() => openConversation(c.ref)}
      >
        <span className="mp-name al-text-body">{c.name}</span>
        <span className="mp-word al-text-label al-muted">
          {c.moving !== undefined ? <span className="mp-mark" aria-hidden="true" /> : null}
          {word}
          {c.moving !== undefined && reduced ? (
            <>
              {' '}
              <span className="mp-now">{S.now}</span>
            </>
          ) : null}
        </span>
        {file ? (
          <span className="mp-file al-text-label al-muted">
            {c.moving === 'out' ? S.sendingTo(c.name) : S.receivingFrom(c.name)}
            <span className="mp-bar" aria-hidden="true" />
          </span>
        ) : null}
      </button>
    </li>
  );
}

function Lines({
  contacts,
  reduced,
}: {
  contacts: readonly MapContact[];
  reduced: boolean;
}): ReactElement | null {
  const height = contacts.length * (ROW_H + GAP);
  if (contacts.length === 0) return null;
  return (
    <svg
      className="mp-lines"
      width={LINES_W}
      height={height}
      viewBox={`0 0 ${String(LINES_W)} ${String(height)}`}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <marker
          id="mp-head"
          viewBox="0 0 8 8"
          refX="8"
          refY="4"
          markerWidth="8"
          markerHeight="8"
          markerUnits="userSpaceOnUse"
          orient="auto-start-reverse"
        >
          <path className="mp-head" d="M0 0 L8 4 L0 8 Z" />
        </marker>
      </defs>
      {contacts.map((c, i) => {
        if (!c.line) return null;
        const y = rowY(i);
        const to = `M0 ${String(FROM_Y)} L${String(LINES_W)} ${String(y)}`;
        const back = `M${String(LINES_W)} ${String(y)} L0 ${String(FROM_Y)}`;
        const marker =
          c.direction === 'both'
            ? { markerStart: 'url(#mp-head)', markerEnd: 'url(#mp-head)' }
            : c.direction === 'out'
              ? { markerEnd: 'url(#mp-head)' }
              : c.direction === 'in'
                ? { markerStart: 'url(#mp-head)' }
                : {};
        const dirs = c.stream
          ? c.bothMoving
            ? ([to, back] as const)
            : ([c.moving === 'in' ? back : to] as const)
          : [];
        return (
          <g key={c.ref} className="mp-g">
            <path
              className={`mp-line mp-w${String(c.weight)} mp-${c.direction}${c.stream ? ' mp-live' : ''}`}
              d={to}
              {...marker}
            />
            <path className="mp-hit" d={to} onClick={() => openConversation(c.ref)} />
            {dirs.map((d, k) => (
              <path
                key={`${String(c.movingAt)}:${String(k)}`}
                className={`mp-stream${c.animate && !reduced ? ' mp-stream-run' : ''}`}
                d={d}
                pathLength={100}
              />
            ))}
            {c.stream && reduced ? (
              <text
                className="mp-now-line"
                x={LINES_W / 2}
                y={(FROM_Y + y) / 2 - 4}
                textAnchor="middle"
              >
                {S.now}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

export function AgentsMap({ agents, client, onShowList, onSwitch }: AgentsMapProps): ReactElement {
  const api = useMemo(() => client ?? createApiClient(), [client]);
  const flowApi = useMemo(() => createFlowApi(api), [api]);
  const reduced = useReducedMotion();
  const pulse = usePulse(api);
  const flow = useFlow(flowApi);
  const [contacts, setContacts] = useState<
    { kind: 'loading' } | { kind: 'ok'; rows: readonly ContactRow[] } | { kind: 'error' }
  >({ kind: 'loading' });
  const [showQuiet, setShowQuiet] = useState<boolean>(readQuiet);
  const [line, say] = useAnnouncer();
  const seen = useRef<Set<string> | undefined>(undefined);

  const loadContacts = useCallback((): void => {
    void flowApi.contacts().then((r) => {
      setContacts(r.kind === 'ok' ? { kind: 'ok', rows: r.contacts } : { kind: 'error' });
    });
  }, [flowApi]);
  useEffect(() => {
    loadContacts();
  }, [loadContacts]);

  const model = buildMap({
    agents,
    contacts: contacts.kind === 'ok' ? contacts.rows : [],
    pulse: pulse.pulse,
    flow: flow.flow,
    nowSec: flow.nowSec(),
    showQuiet,
    live: !flow.failed,
  });

  // New arrivals become one polite line; the first read only learns what is already moving.
  const open = model.current?.label ?? '';
  useEffect(() => {
    if (!flow.loaded || contacts.kind !== 'ok') return;
    const keys = model.contacts
      .filter((c) => c.moving !== undefined)
      .map((c) => ({ key: `${c.ref}:${String(c.movingAt)}:${c.moving ?? ''}`, c }));
    const known = seen.current;
    seen.current = new Set(keys.map((k) => k.key));
    if (known === undefined) return;
    const fresh = keys.find((k) => !known.has(k.key));
    if (fresh !== undefined) say(announcement(fresh.c, open));
  });

  const toggle = (on: boolean): void => {
    setShowQuiet(on);
    writeQuiet(on);
  };
  const retry = (): void => {
    loadContacts();
    flow.retry();
  };

  const loading = contacts.kind === 'loading';
  const failed = contacts.kind === 'error' || flow.failed;

  return (
    <section className="mp" aria-labelledby="mp-title">
      <div className="mp-top">
        <h2 id="mp-title" className="al-text-h2">
          {S.title}
        </h2>
        <Switch label={S.showQuiet} checked={showQuiet} onChange={toggle} />
      </div>
      <p className="mp-summary al-text-body-sm al-muted">{model.summary}</p>
      <div className="mp-announce" role="status" aria-live="polite">
        {line}
      </div>
      {failed ? (
        <p className="al-text-body-sm" role="alert">
          {S.loadError}{' '}
          <button type="button" className="mp-link" onClick={retry}>
            {S.tryAgain}
          </button>
        </p>
      ) : null}
      {loading ? (
        <div className="mp-grid mp-skel" role="status">
          <span className="mp-sr">{S.loading}</span>
          <div className="mp-skel-box" aria-hidden="true" />
          <div className="mp-skel-box" aria-hidden="true" />
        </div>
      ) : contacts.kind === 'error' ? null : (
        <div className={`mp-canvas${failed ? ' mp-dim' : ''}`}>
          <div className="mp-grid">
            <ul className="mp-cur" aria-label={S.title}>
              {model.current === undefined ? null : (
                <AgentBox row={model.current} current onSwitch={onSwitch} />
              )}
            </ul>
            {model.empty ? (
              <div className="mp-contacts mp-empty">
                <EmptyState
                  title={S.empty}
                  action={
                    <Button variant="primary" onClick={() => navigate(ADD_CONTACT_HREF)}>
                      {S.addContact}
                    </Button>
                  }
                />
              </div>
            ) : (
              <>
                <Lines contacts={model.contacts} reduced={reduced} />
                <ul className="mp-contacts" aria-label={model.current?.label ?? S.title}>
                  {model.contacts.map((c) => (
                    <ContactBox key={c.ref} c={c} agent={open} reduced={reduced} />
                  ))}
                  {model.moreContacts > 0 ? (
                    <li>
                      <button
                        type="button"
                        className="mp-more-btn"
                        onClick={() => navigate('/settings/contacts')}
                      >
                        {S.moreContacts(model.moreContacts)}
                      </button>
                    </li>
                  ) : null}
                </ul>
              </>
            )}
            <ul className="mp-others">
              {model.agents
                .filter((a) => a !== model.current)
                .map((a) => (
                  <AgentBox key={a.name} row={a} current={false} onSwitch={onSwitch} />
                ))}
              {model.moreAgents > 0 ? (
                <li>
                  <button type="button" className="mp-more-btn" onClick={onShowList}>
                    {S.moreAgents(model.moreAgents)}
                  </button>
                </li>
              ) : null}
            </ul>
          </div>
          {model.noRecent ? (
            <p className="mp-note al-text-body-sm al-muted">{S.noActivity}</p>
          ) : (
            <p className="mp-note al-text-body-sm al-muted">{S.legend}</p>
          )}
        </div>
      )}
    </section>
  );
}

export default AgentsMap;
