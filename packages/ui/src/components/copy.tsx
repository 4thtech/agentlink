// The one copy button (N1; docs/design/notices.md). Copies text to the clipboard, says "Copied" for
// COPIED_MS (inline, as 21.5 asks), announces it politely once, and says plainly when it could not
// copy. Text only: the text it copies is never put in an attribute, a log or an error.
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { Button, type ButtonProps } from './forms.js';
import { COPIED_MS } from './notice-timing.js';

export type CopyState = 'idle' | 'copied' | 'failed';

/** Writes text to the clipboard; false when there is no clipboard or it refused. */
export async function copyText(text: string): Promise<boolean> {
  try {
    const clip = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (clip === undefined) return false;
    await clip.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** The copy state machine: `copy(text)` sets copied (back to idle after COPIED_MS) or failed. */
export function useCopy(ms: number = COPIED_MS): {
  readonly state: CopyState;
  readonly copy: (text: string) => void;
} {
  const [state, setState] = useState<CopyState>('idle');
  useEffect(() => {
    if (state !== 'copied') return undefined;
    const timer = setTimeout(() => setState('idle'), ms);
    return () => clearTimeout(timer);
  }, [state, ms]);
  const copy = useCallback((text: string): void => {
    void copyText(text).then((ok) => setState(ok ? 'copied' : 'failed'));
  }, []);
  return { state, copy };
}

export interface CopyButtonProps {
  /** What is copied. */
  text: string;
  /** The words on the button (default "Copy"). */
  label?: string;
  /** The words after copying (default "Copied"). */
  copiedLabel?: string;
  /** Said when the copy did not work. */
  failedLabel?: string;
  /** An accessible name when the visible label alone is not clear. */
  ariaLabel?: string;
  size?: ButtonProps['size'];
  variant?: ButtonProps['variant'];
  className?: string;
}

/** A button that copies `text` and confirms it in place. */
export function CopyButton({
  text,
  label = 'Copy',
  copiedLabel = 'Copied',
  failedLabel = 'Couldn’t copy. Select the text and copy it yourself.',
  ariaLabel,
  size = 'sm',
  variant = 'ghost',
  className,
}: CopyButtonProps): ReactElement {
  const { state, copy } = useCopy();
  return (
    <>
      <Button
        size={size}
        variant={variant}
        icon={state === 'copied' ? 'check' : 'copy'}
        {...(className === undefined ? {} : { className })}
        {...(ariaLabel === undefined ? {} : { 'aria-label': ariaLabel })}
        onClick={() => copy(text)}
      >
        {state === 'copied' ? copiedLabel : label}
      </Button>
      <span className="al-visually-hidden" role="status" aria-live="polite">
        {state === 'copied' ? copiedLabel : state === 'failed' ? failedLabel : ''}
      </span>
    </>
  );
}
