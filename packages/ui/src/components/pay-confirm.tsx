// M1-PAY-CONFIRM-b: the paid-action confirmation sheet (b11 §13.1 level 4, §14, §15, §19, §20;
// 04 §2.5.3; 08 §1; 11 §5; D-132).
//
// - It renders only the statement the server returned (`parsePayStatement` refuses anything else):
//   what it is for, the amount (large, tabular, never animated), the detail rows, the old and new
//   value of each spending change, and the trust lines. No value comes from the URL or the page.
// - The main button names the platform's check ("Confirm with Touch ID", "Windows Hello", "your
//   passkey"); it is never focused by default: focus starts on the title (11 §8, b11 §19.5). The
//   system prompt is never drawn; the sheet only waits beside it.
// - One polite live region says Waiting, Recording, Done and notices; errors are role=alert.
// - Done closes itself after about 1.2 s (D-132 decision 3); with reduced motion it waits for Close.
// - The backup code is a small secondary link (D-132 decision 2).
//
// The approval page of @4thtech-io/node draws the same sheet without React (approval-page.ts, the
// PAY_* strings); a test compares the words.
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from 'react';
import { Button, TextField } from './forms.js';

/** Every word the sheet shows (11 §5; b11 §19.6). `{name}` and the like are filled in. */
export const PAY_CONFIRM_STRINGS = Object.freeze({
  titleProof: 'Record proof',
  titleLimits: 'Change your spending limits',
  rowFor: 'For',
  forProof: 'A proof with {name}',
  forSelf: 'A proof of your own note',
  rowPaidFrom: 'Paid from',
  paidFrom: 'Your credits',
  changeProofs: 'Proofs',
  changeBudget: '24-hour budget',
  changePerProof: 'Per-proof limit',
  changeContactProofs: 'Proofs for {name}',
  changeContactPerProof: 'Per-proof limit for {name}',
  aContact: 'a contact',
  notSet: 'Not set',
  ruleAllow: 'Automatic',
  ruleApproval: 'Ask me',
  ruleDeny: 'Never',
  changedTo: '{old} to {new}',
  trustCredits: 'Your credits stay yours; 4thTech never holds them.',
  trustAi: "Your AI can't confirm this for you.",
  remember: 'Remember for this contact',
  rememberHint: 'Next time, proofs like this for {name} run without asking.',
  cancel: 'Cancel',
  useBackup: 'Use backup code instead',
  codeLabel: 'Backup code',
  codeHint: 'The backup code AgentLink showed you when you set up.',
  confirmCode: 'Confirm',
  close: 'Close',
  recordingProof: 'Confirming…',
  recordingLimits: 'Saving your limits…',
  doneProof: 'Done. Your AI records the proof now.',
  doneLimits: 'Done. Your limits are saved.',
  cancelled: 'Not confirmed. Nothing was paid.',
  notVerified: "Couldn't confirm it was you. Try again.",
  expired: 'This request expired.',
  decided: 'Already decided on another screen.',
  changed: 'Something changed since you opened this. Check it again.',
  updateNeeded:
    'Your passkey needs to be set up again for paid actions. Use your backup code this time.',
  wrongCode: "That backup code didn't match. Nothing was paid.",
  triesUsed: 'Too many wrong backup codes. Nothing was paid.',
  wait: 'Too many wrong tries. Wait {seconds} seconds, then try again. Nothing was paid.',
  busy: 'Another confirmation is running. Try again in a moment.',
  stillWorking: "Still working. Your AI will let you know when it's done. You can close this.",
  refusedProof: "Couldn't approve this. Nothing was paid.",
  refusedLimits: "Couldn't save your limits. Nothing changed.",
  failedStart: "This can't be confirmed right now. Nothing was paid.",
  notOffered: "Remembering isn't available for this request.",
  cents: '{cents} cents',
  dollars: '{dollars} dollars',
  dollarsCents: '{dollars} dollars and {cents} cents',
});
const P = PAY_CONFIRM_STRINGS;

