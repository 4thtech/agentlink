// W4-PEOPLE-INVITE: the person ⋯ menu (prototype v23 A4: Rename · Check safety code · Remove).
// Exported for Home (U3). A menu button with aria-expanded; the menu opens with U0's al-menu, takes
// focus on its first item, moves with the arrow keys, and closes on Escape, Tab or a click outside,
// giving focus back to the button. The caller does the work (each action asks for Touch ID there);
// an action it does not pass is left out. The name is text only.
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { INVITE_STRINGS as S, moreFor } from './strings.js';
import './invite.css';

export interface PersonMenuProps {
  /** The name as the list shows it (name-rule output). */
  readonly name: string;
  readonly onRename?: () => void;
  readonly onCheck?: () => void;
  readonly onRemove?: () => void;
}

interface Item {
  readonly label: string;
  readonly run: () => void;
  readonly danger?: boolean;
  readonly icon: ReactElement;
}

const svg = (d: readonly string[]): ReactElement => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {d.map((p) => (
      <path key={p} d={p} />
    ))}
  </svg>
);

const RENAME = svg(['M12 20h9', 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z']);
const CHECK = svg([
  'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z',
]);
const REMOVE = svg([
  'M3 6h18',
  'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6',
  'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
]);

export function PersonMenu({ name, onRename, onCheck, onRemove }: PersonMenuProps): ReactElement {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const items: Item[] = [];
  if (onRename !== undefined) items.push({ label: S.rename, run: onRename, icon: RENAME });
  if (onCheck !== undefined) items.push({ label: S.checkCode, run: onCheck, icon: CHECK });
  if (onRemove !== undefined)
    items.push({ label: S.remove, run: onRemove, danger: true, icon: REMOVE });

  const close = (focusBack: boolean): void => {
    setOpen(false);
    if (focusBack) trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return undefined;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const outside = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (menu.current?.contains(target) || trigger.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const list = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'Tab') {
      close(false);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      list[(at + step + list.length) % list.length]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      (event.key === 'Home' ? list[0] : list[list.length - 1])?.focus();
    }
  };

  return (
    <span className="inv-menu-wrap">
      <button
        ref={trigger}
        type="button"
        className="inv-more al-press"
        aria-label={moreFor(name)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((on) => !on)}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
          focusable="false"
        >
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
      </button>
      {open ? (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label={moreFor(name)}
          className="inv-menu al-menu"
          onKeyDown={onKeyDown}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={`inv-menu-item${item.danger === true ? ' is-danger' : ''}`}
              onClick={() => {
                close(true);
                item.run();
              }}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}
