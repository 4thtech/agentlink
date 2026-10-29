// Actions and form controls (M1-35b; d1/components/Button, Kbd, TextField, Switch, Segmented).
import {
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { Icon } from './brand.js';
import { cx } from './util.js';

export interface KbdProps {
  children: ReactNode;
}

/** A keyboard key, for shortcuts in menus and tooltips. */
export function Kbd({ children }: KbdProps): ReactElement {
  return <kbd className="al-kbd">{children}</kbd>;
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** `primary` at most once per view; `danger` only for destructive or irreversible actions. */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  /** `lg` (44px) for approvals and on mobile. */
  size?: 'sm' | 'md' | 'lg';
  icon?: string;
  iconRight?: string;
  kbd?: string;
  block?: boolean;
}

/**
 * Verb-first, sentence-case action. It never autofocuses: there is no default button on approval
 * surfaces (11 §8), so `autoFocus` is dropped here for every caller.
 */
export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  iconRight,
  kbd,
  block,
  className,
  children,
  type = 'button',
  autoFocus: _autoFocus,
  ...rest
}: ButtonProps): ReactElement {
  void _autoFocus; // dropped on purpose: no autofocus on any action
  return (
    <button
      {...rest}
      type={type}
      className={cx(
        'al-btn',
        `al-btn-${variant}`,
        `al-btn-${size}`,
        block === true && 'al-btn-block',
        className,
      )}
    >
      {icon === undefined ? null : <Icon name={icon} size={size === 'lg' ? 18 : 16} />}
      {children === undefined || children === null ? null : <span>{children}</span>}
      {iconRight === undefined ? null : <Icon name={iconRight} size={16} />}
      {kbd === undefined ? null : <Kbd>{kbd}</Kbd>}
    </button>
  );
}

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix'> {
  label?: string;
  hint?: string;
  /** Replaces the hint and says what to do. */
  error?: string;
  /** For codes, domains, IDs and amounts. */
  mono?: boolean;
  prefix?: string;
}

/** Labelled single-line input on a sunken well. Codes accept paste and password managers. */
export function TextField({
  label,
  hint,
  error,
  mono,
  prefix,
  className,
  id: givenId,
  ...rest
}: TextFieldProps): ReactElement {
  const generated = useId();
  const id = givenId ?? generated;
  const described = error !== undefined || hint !== undefined;
  return (
    <div className={cx('al-field', error !== undefined && 'is-error', className)}>
      {label === undefined ? null : (
        <label htmlFor={id} className="al-field-label al-text-body-sm">
          {label}
        </label>
      )}
      <div className="al-input-wrap">
        {prefix === undefined ? null : (
          <span className="al-input-prefix al-text-code">{prefix}</span>
        )}
        <input
          {...rest}
          id={id}
          className={cx('al-input', mono === true && 'al-text-code')}
          aria-invalid={error === undefined ? undefined : 'true'}
          aria-describedby={described ? `${id}-d` : undefined}
        />
      </div>
      {described ? (
        <div
          id={`${id}-d`}
          className={cx('al-field-hint al-text-caption', error !== undefined && 'is-error')}
        >
          {error === undefined ? null : <Icon name="circle-alert" size={14} />}
          {error ?? hint}
        </div>
      ) : null}
    </div>
  );
}

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  hint?: string;
  /** Replaces the hint and says what to do. */
  error?: string;
  /** For pasted text that is a code or a link. */
  mono?: boolean;
}

/**
 * Labelled multi-line field on a sunken well (HOTFIX-045-PASTE-FIELD). The well grows with the box,
 * so the label above and the hint below never overlap the text; use it for pasted text, not
 * `TextField`, whose well is one line tall.
 */
export function TextArea({
  label,
  hint,
  error,
  mono,
  className,
  id: givenId,
  rows = 3,
  ...rest
}: TextAreaProps): ReactElement {
  const generated = useId();
  const id = givenId ?? generated;
  const described = error !== undefined || hint !== undefined;
  return (
    <div className={cx('al-field', error !== undefined && 'is-error', className)}>
      {label === undefined ? null : (
        <label htmlFor={id} className="al-field-label al-text-body-sm">
          {label}
        </label>
      )}
      <div className="al-input-wrap al-input-wrap-multi">
        <textarea
          {...rest}
          id={id}
          rows={rows}
          className={cx('al-input al-textarea', mono === true && 'al-text-code')}
          aria-invalid={error === undefined ? undefined : 'true'}
          aria-describedby={described ? `${id}-d` : undefined}
        />
      </div>
      {described ? (
        <div
          id={`${id}-d`}
          className={cx('al-field-hint al-text-caption', error !== undefined && 'is-error')}
        >
          {error === undefined ? null : <Icon name="circle-alert" size={14} />}
          {error ?? hint}
        </div>
      ) : null}
    </div>
  );
}

