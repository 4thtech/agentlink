// W4-SHELL (Decision 40; b11 §34.8): Cmd+K (Ctrl+K) reaches every page by name. No design exists for
// it yet (D-116), so it is built from parts that do: the level-3 menu surface of the switcher, a
// TextField and plain rows. Type to filter, arrow keys to move, Enter to go, Escape to close. It
// lists fixed page names only (nav.ts GO_TO); nothing typed leaves the page.
import { TextField } from '@4thtech-io/ui';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { GO_TO, type GoToEntry } from '../nav.js';
import { navigate } from '../router.js';
import { SHELL_STRINGS as S } from '../strings.js';

const OPEN = 'agentlink:go-to';

/** Opens Cmd+K from elsewhere (the avatar menu). */
export function openGoTo(): void {
  window.dispatchEvent(new Event(OPEN));
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

export function GoTo(): ReactElement | null {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setActive(0);
  }, []);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (event.key === 'Escape') setOpen((v) => (v ? false : v));
    };
    const onOpen = (): void => setOpen(true);
    document.addEventListener('keydown', onKey);
    window.addEventListener(OPEN, onOpen);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN, onOpen);
    };
  }, []);
  useEffect(() => {
    if (!open) {
      setQuery('');
      setActive(0);
    }
  }, [open]);

  const shown = useMemo(() => GO_TO.filter((e) => matches(e, query)), [query]);
  if (!open) return null;

  const go = (entry: GoToEntry | undefined): void => {
    if (entry === undefined) return;
    close();
    navigate(entry.path);
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

  return (
    <div className="al-goto-backdrop" onMouseDown={close}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={S.goTo}
        className="ag-menu al-goto"
        onMouseDown={(e) => e.stopPropagation()}
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
                key={entry.path}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === at}
                className={i === at ? 'ag-menu-item is-active' : 'ag-menu-item'}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => go(entry)}
              >
                {entry.label}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
