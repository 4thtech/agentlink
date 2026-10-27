// Shell and tray (M1-35b; d1/components/AppShell, TrayMenu). Frames for the dashboard and console;
// the app supplies the real window chrome, `os` draws chrome for mockups only.
import { useRef, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';
import { Icon, Lockup } from './brand.js';
import { Kbd } from './forms.js';
import { cx } from './util.js';

export interface NavItem {
  icon: string;
  label: string;
  count?: number;
  active?: boolean;
  /** Where the link goes; the app routes it. */
  href?: string;
}

/** A nav link goes to this app (`/…`), a fragment (`#…`) or an https address; anything else is `#`. */
function safeHref(href: string | undefined): string {
  if (href === undefined) return '#';
  // Browsers drop tabs and line breaks inside a URL, so "/<tab>/host" would become "//host".
  if (/[\t\n\r]/.test(href)) return '#';
  if (href.startsWith('#') || href.startsWith('https:')) return href;
  if (href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/\\')) return href;
  return '#';
}

type Connection =
  'connected' | 'offline' | 'paused' | 'checking' | 'disconnected' | 'not-running' | 'needs-setup';

export interface AppShellProps {
  os?: 'macos' | 'windows' | 'linux';
  title?: string;
  /** The page title in the top bar (UI-REFRESH-f). Without it the shell draws no top bar. */
  pageTitle?: string;
  /** The controls at the right end of the top bar: the Under the hood switch, status chip, theme. */
  topBarEnd?: ReactNode;
  agent?: string;
  nav?: readonly NavItem[];
  connection?: Connection;
  statusItems?: readonly string[];
  version?: string;
  children?: ReactNode;
  className?: string;
}

const CONNECTION: Readonly<Record<Connection, string>> = {
  connected: 'Connected',
  offline: "Offline · showing what's saved here",
  paused: 'Paused',
  checking: 'Checking…',
  disconnected: 'Not connected',
  'not-running': 'Not running',
  'needs-setup': 'Needs setup',
};

function Chrome({ os, title }: { os: 'macos' | 'windows' | 'linux'; title: string }): ReactElement {
  return (
    <div className={cx('al-win-bar', `is-${os}`)} aria-hidden="true">
      {os === 'macos' ? (
        <span className="al-win-dots">
          <i />
          <i />
          <i />
        </span>
      ) : null}
      <span className="al-win-title al-text-body-sm">{title}</span>
      {os === 'macos' ? null : (
        <span className="al-win-ctrls">
          {os === 'windows' ? <Icon name="minus" size={14} /> : null}
          {os === 'windows' ? <span className="al-win-max" /> : null}
          <Icon name="x" size={14} />
        </span>
      )}
    </div>
  );
}

/** Desktop dashboard and console frame: sidebar, content, IDE-style status bar. */
export function AppShell({
  os,
  title = 'AgentLink',
  pageTitle,
  topBarEnd,
  agent,
  nav = [],
  connection = 'connected',
  statusItems,
  version,
  children,
  className,
}: AppShellProps): ReactElement {
  const active = nav.findIndex((item) => item.active === true);
  return (
    <div className={cx('al-shell', className)}>
      {os === undefined ? null : <Chrome os={os} title={title} />}
      <div className="al-shell-main">
        <nav className="al-side al-chrome" aria-label="Main">
          <div className="al-side-brand">
            <Lockup size={18} />
          </div>
          {agent === undefined ? null : (
            <button type="button" className="al-agent-switch">
              <Icon name="agent" size={14} />
              <span className="al-text-body-sm">{agent}</span>
              <Icon name="chevron-down" size={14} />
            </button>
          )}
          {/* One highlight that slides to the current item (transform only). Its place is the
              active index, a data attribute the stylesheet maps to a position: no inline style. */}
          <div className="al-nav-wrap" data-active={active < 0 ? undefined : String(active)}>
            <span className="al-nav-slider" aria-hidden="true" />
            <ul>
              {nav.map((item, i) => (
                <li key={i}>
                  <a
                    href={safeHref(item.href)}
                    className={cx('al-nav', item.active === true && 'is-active')}
                    aria-current={item.active === true ? 'page' : undefined}
                  >
                    <Icon name={item.icon} size={16} />
                    <span className="al-text-body">{item.label}</span>
                    {item.count === undefined || item.count === 0 ? null : (
                      <span className="al-nav-count al-text-code">{item.count}</span>
                    )}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </nav>
        <div className="al-shell-body">
          {pageTitle === undefined ? null : (
            <header className="al-topbar al-chrome">
              <span className="al-topbar-title al-text-title-3">{pageTitle}</span>
              <div className="al-topbar-end">{topBarEnd}</div>
            </header>
          )}
          <main className="al-shell-content">{children}</main>
        </div>
      </div>
      <footer className="al-statusbar al-chrome al-text-code">
        {/* One polite live region: announced when the state changes, never per poll (B-11 §15).
            The key replays the fade (and the pulse on Connected) only on a change (B-11 §6 row 1). */}
        <span className="al-sb-item" role="status" aria-live="polite" aria-atomic="true">
          <span key={connection} className="al-sb-state">
            <span className={cx('al-dot', `is-${connection}`)} aria-hidden="true" />
            {CONNECTION[connection]}
          </span>
        </span>
        {(statusItems ?? []).map((s, i) => (
          <span key={i} className="al-sb-item">
            {s}
          </span>
        ))}
        <span className="al-sb-spacer" />
        {version === undefined ? null : <span className="al-sb-item">{version}</span>}
      </footer>
    </div>
  );
}

export interface TrayMenuProps {
  os?: 'macos' | 'windows' | 'linux';
  status?: Connection;
  /** Approvals waiting; the row is hidden at 0. */
  approvals?: number;
  /** A version that is ready to install. */
  updateReady?: string;
  onSelect?: (item: 'approvals' | 'dashboard' | 'pause' | 'resume' | 'update' | 'quit') => void;
}

/** Tray or menu-bar menu: status, Approvals waiting (n), Open dashboard, Pause / Resume, Update, Quit. */
export function TrayMenu({
  os,
  status = 'connected',
  approvals,
  updateReady,
  onSelect,
}: TrayMenuProps): ReactElement {
  const refs = useRef<Array<HTMLDivElement | null>>([]);
  const items: Array<{
    key: 'approvals' | 'dashboard' | 'pause' | 'resume' | 'update' | 'quit';
    icon: string;
    label: string;
    extra?: ReactNode;
  }> = [];
  if (approvals !== undefined && approvals > 0) {
    items.push({
      key: 'approvals',
      icon: 'approval',
      label: 'Approvals waiting',
      extra: <span className="al-nav-count al-text-code">{approvals}</span>,
    });
  }
  items.push({
    key: 'dashboard',
    icon: 'activity',
    label: 'Open dashboard',
    extra: os === 'macos' ? <Kbd>{'⌘D'}</Kbd> : null,
  });
  items.push(
    status === 'paused'
      ? { key: 'resume', icon: 'play', label: 'Resume' }
      : { key: 'pause', icon: 'pause', label: 'Pause' },
  );
  if (updateReady !== undefined) {
    items.push({
      key: 'update',
      icon: 'download',
      label: 'Update ready · restart',
      extra: <span className="al-text-code al-muted">{updateReady}</span>,
    });
  }
  items.push({
    key: 'quit',
    icon: 'x',
    label: 'Quit AgentLink',
    extra: os === 'macos' ? <Kbd>{'⌘Q'}</Kbd> : null,
  });
  const onKey = (event: KeyboardEvent<HTMLDivElement>, index: number): void => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        const item = items[index];
        if (item !== undefined) onSelect?.(item.key);
      }
      return;
    }
    event.preventDefault();
    refs.current[(index + step + items.length) % items.length]?.focus();
  };
  return (
    <div className="al-tray">
      <div className="al-tray-status al-text-body-sm">
        <span className={cx('al-dot', `is-${status}`)} />
        {status === 'connected' ? 'Connected' : status === 'paused' ? 'Paused' : 'Offline'}
      </div>
      <div role="menu" aria-label="AgentLink">
        {items.map((item, i) => (
          <div
            key={item.key}
            ref={(el) => {
              refs.current[i] = el;
            }}
            role="menuitem"
            tabIndex={i === 0 ? 0 : -1}
            className="al-tray-item al-text-body"
            onKeyDown={(event) => onKey(event, i)}
            onClick={() => onSelect?.(item.key)}
          >
            <Icon name={item.icon} size={14} />
            <span>{item.label}</span>
            {item.extra ?? null}
          </div>
        ))}
      </div>
    </div>
  );
}
