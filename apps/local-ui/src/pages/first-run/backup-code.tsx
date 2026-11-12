// F49 (owner feedback, Windows): the master code is easy to type, paste, see and keep.
// - BackupCodeField: every backup-code input. Paste is never blocked; a Show/Hide toggle lets the
//   person check what they typed or pasted; pasted invisible separators are removed (below).
// - saveBackupCodeFile: "Save as file" on the once-shown code, a small .txt made in this page and
//   downloaded locally (a blob URL). Nothing is sent anywhere.
// The code is never put in a URL, a log, analytics or any request other than the existing local
// approval endpoints, which receive it exactly as before.
import { Button, TextField, type TextFieldProps } from '@4thtech-io/ui';
import { useId, useState, type ReactElement } from 'react';

/**
 * The server's own rule for a generated code (packages/crypto secret-code.ts normalizeCode):
 * ASCII only; ASCII spaces and `-` ignored; upper-cased; 0→O, 1→I, 8→B; then exactly 24 base32
 * characters. A copy from a mail, a document or a PDF on Windows can add characters that rule
 * refuses (no-break spaces, tabs, line breaks, zero-width spaces, en/em dashes).
 *
 * This removes only those characters, and only when what is left is a code's shape (24 characters
 * the server's rule accepts, once its own ignored spaces and dashes are left out). It leaves case,
 * ASCII spaces and `-` to the server, so a valid code is never changed: the server reads the same
 * value either way. Anything else (a chosen owner passphrase, opted into in the terminal, which is
 * case- and space-sensitive) is sent exactly as typed.
 */
const SEPARATORS =
  /[\s\u00a0\u1680\u180e\u2000-\u200d\u2010-\u2015\u2028\u2029\u202f\u205f\u2060\u2212\u3000\ufeff]/gu;
const ASCII_IGNORED = /[ -]/g;
const CODE_SHAPE = /^[A-Za-z2-7018]{24}$/;

export function normaliseBackupCode(raw: string): string {
  const compact = raw.replace(SEPARATORS, '').replace(ASCII_IGNORED, '');
  if (!CODE_SHAPE.test(compact)) return raw;
  // Keep the ASCII spaces and dashes the person typed (the server ignores them); drop the rest.
  return raw.replace(SEPARATORS, (ch) => (ch === ' ' ? ' ' : ''));
}

export const BACKUP_CODE_FIELD = {
  show: 'Show',
  hide: 'Hide',
} as const;

/**
 * F49 low (IR 11-03): the cleanup runs on what arrives in one piece (a paste, a drop, a password
 * manager's fill), never on what the person types key by key. A chosen passphrase typed with a
 * no-break space (Option+Space on a Mac) or a dash from the keyboard is sent exactly as typed, even
 * when what is left looks like a code; the cleanup exists only for what a copy adds.
 */
const TYPED = /^(insertText|insertCompositionText|insertLineBreak|insertParagraph|delete)/;

export function typedByKey(event: Event): boolean {
  const kind = (event as Partial<InputEvent>).inputType;
  return typeof kind === 'string' && TYPED.test(kind);
}

/**
 * FB-8: every screen that asks for Touch ID, Windows Hello or a passkey also offers this. It only
 * switches the screen to the backup-code field, whose submit is that screen's existing code path.
 * `data-use-code` is what the presence-surface guard (src/presence-surfaces.dom.test.ts) looks for.
 */
export const USE_CODE_INSTEAD = 'Use your master code instead';

export function UseCodeInstead({
  onClick,
  disabled,
}: {
  readonly onClick: () => void;
  readonly disabled?: boolean;
}): ReactElement {
  return (
    <Button
      variant="ghost"
      size="sm"
      data-use-code=""
      {...(disabled === undefined ? {} : { disabled })}
      onClick={onClick}
    >
      {USE_CODE_INSTEAD}
    </Button>
  );
}

export type BackupCodeFieldProps = Omit<
  TextFieldProps,
  'type' | 'onChange' | 'value' | 'suffix'
> & {
  readonly value: string;
  /** The typed or pasted value; a paste has its invisible separators removed (normaliseBackupCode). */
  readonly onValue: (value: string) => void;
};

/** A backup-code input: paste works, Show/Hide reveals it, pasted separators are cleaned. */
export function BackupCodeField({
  value,
  onValue,
  disabled,
  id: givenId,
  ...rest
}: BackupCodeFieldProps): ReactElement {
  const [shown, setShown] = useState(false);
  const generated = useId();
  const id = givenId ?? generated;
  return (
    <TextField
      id={id}
      autoComplete="off"
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      mono
      {...rest}
      disabled={disabled}
      type={shown ? 'text' : 'password'}
      value={value}
      onChange={(event) => {
        const raw = event.currentTarget.value;
        onValue(typedByKey(event.nativeEvent) ? raw : normaliseBackupCode(raw));
      }}
      suffix={
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={shown}
          aria-controls={id}
          data-reveal-code=""
          disabled={disabled}
          onClick={() => setShown(!shown)}
        >
          {shown ? BACKUP_CODE_FIELD.hide : BACKUP_CODE_FIELD.show}
        </Button>
      }
    />
  );
}

export const BACKUP_CODE_FILE_NAME = 'agentlink-backup-code.txt';

/** The file's text: the code and one line on what it is for. */
export function backupCodeFileText(code: string, sensor: string): string {
  return `AgentLink master code: ${code}\nUse it to approve when ${sensor} isn't available. Keep this file private and never give the code to your AI.\n`;
}

/**
 * Downloads the code as a small .txt, made in this page (a blob URL revoked right after). Returns
 * false when the browser can't (the person can still copy it or save it in a password manager).
 */
export function saveBackupCodeFile(code: string, sensor: string): boolean {
  try {
    const blob = new Blob([backupCodeFileText(code, sensor)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = BACKUP_CODE_FILE_NAME;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
  } catch {
    return false;
  }
}

/** The hidden-textarea copy, for a browser whose clipboard API is missing or refuses. */
function copyWithSelection(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '0';
  area.style.opacity = '0';
  area.style.pointerEvents = 'none';
  const before = document.activeElement as HTMLElement | null;
  document.body.appendChild(area);
  try {
    area.focus();
    area.select();
    area.setSelectionRange(0, text.length);
    return typeof document.execCommand === 'function' && document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.value = '';
    area.remove();
    before?.focus?.();
  }
}

/**
 * F49 (owner, Windows Chrome: "impossible to copy"): Copy that does not fail silently. The
 * clipboard API first; when it is missing or refuses (no focus, a blocked permission), the
 * selection copy; false when both fail, so the page can say so.
 */
export async function copyBackupCode(code: string): Promise<boolean> {
  const clip = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (clip !== undefined && typeof clip.writeText === 'function') {
    try {
      await clip.writeText(code);
      return true;
    } catch {
      // Fall through to the selection copy.
    }
  }
  return copyWithSelection(code);
}
