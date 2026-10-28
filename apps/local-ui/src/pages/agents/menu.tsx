// U3-h: a small menu (b11 §29.1, §29.9): `role="menu"` with arrow keys, Home, End, type-ahead, Esc
// returning focus to the trigger, and a click outside closing it. The trigger is the caller's button
// (aria-haspopup, aria-expanded); this component renders the popup only.
import {
  useEffect,
  useRef,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';

export interface MenuProps {
  readonly label: string;
  readonly onClose: (restoreFocus: boolean) => void;
  /** The trigger, so a click on it is not "outside". */
  readonly triggerRef: RefObject<HTMLElement | null>;
  readonly className?: string;
  readonly children: ReactNode;
}

const ITEMS = '[role="menuitem"]:not([aria-disabled="true"])';

export function Menu({ label, onClose, triggerRef, className, children }: MenuProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const typed = useRef<{ text: string; at: number }>({ text: '', at: 0 });
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(ITEMS)?.focus();
    const outside = (event: MouseEvent): void => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (ref.current?.contains(target) === true) return;
      if (triggerRef.current?.contains(target) === true) return;
      onClose(false);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [onClose, triggerRef]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const inField = (event.target as HTMLElement).tagName === 'INPUT';
    const focus = (i: number): void => {
      event.preventDefault();
      items[(i + items.length) % items.length]?.focus();
    };
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
    } else if (event.key === 'ArrowDown') focus(at + 1);
    else if (event.key === 'ArrowUp') focus(at <= 0 ? items.length - 1 : at - 1);
    else if (inField) return;
    else if (event.key === 'Home') focus(0);
    else if (event.key === 'End') focus(items.length - 1);
    else if (event.key === 'Tab') onClose(false);
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = Date.now();
      const prefix = now - typed.current.at < 700 ? typed.current.text : '';
      typed.current = { text: prefix + event.key.toLowerCase(), at: now };
      const hit = items.findIndex((i) =>
        (i.textContent ?? '').trim().toLowerCase().startsWith(typed.current.text),
      );
      if (hit >= 0) focus(hit);
    }
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className={className === undefined ? 'ag-menu' : `ag-menu ${className}`}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  );
}