const fill = (template: string, values: Readonly<Record<string, string>>): string =>
  template.replace(/\{([a-z]+)\}/g, (all, key: string) => values[key] ?? all);

// --- the statement --------------------------------------------------------------------------------

export type PayField =
  | 'proofs.notarize'
  | 'proofs.dailyBudgetUSD'
  | 'proofs.perActionMaxUSD'
  | 'contactRules.proofs.notarize'
  | 'contactRules.proofs.perActionMaxUSD';

export interface PayChange {
  readonly field: PayField;
  /** For a contact's rule: the contact's agent ID. Bound by the server; never shown. */
  readonly contact?: string;
  readonly old: string | null;
  readonly new: string | null;
}

/** The confirmation statement as the server returns it (core `PayConfirmStatement`). */
export interface PayStatement {
  readonly v: 1;
  readonly kind: 'proof' | 'proof_remember' | 'limits';
  readonly amountUsd: string | null;
  readonly purpose: 'proof' | 'limits_change';
  readonly counterparty: string | null;
  readonly changes: readonly PayChange[];
}

const FIELD_KIND: Readonly<Record<PayField, 'rule' | 'usd'>> = {
  'proofs.notarize': 'rule',
  'proofs.dailyBudgetUSD': 'usd',
  'proofs.perActionMaxUSD': 'usd',
  'contactRules.proofs.notarize': 'rule',
  'contactRules.proofs.perActionMaxUSD': 'usd',
};
const USD = /^(0|[1-9][0-9]{0,8})(\.[0-9]{1,6})?$/;
const RULE = /^(allow|approval|deny)$/;
const STATEMENT_KEYS = 'amountUsd,changes,counterparty,kind,purpose,v';

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The statement, checked; undefined for anything else (it is then never shown). */
export function parsePayStatement(value: unknown): PayStatement | undefined {
  if (!isObject(value)) return undefined;
  if (Object.keys(value).sort().join(',') !== STATEMENT_KEYS || value['v'] !== 1) return undefined;
  const { kind, amountUsd, purpose, counterparty, changes } = value;
  if (kind !== 'proof' && kind !== 'proof_remember' && kind !== 'limits') return undefined;
  if (kind === 'limits') {
    if (amountUsd !== null || purpose !== 'limits_change') return undefined;
  } else if (typeof amountUsd !== 'string' || !USD.test(amountUsd) || purpose !== 'proof') {
    return undefined;
  }
  if (
    counterparty !== null &&
    (typeof counterparty !== 'string' || counterparty.length === 0 || counterparty.length > 200)
  ) {
    return undefined;
  }
  if (!Array.isArray(changes) || changes.length > 32) return undefined;
  const out: PayChange[] = [];
  for (const c of changes as unknown[]) {
    if (!isObject(c)) return undefined;
    const field = c['field'];
    if (typeof field !== 'string' || !(field in FIELD_KIND)) return undefined;
    const kindOf = FIELD_KIND[field as PayField];
    const ok = (x: unknown): x is string | null =>
      x === null || (typeof x === 'string' && (kindOf === 'usd' ? USD : RULE).test(x));
    if (!ok(c['old']) || !ok(c['new'])) return undefined;
    const contact = c['contact'];
    if (contact !== undefined && typeof contact !== 'string') return undefined;
    out.push({
      field: field as PayField,
      ...(contact === undefined ? {} : { contact }),
      old: c['old'],
      new: c['new'],
    });
  }
  return {
    v: 1,
    kind,
    amountUsd: amountUsd as string | null,
    purpose: purpose as PayStatement['purpose'],
    counterparty: counterparty as string | null,
    changes: out,
  };
}

/** "$0.10", "$5", "$5.50", "$0.123": at least two decimals when there are any; never rounded. */
export function formatUsd(value: string): string {
  const [whole, frac = ''] = value.split('.');
  if (frac === '') return `$${whole ?? '0'}`;
  return `$${whole ?? '0'}.${frac.padEnd(2, '0')}`;
}

