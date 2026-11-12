// The recovery code field (UX1113-R3; spec §6.6 step 2): six boxes of four. Paste fills all of them;
// capitals or small letters, spaces, dashes and invisible separators are ignored. Held in this
// component's state only: autocomplete is off, nothing is written to storage, the URL or an attribute
// (the boxes show their value as the element's own value, which is not an attribute).
import { useId, useRef, type ClipboardEvent, type KeyboardEvent, type ReactElement } from 'react';
import { CODE as T } from './strings.js';

export const GROUPS = 6;
export const GROUP_SIZE = 4;

/** Letters and digits only, upper-cased: what a copy from a mail, a PDF or a note may carry is dropped. */
export function clean(raw: string): string {
  return raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/** Spreads a string over six groups of four. */
export function toGroups(raw: string): string[] {
  const text = clean(raw).slice(0, GROUPS * GROUP_SIZE);
  return Array.from({ length: GROUPS }, (_, i) => text.slice(i * GROUP_SIZE, (i + 1) * GROUP_SIZE));
}

export const emptyGroups = (): string[] => Array.from({ length: GROUPS }, () => '');
export const codeOf = (groups: readonly string[]): string => groups.join('');
export const isComplete = (groups: readonly string[]): boolean =>
  codeOf(groups).length === GROUPS * GROUP_SIZE;

export interface CodeFieldProps {
  readonly value: readonly string[];
  readonly onChange: (groups: string[]) => void;
  readonly disabled?: boolean;
  readonly invalid?: boolean;
  readonly describedBy?: string;
  /** Enter on the last box. */
  readonly onSubmit?: () => void;
}

export function CodeField({
  value,
  onChange,
  disabled,
  invalid,
  describedBy,
  onSubmit,
}: CodeFieldProps): ReactElement {
  const id = useId();
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const focus = (i: number): void => {
    const el = refs.current[Math.max(0, Math.min(GROUPS - 1, i))];
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  };
  const set = (i: number, text: string): void => {
    const next = [...value];
    next[i] = text;
    onChange(next);
  };

  const onPaste = (i: number, event: ClipboardEvent<HTMLInputElement>): void => {
    const pasted = clean(event.clipboardData.getData('text'));
    if (pasted.length === 0) return;
    event.preventDefault();
    if (pasted.length > GROUP_SIZE) {
      // More than one group: a whole code fills from the first box, a part from this one.
      const start = pasted.length >= GROUPS * GROUP_SIZE ? 0 : i;
      const next = [...value];
      for (let k = 0; start + k < GROUPS; k += 1) {
        const chunk = pasted.slice(k * GROUP_SIZE, (k + 1) * GROUP_SIZE);
        if (chunk === '') break;
        next[start + k] = chunk;
      }
      onChange(next);
      focus(Math.min(GROUPS - 1, start + Math.floor(pasted.length / GROUP_SIZE)));
      return;
    }
    set(i, pasted.slice(0, GROUP_SIZE));
  };

  const onKey = (i: number, event: KeyboardEvent<HTMLInputElement>): void => {
    const el = event.currentTarget;
    if (event.key === 'Backspace' && el.value === '' && i > 0) {
      event.preventDefault();
      focus(i - 1);
    } else if (event.key === 'ArrowLeft' && el.selectionStart === 0 && i > 0) {
      event.preventDefault();
      focus(i - 1);
    } else if (
      event.key === 'ArrowRight' &&
      el.selectionStart === el.value.length &&
      i < GROUPS - 1
    ) {
      event.preventDefault();
      focus(i + 1);
    } else if (event.key === 'Enter' && onSubmit !== undefined) {
      event.preventDefault();
      onSubmit();
    }
  };

  return (
    <div role="group" aria-label={T.groupsLabel} className="rs-code" id={id}>
      {value.map((group, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          className="rs-code-box"
          type="text"
          inputMode="text"
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          maxLength={GROUP_SIZE}
          size={GROUP_SIZE}
          aria-label={T.groupLabel(i + 1)}
          {...(invalid === true ? { 'aria-invalid': true } : {})}
          {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
          data-lpignore="true"
          data-1p-ignore="true"
          disabled={disabled === true}
          value={group}
          onChange={(event) => {
            const text = clean(event.currentTarget.value).slice(0, GROUP_SIZE);
            set(i, text);
            if (text.length === GROUP_SIZE && i < GROUPS - 1) focus(i + 1);
          }}
          onPaste={(event) => onPaste(i, event)}
          onKeyDown={(event) => onKey(i, event)}
        />
      ))}
    </div>
  );
}
