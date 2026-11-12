// The one notice system (UX 2026-11-12, docs/design/notices.md). Three kinds, one look:
//
// - Toast (feedback.tsx `Toast`, stacked here by `ToastStack`): a transient outcome. Bottom right
//   (centred on narrow screens), closes itself after a few seconds, and always has a close button.
//   Polite; never takes focus; never approves anything.
// - Inline banner (feedback.tsx `Banner`): next to what it is about. Tone info, success, warning or
//   danger; an optional dismiss.
// - Page notice (`PageNotice`, this file): persistent until resolved, at the top of a page, with
//   its action. A labelled region, not a live region: it is there when the page opens.
//
// Classes only (components.css; 08 §4 CSP). Text from other parties is text only (I-5).
import { useEffect, useId, useRef, type ReactElement, type ReactNode } from 'react';
import { Icon } from './brand.js';
import { Toast, type ToastProps } from './feedback.js';
import { cx } from './util.js';

const NOTICE_ICON = {
  info: 'info',
  success: 'check',
  warning: 'triangle-alert',
  danger: 'circle-alert',
  neutral: 'info',
} as const;

export type NoticeTone = keyof typeof NOTICE_ICON;

export interface PageNoticeProps {
  /** `danger` only for integrity or signature failures; `neutral` when nothing needs the owner. */
  tone?: NoticeTone;
  icon?: string;
  /** One short sentence, the notice's name for assistive technology (text; a `bdi` run is fine). */
  title: ReactNode;
  /** One or two sentences. */
  children?: ReactNode;
  /** The notice's action (at most one primary). */
  actions?: ReactNode;
  /** Present only when the notice may be closed before it is resolved. */
  onDismiss?: () => void;
  dismissLabel?: string;
  className?: string;
}

/** A persistent notice at the top of a page: icon, title, a sentence or two, its action, an optional close. */
export function PageNotice({
  tone = 'info',
  icon,
  title,
  children,
  actions,
  onDismiss,
  dismissLabel = 'Dismiss',
  className,
}: PageNoticeProps): ReactElement {
  const id = useId();
  return (
    <section
      className={cx('al-notice', `al-tone-${tone}`, className)}
      aria-labelledby={id}
      data-notice={tone}
    >
      <span className="al-notice-ic" aria-hidden="true">
        <Icon name={icon ?? NOTICE_ICON[tone]} size={16} />
      </span>
      <div className="al-notice-main">
        <p id={id} className="al-notice-title al-text-body">
          {title}
        </p>
        {children === undefined ? null : (
          <div className="al-notice-body al-text-body-sm">{children}</div>
        )}
        {actions === undefined ? null : <div className="al-notice-act">{actions}</div>}
      </div>
      {onDismiss === undefined ? null : (
        <button type="button" className="al-notice-x" aria-label={dismissLabel} onClick={onDismiss}>
          <Icon name="x" size={14} />
        </button>
      )}
    </section>
  );
}

export interface ToastItem {
  readonly id: string | number;
  readonly text: string;
  readonly tone?: ToastProps['tone'];
  readonly icon?: string;
  /** One view or undo action. */
  readonly action?: string;
  readonly onAction?: () => void;
}

/** How long a toast stays; one with an action stays longer, so it can be reached. */
export const TOAST_MS = 6_000;
export const TOAST_ACTION_MS = 10_000;

function TimedToast({
  item,
  onDismiss,
  ms,
}: {
  item: ToastItem;
  onDismiss: (id: ToastItem['id']) => void;
  ms: number;
}): ReactElement {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const close = useRef(onDismiss);
  close.current = onDismiss;
  const start = (): void => {
    if (ms <= 0) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => close.current(item.id), ms);
  };
  const hold = (): void => clearTimeout(timer.current);
  useEffect(() => {
    start();
    return hold;
    // One timer per toast; hover and focus hold it.
  }, []);
  return (
    <div
      className="al-toast-slot"
      onMouseEnter={hold}
      onMouseLeave={start}
      onFocus={hold}
      onBlur={start}
    >
      <Toast
        tone={item.tone ?? 'success'}
        {...(item.icon === undefined ? {} : { icon: item.icon })}
        {...(item.action === undefined
          ? {}
          : {
              action: item.action,
              onAction: () => {
                onDismiss(item.id);
                item.onAction?.();
              },
            })}
        onDismiss={() => onDismiss(item.id)}
      >
        {item.text}
      </Toast>
    </div>
  );
}

export interface ToastStackProps {
  readonly items: readonly ToastItem[];
  readonly onDismiss: (id: ToastItem['id']) => void;
  /** Auto-close after; 0 keeps toasts until closed (tests). Default TOAST_MS / TOAST_ACTION_MS. */
  readonly ms?: number;
  readonly label?: string;
}

/** The toasts, newest last, in one fixed corner. Each closes itself; hover or focus holds it. */
export function ToastStack({
  items,
  onDismiss,
  ms,
  label = 'Notifications',
}: ToastStackProps): ReactElement | null {
  if (items.length === 0) return null;
  return (
    <div className="al-toasts" role="region" aria-label={label}>
      {items.map((item) => (
        <TimedToast
          key={item.id}
          item={item}
          onDismiss={onDismiss}
          ms={ms ?? (item.action === undefined ? TOAST_MS : TOAST_ACTION_MS)}
        />
      ))}
    </div>
  );
}
