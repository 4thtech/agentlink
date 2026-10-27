// Depth (UI-REFRESH-b; B-11 §13.1): Surface levels 0 to 4 and recessed, the level-3 Sheet and the
// level-4 dialog frame. Classes only (`depth.css`), no inline styles (08 §4 CSP). A surface rises
// one level on hover and focus through a pseudo-element's opacity, never two levels. Children are
// elements and text the caller owns; nothing here reads inbound content.
import {
  createElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ElementType,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from 'react';
import { holdInert } from './inert.js';
import { cx } from './util.js';

export type SurfaceLevel = 0 | 1 | 2 | 3 | 4 | 'recessed';

export interface SurfaceProps extends ComponentPropsWithoutRef<'div'> {
  /** 0 canvas, 1 surface (default), 2 raised, 3 sheet, 4 modal, or 'recessed' (a well). */
  level?: SurfaceLevel;
  /** Rises one level on hover and focus. Level 4 is the top and never rises. */
  interactive?: boolean;
  as?: ElementType;
}

export function Surface({
  level = 1,
  interactive = false,
  as = 'div',
  className,
  children,
  ...rest
}: SurfaceProps): ReactElement {
  return createElement(
    as,
    {
      ...rest,
      className: cx(
        'al-surface',
        `al-surface--${level === 'recessed' ? 'recessed' : `l${level}`}`,
        interactive && level !== 4 && 'al-surface--interactive',
        className,
      ),
      'data-level': String(level),
    },
    children,
  );
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Focus starts on the title, Tab stays inside, Escape closes, focus returns to the opener. */
function useModalBehavior(
  active: boolean,
  frame: RefObject<HTMLElement | null>,
  title: RefObject<HTMLElement | null>,
  onClose: () => void,
): (event: ReactKeyboardEvent<HTMLElement>) => void {
  const close = useRef(onClose);
  close.current = onClose;
  // A layout effect, so the background is inert before the first paint and released before the
  // focus goes back to the opener (below, in a passive effect's cleanup).
  useLayoutEffect(() => {
    if (!active || frame.current === null) return undefined;
    return holdInert(frame.current);
  }, [active, frame]);
  useEffect(() => {
    if (!active) return undefined;
    const opener = document.activeElement as HTMLElement | null;
    title.current?.focus();
    return () => {
      if (opener !== null && typeof opener.focus === 'function' && document.contains(opener)) {
        opener.focus();
      }
    };
  }, [active, title]);
  return (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close.current();
      return;
    }
    if (event.key !== 'Tab' || frame.current === null) return;
    const list = [...frame.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (n) => !(n as HTMLButtonElement).disabled,
    );
    const first = list[0];
    const last = list[list.length - 1];
    if (first === undefined || last === undefined) return;
    const now = document.activeElement;
    if (event.shiftKey && (now === first || now === title.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && now === last) {
      event.preventDefault();
      first.focus();
    }
  };
}

export interface SheetProps {
  open: boolean;
  /** The sheet's name: a heading, and its accessible name. */
  title: string;
  onClose: () => void;
  /** Accessible name of the close button. */
  closeLabel?: string;
  className?: string;
  children?: ReactNode;
}

/** A level-3 side sheet (a contact, message or file detail): a full page at 360 px wide. */
export function Sheet({
  open,
  title,
  onClose,
  closeLabel = 'Close',
  className,
  children,
}: SheetProps): ReactElement | null {
  const id = useId();
  const frame = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const onKeyDown = useModalBehavior(open, frame, heading, onClose);
  if (!open) return null;
  return (
    <aside
      ref={frame}
      className={cx('al-surface', 'al-surface--l3', 'al-sheet', className)}
      data-level="3"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${id}-title`}
      onKeyDown={onKeyDown}
    >
      <header className="al-sheet-head">
        <h2 id={`${id}-title`} ref={heading} className="al-sheet-title" tabIndex={-1}>
          {title}
        </h2>
        <button type="button" className="al-sheet-close" aria-label={closeLabel} onClick={onClose}>
          <span aria-hidden="true">×</span>
        </button>
      </header>
      <div className="al-sheet-body">{children}</div>
    </aside>
  );
}

// At most one level-4 layer at a time (B-11 §13.1): the first open frame holds the slot, the others
// wait and take it when it is released.
let dialogHolder: symbol | null = null;
const waiting = new Set<() => void>();

export interface DialogFrameProps {
  open: boolean;
  title: string;
  onClose: () => void;
  className?: string;
  children?: ReactNode;
}

/** A level-4 dialog frame over the blurred overlay. A second one waits until the first closes. */
export function DialogFrame({
  open,
  title,
  onClose,
  className,
  children,
}: DialogFrameProps): ReactElement | null {
  const id = useId();
  const me = useRef(Symbol('dialog'));
  const [holding, setHolding] = useState(false);
  const frame = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const token = me.current;
    const tryClaim = (): void => {
      if (dialogHolder !== null) return;
      dialogHolder = token;
      waiting.delete(tryClaim);
      setHolding(true);
    };
    waiting.add(tryClaim);
    tryClaim();
    return () => {
      waiting.delete(tryClaim);
      if (dialogHolder === token) {
        dialogHolder = null;
        setHolding(false);
        for (const next of [...waiting]) next();
      }
    };
  }, [open]);

  const shown = open && holding;
  const onKeyDown = useModalBehavior(shown, frame, heading, onClose);
  if (!shown) return null;
  return (
    <div className="al-dialog-overlay">
      <section
        ref={frame}
        className={cx('al-surface', 'al-surface--l4', 'al-dialog', className)}
        data-level="4"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        onKeyDown={onKeyDown}
      >
        <h2 id={`${id}-title`} ref={heading} className="al-dialog-title" tabIndex={-1}>
          {title}
        </h2>
        <div className="al-dialog-body">{children}</div>
      </section>
    </div>
  );
}
