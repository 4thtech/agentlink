// Advanced › Diagnostics (W4-SETTINGS-ADVANCED; prototype v23 "Diagnostics"). The version, each AI
// app with the agent in it and its status (from the shared live store, api/live.ts), a button that
// copies a report (versions, statuses and counts only), and below it today's About: licence and the
// public links. App and agent names are text only, bidi-isolated (I-5). The "last heartbeat" column
// of the prototype joins when K1 reports it; until then the column says the status, never a time.
import { Button, Surface } from '@4thtech-io/ui';
import { useEffect, useState, useSyncExternalStore, type ReactElement } from 'react';
import type { ApiResult } from '../../api/client.js';
import { getLive, subscribeLive, type LiveSnapshot } from '../../api/live.js';
import { parseHealth, readHealth } from '../../layout/health.js';
import { cleanLine } from '../activity/clean.js';
import { parseRelays, type Relays } from '../advanced/relays.js';
import { DIAGNOSTICS_STRINGS as S } from './diagnostics-strings.js';
import { ABOUT_LINKS, ABOUT_STRINGS as A } from './strings.js';
import './about.css';
import './diagnostics.css';

export interface ReportFacts {
  readonly version: string | undefined;
  readonly relays: Relays | undefined;
  readonly live: LiveSnapshot;
}

/** Rows: AI app, agent, status word. */
export function rowsOf(live: LiveSnapshot): { app: string; agent: string; word: string }[] {
  return live.agents.flatMap((a) =>
    a.apps.map((app) => ({ app: app.app, agent: a.label, word: app.word })),
  );
}

/** The text that is copied: versions, statuses and counts, nothing else. */
export function buildReport(facts: ReportFacts): string {
  const lines = [
    `${S.app} ${facts.version ?? S.versionUnknown}`,
    ...rowsOf(facts.live).map((r) => cleanLine(`${r.app} · ${r.agent} · ${r.word}`)),
  ];
  const r = facts.relays;
  if (r?.connected !== undefined && r.total !== undefined) {
    lines.push(`${S.reportRelays}: ${String(r.connected)} of ${String(r.total)} connected`);
  }
  return lines.join('\n');
}

export interface DiagnosticsPageProps {
  /** The health read (default: the production read); a test passes its own. */
  readonly read?: () => Promise<ApiResult<unknown>>;
  /** The live store (default: the shared one). */
  readonly live?: LiveSnapshot;
  /** Copies text (default: the clipboard). */
  readonly copy?: ((text: string) => Promise<void>) | undefined;
}

const clipboard = (text: string): Promise<void> => navigator.clipboard.writeText(text);

export function DiagnosticsPage({
  read = readHealth,
  live: injected,
  copy = clipboard,
}: DiagnosticsPageProps): ReactElement {
  const shared = useSyncExternalStore((on) => subscribeLive(on), getLive, getLive);
  const live = injected ?? shared;
  const [version, setVersion] = useState<string | undefined>(undefined);
  const [relays, setRelays] = useState<Relays | undefined>(undefined);
  const [note, setNote] = useState('');

  useEffect(() => {
    let alive = true;
    read().then(
      (r) => {
        if (!alive) return;
        setVersion(parseHealth(r)?.version);
        setRelays(parseRelays(r));
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [read]);

  const rows = rowsOf(live);
  const onCopy = (): void => {
    copy(buildReport({ version, relays, live })).then(
      () => setNote(S.copied),
      () => setNote(S.copyFailed),
    );
  };

  return (
    <div className="dg-page">
      <div className="dg-head">
        <header className="dg-title">
          <span className="al-text-label dg-eyebrow">{S.eyebrow}</span>
          <h1 className="al-text-title-1">{S.title}</h1>
          <p className="al-text-body al-muted">
            {S.app} {version ?? S.versionUnknown} · {S.subtitle}
          </p>
        </header>
        <Button variant="secondary" className="dg-copy" onClick={onCopy}>
          {S.copy}
        </Button>
      </div>
      <p className="dg-note al-text-body-sm" role="status" aria-live="polite">
        {note}
      </p>
      {rows.length === 0 ? (
        <p className="al-text-body al-muted">{S.none}</p>
      ) : (
        <div className="dg-table-wrap">
          <table className="dg-table" aria-label={S.tableLabel}>
            <thead>
              <tr>
                <th scope="col">{S.colApp}</th>
                <th scope="col">{S.colAgent}</th>
                <th scope="col">{S.colStatus}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.agent}\u0000${r.app}`}>
                  <td>
                    <bdi>{cleanLine(r.app)}</bdi>
                  </td>
                  <td>
                    <bdi>{cleanLine(r.agent)}</bdi>
                  </td>
                  <td className="al-text-code">{r.word}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="al-text-body-sm al-muted">{S.footnote}</p>
      <Surface as="section" level={1} className="dg-about" aria-labelledby="dg-about">
        <h2 id="dg-about" className="al-text-h3">
          {S.aboutTitle}
        </h2>
        <p className="al-text-body">{A.intro}</p>
        <p className="al-text-body al-muted">{A.licenceBody}</p>
        <ul className="ab-links">
          {ABOUT_LINKS.map((l) => (
            <li key={l.href}>
              <a href={l.href} target="_blank" rel="noopener noreferrer">
                {l.label}
              </a>
            </li>
          ))}
        </ul>
        <p className="al-text-caption al-muted">{A.madeBy}</p>
      </Surface>
    </div>
  );
}
