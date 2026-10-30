// W4-AGENTS (A11, W4 UX v2 "Agents → fleet table", Under the hood): the same Agents route, denser.
// Search (label and AI app), filter by status and by AI app, sort by most recent activity, name or
// status; select agents for a bulk Remove (one agent at a time, each with its name typed and Touch
// ID); a row opens the agent's own page. Pause applies to the open agent (08 §1), so the bulk bar
// offers it for a single agent only. Labels are text only, in their own bidi run (I-5).
import { AgentIcon, Button } from '@4thtech-io/ui';
import { useId, useMemo, useState, type ReactElement } from 'react';
import { navigate } from '../../router.js';
import {
  agentLine,
  appChoices,
  appsOf,
  dotOf,
  fleetRows,
  relativeTime,
  stateOf,
  type AgentRow,
  type FleetQuery,
  type FleetSort,
  type FleetStatus,
} from './data.js';
import { AppDot } from './parts.js';
import { AGENTS_STRINGS as S } from './strings.js';

const STATUSES: readonly { value: FleetStatus; label: string }[] = [
  { value: 'all', label: S.allStatuses },
  { value: 'working', label: S.working },
  { value: 'ready', label: S.ready },
  { value: 'idle', label: S.idle },
  { value: 'offline', label: S.offline },
  { value: 'paused', label: S.paused },
];
const SORTS: readonly { value: FleetSort; label: string }[] = [
  { value: 'activity', label: S.sortActivity },
  { value: 'name', label: S.sortName },
  { value: 'status', label: S.sortStatus },
];

/** "now" while an AI app runs it, else how long ago it was last seen. */
function lastActive(row: AgentRow, now: number): string {
  const s = stateOf(row);
  if (s === 'working' || s === 'ready' || s === 'idle') return S.now;
  return row.lastSeenAt === undefined ? '—' : relativeTime(row.lastSeenAt, now);
}

export function fleetSummary(rows: readonly AgentRow[]): string {
  const working = rows.filter((r) => stateOf(r) === 'working').length;
  const ready = rows.filter((r) => stateOf(r) === 'ready' || stateOf(r) === 'idle').length;
  return S.fleetSummary(working, ready, rows.length - working - ready);
}

