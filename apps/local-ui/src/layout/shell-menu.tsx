// W4-SHELL-V2: the shell's menus (the agent dropdown, Help). The same keyboard model as the pages'
// menu (b11 §29.9: arrow keys, Home, End, type-ahead, Escape returns focus to the trigger, a click
// outside closes it), and it also moves through `menuitemradio` choices (the agent dropdown's agents,
// as the prototype). Focus starts on the checked choice, else the first item. The trigger is the
// caller's button (aria-haspopup, aria-expanded); this renders the popup only.
import {
  useEffect,
  useRef,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';

export interface ShellMenuProps {
  readonly label: string;
  readonly onClose: (restoreFocus: boolean) => void;
  /** The trigger, so a click on it is not "outside". */
  readonly triggerRef: RefObject<HTMLElement | null>;
  readonly className?: string;
  readonly children: ReactNode;
}

const ITEMS = ['menuitem', 'menuitemradio', 'menuitemcheckbox']
  .map((r) => `[role="${r}"]:not([aria-disabled="true"])`)
  .join(', ');

export function ShellMenu({
  label,
  onClose,
  triggerRef,
  className,
  children,
}: ShellMenuProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const typed = useRef<{ text: string; at: number }>({ text: '', at: 0 });
  useEffect(() => {
    const menu = ref.current;
    (
      menu?.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]') ??
      menu?.querySelector<HTMLElement>(ITEMS)
    )?.focus();
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
    <div ref={ref} role="menu" aria-label={label} className={className} onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}
