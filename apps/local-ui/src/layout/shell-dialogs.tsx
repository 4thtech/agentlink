// W4-SHELL-V2 (prototype v23 Help): the shell's two small dialogs, Keyboard shortcuts and Report a
// problem. Modal: focus moves in, Tab stays inside, Escape or Close returns focus to what opened it.
// Report a problem sends nothing anywhere: "Copy report" puts the text (and, when ticked, versions
// and statuses only, never messages, keys, names or paths) on the clipboard for the user to send.
import { Button } from '@4thtech-io/ui';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { SHELL_STRINGS as S } from '../strings.js';

export type ShellDialog = 'shortcuts' | 'report';
const OPEN = 'agentlink:shell-dialog';

/** Opens a shell dialog; focus goes back to `returnTo` (or what had focus) on close. */
export function openShellDialog(which: ShellDialog, returnTo?: HTMLElement | null): void {
  window.dispatchEvent(
    new CustomEvent(OPEN, { detail: { which, returnTo: returnTo ?? document.activeElement } }),
  );
}

/** What "Add diagnostics" adds: versions and statuses only. */
export interface ReportFacts {
  readonly version?: string;
  readonly connection: string;
  readonly hood: boolean;
  readonly agents: number;
}

export function reportText(what: string, facts: ReportFacts | undefined): string {
  const lines = [what.trim()];
  if (facts !== undefined) {
    lines.push(
      '',
      `AgentLink ${facts.version ?? 'unknown version'}`,
      `Status: ${facts.connection}`,
      `Under the hood: ${facts.hood ? 'on' : 'off'}`,
      `Agents: ${String(facts.agents)}`,
    );
  }
  return lines.join('\n');
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function useTrap(): {
  ref: React.RefObject<HTMLDivElement | null>;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
} {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Tab' || ref.current === null) return;
    const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  return { ref, onKeyDown };
}

function Shortcuts({
  onClose,
  keys,
}: {
  onClose: () => void;
  keys: (key: string, shift?: boolean) => string;
}): ReactElement {
  const title = useId();
  const trap = useTrap();
  const rows: readonly (readonly [string, string])[] = [
    [S.shortcutGoTo, keys('K')],
    [S.shortcutHood, keys('U', true)],
    [S.shortcutShow, keys('/')],
    [S.shortcutClose, 'esc'],
    [S.shortcutMove, '↑ ↓ ⏎'],
  ];
  return (
    <div
      ref={trap.ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby={title}
      className="al-dialog al-pop"
      onKeyDown={trap.onKeyDown}
    >
      <h2 id={title} className="al-text-title-3 al-dialog-title">
        {S.shortcutsTitle}
      </h2>
      <dl className="al-shortcuts">
        {rows.map(([what, key]) => (
          <div key={what} className="al-shortcut">
            <dt>{what}</dt>
            <dd>
              <kbd className="al-kbd">{key}</kbd>
            </dd>
          </div>
        ))}
      </dl>
      <div className="al-dialog-actions">
        <Button variant="secondary" onClick={onClose}>
          {S.close}
        </Button>
      </div>
    </div>
  );
}

function Report({
  onClose,
  facts,
}: {
  onClose: () => void;
  facts: () => ReportFacts;
}): ReactElement {
  const title = useId();
  const field = useId();
  const trap = useTrap();
  const [what, setWhat] = useState('');
  const [diag, setDiag] = useState(true);
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    const text = reportText(what, diag ? facts() : undefined);
    void navigator.clipboard?.writeText(text).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  return (
    <div
      ref={trap.ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby={title}
      className="al-dialog al-pop"
      onKeyDown={trap.onKeyDown}
    >
      <h2 id={title} className="al-text-title-3 al-dialog-title">
        {S.reportTitle}
      </h2>
      <label htmlFor={field} className="al-text-body-sm al-muted">
        {S.reportWhat}
      </label>
      <textarea
        id={field}
        className="al-report-text"
        rows={4}
        placeholder={S.reportPlaceholder}
        value={what}
        onChange={(e) => setWhat(e.currentTarget.value)}
      />
      <label className="al-report-diag al-text-body-sm">
        <input type="checkbox" checked={diag} onChange={(e) => setDiag(e.currentTarget.checked)} />
        {S.reportDiagnostics}
      </label>
      <p className="al-text-body-sm al-muted" role="status" aria-live="polite">
        {copied ? S.reportCopied : ''}
      </p>
      <div className="al-dialog-actions">
        <Button variant="ghost" onClick={onClose}>
          {S.reportCancel}
        </Button>
        <Button variant="primary" onClick={copy}>
          {S.reportCopy}
        </Button>
      </div>
    </div>
  );
}

export interface ShellDialogsProps {
  readonly keys: (key: string, shift?: boolean) => string;
  readonly facts: () => ReportFacts;
}

/** The one place the shell's dialogs render (once, in the layout). */
export function ShellDialogs({ keys, facts }: ShellDialogsProps): ReactElement | null {
  const [which, setWhich] = useState<ShellDialog | null>(null);
  const back = useRef<HTMLElement | null>(null);
  const close = useCallback(() => {
    setWhich(null);
    const el = back.current;
    back.current = null;
    if (el?.isConnected === true) el.focus();
  }, []);
  useEffect(() => {
    const onOpen = (event: Event): void => {
      const detail = (event as CustomEvent<{ which: ShellDialog; returnTo: unknown }>).detail;
      back.current = detail.returnTo instanceof HTMLElement ? detail.returnTo : null;
      setWhich(detail.which);
    };
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') setWhich((w) => (w === null ? w : null));
    };
    window.addEventListener(OPEN, onOpen);
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener(OPEN, onOpen);
      document.removeEventListener('keydown', onKey);
    };
  }, []);
  useEffect(() => {
    if (which === null && back.current !== null) close();
  }, [which, close]);
  if (which === null) return null;
  return (
    <div className="al-dialog-backdrop" onMouseDown={close}>
      <div onMouseDown={(e) => e.stopPropagation()}>
        {which === 'shortcuts' ? (
          <Shortcuts onClose={close} keys={keys} />
        ) : (
          <Report onClose={close} facts={facts} />
        )}
      </div>
    </div>
  );
}