/** The amount in words for screen readers ("10 cents", "5 dollars and 50 cents"). */
export function spokenUsd(value: string): string {
  const [dollars = '0', frac = ''] = value.split('.');
  const padded = frac.padEnd(2, '0');
  const rest = padded.slice(2).replace(/0+$/, '');
  const cents = `${String(Number(padded.slice(0, 2)))}${rest === '' ? '' : `.${rest}`}`;
  if (dollars === '0') return fill(P.cents, { cents });
  if (cents === '0') return fill(P.dollars, { dollars });
  return fill(P.dollarsCents, { dollars, cents });
}

export interface PayConfirmView {
  readonly kind: PayStatement['kind'];
  readonly title: string;
  readonly amount: string | null;
  readonly amountSpoken: string | null;
  readonly rows: readonly { readonly label: string; readonly value: string }[];
  readonly changes: readonly {
    readonly label: string;
    readonly old: string;
    readonly new: string;
  }[];
  /** The counterparty's name (11 §5.2, built by the server), for the Remember hint. */
  readonly name: string | null;
}

function valueText(field: PayField, value: string | null): string {
  if (value === null) return P.notSet;
  if (FIELD_KIND[field] === 'usd') return formatUsd(value);
  return value === 'allow' ? P.ruleAllow : value === 'approval' ? P.ruleApproval : P.ruleDeny;
}

function changeLabel(field: PayField, name: string | null): string {
  const who = name ?? P.aContact;
  switch (field) {
    case 'proofs.notarize':
      return P.changeProofs;
    case 'proofs.dailyBudgetUSD':
      return P.changeBudget;
    case 'proofs.perActionMaxUSD':
      return P.changePerProof;
    case 'contactRules.proofs.notarize':
      return fill(P.changeContactProofs, { name: who });
    default:
      return fill(P.changeContactPerProof, { name: who });
  }
}

/** What the sheet shows for a statement: words only, from the statement only. */
export function payConfirmView(s: PayStatement): PayConfirmView {
  const limits = s.kind === 'limits';
  return {
    kind: s.kind,
    title: limits ? P.titleLimits : P.titleProof,
    amount: s.amountUsd === null ? null : formatUsd(s.amountUsd),
    amountSpoken: s.amountUsd === null ? null : spokenUsd(s.amountUsd),
    rows: limits
      ? []
      : [
          {
            label: P.rowFor,
            value: s.counterparty === null ? P.forSelf : fill(P.forProof, { name: s.counterparty }),
          },
          { label: P.rowPaidFrom, value: P.paidFrom },
        ],
    changes: s.changes.map((c) => ({
      label: changeLabel(c.field, s.counterparty),
      old: valueText(c.field, c.old),
      new: valueText(c.field, c.new),
    })),
    name: s.counterparty,
  };
}

// --- the platform ---------------------------------------------------------------------------------

export type PayPlatform = 'mac' | 'windows' | 'other';

/** From `navigator.userAgentData.platform` (or `navigator.platform`). */
export function detectPayPlatform(platform: string): PayPlatform {
  return /mac/i.test(platform) ? 'mac' : /win/i.test(platform) ? 'windows' : 'other';
}

const SENSOR: Readonly<Record<PayPlatform, string>> = {
  mac: 'Touch ID',
  windows: 'Windows Hello',
  other: 'your passkey',
};

/** The main button and the waiting word, named for the platform (08 §1). */
export function platformLabels(p: PayPlatform): { confirm: string; waiting: string } {
  return { confirm: `Confirm with ${SENSOR[p]}`, waiting: `Waiting for ${SENSOR[p]}` };
}

// --- the sheet ------------------------------------------------------------------------------------

export type PaySheetPhase = 'loading' | 'ready' | 'waiting' | 'recording' | 'done' | 'backup';

