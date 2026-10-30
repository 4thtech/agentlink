// W4-SHELL-V2: in both modes Cmd+K reaches every section, Get started, the Settings pages (and the
// Advanced pages while Under the hood is on), and runs two shell commands: Under the hood on/off and
// Keyboard shortcuts (prototype v23 palette). Kept from #715:
// W4-SHELL (Decision 40; b11 §34.8): Cmd+K (Ctrl+K) reaches every page by name. No design exists for
// it yet (D-116), so it is built from parts that do: the level-3 surface of the switcher's menu, a
// TextField and plain rows. A modal dialog with the combobox and listbox pattern (no role="menu"):
// type to filter, arrow keys to move, Enter to go, Escape to close. Focus stays inside while it is
// open (Tab cannot leave) and goes back to what opened it on close. It lists fixed page names only
// (nav.ts goToEntries); nothing typed leaves the page.
import { TextField } from '@4thtech-io/ui';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { goToEntries, type GoToEntry } from '../nav.js';
import { usePrefs } from '../prefs/index.js';
import { navigate } from '../router.js';
import { SHELL_STRINGS as S } from '../strings.js';
import { openShellDialog } from './shell-dialogs.js';

const OPEN = 'agentlink:go-to';

/** Opens Cmd+K from elsewhere (the avatar menu); focus goes back to `returnTo` on close. */
export function openGoTo(returnTo?: HTMLElement | null): void {
  window.dispatchEvent(new CustomEvent(OPEN, { detail: returnTo ?? null }));
}

export function matches(entry: GoToEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  return `${entry.label} ${entry.keywords ?? ''}`.toLowerCase().includes(q);
}

/** The shortcut's name for this platform, shown next to "Go to". */
export function goToKeys(): string {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  return mac ? '⌘K' : 'Ctrl+K';
}

export interface GoToProps {
  /** Turns Under the hood on or off (the shell's morph). */
  readonly onHood?: (on: boolean) => void;
}

export function GoTo({ onHood }: GoToProps = {}): ReactElement | null {
  const { hood } = usePrefs();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const dialog = useRef<HTMLDivElement | null>(null);
  // What had focus when it opened: focus goes back there on close (b11 §29.9, as the menus do).
  const returnTo = useRef<HTMLElement | null>(null);
  const opened = useRef(false);
  const remember = (el: Element | null): void => {
    returnTo.current = el instanceof HTMLElement && el !== document.body ? el : null;
  };
  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setActive(0);
  }, []);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (!opened.current) remember(document.activeElement);
        setOpen((v) => !v);
        return;
      }
      if (event.key === 'Escape') setOpen((v) => (v ? false : v));
    };
    const onOpen = (event: Event): void => {
      const detail = (event as CustomEvent<unknown>).detail;
      remember(detail instanceof HTMLElement ? detail : document.activeElement);
      setOpen(true);
    };
    document.addEventListener('keydown', onKey);
    window.addEventListener(OPEN, onOpen);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN, onOpen);
    };
  }, []);
  useEffect(() => {
    if (open) {
      opened.current = true;
      return;
    }
    setQuery('');
    setActive(0);
    if (!opened.current) return;
    opened.current = false;
    const back = returnTo.current;
    returnTo.current = null;
    if (back?.isConnected === true) back.focus();
  }, [open]);

  const shown = useMemo(() => goToEntries(hood).filter((e) => matches(e, query)), [hood, query]);
  if (!open) return null;

  const go = (entry: GoToEntry | undefined): void => {
    if (entry === undefined) return;
    if (entry.action === 'shortcuts') {
      // The shortcuts dialog takes over: focus goes back to what had it before Go to.
      const back = returnTo.current;
      returnTo.current = null;
      opened.current = false;
      close();
      openShellDialog('shortcuts', back);
      return;
    }
    close();
    if (entry.action === 'hood') {
      onHood?.(!hood);
      return;
    }
    if (entry.path !== undefined) navigate(entry.path);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => (shown.length === 0 ? 0 : (i + 1) % shown.length));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => (shown.length === 0 ? 0 : (i - 1 + shown.length) % shown.length));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      go(shown[Math.min(active, shown.length - 1)]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };
  const at = Math.min(active, Math.max(shown.length - 1, 0));
  // The one focusable control is the field: Tab and Shift+Tab stay on it (focus trap).
  const trap = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Tab') return;
    event.preventDefault();
    dialog.current?.querySelector('input')?.focus();
  };

  return (
    <div className="al-goto-backdrop" onMouseDown={close}>
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={S.goTo}
        className="al-goto"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={trap}
      >
        <TextField
          label={S.goToFind}
          hint={S.goToHint}
          name="go-to"
          type="search"
          autoComplete="off"
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={shown.length === 0 ? undefined : `${listId}-${at}`}
          value={query}
          onChange={(e) => {
            setQuery(e.currentTarget.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        {shown.length === 0 ? (
          <p className="al-text-body-sm al-muted al-goto-none">{S.goToNone}</p>
        ) : (
          <ul id={listId} role="listbox" aria-label={S.goTo} className="al-goto-list">
            {shown.map((entry, i) => (
              <li
                key={`${entry.hint}:${entry.label}`}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === at}
                className={i === at ? 'al-goto-option is-active' : 'al-goto-option'}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => go(entry)}
              >
                <span className="al-goto-label">{entry.label}</span>
                <span className="al-goto-hint al-text-code">{entry.hint}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