export function Fleet({
  rows,
  now,
  onPause,
  onResume,
  onRemove,
}: {
  rows: readonly AgentRow[];
  now: number;
  onPause: (row: AgentRow) => void;
  onResume: (row: AgentRow) => void;
  onRemove: (rows: readonly AgentRow[]) => void;
}): ReactElement {
  const id = useId();
  const [query, setQuery] = useState<FleetQuery>({
    q: '',
    status: 'all',
    app: 'all',
    sort: 'activity',
  });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const shown = useMemo(() => fleetRows(rows, query), [rows, query]);
  const choices = useMemo(() => appChoices(rows), [rows]);
  // In the order the table shows them (then any selected row a filter now hides).
  const picked = [...shown, ...rows.filter((r) => !shown.includes(r))].filter((r) =>
    selected.has(r.name),
  );
  const allPicked = shown.length > 0 && shown.every((r) => selected.has(r.name));
  const set = (patch: Partial<FleetQuery>): void => setQuery((q) => ({ ...q, ...patch }));
  const toggle = (name: string): void =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  const single = picked.length === 1 ? picked[0] : undefined;

  return (
    <>
      <div className="ag-filters">
        <span className="ag-field ag-field-grow">
          <label htmlFor={`${id}-q`} className="al-text-label al-muted">
            {S.search}
          </label>
          <span className="al-input-wrap">
            <input
              id={`${id}-q`}
              className="al-input"
              type="search"
              name="q"
              value={query.q}
              placeholder={S.searchPlaceholder}
              autoComplete="off"
              onChange={(e) => set({ q: e.currentTarget.value })}
            />
          </span>
        </span>
        <span className="ag-field">
          <label htmlFor={`${id}-status`} className="al-text-label al-muted">
            {S.show}
          </label>
          <span className="al-input-wrap">
            <select
              id={`${id}-status`}
              className="al-input"
              name="status"
              value={query.status}
              onChange={(e) => set({ status: e.currentTarget.value as FleetStatus })}
            >
              {STATUSES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </span>
        </span>
        <span className="ag-field">
          <label htmlFor={`${id}-app`} className="al-text-label al-muted">
            {S.aiApp}
          </label>
          <span className="al-input-wrap">
            <select
              id={`${id}-app`}
              className="al-input"
              name="app"
              value={query.app}
              onChange={(e) => set({ app: e.currentTarget.value })}
            >
              <option value="all">{S.allApps}</option>
              {choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </span>
        </span>
        <span className="ag-field">
          <label htmlFor={`${id}-sort`} className="al-text-label al-muted">
            {S.sortBy}
          </label>
          <span className="al-input-wrap">
            <select
              id={`${id}-sort`}
              className="al-input"
              name="sort"
              value={query.sort}
              onChange={(e) => set({ sort: e.currentTarget.value as FleetSort })}
            >
              {SORTS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </span>
        </span>
      </div>

      {picked.length > 0 ? (
        <div className="ag-bulk al-reveal" role="region" aria-label={S.selectedRegion} data-bulk>
          <span className="al-text-body-sm">{S.selected(picked.length)}</span>
          <span className="ag-actions">
            {single !== undefined && !single.removing ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => (stateOf(single) === 'paused' ? onResume(single) : onPause(single))}
              >
                {stateOf(single) === 'paused' ? S.resume : S.pause}
              </Button>
            ) : null}
            <Button variant="danger" size="sm" onClick={() => onRemove(picked)}>
              {S.remove}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
              {S.clear}
            </Button>
          </span>
        </div>
      ) : null}

      <div className="ag-table-wrap">
        <table className="ag-table">
          <caption className="al-visually-hidden">{S.fleetCaption}</caption>
          <thead>
            <tr>
              <th scope="col" className="ag-col-check">
                <input
                  type="checkbox"
                  aria-label={S.selectAll}
                  checked={allPicked}
                  onChange={() =>
                    setSelected(allPicked ? new Set() : new Set(shown.map((r) => r.name)))
                  }
                />
              </th>
              <th scope="col">{S.colAgent}</th>
              <th scope="col" className="ag-col-opt">
                {S.colApps}
              </th>
              <th scope="col">{S.colStatus}</th>
              <th scope="col" className="ag-col-opt">
                {S.colPeople}
              </th>
              <th scope="col" className="ag-col-opt">
                {S.colLast}
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr
                key={r.name}
                data-agent={r.name}
                className={selected.has(r.name) ? 'is-picked' : undefined}
              >
                <td className="ag-col-check">
                  <input
                    type="checkbox"
                    aria-label={S.selectOne(r.label)}
                    checked={selected.has(r.name)}
                    onChange={() => toggle(r.name)}
                  />
                </td>
                <td>
                  <span className="ag-agent-cell">
                    <AgentIcon label={r.label} seed={r.name} dot={dotOf(r)} />
                    <button
                      type="button"
                      className="ag-rowlink"
                      onClick={() => navigate(`/agents/${r.name}`)}
                    >
                      <bdi>{r.label}</bdi>
                    </button>
                  </span>
                </td>
                <td className="ag-col-opt">
                  <span className="ag-cell-apps">
                    {appsOf(r)
                      .filter((x) => x.state !== 'not_set_up')
                      .map((x) => (
                        <span key={x.id} className="ag-chip al-text-body-sm">
                          <AppDot app={x} />
                          {x.name}
                        </span>
                      ))}
                  </span>
                </td>
                <td className={`ag-line al-text-body-sm is-${stateOf(r)}`}>{agentLine(r, now)}</td>
                <td className="ag-col-opt al-text-body-sm">{r.contacts ?? '—'}</td>
                <td className="ag-col-opt al-text-body-sm al-muted">{lastActive(r, now)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 ? (
          <p className="al-text-body-sm al-muted ag-empty">{S.noMatch}</p>
        ) : null}
      </div>
    </>
  );
}