export interface PayConfirmSheetProps {
  /** The statement's view, or undefined while it loads (nothing is shown that is not the server's). */
  view: PayConfirmView | undefined;
  platform: PayPlatform;
  phase: PaySheetPhase;
  /** One line about what just happened: `info` is polite, `error` is role=alert. */
  notice?: { readonly tone: 'info' | 'error'; readonly text: string };
  /** A final state (expired, decided elsewhere, tries used up): only Close. */
  closed?: boolean;
  /** A passkey can confirm here (the owner's passkey, with its key kept). */
  canPasskey: boolean;
  /** The backup-code link is offered. */
  backup: boolean;
  /** "Remember for this contact", when the server offers it. */
  remember?: { readonly checked: boolean; readonly onChange: (on: boolean) => void };
  reducedMotion: boolean;
  /** True while a request is on its way (buttons wait). */
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onUseBackup: () => void;
  onCode: (code: string) => void;
  onClose: () => void;
}

/** The ring that breathes (waiting), sweeps (recording) and closes into a check (done). */
function Ring({ state }: { state: 'waiting' | 'recording' | 'done' }): ReactElement {
  return (
    <svg
      className="al-pay-ring"
      data-state={state}
      viewBox="0 0 48 48"
      width="48"
      height="48"
      aria-hidden="true"
      focusable="false"
    >
      <circle className="al-pay-ring-track" cx="24" cy="24" r="20" />
      <circle className="al-pay-ring-arc" cx="24" cy="24" r="20" pathLength={100} />
      {state === 'done' ? (
        <path className="al-pay-check" d="M15 24.5l6 6 12-13" pathLength={100} />
      ) : null}
    </svg>
  );
}

const AUTO_CLOSE_MS = 1200;

