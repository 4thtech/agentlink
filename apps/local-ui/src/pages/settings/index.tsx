// Settings home (design-1112 §3.1; mockup 03). Grouped rows: icon, title, one line and a state on
// the right. The pages come from `SETTINGS_PAGES` (nav.ts), so a page added there appears here
// exactly once. At most one notice on top, by priority: no kit, kit out of date, Touch ID not on.
// Every line comes from a real read; a read that fails falls back to plain words, never a made-up
// value, and nothing private (key, address, path of this computer) shows. The footer's version is
// the running package's, from the health read.
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactElement } from 'react';
import { getLive, subscribeLive } from '../../api/live.js';
import { createApiClient, type ApiResult } from '../../api/client.js';
import { ShellIcon } from '../../layout/shell-icons.js';
import { settingsPages, type SettingsPage as SettingsPageEntry } from '../../nav.js';
import { usePrefs } from '../../prefs/index.js';
import { createApprovalsClient, type ApprovalsClient } from '../approvals/client.js';
import { browserPasskeys, OwnerPanel, useOwner } from '../approvals/index.js';
import { detectPlatform } from '../first-run/passkey.js';
import { SENSOR } from '../first-run/strings.js';
import { settingsGroups } from './groups.js';
import { SettingsIcon } from './icons.js';
import { PageIcon, titleFor } from './page-meta.js';
import { readSettingsState, type SettingsState } from './state.js';
import { SETTINGS_STRINGS as S } from './strings.js';
import './settings.css';

export interface SettingsPageProps {
  /** The reads (default: the production client); a test passes its own. */
  readonly get?: (path: string) => Promise<ApiResult<unknown>>;
  /** The approvals client for the Touch ID notice (default: the production one). */
  readonly approvals?: ApprovalsClient;
  /** The pages (default: settingsPages()); a test injects entries other work packages add. */
  readonly pages?: readonly SettingsPageEntry[];
}

const productionGet = (path: string): Promise<ApiResult<unknown>> => createApiClient().get(path);

const DAY = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

type Tone = 'good' | 'warn' | 'plain';
interface Line {
  readonly line: string;
  readonly state?: string;
  readonly tone?: Tone;
}

function themeWord(theme: 'system' | 'light' | 'dark'): string {
  return theme === 'light'
    ? S.appearance.light
    : theme === 'dark'
      ? S.appearance.dark
      : S.appearance.system;
}

/** One row's line and state, from what was read (undefined reads give the plain fallback). */
export function lineFor(
  path: string,
  s: SettingsState | undefined,
  theme: 'system' | 'light' | 'dark',
  sensor: string,
  idName?: string,
): Line {
  switch (path) {
    case '/settings/backup': {
      const b = s?.backup;
      if (b === undefined) return { line: S.backup.fallback };
      if (b.kind === 'none') {
        return { line: S.backup.none, state: S.backup.notBackedUp, tone: 'warn' };
      }
      if (b.unfinished === true) {
        return {
          line: S.backup.saved(DAY.format(b.at), b.covers.join(', ')),
          state: S.backup.notFinished,
          tone: 'warn',
        };
      }
      const stale = b.stale;
      return {
        line: S.backup.saved(DAY.format(b.at), b.covers.join(', ')),
        state: stale ? S.backup.outOfDate : S.backup.upToDate,
        tone: stale ? 'warn' : 'good',
      };
    }
    case '/settings/touch-id':
      return s?.touchId === undefined
        ? { line: S.touchId.line }
        : s.touchId
          ? { line: S.touchId.line, state: S.touchId.on(sensor), tone: 'good' }
          : { line: S.touchId.line, state: S.touchId.masterOnly, tone: 'plain' };
    case '/settings/rules':
      return s?.rules === undefined
        ? { line: S.rules.fallback }
        : {
            line: S.rules.line(s.rules.asks, s.rules.total),
            ...(idName === undefined ? {} : { state: idName, tone: 'plain' as const }),
          };
    case '/settings/apps': {
      const names = s?.apps?.apps.filter((a) => a.state === 'connected').map((a) => a.name);
      if (names === undefined) return { line: S.apps.fallback };
      return names.length === 0
        ? { line: S.apps.none }
        : { line: S.apps.line(names), state: S.apps.state(names.length), tone: 'plain' };
    }
    case '/settings/files': {
      if (s?.folders === undefined) return { line: S.files.fallback };
      const received = s.inbox === undefined ? '' : ` Received files go to ${s.inbox}.`;
      return { line: `${S.files.line(s.folders)}${received}` };
    }
    case '/settings/storage':
      return { line: S.storage.line };
    case '/settings/updates':
      return { line: S.updates.line };
    case '/settings/appearance':
      return { line: S.appearance.line, state: themeWord(theme), tone: 'plain' };
    case '/settings/proofs':
      return s?.credits === undefined
        ? { line: S.proofs.fallback }
        : {
            line: S.proofs.line(s.credits.price),
            state: S.proofs.state(s.credits.balance, s.credits.proofsLeft),
            tone: 'plain',
          };
    case '/settings/advanced':
    case '/advanced/network':
      return s?.health === undefined
        ? { line: S.advanced.line }
        : s.health === 'working'
          ? { line: S.advanced.line, state: S.advanced.working, tone: 'good' }
          : { line: S.advanced.line, state: S.advanced.reconnecting, tone: 'warn' };
    default:
      return { line: '' };
  }
}

