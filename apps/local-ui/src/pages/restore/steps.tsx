// The four steps of the restore wizard, plus the presence sheet, the Check result and the moving
// page (UX1113-R3; spec §6.4 to §6.6). They draw only what their props hold: the page (index.tsx)
// owns the calls. Names from a kit are rendered as text. The master code is held in a prop for as
// long as the card is on screen: never stored, never put in an attribute or a URL.
import { Banner, Button, Icon, Lockup } from '@4thtech-io/ui';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type DragEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useTitleFocus } from '../welcome/index.js';
import { UseCodeInstead, copyBackupCode } from '../first-run/backup-code.js';
import type { DetectedApp } from '../first-run/apps-api.js';
import type { FoundKit, Summary, SummaryRow } from './api.js';
import { CodeField, isComplete } from './code-field.js';
import {
  CHECKED,
  CODE,
  HOW,
  KIT,
  NEEDS_TERMINAL,
  PRESENCE,
  PROTECT,
  REVIEW,
  STEP_IDS,
  WIZARD,
  type StepId,
} from './strings.js';
import './restore.css';

// --- formatting ---------------------------------------------------------------------------------

/** Seconds (or milliseconds) since 1970 as a calendar date: "3 Nov 2026". */
export function formatDate(stamp: number): string {
  const ms = stamp > 1e12 ? stamp : stamp * 1000;
  return new Date(ms).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function formatSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

/** "Tali", "Tali and Work", "Tali, Work and Home". */
export function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] as string}`;
}

// --- frame --------------------------------------------------------------------------------------

export interface FrameProps {
  readonly step: StepId;
  /** Check my kit shows two steps. */
  readonly check?: boolean;
  readonly onCancel: () => void;
  readonly children?: ReactNode;
}

export function Frame({ step, check, onCancel, children }: FrameProps): ReactElement {
  const total = check === true ? 2 : 4;
  const n = STEP_IDS.indexOf(step) + 1;
  const label = (check === true ? WIZARD.stepLabelCheck : WIZARD.stepLabel)(
    n,
    WIZARD.stepNames[step],
  );
  return (
    <div className="rs-wizard">
      <header className="rs-head">
        <Lockup size={22} />
        <div className="rs-head-end">
          <span
            className="rs-progress"
            role="progressbar"
            aria-label={WIZARD.progressLabel}
            aria-valuemin={1}
            aria-valuemax={total}
            aria-valuenow={n}
            aria-valuetext={label}
          >
            <span className="rs-segs" aria-hidden="true">
              {STEP_IDS.slice(0, total).map((id, i) => (
                <span
                  key={id}
                  className="rs-seg"
                  data-state={i < n - 1 ? 'done' : i === n - 1 ? 'current' : 'todo'}
                />
              ))}
            </span>
            <span className="rs-eyebrow">{label}</span>
          </span>
          <button type="button" className="rs-cancel al-text-body-sm" onClick={onCancel}>
            {WIZARD.cancel}
          </button>
        </div>
      </header>
      <div className="rs-body">{children}</div>
    </div>
  );
}

function Title({
  id,
  children,
}: {
  readonly id: string;
  readonly children: ReactNode;
}): ReactElement {
  const ref = useTitleFocus<HTMLHeadingElement>();
  return (
    <h1 id={id} ref={ref} tabIndex={-1} className="rs-title">
      {children}
    </h1>
  );
}

const Assure = ({ children }: { readonly children: ReactNode }): ReactElement => (
  <p className="rs-assure al-text-body-sm">
    <Icon name="key-round" size={18} />
    <span>{children}</span>
  </p>
);

// --- step 1 -------------------------------------------------------------------------------------

export interface KitStepProps {
  readonly kits: readonly FoundKit[] | undefined;
  readonly choice: string | undefined;
  readonly onChoice: (handle: string) => void;
  readonly picked: { readonly name: string } | undefined;
  readonly onFile: (file: File) => void;
  readonly working: boolean;
  readonly error: string | undefined;
  readonly errorHint?: string;
  readonly onContinue: () => void;
  readonly onStartFresh: () => void;
  readonly eyebrow: string;
}

export function KitStep(p: KitStepProps): ReactElement {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [fresh, setFresh] = useState(false);
  const errId = useId();
  const drop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setOver(false);
    const file = event.dataTransfer.files[0];
    if (file !== undefined) p.onFile(file);
  };
  return (
    <section className="rs-screen" aria-labelledby="rs-h">
      <div className="rs-intro">
        <p className="rs-kicker">{p.eyebrow}</p>
        <Title id="rs-h">{KIT.title}</Title>
        <p className="rs-lead">
          {KIT.lead}
          <strong>{KIT.leadName}</strong>.
        </p>
      </div>
      {p.kits === undefined ? (
        <p className="rs-hint" role="status">
          {KIT.looking}
        </p>
      ) : p.kits.length === 0 ? null : (
        <div className="rs-kits" role="radiogroup" aria-labelledby="rs-found">
          <p id="rs-found" className="rs-label">
            {KIT.found}
          </p>
          {p.kits.map((k) => (
            <label key={k.handle} className="rs-kit">
              <input
                type="radio"
                name="kit"
                value={k.handle}
                checked={p.choice === k.handle}
                onChange={() => p.onChoice(k.handle)}
              />
              <span className="rs-kit-icon" aria-hidden="true">
                <Icon name="file" size={20} />
              </span>
              <span className="rs-kit-text">
                <span className="rs-kit-name">{k.name}</span>
                <span className="rs-kit-meta">
                  {KIT.foundLine(
                    (KIT.folders as Record<string, string>)[k.folder] ?? k.folder,
                    formatDate(k.modifiedAt),
                    formatSize(k.size),
                  )}
                </span>
              </span>
              <span className="rs-tick" aria-hidden="true">
                <Icon name="check" size={16} />
              </span>
            </label>
          ))}
        </div>
      )}
      <div
        className="rs-drop"
        data-over={over}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
      >
        <Icon name="download" size={28} />
        <strong>{KIT.dropTitle}</strong>
        <p>{KIT.dropHint}</p>
        <input
          ref={input}
          className="rs-file-input"
          type="file"
          tabIndex={-1}
          aria-label={KIT.choose}
          data-restore-file=""
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            if (file !== undefined) p.onFile(file);
            e.currentTarget.value = '';
          }}
        />
        <Button onClick={() => input.current?.click()}>{KIT.choose}</Button>
        {p.picked === undefined ? null : (
          <p className="al-text-body-sm" role="status">
            {KIT.picked(p.picked.name)}
          </p>
        )}
      </div>
      <Assure>{KIT.assurance}</Assure>
      {p.error === undefined ? null : (
        <div id={errId} role="alert">
          <Banner tone="warning">
            {p.error}
            {p.errorHint === undefined ? null : <> {p.errorHint}</>}
          </Banner>
        </div>
      )}
      <div className="rs-actions">
        <Button variant="primary" size="lg" disabled={p.working} onClick={p.onContinue}>
          {p.working ? KIT.working : KIT.next}
        </Button>
        <button
          type="button"
          className="rs-link"
          onClick={() => setFresh(!fresh)}
          aria-expanded={fresh}
        >
          {KIT.noFile}
        </button>
      </div>
      {fresh ? (
        <Banner
          tone="info"
          action={
            <Button size="sm" onClick={p.onStartFresh}>
              {KIT.startFresh}
            </Button>
          }
        >
          {KIT.noFileBody}
        </Banner>
      ) : null}
    </section>
  );
}

// --- presence (a computer that already has an owner) ---------------------------------------------

export interface PresenceStepProps {
  readonly sensor: string;
  /** True when this browser can use the stored passkey. */
  readonly hasPasskey: boolean;
  readonly working: boolean;
  readonly error: string | undefined;
  readonly onPasskey: () => void;
  readonly onCode: (code: string) => void;
  readonly onBack: () => void;
}

export function PresenceStep(p: PresenceStepProps): ReactElement {
  const [code, setCode] = useState('');
  const [useCode, setUseCode] = useState(!p.hasPasskey);
  useEffect(() => {
    if (!p.hasPasskey) setUseCode(true);
  }, [p.hasPasskey]);
  const id = useId();
  return (
    <section className="rs-screen" aria-labelledby="rs-h">
      <div className="rs-intro">
        <Title id="rs-h">{PRESENCE.title}</Title>
        <p className="rs-lead">{PRESENCE.lead(p.sensor)}</p>
      </div>
      {useCode ? (
        <form
          className="rs-intro"
          onSubmit={(e) => {
            e.preventDefault();
            const value = code;
            setCode('');
            if (value !== '') p.onCode(value);
          }}
        >
          <label htmlFor={id} className="rs-label">
            {PRESENCE.codeLabel}
          </label>
          <input
            id={id}
            className="rs-code-box"
            style={{ textAlign: 'start', paddingInline: 'var(--al-space-4)' }}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={code}
            disabled={p.working}
            onChange={(e) => setCode(e.currentTarget.value)}
          />
          <p className="rs-hint">{PRESENCE.warning}</p>
          <div className="rs-actions">
            <Button variant="primary" size="lg" type="submit" disabled={p.working || code === ''}>
              {PRESENCE.useCode}
            </Button>
            <Button variant="ghost" onClick={p.onBack}>
              {WIZARD.back}
            </Button>
          </div>
        </form>
      ) : (
        <div className="rs-actions">
          <Button variant="primary" size="lg" disabled={p.working} onClick={p.onPasskey}>
            {PRESENCE.usePasskey(p.sensor)}
          </Button>
          <UseCodeInstead onClick={() => setUseCode(true)} />
          <Button variant="ghost" onClick={p.onBack}>
            {WIZARD.back}
          </Button>
        </div>
      )}
      {p.error === undefined ? null : (
        <div role="alert">
          <Banner tone="warning">{p.error}</Banner>
        </div>
      )}
    </section>
  );
}

// --- step 2 -------------------------------------------------------------------------------------

export interface CodeStepProps {
  readonly eyebrow: string;
  readonly savedDate: string | undefined;
  readonly groups: readonly string[];
  readonly onGroups: (groups: string[]) => void;
  readonly working: boolean;
  /** A wait after wrong tries: Open stays off. */
  readonly blocked?: boolean;
  readonly error: string | undefined;
  readonly onOpen: () => void;
  readonly onBack: () => void;
  readonly onStartFresh: () => void;
}

export function CodeStep(p: CodeStepProps): ReactElement {
  const [lost, setLost] = useState(false);
  const hintId = useId();
  const complete = isComplete(p.groups);
  return (
    <section className="rs-screen" aria-labelledby="rs-h">
      <div className="rs-intro">
        <p className="rs-kicker">{p.eyebrow}</p>
        <Title id="rs-h">{CODE.title}</Title>
        <p className="rs-lead">
          {p.savedDate === undefined ? CODE.leadNoDate : CODE.lead(p.savedDate)}
        </p>
      </div>
      <div className="rs-intro">
        <CodeField
          value={p.groups}
          onChange={p.onGroups}
          disabled={p.working}
          invalid={p.error !== undefined}
          describedBy={hintId}
          onSubmit={() => {
            if (complete && !p.working) p.onOpen();
          }}
        />
        <p id={hintId} className="rs-hint">
          {CODE.hint}
        </p>
      </div>
      <Banner tone="warning" title={CODE.warnTitle}>
        {CODE.warn}
      </Banner>
      <Assure>{CODE.assurance}</Assure>
      {p.error === undefined ? null : (
        <div role="alert">
          <Banner tone="danger">{p.error}</Banner>
        </div>
      )}
      {p.working ? (
        <p className="rs-spin" role="status">
          {CODE.opening}
        </p>
      ) : null}
      <div className="rs-actions">
        <Button
          variant="primary"
          size="lg"
          disabled={p.working || p.blocked === true || !complete}
          onClick={p.onOpen}
        >
          {p.working ? CODE.opening : CODE.open}
        </Button>
        <Button variant="ghost" size="lg" disabled={p.working} onClick={p.onBack}>
          {WIZARD.back}
        </Button>
        <button
          type="button"
          className="rs-link rs-end"
          aria-expanded={lost}
          onClick={() => setLost(!lost)}
        >
          {CODE.lost}
        </button>
      </div>
      {lost ? (
        <Banner
          tone="info"
          action={
            <Button size="sm" onClick={p.onStartFresh}>
              {CODE.startFresh}
            </Button>
          }
        >
          {CODE.lostBody}
        </Banner>
      ) : null}
    </section>
  );
}

// --- Check my kit result ------------------------------------------------------------------------

export function CheckedStep({
  summary,
  onDone,
  onAnother,
}: {
  readonly summary: Summary;
  readonly onDone: () => void;
  readonly onAnother: () => void;
}): ReactElement {
  const names = summary.ids.map((r) => r.name);
  const people = summary.ids.reduce((n, r) => n + r.people, 0);
  const last = summary.ids.reduce<number | null>(
    (m, r) => (r.lastMessageAt === null ? m : Math.max(m ?? 0, r.lastMessageAt)),
    null,
  );
  return (
    <section className="rs-screen" aria-labelledby="rs-h">
      <div className="rs-done-mark" aria-hidden="true">
        <Icon name="check" size={36} />
      </div>
      <div className="rs-intro">
        <Title id="rs-h">{CHECKED.title}</Title>
        <p className="rs-lead">
          {names.length === 0
            ? CHECKED.bodyNone(formatDate(summary.createdAt))
            : CHECKED.body(
                formatDate(summary.createdAt),
                nameList(names),
                people,
                last === null || summary.contents === 'identity' ? undefined : formatDate(last),
              )}
        </p>
        <p className="rs-hint">{CHECKED.note}</p>
      </div>
      <div className="rs-actions">
        <Button variant="primary" size="lg" onClick={onDone}>
          {CHECKED.done}
        </Button>
        <Button variant="ghost" size="lg" onClick={onAnother}>
          {CHECKED.another}
        </Button>
      </div>
    </section>
  );
}

// --- step 3 -------------------------------------------------------------------------------------

const NAME_RULE = /^[a-z][a-z0-9-]{0,31}$/;

export interface ReviewState {
  /** Ticked agent ids. */
  readonly selected: ReadonlySet<string>;
  /** The name each ID comes back as (suggested or typed). */
  readonly names: Readonly<Record<string, string>>;
}

export interface ReviewStepProps {
  readonly summary: Summary;
  readonly state: ReviewState;
  readonly onState: (next: ReviewState) => void;
  readonly sensor: string;
  readonly newOwner: boolean;
  readonly working: boolean;
  readonly error: string | undefined;
  readonly onRestore: () => void;
  readonly onBack: () => void;
  readonly onDone: () => void;
}

function Row({
  row,
  state,
  onState,
  summary,
  disabled,
}: {
  readonly row: SummaryRow;
  readonly state: ReviewState;
  readonly onState: (next: ReviewState) => void;
  readonly summary: Summary;
  readonly disabled: boolean;
}): ReactElement {
  const off = row.state === 'already_here' || row.state === 'removed_earlier';
  const checked = !off && state.selected.has(row.agentId);
  const [editing, setEditing] = useState(false);
  const typed = state.names[row.agentId] ?? row.suggestedName ?? row.name;
  const [draft, setDraft] = useState(typed);
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const nameId = useId();
  const last =
    row.lastMessageAt === null || summary.contents === 'identity'
      ? undefined
      : formatDate(row.lastMessageAt);
  const toggle = (): void => {
    if (off || disabled) return;
    const next = new Set(state.selected);
    if (checked) next.delete(row.agentId);
    else next.add(row.agentId);
    onState({ ...state, selected: next });
  };
  const useName = (): void => {
    const name = draft.trim().toLowerCase();
    if (!NAME_RULE.test(name)) return setProblem(REVIEW.nameInvalid);
    const clash = summary.ids.some((r) => r.agentId !== row.agentId && r.name === name);
    const other = Object.entries(state.names).some(([id, n]) => id !== row.agentId && n === name);
    if (clash || other) return setProblem(REVIEW.nameClash);
    setProblem(undefined);
    setEditing(false);
    onState({ ...state, names: { ...state.names, [row.agentId]: name } });
  };
  const initial = [...row.name][0]?.toUpperCase() ?? '?';
  return (
    <li className="rs-row" data-state={row.state} data-off={off}>
      <label className="rs-pick">
        <input
          type="checkbox"
          checked={checked}
          disabled={off || disabled}
          aria-label={REVIEW.pick(row.name)}
          onChange={toggle}
        />
        <span className="rs-tick" aria-hidden="true">
          <Icon name="check" size={16} />
        </span>
      </label>
      <span className="rs-avatar" aria-hidden="true">
        {initial}
      </span>
      <span className="rs-row-text">
        <bdi className="rs-row-name">{row.name}</bdi>
        <span className="rs-row-line">
          {row.state === 'new' ? (
            summary.contents === 'identity' ? (
              REVIEW.newLineIdentity(row.people)
            ) : (
              REVIEW.newLine(row.people, last)
            )
          ) : row.state === 'name_taken' ? (
            <>
              {REVIEW.takenLine(row.people, row.name)}
              <strong>
                <bdi>{typed}</bdi>
              </strong>
            </>
          ) : row.state === 'already_here' ? (
            REVIEW.hereLine
          ) : (
            REVIEW.removedLine('')
          )}
        </span>
        {editing ? (
          <span className="rs-row-edit">
            <label htmlFor={nameId} className="al-sr-only">
              {REVIEW.nameLabel(row.name)}
            </label>
            <input
              id={nameId}
              className="rs-code-box"
              style={{
                blockSize: 40,
                textAlign: 'start',
                paddingInline: 'var(--al-space-3)',
                maxInlineSize: 220,
              }}
              type="text"
              autoComplete="off"
              spellCheck={false}
              maxLength={32}
              value={draft}
              onChange={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  useName();
                }
              }}
            />
            <Button size="sm" onClick={useName}>
              {REVIEW.nameSave}
            </Button>
            {problem === undefined ? null : (
              <span className="rs-error" role="alert">
                {problem}
              </span>
            )}
          </span>
        ) : null}
      </span>
      {row.state === 'name_taken' ? (
        <Button size="sm" disabled={disabled} onClick={() => setEditing(!editing)}>
          {REVIEW.changeName}
        </Button>
      ) : (
        <span className="rs-chip" data-tone={row.state === 'new' ? 'success' : 'neutral'}>
          {row.state === 'new'
            ? REVIEW.willBeRestored
            : row.state === 'already_here'
              ? REVIEW.alreadyHere
              : REVIEW.removedEarlier}
        </span>
      )}
    </li>
  );
}

export function ReviewStep(p: ReviewStepProps): ReactElement {
  const { summary } = p;
  const choosable = summary.ids.filter((r) => r.state === 'new' || r.state === 'name_taken');
  const count = choosable.filter((r) => p.state.selected.has(r.agentId)).length;
  const date = formatDate(summary.createdAt);
  const names = summary.ids.filter((r) => r.state === 'new' || r.state === 'name_taken').length;
  void names;
  return (
    <section className="rs-screen rs-wide" aria-labelledby="rs-h">
      <div className="rs-intro">
        <p className="rs-kicker">{REVIEW.eyebrow(date)}</p>
        <Title id="rs-h">{REVIEW.title}</Title>
        <p className="rs-lead">{REVIEW.lead}</p>
      </div>
      <ul className="rs-list" aria-label={REVIEW.listLabel}>
        {summary.ids.map((row) => (
          <Row
            key={row.agentId}
            row={row}
            state={p.state}
            onState={p.onState}
            summary={summary}
            disabled={p.working}
          />
        ))}
      </ul>
      {choosable.length === 0 ? (
        <Banner tone="info">{REVIEW.nothing}</Banner>
      ) : (
        <div className="rs-cols">
          <div>
            <h2>{REVIEW.comesBack}</h2>
            <ul className="rs-bullets" data-tone="ok">
              {[
                ...REVIEW.comes,
                ...(summary.contents === 'identity' ? [] : [REVIEW.comesSince(date)]),
              ].map((t) => (
                <li key={t}>
                  <Icon name="check" size={16} />
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h2>{REVIEW.doNext}</h2>
            <ul className="rs-bullets" data-tone="todo">
              {REVIEW.next(p.sensor, p.newOwner).map((t) => (
                <li key={t}>
                  <Icon name="arrow-right" size={16} />
                  <span>{t}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {p.error === undefined ? null : (
        <div role="alert">
          <Banner tone="danger">{p.error}</Banner>
        </div>
      )}
      {p.working ? (
        <p className="rs-spin" role="status">
          {REVIEW.progress(
            choosable.find((r) => p.state.selected.has(r.agentId))?.name ?? '',
            1,
            Math.max(1, count),
          )}
        </p>
      ) : null}
      <div className="rs-actions">
        {choosable.length === 0 ? (
          <Button variant="primary" size="lg" onClick={p.onDone}>
            {REVIEW.done}
          </Button>
        ) : (
          <Button
            variant="primary"
            size="lg"
            disabled={p.working || count === 0}
            onClick={p.onRestore}
          >
            {p.working
              ? REVIEW.restoring
              : p.error === undefined
                ? REVIEW.restore(count)
                : REVIEW.tryAgain}
          </Button>
        )}
        <Button variant="ghost" size="lg" disabled={p.working} onClick={p.onBack}>
          {WIZARD.back}
        </Button>
      </div>
      <details className="rs-hood">
        <summary>{REVIEW.hood}</summary>
        <p>{REVIEW.hoodKit(summary.kitId, summary.contents)}</p>
        {summary.ids.map((r) => (
          <p key={r.agentId}>
            <bdi>{r.name}</bdi> · <code>{r.agentId}</code>
          </p>
        ))}
      </details>
    </section>
  );
}

// --- step 4 -------------------------------------------------------------------------------------

export interface AppRow {
  readonly app: DetectedApp;
}

export interface ProtectStepProps {
  readonly restored: readonly string[];
  readonly failed: readonly string[];
  readonly masterCode: string | undefined;
  readonly sensor: string;
  readonly touchId: boolean;
  readonly savedDate: string;
  readonly apps: readonly DetectedApp[] | undefined;
  readonly idName: string;
  readonly connecting: string | undefined;
  readonly onConnect: (appId: string) => void;
  /** The inline connect flow for the app being connected. */
  readonly connectView: ReactNode;
  readonly saved: boolean;
  readonly onSaved: (value: boolean) => void;
  readonly onHome: () => void;
  readonly storage: boolean;
}

function Code({
  code,
  onPrint,
}: {
  readonly code: string;
  readonly onPrint: () => void;
}): ReactElement {
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no');
  return (
    <>
      <div className="rs-secret-head">
        <span>
          <Icon name="key-round" size={18} /> {PROTECT.codeTitle}
        </span>
        <span className="rs-chip">{PROTECT.shownOnce}</span>
      </div>
      <p className="rs-secret-val" data-master-code="">
        {code}
      </p>
      <div className="rs-actions">
        <Button
          icon={copied === 'yes' ? 'check' : 'copy'}
          onClick={() => void copyBackupCode(code).then((ok) => setCopied(ok ? 'yes' : 'failed'))}
        >
          {copied === 'yes' ? PROTECT.copied : PROTECT.copy}
        </Button>
        <Button icon="printer" onClick={onPrint}>
          {PROTECT.print}
        </Button>
      </div>
      {copied === 'failed' ? (
        <p className="rs-error" role="alert">
          {PROTECT.copyFailed}
        </p>
      ) : null}
    </>
  );
}

export function ProtectStep(p: ProtectStepProps): ReactElement {
  const code = p.masterCode;
  const ready = code === undefined || p.saved;
  return (
    <section className="rs-screen rs-wide" aria-labelledby="rs-h">
      <div className="rs-done-mark" aria-hidden="true">
        <Icon name="check" size={36} />
      </div>
      <div className="rs-intro">
        <Title id="rs-h">{PROTECT.title(p.restored.length)}</Title>
        {p.restored.length === 0 ? null : (
          <p className="rs-lead">{PROTECT.lead(nameList(p.restored))}</p>
        )}
      </div>
      {p.failed.length === 0 ? null : (
        <Banner tone="warning">{PROTECT.partial(nameList(p.failed))}</Banner>
      )}
      {code === undefined ? (
        <Banner tone="success">{PROTECT.unchanged(p.sensor)}</Banner>
      ) : (
        <div className="rs-secret">
          <Code code={code} onPrint={() => window.print()} />
          <p>{p.touchId ? PROTECT.codeBody(p.sensor) : PROTECT.codeBodyNoSensor}</p>
          <label className="rs-saved">
            <input
              type="checkbox"
              checked={p.saved}
              onChange={(e) => p.onSaved(e.currentTarget.checked)}
            />
            <span className="rs-tick" aria-hidden="true">
              <Icon name="check" size={16} />
            </span>
            <span>{PROTECT.saved}</span>
          </label>
          {/* Rendered here in memory for the printer only; never written to disk. */}
          <div className="rs-print-sheet" aria-hidden="true">
            <h1>{PROTECT.printTitle}</h1>
            <p>{PROTECT.printLead(p.savedDate)}</p>
            <p>
              <code>{code}</code>
            </p>
            <p>{PROTECT.printKeep}</p>
          </div>
        </div>
      )}
      <div className="rs-intro">
        <h2 className="rs-h2">{PROTECT.reconnect}</h2>
        {p.apps === undefined ? (
          <p className="rs-hint" role="status">
            {PROTECT.looking}
          </p>
        ) : p.apps.length === 0 ? (
          <p className="rs-hint">{PROTECT.noApps}</p>
        ) : (
          <ul className="rs-apps">
            {p.apps.map((app) => (
              <li key={app.id} className="rs-app-wrap">
                <div className="rs-app">
                  <span className="rs-mark" aria-hidden="true">
                    {[...app.name][0]?.toUpperCase() ?? '?'}
                  </span>
                  <span className="rs-row-text">
                    <span className="rs-row-name">{app.name}</span>
                    <span className="rs-row-line">
                      {app.state === 'connected' && app.agent === p.idName
                        ? PROTECT.appUses(p.idName)
                        : PROTECT.appFound}
                    </span>
                  </span>
                  {app.state === 'connected' && app.agent === p.idName ? (
                    <span className="rs-chip" data-tone="success">
                      <Icon name="check" size={14} /> {PROTECT.connected}
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      disabled={app.state === 'not_ours' || app.state === 'unreadable'}
                      onClick={() => p.onConnect(app.id)}
                    >
                      {PROTECT.connect(p.idName)}
                    </Button>
                  )}
                </div>
                {p.connecting === app.id ? (
                  <div className="rs-connect-wrap">{p.connectView}</div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      {p.storage ? <Banner tone="info">{PROTECT.storage}</Banner> : null}
      <Banner tone="warning" title={PROTECT.oldTitle}>
        {PROTECT.old}{' '}
        <a href="/restore/move" className="rs-link">
          {PROTECT.how}
        </a>
      </Banner>
      <div className="rs-actions">
        <Button variant="primary" size="lg" disabled={!ready} onClick={p.onHome}>
          {PROTECT.home}
        </Button>
        <span className="rs-hint">{ready ? PROTECT.tip(p.savedDate) : PROTECT.needSaved}</span>
      </div>
    </section>
  );
}

// --- the terminal path and the moving page --------------------------------------------------------

export function NeedsTerminal({ onBack }: { readonly onBack: () => void }): ReactElement {
  return (
    <section className="rs-screen" aria-labelledby="rs-h">
      <div className="rs-intro">
        <Title id="rs-h">{NEEDS_TERMINAL.title}</Title>
        <p className="rs-lead">{NEEDS_TERMINAL.body}</p>
      </div>
      <details className="rs-hood">
        <summary>{NEEDS_TERMINAL.hoodTitle}</summary>
        <p>
          {NEEDS_TERMINAL.hoodBody} <code>{NEEDS_TERMINAL.command}</code>
        </p>
      </details>
      <div className="rs-actions">
        <Button size="lg" onClick={onBack}>
          {NEEDS_TERMINAL.back}
        </Button>
      </div>
    </section>
  );
}

export function HowToMove({
  onStart,
  onBack,
}: {
  readonly onStart: () => void;
  readonly onBack: () => void;
}): ReactElement {
  return (
    <section className="rs-screen" aria-labelledby="rs-h">
      <div className="rs-intro">
        <Title id="rs-h">{HOW.title}</Title>
        <p className="rs-lead">{HOW.lead}</p>
      </div>
      <ol className="rs-steps">
        {HOW.steps.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      <div className="rs-actions">
        <Button variant="primary" size="lg" onClick={onStart}>
          {HOW.start}
        </Button>
        <Button variant="ghost" size="lg" onClick={onBack}>
          {HOW.back}
        </Button>
      </div>
    </section>
  );
}
