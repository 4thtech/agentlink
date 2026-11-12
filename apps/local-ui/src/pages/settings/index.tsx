// Settings home (design-1112 §3.1; mockup 03). Grouped rows: icon, title, one line and a state on
// the right. The pages come from `SETTINGS_PAGES` (nav.ts), so a page added there appears here
// exactly once. At most one notice on top, by priority: no kit, kit out of date, Touch ID not on.
// Every line comes from a real read; a read that fails falls back to plain words, never a made-up
// value, and nothing private (key, address, path of this computer) shows. The footer's version is
// the running package's, from the health read.
import { PageNotice } from '@4thtech-io/ui';
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { createApiClient, type ApiResult } from '../../api/client.js';
import { ShellIcon } from '../../layout/shell-icons.js';
import { SETTINGS_PAGES } from '../../nav.js';
import { usePrefs } from '../../prefs/index.js';
import { createApprovalsClient, type ApprovalsClient } from '../approvals/client.js';
import { browserPasskeys, OwnerPanel, useOwner } from '../approvals/index.js';
import { detectPlatform } from '../first-run/passkey.js';
import { SENSOR } from '../first-run/strings.js';
import { groupOf, settingsGroups } from './groups.js';
import { PageIcon, titleFor } from './page-meta.js';
import { readSettingsState, type SettingsState } from './state.js';
import { SETTINGS_STRINGS as S } from './strings.js';
import './settings.css';

export interface SettingsPageProps {
  /** The reads (default: the production client); a test passes its own. */
  readonly get?: (path: string) => Promise<ApiResult<unknown>>;
  /** The approvals client for the Touch ID notice (default: the production one). */
  readonly approvals?: ApprovalsClient;
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
): Line {
  switch (path) {
    case '/settings/backup': {
      const b = s?.backup;
      if (b === undefined) return { line: S.backup.fallback };
      if (b.kind === 'none') {
        return { line: S.backup.none, state: S.backup.notBackedUp, tone: 'warn' };
      }
      const stale = b.missingIds > 0 || b.missingPeople > 0;
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
        : { line: S.rules.line(s.rules.asks, s.rules.total) };
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
}): ReactElement {
  return (
    <a className="set-row" href={props.path}>
      <span className="set-row-ic" aria-hidden="true">
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

/** The one notice by priority, or undefined when the kit says nothing needs the owner. */
function KitNotice({ state }: { readonly state: SettingsState | undefined }): ReactElement | null {
  const b = state?.backup;
  if (b === undefined) return null;
  if (b.kind === 'none') {
    return (
      <PageNotice
        tone="warning"
        title={S.notice.noKitTitle}
        actions={
          <a className="al-btn al-btn-primary al-btn-sm" href="/settings/backup">
            {S.notice.noKitAction}
          </a>
        }
      >
        <p>{S.notice.noKit}</p>
      </PageNotice>
    );
  }
  if (b.missingIds === 0 && b.missingPeople === 0) return null;
  return (
    <PageNotice
      tone="warning"
      title={S.notice.staleTitle(b.missingIds, b.missingPeople)}
      actions={
        <a className="al-btn al-btn-primary al-btn-sm" href="/settings/backup">
          {S.notice.staleAction}
        </a>
      }
    >
      <p>{S.notice.stale(DAY.format(b.at))}</p>
    </PageNotice>
  );
}

export function SettingsPage({ get = productionGet, approvals }: SettingsPageProps): ReactElement {
  const prefs = usePrefs();
  const [state, setState] = useState<SettingsState | undefined>(undefined);
  const client = useMemo(() => approvals ?? createApprovalsClient(), [approvals]);
  const passkeys = browserPasskeys();
  const owner = useOwner(client, passkeys);

  useEffect(() => {
    let live = true;
    void readSettingsState(get).then((s) => {
      if (live) setState(s);
    });
    return () => {
      live = false;
    };
  }, [get]);

  const groups = settingsGroups(SETTINGS_PAGES);
  const sensor = SENSOR[detectPlatform()];
  const kit = state?.backup;
  const kitNeedsOwner =
    kit !== undefined && (kit.kind === 'none' || kit.missingIds + kit.missingPeople > 0);
  return (
    <div className="set-page">
      <h1 className="al-text-title-1">{S.title}</h1>
      {kitNeedsOwner ? (
        <KitNotice state={state} />
      ) : owner === undefined ? null : (
        <OwnerPanel owner={owner} canPasskey={passkeys} />
      )}
      {groups.map((g) => (
        <section key={g.id} className="set-group" aria-labelledby={`set-g-${g.id}`}>
          <h2 id={`set-g-${g.id}`} className="set-group-title al-text-label">
            {S.groups[groupOf(g.pages[0]?.path ?? '')]}
          </h2>
          <div className="set-list">
            {g.pages.map((p) => (
              <Row
                key={p.path}
                path={p.path}
                title={titleFor(p.path, p.label)}
                line={lineFor(p.path, state, prefs.theme, sensor)}
              />
            ))}
          </div>
        </section>
      ))}
      {state?.version === undefined ? null : (
        <p className="set-footer al-text-caption al-muted">{S.footer.upToDate(state.version)}</p>
      )}
    </div>
  );
}
