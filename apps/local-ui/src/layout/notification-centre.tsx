// N5 (PLAN-NOTIFY §3.1, §4.1; D1, D4): the bell in the top bar and its small centre.
//
// - The bell: a button with the unread number ("9+" above nine), named "Notifications, 3 new"; a
//   change of the number is announced once (one polite status, never per poll).
// - The centre: the shell's menu (ShellMenu: arrow keys, Home, End, Escape returns focus to the
//   bell, a click outside closes it), grouped Needs you · New · Earlier, with Mark all read, a link
//   to Settings › Notifications and Open Activity. A row opens its page and marks it read. A waiting
//   approval stays counted until it is decided (marking it read never decides it).
// - Names: a person is named only from the owner's own contact list, by ref, as bold React text; an
//   unknown ref is "a contact". Items never carry text, a file name or a link (N4).
// - On a phone the centre is a sheet across the width (shell.css).
// - It also keeps the tab title's number and the favicon dot in step (attention.ts).
import { useCallback, useEffect, useRef, useState, type ReactElement, type RefObject } from 'react';
import { createApiClient } from '../api/client.js';
import {
  markAllNotificationsRead,
  markNotificationRead,
  useNotifications,
  type NotificationItem,
  type NotificationList,
} from '../api/notifications.js';
import { ACTIVITY_PATH, HOME_PATH } from '../nav.js';
import { LIST_PATH, parseList } from '../pages/contacts/data.js';
import { navigate } from '../router.js';
import { setAttention } from './attention.js';
import { NOTIFY_STRINGS as S } from './notification-strings.js';
import { ShellIcon, type ShellIconName } from './shell-icons.js';
import { ShellMenu } from './shell-menu.js';

export const NOTIFICATIONS_SETTINGS_PATH = '/settings/notifications';

/** Where a row goes (deep links inside the app only; never a link from an item). */
export function targetOf(item: NotificationItem): string {
  switch (item.kind) {
    case 'update':
      return '/settings/updates';
    case 'network':
      return '/advanced/network';
    default:
      return HOME_PATH;
  }
}

/** "just now", "3 min ago", "2 h ago", "yesterday", "4 days ago". */
export function ago(at: number, nowSeconds: number): string {
  const s = Math.max(0, nowSeconds - at);
  if (s < 60) return S.justNow;
  if (s < 3_600) return S.minutes(Math.floor(s / 60));
  if (s < 86_400) return S.hours(Math.floor(s / 3_600));
  return S.days(Math.floor(s / 86_400));
}

const ICON: Readonly<Record<NotificationItem['kind'], ShellIconName>> = {
  approvals: 'check',
  messages: 'stream',
  files: 'book',
  update: 'rocket',
  network: 'relays',
};

const TONE: Readonly<Record<NotificationItem['kind'], string>> = {
  approvals: 'warning',
  messages: 'accent',
  files: 'accent',
  update: 'accent',
  network: 'neutral',
};

/** Groups (PLAN-NOTIFY §4.1): approvals waiting first, then unread, then read. */
export function groupsOf(items: readonly NotificationItem[]): {
  readonly needsYou: readonly NotificationItem[];
  readonly fresh: readonly NotificationItem[];
  readonly earlier: readonly NotificationItem[];
} {
  return {
    needsYou: items.filter((i) => i.kind === 'approvals'),
    fresh: items.filter((i) => i.kind !== 'approvals' && !i.read),
    earlier: items.filter((i) => i.kind !== 'approvals' && i.read),
  };
}

function Sentence({
  item,
  names,
}: {
  readonly item: NotificationItem;
  readonly names: ReadonlyMap<string, string>;
}): ReactElement {
  const who = item.ref === undefined ? undefined : names.get(item.ref);
  const person = who === undefined ? S.aContact : <b>{who}</b>;
  switch (item.kind) {
    case 'approvals':
      return <>{S.approvals(item.count)}</>;
    case 'messages':
      return (
        <>
          {S.messages(item.count)}
          {person}
        </>
      );
    case 'files':
      return (
        <>
          {S.files(item.count)}
          {person}
        </>
      );
    case 'update':
      return <>{S.update}</>;
    case 'network':
      return <>{S.network}</>;
  }
}

const SECOND_LINE: Readonly<Record<NotificationItem['kind'], string>> = {
  approvals: S.approvalsLine,
  messages: S.personLine,
  files: S.personLine,
  update: S.updateLine,
  network: S.networkLine,
};

function Row({
  item,
  names,
  now,
  onOpen,
}: {
  readonly item: NotificationItem;
  readonly names: ReadonlyMap<string, string>;
  readonly now: number;
  readonly onOpen: (item: NotificationItem) => void;
}): ReactElement {
  const unread = item.kind === 'approvals' || !item.read;
  return (
    <button
      type="button"
      role="menuitem"
      className="al-mitem al-nc-row"
      data-kind={item.kind}
      data-unread={unread ? 'true' : 'false'}
      onClick={() => onOpen(item)}
    >
      <span className={`al-nc-icon is-${TONE[item.kind]}`} aria-hidden="true">
        <ShellIcon name={ICON[item.kind]} size={16} />
      </span>
      <span className="al-nc-text">
        <span className="al-nc-line">
          <Sentence item={item} names={names} />
        </span>
        <span className="al-nc-sub">
          {SECOND_LINE[item.kind]} · {ago(item.at, now)}
        </span>
      </span>
      {unread ? (
        <span className="al-nc-dot">
          <span className="al-visually-hidden">{S.unread}</span>
        </span>
      ) : null}
    </button>
  );
}

