// Status, identity and contacts (M1-35b; d1/components/StatusChip, IdentityLabel, Fingerprint,
// ContactName, SafetyCode, ContactCard; DESIGN-ADJ-1 C-4, C-8, C-10, X-7, X-11).
// A label is ours; a name is theirs (11 §5.2): the name rule runs here and nowhere else.
import type { ReactElement, ReactNode } from 'react';
import { Icon } from './brand.js';
import { Button } from './forms.js';
import type { ContactNameInput, ContactStatus, IdentityKind, Status, Tone } from './types.js';
import { cleanText, cx } from './util.js';

/** Icon, word and tone of every status. A chip is never colour alone. */
const STATUS: Readonly<Record<Status, readonly [tone: Tone, icon: string, word: string]>> = {
  sent: ['info', 'arrow-right', 'Sent'],
  received: ['neutral', 'inbox', 'Received'],
  delivered: ['success', 'receipt-delivered', 'Delivered'],
  opened: ['success', 'receipt-opened', 'Opened'],
  accepted: ['success', 'receipt-accepted', 'Accepted'],
  rejected: ['neutral', 'receipt-rejected', 'Rejected'],
  'delivery-requested': ['info', 'receipt-delivered', 'Delivery requested'],
  recording: ['info', 'refresh-cw', 'Recording'],
  recorded: ['proof', 'proof-seal', 'Recorded'],
  'waiting-to-post': ['neutral', 'clock', 'Waiting to post'],
  'needs-approval': ['accent', 'approval', 'Needs approval'],
  approved: ['success', 'check', 'Approved'],
  denied: ['neutral', 'x', 'Denied'],
  expired: ['neutral', 'clock', 'Expired'],
  'needs-setup': ['warning', 'settings', 'Needs setup'],
  'needs-credits': ['warning', 'circle-alert', 'Needs credits'],
  failed: ['danger', 'triangle-alert', 'Failed'],
  flagged: ['warning', 'triangle-alert', 'Flagged'],
  online: ['success', 'circle', 'Online'],
  'last-seen': ['neutral', 'clock', 'Last seen'],
  paused: ['neutral', 'pause', 'Paused'],
  offline: ['neutral', 'wifi-off', 'Offline'],
};

export interface StatusChipProps {
  status: Status;
  detail?: string;
  children?: ReactNode;
  className?: string;
}

/** Icon plus uppercase mono word for a message, proof or agent status. */
export function StatusChip({ status, detail, children, className }: StatusChipProps): ReactElement {
  const [tone, icon, word] = STATUS[status] ?? STATUS.sent;
  return (
    <span className={cx('al-chip', `al-tone-${tone}`, className)}>
      <Icon name={icon} size={12} strokeWidth={2.25} />
      <span className="al-text-label">{children ?? word}</span>
      {detail === undefined ? null : (
        <span className="al-chip-detail al-text-body-sm">{detail}</span>
      )}
    </span>
  );
}

const IDENTITY: Readonly<
  Record<IdentityKind, readonly [tone: string, icon: string, word: string]>
> = {
  selfdeclared: ['selfdeclared', 'identity-selfdeclared', 'Self-declared'],
  checked: ['checked', 'identity-checked', 'Safety code checked'],
  registered: ['registered', 'identity-registered', 'Registered'],
  verified: ['verified', 'identity-verified', 'Verified domain'],
  'domain-warning': ['warning', 'domain-warning', 'Domain no longer verified'],
};

export interface IdentityLabelProps {
  kind: IdentityKind;
  /** For `verified`. */
  domain?: string;
  /** The punycode form of an international domain name. */
  punycode?: string;
  /** For "Domain no longer verified". */
  date?: string;
  className?: string;
}

/** How strongly a contact's identity is established. A name never stands where a label stands. */
export function IdentityLabel({
  kind,
  domain,
  punycode,
  date,
  className,
}: IdentityLabelProps): ReactElement {
  const [tone, icon, word] = IDENTITY[kind] ?? IDENTITY.selfdeclared;
  const text =
    kind === 'verified' && domain !== undefined ? `${word} · ${cleanText(domain, 253)}` : word;
  return (
    <span
      className={cx('al-idl', `al-idl-${tone}`, className)}
      title={
        kind === 'selfdeclared'
          ? 'Name chosen by its owner. Compare the safety code to be sure.'
          : undefined
      }
    >
      <Icon name={icon} size={12} strokeWidth={2.25} />
      <span className="al-text-body-sm">{text}</span>
      {punycode === undefined ? null : (
        <span className="al-idl-puny al-text-code">{cleanText(punycode, 253)}</span>
      )}
      {date === undefined ? null : <span className="al-idl-date al-text-body-sm">{date}</span>}
    </span>
  );
}

