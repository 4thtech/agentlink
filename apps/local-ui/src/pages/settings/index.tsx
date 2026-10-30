// Settings (W4-SETTINGS-ADVANCED; prototype v23 "Settings", A9). One list: Backup & Touch ID, Files
// folder, Appearance, Rules for approvals, Proofs & credits, Notifications ("not yet") and Advanced,
// which opens in place. Each row is a link to its page (the same pages as before) with one line that
// says where it stands, from real reads: the credits and the relay count. When a read fails the line
// falls back to plain words; nothing is made up, and no address, key or path of this computer shows.
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { createApiClient, type ApiResult } from '../../api/client.js';
import { ShellIcon, type ShellIconName } from '../../layout/shell-icons.js';
import { HEALTH_PATH } from '../../layout/health.js';
import { usePrefs } from '../../prefs/index.js';
import { parseRelays, type Relays } from '../advanced/relays.js';
import { CREDITS_PATH, parseCredits, type CreditsAnswer } from '../proofs/data.js';
import { SettingsIcon, type SettingsIconName } from './icons.js';
import { SETTINGS_STRINGS as S } from './strings.js';
import './settings.css';

export interface SettingsPageProps {
  /** The reads (default: the production client); a test passes its own. */
  readonly get?: (path: string) => Promise<ApiResult<unknown>>;
}

const productionGet = (path: string): Promise<ApiResult<unknown>> => createApiClient().get(path);

function Row(props: {
  readonly href: string;
  readonly icon: SettingsIconName | ShellIconName;
  readonly title: string;
  readonly line: string;
}): ReactElement {
  const own =
    props.icon === 'backup' ||
    props.icon === 'folder' ||
    props.icon === 'appearance' ||
    props.icon === 'bell';
  return (
    <a className="st-row" href={props.href}>
      {own ? (
        <SettingsIcon name={props.icon as SettingsIconName} />
      ) : (
        <ShellIcon name={props.icon as ShellIconName} />
      )}
      <span className="st-row-text">
        <span className="st-row-title">{props.title}</span>
        <span className="st-row-line">{props.line}</span>
      </span>
      <ShellIcon name="chev-r" size={18} className="st-chev" />
    </a>
  );
}

function themeLine(theme: 'system' | 'light' | 'dark'): string {
  return theme === 'light'
    ? S.appearance.light
    : theme === 'dark'
      ? S.appearance.dark
      : S.appearance.system;
}

function AdvancedRows({
  relays,
}: {
  readonly relays: Relays | 'loading' | undefined;
}): ReactElement {
  const A = S.advanced;
  const relayText =
    relays === 'loading'
      ? ''
      : relays?.connected === undefined || relays.total === undefined
        ? A.unknown
        : A.relayCount(relays.connected, relays.total);
  return (
    <div className="st-advanced al-reveal">
      <a className="st-adv-row" href="/activity">
        <span className="st-adv-label">{A.activity}</span>
        <span className="st-adv-value">{A.open}</span>
      </a>
      <div className="st-adv-row">
        <span className="st-adv-label">{A.network}</span>
        <span className="st-adv-value">{A.auto}</span>
      </div>
      <a className="st-adv-row" href="/advanced/network">
        <span className="st-adv-label">{A.relays}</span>
        <span className="st-adv-value">{relayText}</span>
      </a>
      <a className="st-adv-row" href="/contacts">
        <span className="st-adv-label">{A.invites}</span>
        <span className="st-adv-value">{A.open}</span>
      </a>
    </div>
  );
}

export function SettingsPage({ get = productionGet }: SettingsPageProps): ReactElement {
  const prefs = usePrefs();
  const panel = useId();
  const [credits, setCredits] = useState<CreditsAnswer | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [relays, setRelays] = useState<Relays | 'loading' | undefined>(undefined);

  useEffect(() => {
    let live = true;
    get(CREDITS_PATH).then(
      (r) => {
        if (live) setCredits(parseCredits(r.kind === 'ok' ? r.data : undefined));
      },
      () => {
        if (live) setCredits({ kind: 'unavailable' });
      },
    );
    return () => {
      live = false;
    };
  }, [get]);

  // The relay count is read the first time Advanced opens, not on every visit.
  const asked = useRef(false);
  useEffect(() => {
    if (!open || asked.current) return;
    asked.current = true;
    setRelays('loading');
    get(HEALTH_PATH).then(
      (r) => setRelays(parseRelays(r) ?? {}),
      () => setRelays({}),
    );
  }, [open, get]);

  const proofsLine =
    credits?.kind === 'ok'
      ? `${S.proofs.credits(credits.balance)} · ${S.proofs.left(credits.proofsLeft)}`
      : S.proofs.fallback;

  return (
    <div className="st-page">
      <h1 className="al-text-title-1">{S.title}</h1>
      <div className="st-list">
        <Row href="/settings/backup" icon="backup" title={S.backup.title} line={S.backup.line} />
        <Row href="/settings/files" icon="folder" title={S.files.title} line={S.files.line} />
        <Row
          href="/settings/appearance"
          icon="appearance"
          title={S.appearance.title}
          line={themeLine(prefs.theme)}
        />
        <Row href="/settings/rules" icon="rules" title={S.rules.title} line={S.rules.line} />
        <Row href="/settings/proofs" icon="proofs" title={S.proofs.title} line={proofsLine} />
        <Row
          href="/settings/notifications"
          icon="bell"
          title={S.notifications.title}
          line={S.notifications.line}
        />
        <button
          type="button"
          className="st-row"
          aria-expanded={open}
          aria-controls={panel}
          onClick={() => setOpen((o) => !o)}
        >
          <ShellIcon name="diag" />
          <span className="st-row-text">
            <span className="st-row-title">{S.advanced.title}</span>
            <span className="st-row-line">{S.advanced.line}</span>
          </span>
          <ShellIcon name="chev-r" size={18} className="st-chev" />
        </button>
        <div id={panel}>{open ? <AdvancedRows relays={relays} /> : null}</div>
      </div>
    </div>
  );
}
