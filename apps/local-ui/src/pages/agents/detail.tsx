// W4-AGENTS (W4 UX v2 "per-agent detail page"; `/agents/<name>`): one agent's own page. Its live
// line and Pause or Resume; its AI apps with their words, Connect and Disconnect, and a heartbeat
// history drawn only from the reads this page saw while it was open (history.ts: never a made-up
// bar); its people and rules (the open agent's; another agent's page offers to open it); what
// changed while the page was open; and the recovery kit in Settings. Labels and names are text only:
// labels in their own bidi run, contact names under the name rule (I-5, 11 §5.2).
import { AgentIcon, Button, ContactName, Icon, useHood } from '@4thtech-io/ui';
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import type { OwnerClient } from '../contacts/owner.js';
import type { AppsApi } from '../apps/api.js';
import type { RulesView } from '../rules/data.js';
import { AppsPanel } from './apps-panel.js';
import { agentLine, appWord, dotOf, stateOf, type AgentRow } from './data.js';
import type { DetailApi, PeopleRead, RulesRead } from './detail-api.js';
import { historyOf, stateChangesOf } from './history.js';
import { BackupPanel } from './simple.js';
import { LIVE_WORDS as W } from '../../api/live.js';
import { AGENTS_STRINGS as S } from './strings.js';

const PEOPLE_SHOWN = 12;

function Section({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <section className="ag-section">
      <h2 className="al-text-title-3">{title}</h2>
      {children}
    </section>
  );
}

/** One bar per read this page saw: tall while Working, half while Ready or Idle, a sliver otherwise. */
function Sparkline({
  agent,
  app,
  name,
  word,
}: {
  agent: string;
  app: string;
  name: string;
  word: string;
}): ReactElement | null {
  const samples = historyOf(agent, app);
  if (samples.length < 2) return null;
  return (
    <span
      className="ag-spark"
      role="img"
      aria-label={S.sparkLabel(name, samples.length, word)}
      data-sparkline={app}
    >
      {samples.map((s) => (
        <span key={s.at} className={`ag-bar is-${s.state}`} />
      ))}
    </span>
  );
}

const ruleWord = (v: 'allow' | 'approval' | 'deny' | 'auto'): string =>
  v === 'allow' || v === 'auto' ? S.ruleAllow : v === 'approval' ? S.ruleAsk : S.ruleNever;