export interface FingerprintProps {
  /** The short owner fingerprint, for example `7F3A·19C2`. */
  value: string;
  /** `Contact` renders the fallback name for unnamed or suspicious senders. */
  prefix?: string;
  className?: string;
}

/** A short fingerprint in mono. Only in identity contexts. Read character by character. */
export function Fingerprint({ value, prefix, className }: FingerprintProps): ReactElement {
  const clean = cleanText(value, 64);
  return (
    <span className={cx('al-fp', className)}>
      {prefix === undefined ? null : <span className="al-text-body-sm al-muted">{prefix} </span>}
      <span role="img" className="al-text-code" aria-label={clean.split('').join(' ')}>
        {clean}
      </span>
    </span>
  );
}

// Words that must never pass for a label or a system voice inside a contact's name (11 §5.2).
const RESERVED = [
  'verified',
  'registered',
  'self-declared',
  'selfdeclared',
  'safety code',
  'checked',
  'agentlink',
  'system',
  'approved',
  'owner',
];
// Letters, digits, spaces and . ' - only, Latin script only (mixed scripts fall back).
const NAME_OK = /^[A-Za-z0-9À-ɏ .'’-]+$/;

export type FormattedName = { kind: 'alias' | 'restricted' | 'fingerprint'; text: string };

/**
 * The name rule (11 §5.2): the owner's alias as is; else the contact's own name in quotes if it
 * passes the restricted set (32 characters at most, no reserved words); else "Contact <fingerprint>".
 * The same function formats notifications, OS prompts and chat text.
 */
export function formatContactName(input: ContactNameInput): FormattedName {
  const alias = cleanText(input.alias ?? '', 100).trim();
  if (alias !== '') return { kind: 'alias', text: alias };
  const name = (input.name ?? '').normalize('NFC').trim();
  const lower = name.toLowerCase();
  if (name === '' || RESERVED.some((w) => lower.includes(w)) || !NAME_OK.test(name)) {
    return { kind: 'fingerprint', text: `Contact ${cleanText(input.fingerprint ?? '—', 64)}` };
  }
  return { kind: 'restricted', text: `“${name.slice(0, 32)}”` };
}

export interface ContactNameProps extends ContactNameInput {
  label?: IdentityKind;
  domain?: string;
  /** Show the label next to an alias too. */
  showLabel?: boolean;
  className?: string;
}

/** Applies the name rule on every surface outside the untrusted container. */
export function ContactName({
  label,
  domain,
  showLabel,
  className,
  ...input
}: ContactNameProps): ReactElement {
  const n = formatContactName(input);
  const identity =
    label !== undefined && (n.kind !== 'alias' || showLabel === true) ? (
      <IdentityLabel kind={label} {...(domain === undefined ? {} : { domain })} />
    ) : null;
  return (
    <span className={cx('al-cname', `al-cname-${n.kind}`, className)}>
      {n.kind === 'fingerprint' ? (
        <Fingerprint prefix="Contact" value={cleanText(input.fingerprint ?? '—', 64)} />
      ) : (
        <span className="al-cname-text">{n.text}</span>
      )}
      {identity}
    </span>
  );
}

export interface SafetyCodeProps {
  /** Twelve digits in groups of four, separated by spaces. */
  code: string;
  contactName?: string;
  state?: 'unchecked' | 'waiting' | 'matched' | 'mismatch' | 'changed';
  onMatch?: () => void;
  onMismatch?: () => void;
}

/** Twelve grouped digits to compare out of band at pairing (04 §3.6.1). */
export function SafetyCode({
  code,
  contactName,
  state = 'unchecked',
  onMatch,
  onMismatch,
}: SafetyCodeProps): ReactElement {
  const groups = cleanText(code, 64).split(' ');
  const who = contactName === undefined ? 'your contact' : cleanText(contactName, 100);
  return (
    <section className={cx('al-sc', `is-${state}`)} aria-label="Safety code">
      <div className="al-sc-head">
        <Icon name="safety-code" size={16} />
        <span className="al-text-label">
          {state === 'changed' ? 'Safety code changed' : 'Safety code'}
        </span>
      </div>
      <div
        className="al-sc-code al-text-code-lg"
        role="img"
        aria-label={groups.map((g) => g.split('').join(' ')).join(', ')}
      >
        {groups.map((g, i) => (
          <span key={i}>{g}</span>
        ))}
      </div>
      {state === 'changed' ? (
        <p className="al-text-body">
          {`${contactName === undefined ? 'This contact' : who}'s agent updated its keys (same owner). The safety code changed. Compare it again.`}
        </p>
      ) : null}
      {state === 'waiting' ? (
        <p className="al-text-body al-muted" role="status">
          {`Waiting for ${who}'s agent to show its code…`}
        </p>
      ) : null}
      {state === 'unchecked' || state === 'changed' ? (
        <>
          <p className="al-text-body al-muted">
            {`Compare with ${who} by phone or in person. It should read the same on both screens.`}
          </p>
          <div className="al-sc-actions">
            <Button icon="check" onClick={onMatch}>
              They match
            </Button>
            <Button variant="ghost" icon="x" onClick={onMismatch}>
              They don't
            </Button>
          </div>
        </>
      ) : null}
      {state === 'matched' ? (
        <p className="al-sc-ok al-text-body">
          <Icon name="identity-checked" size={16} />
          {`Matched. ${who} now shows as Safety code checked.`}
        </p>
      ) : null}
      {state === 'mismatch' ? (
        <div className="al-sc-stop al-tone-warning">
          <Icon name="triangle-alert" size={16} />
          <div>
            <p className="al-text-body">
              <strong>Pairing stopped. Nothing was shared.</strong>
            </p>
            <p className="al-text-body-sm al-muted">
              {`Codes that differ can mean the invite was copied or changed on the way. Ask ${who} for a new invite through a channel you trust.`}
            </p>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** Contact states: a word and an icon for each (a blocked contact is not only greyed out). */
const CONTACT_STATE = {
  blocked: ['neutral', 'ban', 'Blocked'],
  revoked: ['neutral', 'x', 'Revoked'],
  paused: ['neutral', 'pause', 'Paused'],
  flagged: ['warning', 'triangle-alert', 'Flagged'],
  mismatch: ['warning', 'triangle-alert', 'Safety code did not match'],
} as const satisfies Record<string, readonly [Tone, string, string]>;

export interface ContactCardProps extends ContactNameInput {
  label?: IdentityKind;
  domain?: string;
  agent?: string;
  aiApp?: string;
  /** A contact never shows presence: use `lastActivity` (06 §2.1). */
  status?: ContactStatus;
  statusDetail?: string;
  /** For example "Last activity 2 hours ago". */
  lastActivity?: string;
  /** `flagged`: a proof did not match (M1-7g-c); `mismatch`: the safety code did not match. */
  state?: keyof typeof CONTACT_STATE;
  /** A sender who is not a contact: "an unknown sender", never "Contact …" (D-72, X-7). */
  unknownSender?: boolean;
  actions?: ReactNode;
}

function initials(text: string): string {
  const t = text.replace(/[“”"]/g, '').trim();
  if (t.startsWith('Contact ')) return '#';
  return (
    t
      .split(/\s+/)
      .map((w) => w.charAt(0))
      .join('')
      .slice(0, 2)
      .toUpperCase() || '?'
  );
}

/** A contact row: monogram, name under the name rule, label, agent, AI app, fingerprint, status. */
export function ContactCard({
  label,
  domain,
  agent,
  aiApp,
  status,
  statusDetail,
  lastActivity,
  state,
  unknownSender,
  actions,
  ...input
}: ContactCardProps): ReactElement {
  const unknown = unknownSender === true;
  const n = formatContactName(input);
  const fp = input.fingerprint === undefined ? undefined : cleanText(input.fingerprint, 64);
  const st = state === undefined ? undefined : CONTACT_STATE[state];
  return (
    <div
      className={cx('al-contact', state !== undefined && `is-${state}`, unknown && 'is-unknown')}
    >
      <span className="al-avatar al-text-label" aria-hidden="true">
        {unknown ? '?' : initials(n.text)}
      </span>
      <div className="al-contact-main">
        <div className="al-contact-name">
          {unknown ? (
            <span className="al-cname al-cname-unknown">
              <span className="al-cname-text">Request from an unknown sender</span>
              {fp === undefined ? null : <span className="al-muted">{' · '}</span>}
              {fp === undefined ? null : <Fingerprint value={fp} />}
            </span>
          ) : (
            <ContactName
              {...input}
              showLabel
              {...(label === undefined ? {} : { label })}
              {...(domain === undefined ? {} : { domain })}
            />
          )}
        </div>
        <div className="al-contact-meta al-text-body-sm al-muted">
          {agent === undefined ? null : (
            <span>
              <Icon name="agent" size={14} />
              {agent}
            </span>
          )}
          {aiApp === undefined ? null : <span>{aiApp}</span>}
          {fp === undefined || unknown ? null : <Fingerprint value={fp} />}
          {lastActivity === undefined ? null : <span>{lastActivity}</span>}
        </div>
      </div>
      <div className="al-contact-side">
        {status === undefined ? null : (
          <StatusChip
            status={status}
            {...(statusDetail === undefined ? {} : { detail: statusDetail })}
          />
        )}
        {st === undefined ? null : (
          <span className={cx('al-chip', `al-tone-${st[0]}`)}>
            <Icon name={st[1]} size={12} strokeWidth={2.25} />
            <span className="al-text-label">{st[2]}</span>
          </span>
        )}
        {actions ?? null}
      </div>
    </div>
  );
}