function Row(props: {
  readonly path: string;
  readonly title: string;
  readonly line: Line;
  readonly tile?: Tone;
}): ReactElement {
  const { tile } = props;
  return (
    <a className="set-row" href={props.path}>
      <span className={`set-row-ic${tile === undefined ? '' : ` is-${tile}`}`} aria-hidden="true">
        <PageIcon path={props.path} />
      </span>
      <span className="set-row-text">
        <span className="set-row-title">{props.title}</span>
        {props.line.line === '' ? null : <span className="set-row-line">{props.line.line}</span>}
      </span>
      {props.line.state === undefined ? null : (
        <span className={`set-state is-${props.line.tone ?? 'plain'}`}>{props.line.state}</span>
      )}
      <ShellIcon name="chev-r" size={18} className="set-chev" />
    </a>
  );
}

/** The kit notice: a tinted card, icon, bold title, a line, and the primary action on the right. */
function KitCard(props: {
  readonly title: string;
  readonly line: string;
  readonly action: string;
}): ReactElement {
  return (
    <section className="set-notice" aria-labelledby="set-notice-t">
      <span className="set-notice-ic" aria-hidden="true">
        <SettingsIcon name="shield" />
      </span>
      <div className="set-notice-text">
        <p id="set-notice-t" className="set-notice-title">
          {props.title}
        </p>
        <p className="set-notice-line">{props.line}</p>
      </div>
      <a className="al-btn al-btn-primary set-notice-act" href="/settings/backup">
        {props.action}
      </a>
    </section>
  );
}

function KitNotice({ state }: { readonly state: SettingsState | undefined }): ReactElement | null {
  const b = state?.backup;
  if (b === undefined) return null;
  if (b.kind === 'none') {
    return (
      <KitCard title={S.notice.noKitTitle} line={S.notice.noKit} action={S.notice.noKitAction} />
    );
  }
  if (!b.stale || (b.missingIds === 0 && b.missingPeople === 0)) return null;
  return (
    <KitCard
      title={S.notice.staleTitle(b.missingIds, b.missingPeople)}
      line={S.notice.stale(DAY.format(b.at))}
      action={S.notice.staleAction}
    />
  );
}

export function SettingsPage({
  get = productionGet,
  approvals,
  pages = settingsPages(),
}: SettingsPageProps): ReactElement {
  const prefs = usePrefs();
  const [state, setState] = useState<SettingsState | undefined>(undefined);
  const [query, setQuery] = useState('');
  const client = useMemo(() => approvals ?? createApprovalsClient(), [approvals]);
  const passkeys = browserPasskeys();
  const owner = useOwner(client, passkeys);
  const live = useSyncExternalStore(subscribeLive, getLive, () => LIVE_EMPTY);
  // The ID's name beside Rules, only when the owner has two or more IDs (UX1113-QA2 N4: its label,
  // the name people know; the folder name is for Under the hood).
  const idName = live.agents.length >= 2 ? live.agents.find((a) => a.current)?.label : undefined;

  useEffect(() => {
    let current = true;
    void readSettingsState(get).then((s) => {
      if (current) setState(s);
    });
    return () => {
      current = false;
    };
  }, [get]);

  const sensor = SENSOR[detectPlatform()];
  const items = settingsGroups(pages).map((g) => ({
    id: g.id,
    rows: g.pages.map((p) => ({
      path: p.path,
      title: titleFor(p.path, p.label),
      line: lineFor(p.path, state, prefs.theme, sensor, idName),
    })),
  }));
  const needle = query.trim().toLowerCase();
  const shown = items
    .map((g) => ({
      ...g,
      rows: g.rows.filter(
        (r) =>
          needle === '' ||
          r.title.toLowerCase().includes(needle) ||
          r.line.line.toLowerCase().includes(needle),
      ),
    }))
    .filter((g) => g.rows.length > 0);
  const kit = state?.backup;
  const kitNeedsOwner = kit !== undefined && (kit.kind === 'none' || kit.stale);
  return (
    <div className="set-page">
      <div className="set-head">
        <h1 className="al-text-title-1">{S.title}</h1>
        <label className="set-search">
          <ShellIcon name="search" size={16} />
          <input
            type="search"
            value={query}
            placeholder={S.search.label}
            aria-label={S.search.label}
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query !== '') {
                e.preventDefault();
                setQuery('');
              }
            }}
          />
        </label>
      </div>
      {kitNeedsOwner ? (
        <KitNotice state={state} />
      ) : owner === undefined || state?.nativeOn === true ? null : (
        <OwnerPanel owner={owner} canPasskey={passkeys} />
      )}
      {shown.map((g) => (
        <section key={g.id} className="set-group" aria-labelledby={`set-g-${g.id}`}>
          <h2 id={`set-g-${g.id}`} className="set-group-title al-text-label">
            {S.groups[g.id]}
          </h2>
          <div className="set-list">
            {g.rows.map((r) => (
              <Row
                key={r.path}
                path={r.path}
                title={r.title}
                line={r.line}
                {...(r.path === '/settings/backup' || r.path === '/settings/touch-id'
                  ? r.line.tone === undefined
                    ? {}
                    : { tile: r.line.tone }
                  : {})}
              />
            ))}
          </div>
        </section>
      ))}
      {shown.length === 0 ? (
        <p className="set-empty" role="status">
          {S.search.empty}
        </p>
      ) : null}
      {state?.version === undefined ? null : (
        <p className="set-footer al-text-caption al-muted">{S.footer.version(state.version)}</p>
      )}
    </div>
  );
}

const LIVE_EMPTY = { list: undefined, agents: [], error: false } as const;