function RulesLines({ rules }: { rules: RulesView }): ReactElement {
  return (
    <ul className="ag-plain al-text-body-sm">
      <li>{S.ruleProofs(ruleWord(rules.proofs.notarize))}</li>
      <li>{S.ruleContacts(ruleWord(rules.contacts.acceptInvites))}</li>
      <li>{S.ruleFiles(rules.files.maxSendSizeMB, rules.files.maxReceiveSizeMB)}</li>
    </ul>
  );
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function AgentDetail({
  row,
  now,
  detailApi,
  owner,
  apps,
  labelOf,
  banner,
  onPause,
  onResume,
  onSwitch,
  onAppsElsewhere,
  onChanged,
  onAgentChanged,
}: {
  row: AgentRow;
  now: number;
  detailApi: DetailApi;
  owner: OwnerClient;
  apps?: AppsApi;
  labelOf: (folder: string) => string;
  /** The paused banner (with Resume), for the open agent. */
  banner: ReactElement | null;
  onPause: (row: AgentRow) => void;
  onResume: (row: AgentRow) => void;
  onSwitch: (row: AgentRow) => void;
  onAppsElsewhere: (row: AgentRow) => void;
  onChanged: () => void;
  onAgentChanged: () => void;
}): ReactElement {
  const hood = useHood();
  const state = stateOf(row);
  const [people, setPeople] = useState<PeopleRead | undefined>(undefined);
  const [rules, setRules] = useState<RulesRead | undefined>(undefined);
  const current = row.current;

  useEffect(() => {
    if (!current) return undefined;
    let live = true;
    void detailApi.people().then((r) => {
      if (live) setPeople(r);
    });
    void detailApi.rules().then((r) => {
      if (live) setRules(r);
    });
    return () => {
      live = false;
    };
  }, [current, detailApi]);

  const changes = [...stateChangesOf(row.name)].reverse();

  return (
    <div className="ag-detail">
      <a className="ag-back al-text-body-sm" href="/agents">
        <Icon name="chevron-right" size={14} className="ag-back-icon" />
        {S.backToAgents}
      </a>
      <div className="ag-detail-head">
        <AgentIcon label={row.label} seed={row.name} size="lg" dot={dotOf(row)} />
        <div className="ag-card-title">
          <h1 className="al-text-h1 ag-label">
            <bdi>{row.label}</bdi>
          </h1>
          <span className={`ag-line al-text-body is-${state}`}>{agentLine(row, now)}</span>
          {hood ? (
            <span className="al-text-body-sm al-muted al-text-code">{S.folder(row.name)}</span>
          ) : null}
        </div>
        <div className="ag-actions">
          {row.removing ? null : (
            <Button
              variant="secondary"
              icon={state === 'paused' ? 'play' : 'pause'}
              onClick={() => (state === 'paused' ? onResume(row) : onPause(row))}
            >
              {state === 'paused' ? S.resume : S.pause}
            </Button>
          )}
          {current ? null : (
            <Button variant="ghost" onClick={() => onSwitch(row)}>
              {S.openAgent}
            </Button>
          )}
        </div>
      </div>
      {banner}

      <div className="ag-sections">
        <Section title={S.aiApps}>
          {hood ? <p className="al-text-body-sm al-muted">{S.historyNote}</p> : null}
          <AppsPanel
            row={row}
            labelOf={labelOf}
            owner={owner}
            {...(apps === undefined ? {} : { apps })}
            now={now}
            onOtherAgent={() => onAppsElsewhere(row)}
            onChanged={onChanged}
            onAgentChanged={onAgentChanged}
            extra={(a) => (
              <Sparkline agent={row.name} app={a.id} name={a.name} word={appWord(a, now)} />
            )}
          />
        </Section>

        <Section title={S.people}>
          {!current ? (
            <p className="al-text-body-sm al-muted">
              {S.contactsCount(row.contacts)} · {S.peopleOther(row.label)}
            </p>
          ) : people === undefined ? (
            <p className="al-text-body-sm al-muted">{S.reading}</p>
          ) : people.kind === 'error' ? (
            <p className="al-text-body-sm al-muted">{S.peopleUnavailable}</p>
          ) : people.people.length === 0 ? (
            <p className="al-text-body-sm al-muted">{S.noPeople}</p>
          ) : (
            <ul className="ag-plain">
              {people.people.slice(0, PEOPLE_SHOWN).map((c) => (
                <li key={c.ref} className="al-text-body-sm">
                  <ContactName
                    {...(c.nameSource === 'owner' ? { alias: c.name } : { name: c.name })}
                    {...(c.fingerprint === undefined ? {} : { fingerprint: c.fingerprint })}
                    {...(c.label === 'safety-code-checked' ? { label: 'checked' as const } : {})}
                  />
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title={S.rules}>
          {!current ? (
            <p className="al-text-body-sm al-muted">{S.rulesOther(row.label)}</p>
          ) : rules === undefined ? (
            <p className="al-text-body-sm al-muted">{S.reading}</p>
          ) : rules.kind === 'error' ? (
            <p className="al-text-body-sm al-muted">{S.rulesUnavailable}</p>
          ) : (
            <>
              <RulesLines rules={rules.rules} />
              <a className="ag-link al-text-body-sm" href="/settings/rules">
                {S.seeRules}
              </a>
            </>
          )}
        </Section>

        <Section title={S.activity}>
          {changes.length === 0 ? (
            <p className="al-text-body-sm al-muted">{S.noActivity}</p>
          ) : (
            <ul className="ag-plain al-text-body-sm">
              {changes.map((c) => (
                <li key={c.at} className="ag-event">
                  <span className="al-muted">{clock(c.at)}</span>
                  <span>
                    {c.state === 'paused'
                      ? W.paused
                      : c.state === 'working' && c.app !== undefined
                        ? W.workingIn(c.app)
                        : c.state === 'ready' && c.app !== undefined
                          ? W.readyIn(c.app)
                          : c.state === 'idle'
                            ? W.idle
                            : c.state === 'ready'
                              ? W.ready
                              : W.offline}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {current ? (
            <a className="ag-link al-text-body-sm" href="/activity">
              {S.seeAllActivity}
            </a>
          ) : null}
        </Section>

        <Section title={S.backup}>
          <BackupPanel />
        </Section>
      </div>
    </div>
  );
}