export interface SwitchProps {
  label: string;
  /** When the effect is not obvious. */
  description?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  disabled?: boolean;
  /** A quiet word beside the switch, e.g. "Unsaved" while a draft differs from what is in force. */
  note?: string;
  onChange?: (on: boolean) => void;
}

/**
 * Binary setting that applies immediately, with On / Off in words beside the knob. A rule saved
 * through a switch still needs owner presence on save; the caller does that in `onChange`.
 */
export function Switch({
  label,
  description,
  checked,
  defaultChecked,
  disabled,
  note,
  onChange,
}: SwitchProps): ReactElement {
  const [inner, setInner] = useState(defaultChecked === true);
  const on = checked ?? inner;
  const id = useId();
  const describedBy =
    [description === undefined ? '' : `${id}-d`, note === undefined ? '' : `${id}-n`]
      .filter((x) => x !== '')
      .join(' ') || undefined;
  const toggle = (): void => {
    if (disabled === true) return;
    if (checked === undefined) setInner(!on);
    onChange?.(!on);
  };
  return (
    <label className={cx('al-switch-row', disabled === true && 'is-disabled')}>
      <span className="al-switch-text">
        <span id={`${id}-l`} className="al-text-body">
          {label}
        </span>
        {description === undefined ? null : (
          <span id={`${id}-d`} className="al-text-caption al-muted">
            {description}
          </span>
        )}
      </span>
      {note === undefined ? null : (
        <span id={`${id}-n`} className="al-switch-note al-text-caption al-muted">
          {note}
        </span>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={on ? 'true' : 'false'}
        aria-labelledby={`${id}-l`}
        aria-describedby={describedBy}
        className={cx('al-switch', on && 'is-on')}
        onClick={toggle}
        disabled={disabled}
      >
        <span className="al-switch-knob" />
        <span className="al-switch-state al-text-label">{on ? 'On' : 'Off'}</span>
      </button>
    </label>
  );
}

export interface SegmentedOption {
  value: string;
  label: string;
  /** `recommended` marks the safe default. */
  hint?: string;
  /** Shown inside the option after the label (a count badge). */
  badge?: ReactNode;
}

export interface SegmentedProps {
  label: string;
  /** The id of a visible label for the group. The group keeps `label` too (same words). */
  labelledBy?: string;
  options: readonly SegmentedOption[];
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  /**
   * `radio` (default) for values, filters and layouts. `tabs` for views that swap the panel below:
   * tablist semantics (ARIA APG), same look (b11 §22.1).
   */
  variant?: 'radio' | 'tabs';
  /** Tabs: tab ids are `<idPrefix>-tab-<value>`, so the panel can name its tab. */
  idPrefix?: string;
  /** Tabs: the id of the tabpanel that every tab controls. */
  panelId?: string;
}

/**
 * Pick one of 2 to 4 options (Allowed / Ask me / Never) in the switch's visual language: a recessed
 * track and a sliding thumb. One tab stop; arrow keys move and select (wrapping); Home and End jump.
 */
export function Segmented({
  label,
  labelledBy,
  options,
  value,
  defaultValue,
  onChange,
  variant = 'radio',
  idPrefix,
  panelId,
}: SegmentedProps): ReactElement {
  const fallbackId = useId();
  const prefix = idPrefix ?? fallbackId;
  const tabs = variant === 'tabs';
  const [inner, setInner] = useState(defaultValue ?? options[0]?.value);
  const current = value ?? inner;
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const stop = Math.max(
    0,
    options.findIndex((o) => o.value === current),
  );
  const choose = (next: string): void => {
    if (value === undefined) setInner(next);
    onChange?.(next);
  };
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    let target: number;
    if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = options.length - 1;
    else if (step === 0) return;
    else target = (index + step + options.length) % options.length;
    event.preventDefault();
    const option = options[target];
    if (option === undefined) return;
    choose(option.value);
    refs.current[target]?.focus();
  };
  return (
    <div
      className="al-seg"
      role={tabs ? 'tablist' : 'radiogroup'}
      aria-label={label}
      aria-labelledby={labelledBy}
      data-count={options.length}
      data-index={stop}
    >
      {options.map((option, i) => {
        const on = option.value === current;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role={tabs ? 'tab' : 'radio'}
            {...(tabs
              ? {
                  id: `${prefix}-tab-${option.value}`,
                  'aria-selected': on ? 'true' : 'false',
                  'aria-controls': panelId,
                }
              : { 'aria-checked': on ? 'true' : 'false' })}
            tabIndex={i === stop ? 0 : -1}
            className={cx('al-seg-opt al-text-body-sm', on && 'is-on')}
            onClick={() => choose(option.value)}
            onKeyDown={(event) => onKey(event, i)}
          >
            {on ? <Icon name="check" size={14} /> : null}
            {option.label}
            {option.hint === undefined ? null : <span className="al-seg-hint">{option.hint}</span>}
            {option.badge}
          </button>
        );
      })}
    </div>
  );
}