function Group({
  label,
  items,
  names,
  now,
  onOpen,
}: {
  readonly label: string;
  readonly items: readonly NotificationItem[];
  readonly names: ReadonlyMap<string, string>;
  readonly now: number;
  readonly onOpen: (item: NotificationItem) => void;
}): ReactElement | null {
  const id = `al-nc-${label.replace(/\W+/g, '-').toLowerCase()}`;
  if (items.length === 0) return null;
  return (
    <div role="group" aria-labelledby={id} className="al-nc-group">
      <div id={id} className="al-menu-head">
        {label}
      </div>
      {items.map((item) => (
        <Row key={item.id} item={item} names={names} now={now} onOpen={onOpen} />
      ))}
    </div>
  );
}

async function readNames(): Promise<ReadonlyMap<string, string>> {
  const answer = await createApiClient().get(LIST_PATH);
  if (answer.kind !== 'ok') return new Map();
  const list = parseList(answer.data);
  if (list.kind !== 'ok') return new Map();
  return new Map(list.contacts.map((c) => [c.ref, c.name]));
}

export interface NotificationPanelProps {
  readonly list: NotificationList;
  readonly names: ReadonlyMap<string, string>;
  readonly now: number;
  readonly onOpen: (item: NotificationItem) => void;
  readonly onMarkAll: () => void;
  readonly onSettings: () => void;
  readonly onActivity: () => void;
  readonly onClose: (restoreFocus: boolean) => void;
  readonly triggerRef: RefObject<HTMLElement | null>;
}

/** The centre itself (exported for its DOM tests). */
export function NotificationPanel(props: NotificationPanelProps): ReactElement {
  const { list, names, now, onOpen } = props;
  const g = groupsOf(list.items);
  const empty = list.items.length === 0;
  return (
    <ShellMenu
      label={S.title}
      onClose={props.onClose}
      triggerRef={props.triggerRef}
      className="al-shell-menu al-menu al-nc-menu"
    >
      <div className="al-nc-head">
        <span className="al-nc-title al-text-label">{S.title}</span>
        <button
          type="button"
          role="menuitem"
          className="al-mitem al-nc-headbtn"
          aria-disabled={
            list.items.every((i) => i.kind === 'approvals' || i.read) ? 'true' : undefined
          }
          onClick={props.onMarkAll}
        >
          {S.markAll}
        </button>
        <button
          type="button"
          role="menuitem"
          className="al-mitem al-nc-headbtn al-nc-cog"
          aria-label={S.settings}
          title={S.settings}
          onClick={props.onSettings}
        >
          <ShellIcon name="settings" size={16} />
        </button>
      </div>
      <div className="al-nc-list">
        {empty ? <p className="al-nc-empty al-text-body-sm">{S.empty}</p> : null}
        <Group label={S.needsYou} items={g.needsYou} names={names} now={now} onOpen={onOpen} />
        <Group label={S.fresh} items={g.fresh} names={names} now={now} onOpen={onOpen} />
        <Group label={S.earlier} items={g.earlier} names={names} now={now} onOpen={onOpen} />
      </div>
      <div className="al-menu-sep" />
      <button type="button" role="menuitem" className="al-mitem" onClick={props.onActivity}>
        <ShellIcon name="activity" size={16} />
        {S.openActivity}
      </button>
    </ShellMenu>
  );
}

export interface NotificationBellProps {
  readonly path: string;
  /** Test seams. */
  readonly read?: () => Promise<NotificationList | undefined>;
  readonly names?: () => Promise<ReadonlyMap<string, string>>;
  readonly now?: () => number;
}

/** The bell and its centre (the top bar). */
export function NotificationBell({
  path,
  read,
  names: readNamesSeam,
  now = () => Math.floor(Date.now() / 1000),
}: NotificationBellProps): ReactElement {
  const { list, refresh } = useNotifications(path, read);
  const [open, setOpen] = useState(false);
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  const trigger = useRef<HTMLButtonElement>(null);
  const n = list.unread;

  useEffect(() => {
    setAttention({ unread: list.unread, approvals: list.approvals });
  }, [list.unread, list.approvals]);

  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    refresh();
    (readNamesSeam ?? readNames)().then(
      (m) => live && setNames(m),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [open, readNamesSeam, refresh]);

  const close = useCallback((restore: boolean): void => {
    setOpen(false);
    if (restore) trigger.current?.focus();
  }, []);

  const go = (to: string): void => {
    close(false);
    navigate(to);
  };

  return (
    <div className="al-nc">
      <button
        ref={trigger}
        type="button"
        className="al-iconbtn al-press al-nc-bell"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={n > 0 ? S.bellNew(n) : S.bell}
        title={S.bell}
        onClick={() => setOpen((v) => !v)}
      >
        <ShellIcon name="bell" size={20} />
        {n > 0 ? (
          <span className="al-nav-count al-nc-count al-text-code" aria-hidden="true">
            {n > 9 ? '9+' : String(n)}
          </span>
        ) : null}
      </button>
      {/* One polite announcement when the number changes (never per poll: same text, no news). */}
      <span className="al-visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {S.announce(n)}
      </span>
      {open ? (
        <NotificationPanel
          list={list}
          names={names}
          now={now()}
          triggerRef={trigger}
          onClose={close}
          onOpen={(item) => {
            if (item.kind !== 'approvals' && !item.read) void markNotificationRead(item.id);
            go(targetOf(item));
          }}
          onMarkAll={() => {
            void markAllNotificationsRead();
          }}
          onSettings={() => go(NOTIFICATIONS_SETTINGS_PATH)}
          onActivity={() => go(ACTIVITY_PATH)}
        />
      ) : null}
    </div>
  );
}
