// Feedback and onboarding blocks (M1-35b; d1/components/Banner, Toast, EmptyState, CopyPrompt,
// SecretDisplay).
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { Icon } from './brand.js';
import { Button } from './forms.js';
import { cleanText, cx } from './util.js';

const TONE_ICON = {
  info: 'info',
  success: 'check',
  warning: 'triangle-alert',
  danger: 'circle-alert',
  neutral: 'info',
  offline: 'wifi-off',
  proof: 'proof-seal',
} as const;

export interface BannerProps {
  /** `danger` only for integrity or signature failures. */
  tone?: keyof typeof TONE_ICON;
  title?: string;
  icon?: string;
  /** At most one action. */
  action?: ReactNode;
  compact?: boolean;
  children?: ReactNode;
}

/** Page-level message with an icon, one or two sentences and at most one action. */
export function Banner({
  tone = 'info',
  title,
  icon,
  action,
  compact,
  children,
}: BannerProps): ReactElement {
  return (
    <div
      className={cx(
        'al-banner',
        `al-tone-${tone === 'offline' ? 'neutral' : tone}`,
        compact === true && 'is-compact',
      )}
      role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}
    >
      <Icon name={icon ?? TONE_ICON[tone]} size={16} />
      <div className="al-banner-text al-text-body">
        {title === undefined ? null : <strong>{`${title} `}</strong>}
        {children}
      </div>
      {action === undefined ? null : <div className="al-banner-act">{action}</div>}
    </div>
  );
}

export interface ToastProps {
  tone?: Exclude<keyof typeof TONE_ICON, 'offline'>;
  icon?: string;
  /** One view or undo action. */
  action?: string;
  onAction?: () => void;
  onDismiss?: () => void;
  children?: ReactNode;
}

/** A transient outcome with one action. Polite live region; never takes focus; never approves anything. */
export function Toast({
  tone = 'success',
  icon,
  action,
  onAction,
  onDismiss,
  children,
}: ToastProps): ReactElement {
  return (
    <div className={cx('al-toast', `al-tone-${tone}`)} role="status" aria-live="polite">
      <Icon name={icon ?? TONE_ICON[tone]} size={16} />
      <span className="al-text-body">{children}</span>
      {action === undefined ? null : (
        <button type="button" className="al-toast-act al-text-body-sm" onClick={onAction}>
          {action}
        </button>
      )}
      <button type="button" className="al-toast-x" aria-label="Dismiss" onClick={onDismiss}>
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}

export interface EmptyStateProps {
  title: string;
  /** A prompt to try in your AI, for example `Send the signed contract to Marko and notarize it.` */
  prompt?: string;
  icon?: string;
  action?: ReactNode;
}

/** One sentence plus a prompt to try in your AI. */
export function EmptyState({
  title,
  prompt,
  icon = 'inbox',
  action,
}: EmptyStateProps): ReactElement {
  return (
    <div className="al-empty">
      <span className="al-empty-ic">
        <Icon name={icon} size={20} />
      </span>
      <p className="al-text-body">{title}</p>
      {prompt === undefined ? null : (
        <code className="al-empty-try al-text-code">
          <span className="al-muted">Try: </span>
          {prompt}
        </code>
      )}
      {action ?? null}
    </div>
  );
}

/** Copy text to the clipboard; false when there is no clipboard or the browser refuses. */
async function copyText(text: string): Promise<boolean> {
  try {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (clipboard === undefined) return false;
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export interface CopyPromptProps {
  /** Natural-language text to paste into an AI. */
  prompt?: string;
  /** A shell line, drawn after a `$`. */
  command?: string;
  title?: string;
  note?: string;
  /** `hero` makes Copy primary: the largest element of onboarding. */
  size?: 'default' | 'hero';
}

/** The "Paste this to your agent" block and terminal commands. */
export function CopyPrompt({
  prompt,
  command,
  title,
  note,
  size = 'default',
}: CopyPromptProps): ReactElement {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  const isCommand = command !== undefined && prompt === undefined;
  return (
    <section className={cx('al-copy', size === 'hero' && 'is-hero')}>
      <header className="al-copy-head">
        <span className="al-copy-title">
          <Icon name={isCommand ? 'terminal' : 'agent'} size={14} />
          <span className="al-text-label">
            {title ?? (isCommand ? 'Terminal' : 'Paste this to your agent')}
          </span>
        </span>
        <Button
          size="sm"
          variant={size === 'hero' ? 'primary' : 'ghost'}
          icon={copied ? 'check' : 'copy'}
          onClick={() => {
            void copyText(prompt ?? command ?? '').then((ok) => setCopied(ok));
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <span className="al-sr-only" role="status" aria-live="polite">
          {copied ? 'Copied' : ''}
        </span>
      </header>
      <pre className="al-copy-body al-text-code">
        {isCommand ? (
          <>
            <span className="al-copy-ps" aria-hidden="true">
              {'$ '}
            </span>
            <span className="al-copy-cmd">{command}</span>
          </>
        ) : (
          prompt
        )}
      </pre>
      {note === undefined ? null : <p className="al-copy-note al-text-caption al-muted">{note}</p>}
    </section>
  );
}

export interface SecretDisplayProps {
  label?: string;
  /** The secret, in groups separated by spaces. Shown once; never echoed anywhere else. */
  value: string;
  explain?: string;
  /** Without it, Copy uses the clipboard. */
  onCopy?: () => void;
  onDownload?: () => void;
  onPrint?: () => void;
  onContinue?: () => void;
}

/** A secret shown once (recovery code, unlock code). Continue stays disabled until "I've saved it". */
export function SecretDisplay({
  label = 'Recovery code',
  value,
  explain,
  onCopy,
  onDownload,
  onPrint,
  onContinue,
}: SecretDisplayProps): ReactElement {
  const [saved, setSaved] = useState(false);
  const groups = cleanText(value, 400).split(' ');
  return (
    <section className="al-secret" aria-label={label}>
      <div className="al-secret-head">
        <span className="al-text-label">{label}</span>
        <span className="al-text-caption al-muted">Shown once</span>
      </div>
      <div className="al-secret-val al-text-code-lg">
        {groups.map((g, i) => (
          <span key={i}>{g}</span>
        ))}
      </div>
      {explain === undefined ? null : <p className="al-text-body-sm al-muted">{explain}</p>}
      <div className="al-secret-actions">
        <Button
          size="sm"
          icon="copy"
          onClick={() => {
            if (onCopy !== undefined) onCopy();
            else void copyText(value);
          }}
        >
          Copy
        </Button>
        {onDownload === undefined ? null : (
          <Button size="sm" icon="download" onClick={onDownload}>
            Download
          </Button>
        )}
        {onPrint === undefined ? null : (
          <Button size="sm" icon="printer" onClick={onPrint}>
            Print
          </Button>
        )}
      </div>
      <label className="al-check al-text-body">
        <input type="checkbox" checked={saved} onChange={() => setSaved(!saved)} />
        I've saved it
      </label>
      <Button variant="primary" block disabled={!saved} onClick={onContinue}>
        Continue
      </Button>
    </section>
  );
}