export function PayConfirmSheet(props: PayConfirmSheetProps): ReactElement {
  const { view, platform, phase, notice, closed, canPasskey, backup, remember, reducedMotion } =
    props;
  const id = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  const [code, setCode] = useState('');
  const labels = platformLabels(platform);
  const limits = view?.kind === 'limits';
  const onClose = useRef(props.onClose);
  onClose.current = props.onClose;

  // Focus starts on the title (never Confirm) and returns to the opener when the sheet goes.
  useEffect(() => {
    opener.current = document.activeElement;
    titleRef.current?.focus();
    return () => {
      const back = opener.current as HTMLElement | null;
      if (back !== null && typeof back.focus === 'function' && document.contains(back))
        back.focus();
    };
  }, []);

  // D-132 decision 3: Done closes itself after about 1.2 s, unless motion is reduced.
  useEffect(() => {
    if (phase !== 'done' || reducedMotion || closed === true) return undefined;
    const timer = setTimeout(() => onClose.current(), AUTO_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [phase, reducedMotion, closed]);

  const live =
    phase === 'waiting'
      ? labels.waiting
      : phase === 'recording'
        ? limits
          ? P.recordingLimits
          : P.recordingProof
        : phase === 'done'
          ? limits
            ? P.doneLimits
            : P.doneProof
          : notice?.tone === 'info'
            ? notice.text
            : '';

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      if (phase === 'recording' || phase === 'waiting') return;
      event.preventDefault();
      if (closed === true || phase === 'done') props.onClose();
      else props.onCancel();
      return;
    }
    if (event.key !== 'Tab' || sheetRef.current === null) return;
    const list = [
      ...sheetRef.current.querySelectorAll<HTMLElement>('button, input, a[href]'),
    ].filter((n) => !(n as HTMLButtonElement).disabled);
    const first = list[0];
    const last = list[list.length - 1];
    if (first === undefined || last === undefined) return;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === titleRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const showBackupForm = phase === 'backup' || (phase === 'ready' && !canPasskey);
  const ring = phase === 'waiting' || phase === 'recording' || phase === 'done' ? phase : null;
  const amountId = `${id}-amount`;
  const forId = `${id}-for`;

  return (
    <div className="al-pay-overlay">
      <div
        ref={sheetRef}
        className="al-pay-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${amountId} ${forId}`}
        data-motion={reducedMotion ? 'reduced' : 'full'}
        onKeyDown={onKeyDown}
      >
        <div className="al-pay-grab" aria-hidden="true" />
        <h2 id={`${id}-title`} ref={titleRef} tabIndex={-1} className="al-pay-title">
          {view?.title ?? P.titleProof}
        </h2>
        {view?.amount == null ? null : (
          <p id={amountId} className="al-pay-amount" aria-label={view.amountSpoken ?? undefined}>
            {view.amount}
          </p>
        )}
        {view === undefined ? null : (
          <>
            <dl className="al-pay-rows">
              {view.rows.map((r, i) => (
                <div key={r.label} className="al-pay-row">
                  <dt>{r.label}</dt>
                  <dd {...(i === 0 ? { id: forId } : {})}>{r.value}</dd>
                </div>
              ))}
              {view.changes.map((c) => (
                <div key={c.label} className="al-pay-row">
                  <dt>{c.label}</dt>
                  <dd
                    className="al-pay-change"
                    aria-label={fill(P.changedTo, { old: c.old, new: c.new })}
                  >
                    <span className="al-pay-old">{c.old}</span>
                    <span className="al-pay-arrow" aria-hidden="true">
                      {' → '}
                    </span>
                    <span className="al-pay-new">{c.new}</span>
                  </dd>
                </div>
              ))}
            </dl>
            <div className="al-pay-trust">
              <p>{P.trustCredits}</p>
              <p>{P.trustAi}</p>
            </div>
          </>
        )}
        {remember !== undefined && closed !== true && (phase === 'ready' || phase === 'backup') ? (
          <label className="al-check al-pay-remember">
            <input
              type="checkbox"
              checked={remember.checked}
              disabled={props.busy === true}
              onChange={(e) => remember.onChange(e.currentTarget.checked)}
            />
            <span>
              <span>{P.remember}</span>
              {view?.name == null ? null : (
                <span className="al-field-hint al-text-caption">
                  {fill(P.rememberHint, { name: view.name })}
                </span>
              )}
            </span>
          </label>
        ) : null}
        <div className="al-pay-status">
          {ring === null ? null : <Ring state={ring} />}
          <p className="al-pay-live" aria-live="polite">
            {live}
          </p>
          {notice?.tone === 'error' ? (
            <p className="al-pay-alert" role="alert">
              {notice.text}
            </p>
          ) : null}
        </div>
        <div className="al-pay-actions">
          {closed === true || (phase === 'done' && reducedMotion) ? (
            <Button variant="primary" size="lg" block onClick={props.onClose}>
              {P.close}
            </Button>
          ) : phase === 'ready' && view !== undefined && canPasskey ? (
            <Button
              variant="primary"
              size="lg"
              block
              icon="key-round"
              disabled={props.busy === true}
              onClick={props.onConfirm}
            >
              {labels.confirm}
            </Button>
          ) : showBackupForm && view !== undefined ? (
            <form
              className="al-pay-code"
              onSubmit={(e) => {
                e.preventDefault();
                const value = code;
                setCode('');
                if (value.length > 0) props.onCode(value);
              }}
            >
              <TextField
                label={P.codeLabel}
                hint={P.codeHint}
                type="password"
                autoComplete="off"
                spellCheck={false}
                mono
                value={code}
                onChange={(e) => setCode(e.currentTarget.value)}
              />
              <Button
                variant="primary"
                size="lg"
                block
                type="submit"
                disabled={props.busy === true}
              >
                {P.confirmCode}
              </Button>
            </form>
          ) : null}
          {closed !== true && phase !== 'done' && phase !== 'recording' ? (
            <Button variant="ghost" block onClick={props.onCancel}>
              {P.cancel}
            </Button>
          ) : null}
          {closed !== true && phase === 'ready' && view !== undefined && canPasskey && backup ? (
            <button type="button" className="al-pay-link" onClick={props.onUseBackup}>
              {P.useBackup}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
