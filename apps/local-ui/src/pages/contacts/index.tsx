// Contacts (M1-11c-a2; d1 Local-contacts with DESIGN-ADJ-1 CO-4, CO-5, X-7, X-11; 04 §3.6.1; 11
// §5.2, §6.2; UX audit 3b, 10a).
//
// The list beside the selected contact. Names, never keys: the owner's alias, or the contact's own
// name under the ui name rule (formatContactName), always as React text; the short fingerprint only
// as that rule's fallback. No presence for contacts (X-11).
//
// The 12 digits: on a paired contact that is not yet checked, the page shows the 12 digits with a
// gentle nudge and three choices. "They match" asks for owner presence and posts the code it showed;
// the server signs `contact.check` (it signs only if that is still the code). "They don't match"
// signs nothing by itself (04 §3.6.1): it explains and offers Remove. "Skip" keeps the contact
// Self-declared.
//
// Rename and Remove ask for owner presence (the passkey, or the master code). Every change is one POST
// to a presence route; the page never signs (owner.ts). UX1112 WP-12 (F-2; D-72): Block (after a
// short explanation) and Unblock sit in the same menu and ask for presence the same way.
//
// W4-PEOPLE-INVITE (prototype v23 A4, A5, A7): "Invite someone" opens the Invite screen in place
// (`?invite` too); open invites are PendingInviteRow rows that say so once cancelled; Rename, Check
// Contact check and Remove sit in the person ⋯ menu; and when an open invite is answered (or a pasted
// one connects), the new contact arrives with the Connected moment and its Contact check.
import {
  Banner,
  Button,
  ContactName,
  EmptyState,
  Icon,
  Sheet,
  Skeleton,
  SuccessMoment,
  Surface,
  TextField,
  formatContactName,
  useHood,
  useReducedMotion,
} from '@4thtech-io/ui';
import { UnderTheHood } from '../../lazy/hood.js';
import { ShellIcon } from '../../layout/shell-icons.js';
import type { IdentityKind } from '@4thtech-io/ui';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from 'react';
import { createApiClient, type ApiClient, type ApiResult } from '../../api/client.js';
import { usePrefs } from '../../prefs/index.js';
import { ActivitySort, compareMostActive, sortKey, usePulse, type Pulse } from '../pulse/index.js';
import { PAGE_TITLES } from '../../strings.js';
import { ADD_CONTACT_MARKER } from './add-contact-link.js';
import { connectingTo } from './add-strings.js';
import {
  LIST_PATH,
  PEOPLE_ALL_PATH,
  contactPath,
  parseCode,
  parseList,
  idMissing,
  parsePeopleAll,
  parseRenameCheck,
  renameCheckPath,
  type CodeAnswer,
  type ContactRow,
  type IdPeople,
} from './data.js';
import { switchAgent } from '../../api/live.js';
import {
  INVITES_LIST_PATH,
  createInviteApi,
  parseConnecting,
  parseOpenInvites,
  type ConnectingRow,
  type InviteApi,
  type LinkOutcome,
  type OpenInvite,
} from './invite-api.js';
import { CONTACTS_CHANGED, diffContacts } from '../../api/contact-changes.js';
import { ConnectingInviteRow } from '../invite/pending-row.js';
import { PASTE_MARKER } from '../invite/paste-entry.js';
import { FEEDBACK_STRINGS as F } from '../invite/strings.js';
import { isKept, keep, loadKept } from './kept.js';
import {
  createOwnerClient,
  type OwnerClient,
  type OwnerResult,
  type PasskeyInfo,
  type PresenceProof,
} from './owner.js';
import { PresencePrompt } from './presence-prompt.js';
import { canCompareCode, clearCheckParam, peekCheckRef } from './safety.js';
import { useInviteFirst } from '../home/start-here-empty.js';
import { ConnectedMoment, type ConnectedMomentProps } from '../invite/connected.js';
import { useOwnName } from '../invite/own-name.js';
import { InviteScreen, PasteScreen } from '../invite/invite-screen.js';
import { PendingInviteRow, type CancelResult } from '../invite/pending-row.js';
import { initials } from '../../initials.js';
import { PersonMenu } from '../invite/person-menu.js';
import { INVITE_STRINGS as I } from '../invite/strings.js';
import { START_STRINGS } from '../home/strings.js';
import {
  ALL_IDS,
  CONTACTS_STRINGS as S,
  HOOD,
  SUMMARY,
  countLine,
  mismatchBody,
  nudge,
  personLine,
  sameNameTag,
  secondConnection,
  since,
  waitSeconds,
  waitingFor,
} from './strings.js';
import { failureCopy } from '../../api/failure-reasons.js';
import './contacts.css';

type ListState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'error' }
  | { readonly phase: 'not_set_up' }
  | { readonly phase: 'ok'; readonly contacts: readonly ContactRow[] };

/**
 * WP-P2: a person of the open ID as listed, with that ID when there are 2+ IDs (`id` is absent with
 * one ID). Another ID's people are not listed by name: its names stay sealed in its own store until
 * it is opened (04 §2.5), so it shows as "{n} people with {ID}" with Open {ID}.
 */
type Person = ContactRow & {
  readonly id?: { readonly name: string; readonly label: string; readonly current: boolean };
};

const personKey = (c: Person): string => `${c.id?.name ?? ''}:${c.ref}`;

/** One owner operation waiting for presence. */
interface Pending {
  readonly what: 'check' | 'rename' | 'remove' | 'block' | 'unblock';
  readonly ref: string;
  readonly input?: unknown;
  readonly summary: string;
}

const DATE = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/** Time of day, for telling two same-named people apart when no ID tag is known. */
const TIME = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

/** The names (as the rows show them, lower case) that more than one person in `rows` has. */
export function repeatedNames(rows: readonly ContactRow[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const c of rows) {
    const key = shownName(c).trim().toLowerCase();
    if (seen.has(key)) repeated.add(key);
    seen.add(key);
  }
  return repeated;
}

/** The pairing day in the second-connection notice ("paired 25 Oct"). */
const DAY = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

const nameInput = (c: ContactRow): { alias?: string; name?: string; fingerprint?: string } =>
  c.nameSource === 'owner'
    ? { alias: c.name }
    : { name: c.name, ...(c.fingerprint === undefined ? {} : { fingerprint: c.fingerprint }) };

/** The name as the ui name rule shows it, for sentences (always rendered as text). */
const shownName = (c: ContactRow): string => formatContactName(nameInput(c)).text;

/**
 * The rename note: the new name is always visible (under your own name for them, as "Now calls
 * itself {new}"), and "(was {old})" only when the old name differs from what the row shows.
 */
export const renameNote = (c: ContactRow): string => {
  const shown = shownName(c);
  const parts: string[] = [];
  if (c.newName !== undefined && c.newName !== shown) parts.push(S.nowCalls(c.newName));
  if (c.formerName !== undefined && c.formerName !== shown && c.formerName !== c.newName) {
    parts.push(S.wasName(c.formerName));
  }
  return parts.join(' ');
};

const labelKind = (c: ContactRow): IdentityKind =>
  c.label === 'safety-code-checked' ? 'checked' : 'selfdeclared';

function Chip({ icon, tone, children }: { icon: string; tone: string; children: string }) {
  return (
    <span className={`ct-chip al-tone-${tone}`}>
      <Icon name={icon} size={12} strokeWidth={2.25} />
      <span className="al-text-body-sm">{children}</span>
    </span>
  );
}

function StateChip({ contact }: { contact: ContactRow }): ReactElement | null {
  if (contact.status === 'blocked')
    return (
      <Chip icon="ban" tone="neutral">
        {S.blocked}
      </Chip>
    );
  if (contact.status === 'revoked')
    return (
      <Chip icon="x" tone="neutral">
        {S.revoked}
      </Chip>
    );
  if (contact.pairing === 'pending')
    return (
      <Chip icon="clock" tone="neutral">
        {S.waiting}
      </Chip>
    );
  if (contact.pairing === 'mismatch') {
    return (
      <Chip icon="triangle-alert" tone="warning">
        {S.mismatchChip}
      </Chip>
    );
  }
  return null;
}

/** "2 h ago", "yesterday", or a short date: plain text for the row line. */
function ago(at: number, now: number): string {
  const sec = Math.max(0, now - at);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${String(Math.floor(sec / 60))} min ago`;
  if (sec < 86_400) return `${String(Math.floor(sec / 3600))} h ago`;
  if (sec < 172_800) return 'yesterday';
  return DAY.format(new Date(at * 1000));
}

function PersonRow({
  c,
  selected,
  fresh,
  pulse,
  onSelect,
  archived,
  again,
  sameName = false,
}: {
  c: Person;
  selected: string | undefined;
  fresh?: string | undefined;
  pulse: Pulse | undefined;
  onSelect: (ref: string, person: Person) => void;
  /** Set for an archived (removed) connection. */
  archived?: boolean;
  /** An active person with the same owner: the day you connected again. */
  again?: string | undefined;
  /** Another person in this list has the same name: the row says what tells them apart. */
  sameName?: boolean;
}): ReactElement {
  // WP-P2: the activity pulse is the open ID's; another ID's people show no last message here.
  const other = c.id !== undefined && !c.id.current;
  const last = other ? undefined : pulse?.contacts.get(c.ref)?.lastAt;
  const connected = DAY.format(new Date((c.pairedAt ?? c.since) * 1000));
  const name = (
    <span className="al-contact-name">
      <bdi>{shownName(c)}</bdi>
      {renameNote(c) === '' ? null : (
        <span className="al-text-caption al-muted ct-former">
          {' '}
          <bdi>{renameNote(c)}</bdi>
        </span>
      )}
      {archived === true ? (
        <span className="al-text-caption al-muted"> · {S.olderConnection}</span>
      ) : null}
    </span>
  );
  return (
    <li>
      <button
        type="button"
        className={`al-contact ct-row${c.status === 'active' ? '' : ` is-${c.status}`}${c.ref === fresh ? ' is-fresh' : ''}`}
        aria-current={c.ref === selected && !other ? 'true' : undefined}
        onClick={() => onSelect(c.ref, c)}
      >
        <span className="al-avatar al-text-label" aria-hidden="true">
          {initials(shownName(c))}
        </span>
        <span className="al-contact-main">
          {name}
          <span className="al-text-caption al-muted ct-line">
            {archived === true
              ? `${S.theyRemoved}${again === undefined ? '' : ` ${S.connectedAgain(again)}`} ${S.oldConversation}`
              : personLine(
                  last === undefined || last <= 0 || pulse === undefined
                    ? undefined
                    : ago(last, pulse.now),
                  connected,
                ) +
                (sameName
                  ? ` · ${sameNameTag(c.fingerprint, TIME.format(new Date((c.pairedAt ?? c.since) * 1000)))}`
                  : '')}
          </span>
        </span>
        <span className="al-contact-side">
          {c.id === undefined ? null : (
            <span className="al-text-body-sm al-muted ct-with">
              {ALL_IDS.with} <bdi>{c.id.label}</bdi>
            </span>
          )}
          {archived === true ? (
            <span className="al-text-body-sm ct-open">{S.open}</span>
          ) : (
            <>
              <StateChip contact={c} />
              {c.status === 'active' && c.pairing === 'complete' ? (
                c.label === 'safety-code-checked' ? (
                  <Chip icon="check" tone="success">
                    {HOOD.checked}
                  </Chip>
                ) : (
                  <span className="al-text-body-sm ct-check">{S.checkContact}</span>
                )
              ) : null}
            </>
          )}
        </span>
      </button>
    </li>
  );
}

function ContactList({
  contacts,
  selected,
  pulse,
  onSelect,
  fresh,
}: {
  contacts: readonly Person[];
  selected: string | undefined;
  pulse: Pulse | undefined;
  onSelect: (ref: string, person: Person) => void;
  /** W5-INVITE-FEEDBACK: the contact that just connected (a short pulse). */
  fresh?: string | undefined;
}): ReactElement {
  const repeated = repeatedNames(contacts);
  return (
    <Surface as="ul" level={1} className="ct-list" aria-label={S.listLabel}>
      {contacts.map((c) => (
        <PersonRow
          key={personKey(c)}
          c={c}
          sameName={repeated.has(shownName(c).trim().toLowerCase())}
          selected={selected}
          fresh={fresh}
          pulse={pulse}
          onSelect={onSelect}
        />
      ))}
    </Surface>
  );
}

/** Revoked and removed connections: they move here by themselves; collapsed by default (spec §5). */
function ArchivedList({
  gone,
  active,
  selected,
  pulse,
  onSelect,
}: {
  gone: readonly Person[];
  active: readonly Person[];
  selected: string | undefined;
  pulse: Pulse | undefined;
  onSelect: (ref: string, person: Person) => void;
}): ReactElement | null {
  if (gone.length === 0) return null;
  const againOf = (c: Person): string | undefined => {
    const n = shownName(c).trim().toLowerCase();
    // WP-P2: only a person of the same ID tells "you connected again".
    const next = active.find(
      (a) =>
        a.id?.name === c.id?.name &&
        (a.olderSameOwner === c.ref || shownName(a).trim().toLowerCase() === n),
    );
    return next === undefined
      ? undefined
      : DAY.format(new Date((next.pairedAt ?? next.since) * 1000));
  };
  return (
    <details className="ct-archived">
      <summary className="al-text-body ct-sum">{`${S.archivedLabel} (${String(gone.length)})`}</summary>
      <Surface as="ul" level={1} className="ct-list ct-list-archived" aria-label={S.archivedLabel}>
        {gone.map((c) => (
          <PersonRow
            key={personKey(c)}
            c={c}
            selected={selected}
            pulse={pulse}
            onSelect={onSelect}
            archived
            again={againOf(c)}
          />
        ))}
      </Surface>
      <p className="al-text-caption al-muted">{S.archivedFoot}</p>
    </details>
  );
}

type CodeState = { readonly kind: 'loading' } | CodeAnswer;

function SafetyCodeBlock({
  contact,
  code,
  onMatch,
  onMismatch,
  onSkip,
}: {
  contact: ContactRow;
  code: CodeState;
  onMatch: (code: string) => void;
  onMismatch: () => void;
  onSkip: () => void;
}): ReactElement {
  if (code.kind !== 'ok') {
    return (
      <section className="al-sc" aria-label={S.safetyCode}>
        <div className="al-sc-head">
          <Icon name="safety-code" size={16} />
          <span className="al-text-label">{S.safetyCode}</span>
        </div>
        <p className="al-text-body al-muted" role="status">
          {code.kind === 'loading' ? S.codeLoading : S.codeUnavailable}
        </p>
      </section>
    );
  }
  const groups = code.code.split(' ');
  return (
    <section className="al-sc" aria-label={S.safetyCode}>
      <div className="al-sc-head">
        <Icon name="safety-code" size={16} />
        <span className="al-text-label">{S.safetyCode}</span>
      </div>
      <p className="al-text-body">{nudge(shownName(contact))}</p>
      <p className="al-text-body-sm al-muted">{S.safetyExplain}</p>
      <div
        className="al-sc-code al-text-code-lg"
        role="img"
        aria-label={groups.map((g) => g.split('').join(' ')).join(', ')}
      >
        {groups.map((g, i) => (
          <span key={i}>{g}</span>
        ))}
      </div>
      <div className="al-sc-actions ct-actions">
        <Button icon="check" onClick={() => onMatch(code.code)}>
          {S.theyMatch}
        </Button>
        <Button variant="ghost" icon="x" onClick={onMismatch}>
          {S.theyDontMatch}
        </Button>
        <Button variant="ghost" onClick={onSkip}>
          {S.skip}
        </Button>
      </div>
    </section>
  );
}

const MESSAGE: Readonly<Record<Exclude<OwnerResult['kind'], 'done' | 'wait'>, string>> = {
  rejected: S.presenceRejected,
  required: S.presenceRequired,
  refused: S.refused,
  not_applied: S.notApplied,
  busy: S.busy,
  session: S.sessionExpired,
  failed: failureCopy(undefined),
};

function Detail({
  contact,
  api,
  owner,
  passkey,
  older,
  onKeepBoth,
  onChanged,
}: {
  contact: ContactRow;
  api: ApiClient;
  owner: OwnerClient;
  passkey: PasskeyInfo | undefined;
  /** An older contact with the same owner, not yet kept (M1-UX3-DUP-CONTACTS). */
  older: ContactRow | undefined;
  onKeepBoth: () => void;
  onChanged: (what: Pending['what']) => void;
}): ReactElement {
  const hood = useHood();
  const ref = contact.ref;
  const name = shownName(contact);
  const compare = canCompareCode(contact);
  const [code, setCode] = useState<CodeState>({ kind: 'loading' });
  const [codeTick, setCodeTick] = useState(0);
  const [skipped, setSkipped] = useState(false);
  const [mismatch, setMismatch] = useState(false);
  const [matched, setMatched] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [alias, setAlias] = useState('');
  const [aliasError, setAliasError] = useState<string | undefined>(undefined);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmBlock, setConfirmBlock] = useState(false);
  // PRE-031-FIXES: "Remove older" goes through the same confirm step as Remove.
  const [confirmOlder, setConfirmOlder] = useState(false);
  const dupNoticeId = useId();
  const reduced = useReducedMotion();
  const [pending, setPending] = useState<Pending | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!compare || skipped) return;
    let live = true;
    setCode({ kind: 'loading' });
    void api.get(contactPath(ref, 'safety-code')).then((res) => {
      if (live) setCode(res.kind === 'ok' ? parseCode(res.data) : { kind: 'unavailable' });
    });
    return () => {
      live = false;
    };
  }, [api, ref, compare, skipped, codeTick]);

  const ask = (next: Pending): void => {
    setError(undefined);
    setNotice(undefined);
    setPending(next);
  };

  const submit = useCallback(
    (proof: PresenceProof) => {
      if (pending === undefined) return;
      setBusy(true);
      setError(undefined);
      void owner
        .post(contactPath(pending.ref, pending.what), pending.input, proof)
        .then((result) => {
          setBusy(false);
          if (result.kind === 'done') {
            setPending(undefined);
            if (pending.what === 'check') setMatched(true);
            if (pending.what === 'rename') {
              setRenaming(false);
              setAlias('');
              setNotice(S.renamed);
            }
            if (pending.what === 'block') setNotice(S.blockedNow);
            if (pending.what === 'unblock') setNotice(S.unblocked);
            onChanged(pending.what);
            return;
          }
          if (result.kind === 'wait') {
            setError(waitSeconds(result.seconds));
            return;
          }
          if (result.kind === 'rejected' || result.kind === 'required') {
            setError(MESSAGE[result.kind]);
            return;
          }
          // Nothing was changed: close the prompt and say so; a check compares again.
          setPending(undefined);
          setNotice(result.kind === 'failed' ? failureCopy(result.reason) : MESSAGE[result.kind]);
          if (pending.what === 'check') setCodeTick((n) => n + 1);
        });
    },
    [owner, pending, onChanged],
  );

  const saveName = (event: FormEvent): void => {
    event.preventDefault();
    const wanted = alias.trim();
    if (wanted === '') {
      setAliasError(S.aliasInvalid);
      return;
    }
    setAliasError(undefined);
    void api.get(renameCheckPath(ref, wanted)).then((res: ApiResult<unknown>) => {
      const check =
        res.kind === 'ok'
          ? parseRenameCheck(res.data)
          : ({ kind: 'refused', reason: 'unavailable' } as const);
      if (check.kind === 'ok') {
        ask({
          what: 'rename',
          ref,
          input: { alias: wanted },
          summary: SUMMARY.rename(name, wanted),
        });
        return;
      }
      setAliasError(
        check.reason === 'alias_taken'
          ? S.aliasTaken
          : check.reason === 'alias_invalid'
            ? S.aliasInvalid
            : check.reason === 'contact_unknown'
              ? S.contactUnknown
              : S.renameUnavailable,
      );
    });
  };

  const removeNow = (): void => ask({ what: 'remove', ref, summary: SUMMARY.remove(name) });

  // The same Remove as above, for the older contact: the existing presence route, nothing new.
  const duplicate =
    older === undefined ||
    pending !== undefined ||
    renaming ||
    confirmRemove ||
    confirmBlock ||
    confirmOlder ? null : (
      <Surface level={3} className="ct-dup">
        <Banner tone="info" icon="users">
          <p className="al-text-body" id={dupNoticeId}>
            {secondConnection(shownName(older), DAY.format(new Date(older.since * 1000)))}
          </p>
          <div className="ct-actions">
            <Button variant="ghost" size="sm" onClick={onKeepBoth}>
              {S.keepBoth}
            </Button>
            <Button
              variant="danger"
              size="sm"
              aria-describedby={dupNoticeId}
              onClick={() => setConfirmOlder(true)}
            >
              {S.removeOlder}
            </Button>
          </div>
        </Banner>
      </Surface>
    );

  let safety: ReactElement | null = null;
  if (matched || contact.label === 'safety-code-checked') {
    safety = (
      <>
        <p className="al-sc-ok al-text-body">
          <Icon name="identity-checked" size={16} />
          {matched ? S.matched : S.checked}
        </p>
        {matched ? <SuccessMoment kind="codes" /> : null}
      </>
    );
  } else if (contact.status === 'active' && contact.pairing === 'pending') {
    safety = (
      <>
        <p className="ct-waiting al-text-body" data-motion={reduced ? 'reduced' : 'full'}>
          <Icon name="clock" size={16} />
          <span>{waitingFor(name)}</span>
        </p>
        <p className="al-text-body al-muted">{S.waitingDetail}</p>
      </>
    );
  } else if (compare && mismatch) {
    safety = (
      <div className="al-sc-stop al-tone-warning" role="alert">
        <Icon name="triangle-alert" size={16} />
        <div>
          <p className="al-text-body">
            <strong>{S.mismatchTitle}</strong>
          </p>
          <p className="al-text-body-sm al-muted">{mismatchBody(name)}</p>
          {pending === undefined ? (
            <div className="ct-actions">
              <Button variant="danger" onClick={removeNow}>
                {S.removeContact}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setMismatch(false);
                  setSkipped(true);
                }}
              >
                {S.keep}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    );
  } else if (compare && skipped) {
    safety = (
      <Button variant="ghost" size="sm" icon="safety-code" onClick={() => setSkipped(false)}>
        {S.compareCode}
      </Button>
    );
  } else if (compare && pending === undefined) {
    safety = (
      <SafetyCodeBlock
        contact={contact}
        code={code}
        onMatch={(shown) =>
          ask({ what: 'check', ref, input: { code: shown }, summary: SUMMARY.check(name) })
        }
        onMismatch={() => setMismatch(true)}
        onSkip={() => setSkipped(true)}
      />
    );
  }

  return (
    <section className="ct-detail" aria-label={name}>
      <div className="ct-detail-head">
        <h2 className="al-text-title-2">
          <ContactName {...nameInput(contact)} label={labelKind(contact)} showLabel />
        </h2>
        {pending === undefined && !renaming && !confirmRemove && !confirmBlock && !confirmOlder ? (
          <PersonMenu
            name={name}
            onRename={() => setRenaming(true)}
            {...(compare
              ? {
                  onCheck: () => {
                    setMismatch(false);
                    setSkipped(false);
                    setCodeTick((n) => n + 1);
                  },
                }
              : {})}
            {...(contact.status === 'active'
              ? {
                  onBlock: () => {
                    setNotice(undefined);
                    setConfirmBlock(true);
                  },
                }
              : {})}
            {...(contact.status === 'blocked'
              ? { onUnblock: () => ask({ what: 'unblock', ref, summary: SUMMARY.unblock(name) }) }
              : {})}
            {...(contact.status === 'revoked' ? {} : { onRemove: () => setConfirmRemove(true) })}
          />
        ) : null}
      </div>
      <p className="al-text-body-sm al-muted">
        {since(DATE.format(new Date(contact.since * 1000)))}
      </p>
      {hood ? (
        <dl className="ct-hood" data-hood-facts>
          {hoodFacts(contact).map(([label, value]) => (
            <div key={label} className="ct-hood-row">
              <dt className="al-text-body-sm al-muted">{label}</dt>
              <dd className="al-text-body-sm al-text-code">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {duplicate}
      {contact.status === 'blocked' ? <p className="al-text-body">{S.blockedDetail}</p> : null}
      {contact.status === 'revoked' ? (
        <Banner tone="neutral" icon="minus" title={S.revokedTitle}>
          {S.revokedDetail} {S.revokedMore}
        </Banner>
      ) : null}
      {notice === undefined ? null : (
        <p className="al-text-body" role="status">
          {notice}
        </p>
      )}
      {renaming && pending === undefined ? (
        <form className="ct-rename" onSubmit={saveName}>
          <TextField
            label={S.renameLabel}
            hint={S.renameHint}
            name="alias"
            autoComplete="off"
            maxLength={32}
            value={alias}
            onChange={(e) => setAlias(e.currentTarget.value)}
            {...(aliasError === undefined ? {} : { error: aliasError })}
          />
          <div className="ct-actions">
            <Button type="submit" variant="primary">
              {S.saveName}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setRenaming(false);
                setAliasError(undefined);
              }}
            >
              {S.cancel}
            </Button>
          </div>
        </form>
      ) : null}
      {confirmBlock && pending === undefined ? (
        <div className="ct-confirm">
          <p className="al-text-body">{S.blockExplain}</p>
          <div className="ct-actions">
            <Button
              variant="danger"
              onClick={() => {
                setConfirmBlock(false);
                ask({ what: 'block', ref, summary: SUMMARY.block(name) });
              }}
            >
              {S.blockContact}
            </Button>
            <Button variant="ghost" onClick={() => setConfirmBlock(false)}>
              {S.cancel}
            </Button>
          </div>
        </div>
      ) : null}
      {(confirmRemove || (confirmOlder && older !== undefined)) && pending === undefined ? (
        <div className="ct-confirm">
          <p className="al-text-body">{S.removeExplain}</p>
          <div className="ct-actions">
            <Button
              variant="danger"
              onClick={() => {
                if (confirmOlder && older !== undefined) {
                  setConfirmOlder(false);
                  ask({
                    what: 'remove',
                    ref: older.ref,
                    summary: SUMMARY.remove(shownName(older)),
                  });
                  return;
                }
                setConfirmRemove(false);
                removeNow();
              }}
            >
              {S.removeContact}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setConfirmRemove(false);
                setConfirmOlder(false);
              }}
            >
              {S.cancel}
            </Button>
          </div>
        </div>
      ) : null}
      {pending === undefined ? null : (
        <PresencePrompt
          summary={pending.summary}
          passkey={passkey}
          busy={busy}
          error={error}
          onSubmit={submit}
          onCancel={() => {
            setPending(undefined);
            setError(undefined);
          }}
        />
      )}
      {safety}
    </section>
  );
}

/**
 * Under the hood (B-11 §16): what the list already carries, nothing more. The fingerprint is only
 * sent for some contacts, so it is left out otherwise; the contact's ref is never shown.
 */
function hoodFacts(c: ContactRow): [string, string][] {
  return [
    ...(c.fingerprint === undefined
      ? []
      : ([[HOOD.fingerprint, c.fingerprint]] as [string, string][])),
    [HOOD.identity, c.label === 'safety-code-checked' ? HOOD.checked : HOOD.selfDeclared],
    [HOOD.paired, new Date(c.since * 1000).toISOString().slice(0, 10)],
  ];
}

function hoodFields(c: ContactRow): unknown[] {
  return [
    ...(c.fingerprint === undefined
      ? []
      : [{ kind: 'text', label: HOOD.fingerprint, value: c.fingerprint }]),
    {
      kind: 'text',
      label: HOOD.identity,
      value: c.label === 'safety-code-checked' ? HOOD.checked : HOOD.selfDeclared,
    },
    {
      kind: 'time',
      label: HOOD.paired,
      value: new Date(c.since * 1000).toISOString().slice(0, 10),
    },
  ];
}

/** W4-INVITES-LIST: how long Contacts keeps following after Connect (the inviter's answer). */
const FOLLOW_AFTER_CONNECT_MS = 120_000;

/**
 * W4-INVITES-LIST (b11 §21.3, Closing), W4-PEOPLE-INVITE (A4): the open invites the server holds,
 * and the ones cancelled in this visit, as PendingInviteRow rows. The list carries no link; Copy
 * link and Show link read the kept one on a click (REL051-B2). The newest gets the 1.2 s highlight
 * (a colour only).
 */
function PendingInvites({
  rows,
  cancelled,
  highlight,
  now,
  onCancel,
  onLink,
  connecting = [],
  blockedRefs,
  onUnblock,
  onCancelConnecting,
}: {
  rows: readonly OpenInvite[];
  cancelled: readonly OpenInvite[];
  highlight: string | undefined;
  now: number;
  onCancel: (inviteId: string) => Promise<CancelResult>;
  /** REL051-B2: the kept link of one open invite. */
  onLink?: (inviteId: string) => Promise<LinkOutcome>;
  /** W5-INVITE-FEEDBACK: this agent's accepts that wait for the inviter's answer. */
  connecting?: readonly ConnectingRow[];
  /** Contacts the page knows are blocked (matched to a waiting accept by ref). */
  blockedRefs?: ReadonlySet<string>;
  /** REL051-B1 (N2): Unblock for a waiting accept on a blocked person (the server flag or the list). */
  onUnblock?: (ref: string, name: string) => void;
  /** REL051-B1 (N2): Cancel a waiting accept through the server. */
  onCancelConnecting?: (ref: string) => Promise<CancelResult>;
}): ReactElement | null {
  const gone = cancelled.filter((c) => !rows.some((r) => r.inviteId === c.inviteId));
  if (rows.length === 0 && gone.length === 0 && connecting.length === 0) return null;
  const done = new Set(cancelled.map((c) => c.inviteId));
  return (
    <Surface as="ul" level={1} className="ct-list ct-invites" aria-label={I.pendingLabel}>
      {connecting.map((c) => (
        <ConnectingInviteRow
          key={`c-${c.ref}`}
          row={c}
          blocked={c.blocked === true || blockedRefs?.has(c.ref) === true}
          {...(onUnblock === undefined || (c.blocked !== true && blockedRefs?.has(c.ref) !== true)
            ? {}
            : { onUnblock: () => onUnblock(c.ref, c.name) })}
          {...(onCancelConnecting === undefined
            ? {}
            : { onCancel: () => onCancelConnecting(c.ref) })}
        />
      ))}
      {[...gone, ...rows].map((r) => (
        <PendingInviteRow
          key={r.inviteId}
          invite={r}
          now={now}
          cancelled={done.has(r.inviteId)}
          highlight={r.inviteId === highlight}
          onCancel={onCancel}
          {...(onLink === undefined ? {} : { onLink })}
        />
      ))}
    </Surface>
  );
}

/** The Connected moment with your own letter (the open agent's name, read only while it shows). */
function OwnMoment(props: Omit<ConnectedMomentProps, 'me'>): ReactElement {
  const me = useOwnName(undefined);
  return <ConnectedMoment {...props} me={me} />;
}

/** The newest contact that was not there before and is now paired (the Connected moment). */
function arrival(
  before: ReadonlySet<string>,
  contacts: readonly ContactRow[],
): ContactRow | undefined {
  return contacts
    .filter((c) => !before.has(c.ref) && c.status === 'active' && c.pairing === 'complete')
    .sort((a, b) => b.since - a.since)[0];
}

export interface ContactsPageProps {
  /** For tests; the page's own same-origin clients by default. */
  readonly api?: ApiClient;
  readonly owner?: OwnerClient;
  readonly invites?: InviteApi;
  /** How often the page reads again while something waits (5 s; tests use less). */
  readonly pollMs?: number;
  /** WP-P2: opens another ID (the shell's switch, api/live.ts `switchAgent`); tests pass a fake. */
  readonly switchTo?: (name: string) => Promise<{ readonly kind: string }>;
}

/** W4-PEOPLE-INVITE: `?invite` opens the Invite screen; the marker leaves the address at once. */
export const INVITE_MARKER = 'invite';
function openedForInvite(): boolean {
  if (typeof location === 'undefined' || location.search !== `?${INVITE_MARKER}`) return false;
  history.replaceState(history.state, '', location.pathname + location.hash);
  return true;
}

/** W5-PASTE-ENTRY: `?paste` opens the paste screen; the marker leaves the address at once. */
function openedForPaste(): boolean {
  if (typeof location === 'undefined' || location.search !== `?${PASTE_MARKER}`) return false;
  history.replaceState(history.state, '', location.pathname + location.hash);
  return true;
}

/** True once, when the page was opened through an older Add contact link (b11 §21.1). */
function openedForAdd(): boolean {
  if (typeof location === 'undefined' || location.search !== `?${ADD_CONTACT_MARKER}`) return false;
  // Drop the marker at once: the address holds nothing about the sheet afterwards.
  history.replaceState(history.state, '', location.pathname + location.hash);
  return true;
}

export function ContactsPage({
  api: givenApi,
  owner: givenOwner,
  invites: givenInvites,
  pollMs = 5_000,
  switchTo = switchAgent,
}: ContactsPageProps = {}): ReactElement {
  const api = useMemo(() => givenApi ?? createApiClient(), [givenApi]);
  const owner = useMemo(() => givenOwner ?? createOwnerClient(), [givenOwner]);
  const invites = useMemo(() => givenInvites ?? createInviteApi(), [givenInvites]);
  const [list, setList] = useState<ListState>({ phase: 'loading' });
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [passkey, setPasskey] = useState<PasskeyInfo | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const [removed, setRemoved] = useState(false);
  const [kept, setKept] = useState(loadKept);
  const [sheetOpen, setSheetOpen] = useState(false);
  // W5-SAFETY-STEP: Home's "Compare the 12 digits" link (`?check=<ref>`) opens that contact's panel.
  const wantsCheck = useRef(peekCheckRef());
  const [rows, setRows] = useState<readonly OpenInvite[]>([]);
  const [highlight, setHighlight] = useState<string | undefined>(undefined);
  const [justCreated, setJustCreated] = useState(false);
  const [cancelledRows, setCancelledRows] = useState<readonly OpenInvite[]>([]);
  // W5-INVITE-FEEDBACK: the accepts that wait (server rows), the contact that just connected, and
  // the last list for telling what changed.
  const [connectingRows, setConnectingRows] = useState<readonly ConnectingRow[]>([]);
  const [fresh, setFresh] = useState<string | undefined>(undefined);
  const lastRead = useRef<
    | { contacts: readonly ContactRow[]; connecting: readonly ConnectingRow[]; open: number }
    | undefined
  >(undefined);
  const lastConnecting = useRef<readonly ConnectingRow[]>([]);
  const lastOpen = useRef(0);
  // W4-WIRE: the old Add contact marker opens the Invite screen too (the sheet is no way in now).
  const [inviting, setInviting] = useState(() => openedForInvite() || openedForAdd());
  // The Connected moment: the contacts known before, and whether an arrival is expected (an open
  // invite, or a pasted one that is connecting).
  const known = useRef<ReadonlySet<string> | undefined>(undefined);
  const expecting = useRef(false);
  // W6-ACCEPT-CONNECTED: the contacts known when a pasted invite's accept was sent. Over the real
  // relays the accept's request waits ~10 s for the relays while the inviter answers within a
  // second, so a read during the accept already holds the new contact: the arrival is told against
  // this set, not the last read. `acceptArrived`: it arrived before the accept returned.
  const acceptBase = useRef<ReadonlySet<string> | undefined>(undefined);
  const acceptArrived = useRef(false);
  const acceptInFlight = useRef(false);
  const [arrived, setArrived] = useState<ContactRow | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  // WP-P2 (spec §5): every ID's people (undefined until read, or when the read is not usable: the
  // page then keeps the open ID's list), the ID filter ('' = All my IDs) and the name search.
  const [ids, setIds] = useState<readonly IdPeople[] | undefined>(undefined);
  const [idFilter, setIdFilter] = useState('');
  const [query, setQuery] = useState('');
  const filterId = useId();
  const searchId = useId();
  const activity = usePulse(api);
  const { activitySort } = usePrefs();
  const inviteFirst = useInviteFirst();

  // HOTFIX-045: one read at a time; a background read (the poll) never replaces a good list with an error.
  const inFlight = useRef(false);
  const background = useRef(false);
  const [connectingSince, setConnectingSince] = useState<number | undefined>(undefined);

  useEffect(() => {
    let live = true;
    const quiet = background.current;
    background.current = false;
    inFlight.current = true;
    // W4-INVITES-LIST: the open invites are read wherever the contacts are; a failed read keeps
    // the last good rows.
    void api.get(INVITES_LIST_PATH).then(
      (res) => {
        if (!live || res.kind !== 'ok') return;
        const read = parseOpenInvites(res.data);
        if (read !== undefined) {
          setRows(read);
          lastOpen.current = read.length;
          if (read.length > 0) expecting.current = true;
        }
        const waiting = parseConnecting(res.data);
        lastConnecting.current = waiting;
        setConnectingRows(waiting);
      },
      () => undefined,
    );
    // WP-P2: every ID's people; a failed read keeps the last good one.
    void api.get(PEOPLE_ALL_PATH).then(
      (res) => {
        if (!live || res.kind !== 'ok') return;
        const read = parsePeopleAll(res.data);
        if (read !== undefined) setIds(read);
      },
      () => undefined,
    );
    void api
      .get(LIST_PATH)
      .then((res) => {
        inFlight.current = false;
        if (!live) return;
        if (quiet && !(res.kind === 'ok' && parseList(res.data).kind === 'ok')) return;
        if (res.kind === 'error' && res.status === 409) {
          setList({ phase: 'not_set_up' });
          return;
        }
        const answer = res.kind === 'ok' ? parseList(res.data) : ({ kind: 'error' } as const);
        if (answer.kind !== 'ok') {
          setList({ phase: 'error' });
          return;
        }
        setList({ phase: 'ok', contacts: answer.contacts });
        // W5-INVITE-FEEDBACK: the contact that connected (or connected again) gets a short pulse;
        // after a re-pair the Contact check starts over, so the page says so.
        const prior = lastRead.current;
        lastRead.current = {
          contacts: answer.contacts,
          connecting: lastConnecting.current,
          open: lastOpen.current,
        };
        if (prior !== undefined) {
          const pic = (r: typeof prior) => ({
            agent: null,
            contacts: r.contacts,
            connecting: r.connecting,
            openInvites: r.open,
          });
          const [change] = diffContacts(pic(prior), pic(lastRead.current)).slice(-1);
          if (change !== undefined) {
            setFresh(change.ref);
            if (change.kind === 'again') setNotice(F.again(change.name));
            else setNotice(undefined);
          }
        }
        // A new paired contact while an invite was open (or a pasted one was connecting).
        const before = acceptBase.current ?? known.current;
        known.current = new Set(answer.contacts.map((c) => c.ref));
        if (before !== undefined && (expecting.current || acceptBase.current !== undefined)) {
          const fresh = arrival(before, answer.contacts);
          if (fresh !== undefined) {
            if (acceptBase.current !== undefined) acceptArrived.current = true;
            expecting.current = false;
            acceptBase.current = undefined;
            setArrived(fresh);
            setNotice(undefined);
          }
        }
        const wanted = wantsCheck.current;
        if (wanted !== undefined) {
          wantsCheck.current = undefined;
          clearCheckParam();
          if (answer.contacts.some((c) => c.ref === wanted)) {
            setSelected(wanted);
            setSheetOpen(true);
            return;
          }
        }
        setSelected((current) =>
          current !== undefined && answer.contacts.some((c) => c.ref === current)
            ? current
            : answer.contacts[0]?.ref,
        );
      })
      .catch(() => {
        inFlight.current = false;
      });
    return () => {
      live = false;
    };
  }, [api, tick]);

  // HOTFIX-045: while anything waits for its pairing, re-read every 5 s and when the tab comes back.
  // W4-INVITES-LIST: an open invite waits too (the new contact appears when the other side accepts),
  // and so does this page for two minutes after Connect (the pairing is not a contact until the
  // inviter answers).
  const connecting =
    connectingSince !== undefined && Date.now() - connectingSince < FOLLOW_AFTER_CONNECT_MS;
  const anyPending =
    (list.phase === 'ok' && list.contacts.some((c) => c.pairing === 'pending')) ||
    rows.length > 0 ||
    connectingRows.length > 0 ||
    connecting;
  // W5-INVITE-FEEDBACK: the stream says the contacts or invites changed: read again at once.
  useEffect(() => {
    const onContacts = (): void => {
      if (inFlight.current) return;
      inFlight.current = true;
      background.current = true;
      setTick((n) => n + 1);
    };
    window.addEventListener(CONTACTS_CHANGED, onContacts);
    return () => window.removeEventListener(CONTACTS_CHANGED, onContacts);
  }, []);
  useEffect(() => {
    if (fresh === undefined) return undefined;
    const t = setTimeout(() => setFresh(undefined), 2400);
    return () => clearTimeout(t);
  }, [fresh]);
  useEffect(() => {
    if (!anyPending) return undefined;
    // Skips while a read is running (slow servers never pile up) and while the tab is hidden; coming
    // back fires focus and visibilitychange together, and the first one claims the single read.
    const bump = (): void => {
      if (inFlight.current || document.hidden) return;
      inFlight.current = true;
      background.current = true;
      setTick((n) => n + 1);
    };
    const timer = setInterval(bump, pollMs);
    const onVisible = (): void => bump();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', bump);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', bump);
    };
  }, [anyPending, pollMs]);

  useEffect(() => {
    let live = true;
    void owner.passkey().then((info) => {
      if (live) setPasskey(info);
    });
    return () => {
      live = false;
    };
  }, [owner]);

  // The highlight lasts 1.2 s (b11 §21.3); only its colour fades, so it is the same when reduced.
  useEffect(() => {
    if (highlight === undefined) return undefined;
    const t = setTimeout(() => setHighlight(undefined), 1200);
    return () => clearTimeout(t);
  }, [highlight]);

  const onChanged = useCallback((what: Pending['what']) => {
    setRemoved(what === 'remove');
    if (what === 'remove') setSheetOpen(false);
    setTick((n) => n + 1);
  }, []);

  // IR-W4-WIRE-2X-1: "Have an invite link? Paste it" opens a paste screen that makes no invite.
  const [pasting, setPasting] = useState(openedForPaste);
  // REL051-B2: Paste it from the Invite screen means "I was invited", not "I invite": the link the
  // screen made and that never left it is ended as the screen goes. Done keeps it (it waits below).
  const discardInvite = useRef(false);
  const openPaste = (): void => {
    if (inviting) discardInvite.current = true;
    setSheetOpen(false);
    setNotice(undefined);
    setInviting(false);
    setPasting(true);
  };
  const openInvite = (): void => {
    discardInvite.current = false;
    setSheetOpen(false);
    setNotice(undefined);
    setInviting(true);
  };
  const ready = list.phase === 'ok';
  const empty = ready && list.contacts.length === 0;
  // Start here step 2 not done yet: the empty state carries the one Add contact (b11 §27.4), and it
  // opens the sheet here directly.
  const inviteInEmpty = empty && rows.length === 0 && inviteFirst;
  const title = (
    <div className="ct-title-row">
      <h1 className="al-text-title-1">{PAGE_TITLES.contacts}</h1>
      {ready ? (
        <div className="ct-actions">
          <Button
            variant={inviteInEmpty ? 'secondary' : 'primary'}
            icon="user-plus"
            className="al-press"
            onClick={openInvite}
          >
            {I.title}
          </Button>
          <Button variant="secondary" className="al-press" onClick={openPaste}>
            {F.pasteEntry}
          </Button>
        </div>
      ) : null}
    </div>
  );
  // W4-WIRE-2 (Decision 52 (3)): the Add contact sheet is retired. Invite someone opens the Invite
  // screen, and its "Have an invite link? Paste it" accepts an invite someone sent.
  const accepted = (
    name: string,
    info?: { readonly sent: boolean; readonly again: boolean },
  ): void => {
    setInviting(false);
    setPasting(false);
    acceptInFlight.current = false;
    // W6-ACCEPT-CONNECTED: the new contact already arrived while the accept was on its way (the
    // Connected moment shows): nothing waits any more.
    if (acceptArrived.current) {
      acceptArrived.current = false;
      setTick((n) => n + 1);
      return;
    }
    // W5-INVITE-FEEDBACK: honest about an accept that could not leave this computer yet.
    setNotice(info?.sent === false ? F.waitingOnline(name) : connectingTo(name));
    setConnectingSince(Date.now());
    expecting.current = true;
    setTick((n) => n + 1);
  };
  const accepting = (): void => {
    acceptBase.current = known.current ?? new Set();
    acceptArrived.current = false;
    acceptInFlight.current = true;
  };
  // W6-ACCEPT-CONNECTED: an accept that failed (refused, offline, presence) expects no arrival.
  const acceptFailed = (): void => {
    acceptBase.current = undefined;
    acceptArrived.current = false;
    acceptInFlight.current = false;
  };
  const status =
    notice === undefined ? null : (
      <p className="al-text-body" role="status">
        {notice}
      </p>
    );
  const cancelInvite = async (inviteId: string): Promise<CancelResult> => {
    const outcome = await invites.cancel(inviteId);
    if (outcome.kind === 'cancelled') {
      const row = rows.find((r) => r.inviteId === inviteId);
      if (row !== undefined) setCancelledRows((list) => [...list, row]);
      setTick((n) => n + 1);
      return 'cancelled';
    }
    if (outcome.kind === 'not_found') {
      setTick((n) => n + 1);
      return 'gone';
    }
    return 'failed';
  };
  // REL051-B1 (N2): Unblock for a waiting accept on a person who is not in the list (blocked, then
  // removed): owner presence here, then `POST /api/ui/contacts/:ref/unblock`; the page never signs.
  const [unblocking, setUnblocking] = useState<{ ref: string; name: string } | undefined>(
    undefined,
  );
  const [unblockBusy, setUnblockBusy] = useState(false);
  const [unblockError, setUnblockError] = useState<string | undefined>(undefined);
  const submitUnblock = (proof: PresenceProof): void => {
    if (unblocking === undefined) return;
    setUnblockBusy(true);
    setUnblockError(undefined);
    void owner.post(contactPath(unblocking.ref, 'unblock'), undefined, proof).then((result) => {
      setUnblockBusy(false);
      if (result.kind === 'wait') {
        setUnblockError(waitSeconds(result.seconds));
        return;
      }
      if (result.kind === 'rejected' || result.kind === 'required') {
        setUnblockError(MESSAGE[result.kind]);
        return;
      }
      setUnblocking(undefined);
      if (result.kind === 'done') {
        setNotice(S.unblocked);
        setTick((n) => n + 1);
        return;
      }
      setNotice(result.kind === 'failed' ? failureCopy(result.reason) : MESSAGE[result.kind]);
    });
  };
  const cancelConnecting = async (ref: string): Promise<CancelResult> => {
    if (invites.cancelConnecting === undefined) return 'failed';
    const outcome = await invites.cancelConnecting(ref);
    if (outcome.kind === 'cancelled' || outcome.kind === 'not_found') {
      setConnectingRows((list) => list.filter((c) => c.ref !== ref));
      // IR-REL051-R2C-1: the page's "Connecting to {name}…" line goes with the row.
      setNotice(undefined);
      setConnectingSince(undefined);
      setTick((n) => n + 1);
      return outcome.kind === 'cancelled' ? 'cancelled' : 'gone';
    }
    return 'failed';
  };
  const waitingCount = rows.length + connectingRows.length;
  const invitesList = (
    <>
      {waitingCount > 0 ? (
        <h2 className="al-text-body ct-group">{`${S.invitesWaiting} (${String(waitingCount)})`}</h2>
      ) : null}
      <PendingInvites
        rows={rows}
        cancelled={cancelledRows}
        highlight={highlight}
        now={Date.now()}
        onCancel={cancelInvite}
        {...(invites.link === undefined ? {} : { onLink: (id: string) => invites.link!(id) })}
        connecting={connectingRows}
        blockedRefs={
          new Set(
            (list.phase === 'ok' ? list.contacts : [])
              .filter((c) => c.status === 'blocked')
              .map((c) => c.ref),
          )
        }
        onUnblock={(ref, name) => {
          const known = (list.phase === 'ok' ? list.contacts : []).some(
            (c) => c.ref === ref && c.status === 'blocked',
          );
          if (known) {
            setRemoved(false);
            setSelected(ref);
            setSheetOpen(true);
            return;
          }
          setNotice(undefined);
          setUnblockError(undefined);
          setUnblocking({ ref, name });
        }}
        onCancelConnecting={cancelConnecting}
      />
      {unblocking === undefined ? null : (
        <PresencePrompt
          summary={SUMMARY.unblock(unblocking.name)}
          passkey={passkey}
          busy={unblockBusy}
          error={unblockError}
          onSubmit={submitUnblock}
          onCancel={() => {
            setUnblocking(undefined);
            setUnblockError(undefined);
          }}
        />
      )}
    </>
  );
  const moment =
    arrived === undefined ? null : (
      <div className="inv-connected-card">
        <OwnMoment
          name={shownName(arrived)}
          selfDeclared={arrived.nameSource !== 'owner'}
          owner={owner}
          contactRef={arrived.ref}
          api={api}
          headingLevel={2}
          onDone={() => {
            setArrived(undefined);
            setSelected(arrived.ref);
          }}
        />
      </div>
    );

  // WP-P2 (spec §5): with 2+ IDs every row says "with {ID}" and the filter shows; the open ID's
  // people come from its own read (LIST_PATH), every other ID's from the all-IDs read.
  const multi = ids !== undefined && ids.length >= 2;
  const openIdOf = ids?.find((id) => id.current);
  const ownPeople: readonly Person[] =
    list.phase !== 'ok'
      ? []
      : multi && openIdOf !== undefined
        ? list.contacts.map((c): Person => ({
            ...c,
            id: { name: openIdOf.name, label: openIdOf.label, current: true },
          }))
        : list.contacts;
  const needle = query.trim().toLowerCase();
  const shownPeople: readonly Person[] = ownPeople.filter(
    (c) =>
      (!multi || idFilter === '' || c.id?.name === idFilter) &&
      (needle === '' || shownName(c).toLowerCase().includes(needle)),
  );
  // Another ID's people are only counted (names are found after opening that ID): shown while no
  // name is searched, under All my IDs or that ID's filter.
  const otherIds: readonly IdPeople[] = !multi
    ? []
    : (ids ?? []).filter(
        (id) =>
          !id.current &&
          id.count !== undefined &&
          id.count > 0 &&
          needle === '' &&
          (idFilter === '' || id.name === idFilter),
      );
  const otherCount = otherIds.reduce((n, id) => n + (id.count ?? 0), 0);
  const anyOther = multi && (ids ?? []).some((id) => !id.current && (id.count ?? 0) > 0);
  const missingIds = !multi
    ? []
    : (ids ?? [])
        .filter((id) => !id.current && idMissing(id))
        .filter((id) => idFilter === '' || id.name === idFilter)
        .map((id) => id.label);
  const openOtherId = (name: string, label: string): void => {
    setNotice(ALL_IDS.opening(label));
    void switchTo(name).then(
      (outcome) => {
        if (outcome.kind !== 'done') setNotice(ALL_IDS.openFailed);
      },
      () => setNotice(ALL_IDS.openFailed),
    );
  };

  const page = ((): ReactElement => {
    if (list.phase === 'not_set_up') {
      return (
        <>
          {title}
          <EmptyState icon="info" title={S.notSetUp} />
        </>
      );
    }
    if (list.phase === 'loading') {
      return (
        <>
          {title}
          <Skeleton loading label={S.loading} lines={4} className="ct-loading" />
        </>
      );
    }
    if (list.phase === 'error') {
      return (
        <>
          {title}
          <EmptyState icon="circle-alert" title={S.listUnavailable} />
        </>
      );
    }
    if (list.contacts.length === 0 && !anyOther) {
      return (
        <>
          {title}
          {removed ? (
            <p className="al-text-body" role="status">
              {S.removed}
            </p>
          ) : null}
          {status}
          {rows.length === 0 && connectingRows.length === 0 ? (
            inviteFirst ? (
              <EmptyState
                icon="users"
                title={START_STRINGS.emptyContacts}
                prompt={S.emptyPrompt}
                action={
                  <Button
                    variant="primary"
                    icon="user-plus"
                    className="al-press"
                    onClick={openInvite}
                  >
                    {START_STRINGS.addContact}
                  </Button>
                }
              />
            ) : (
              <EmptyState icon="users" title={S.emptyTitle} prompt={S.emptyPrompt} />
            )
          ) : (
            <div className="ct-layout">{invitesList}</div>
          )}
        </>
      );
    }
    const current = list.contacts.find((c) => c.ref === selected) ?? list.contacts[0];
    // M1-UX3-DUP-CONTACTS: the server links a newer contact to an older one with the same owner by
    // ref only; the notice shows on the newer one unless "Keep both" was chosen in this browser.
    const olderRef = current?.olderSameOwner;
    const older =
      current === undefined || olderRef === undefined || isKept(kept, current.ref, olderRef)
        ? undefined
        : list.contacts.find(
            (c) => c.ref === olderRef && c.ref !== current.ref && c.status === 'active',
          );
    const live = shownPeople.filter((c) => c.status !== 'revoked');
    const liveSorted =
      activitySort === 'active'
        ? [...live].sort((x, y) =>
            compareMostActive(sortKey(activity.pulse, x.ref, 0), sortKey(activity.pulse, y.ref, 0)),
          )
        : live;
    const openRow = (ref: string): void => {
      setRemoved(false);
      setSelected(ref);
      setSheetOpen(true);
    };
    return (
      <>
        {title}
        <p className="al-text-body al-muted ct-lead">{S.lead}</p>

        {removed ? (
          <p className="al-text-body" role="status">
            {S.removed}
          </p>
        ) : null}
        {status}
        <div className="ct-toolbar">
          {multi ? (
            <span className="al-input-wrap ct-idfilter">
              <label className="al-visually-hidden" htmlFor={filterId}>
                {ALL_IDS.filterLabel}
              </label>
              <span className="al-input-prefix" aria-hidden="true">
                <ShellIcon name="idcard" size={14} />
              </span>
              <select
                id={filterId}
                className="al-input"
                value={idFilter}
                onChange={(e) => setIdFilter(e.currentTarget.value)}
              >
                <option value="">{ALL_IDS.allIds}</option>
                {(ids ?? []).map((id) => (
                  <option key={id.name} value={id.name}>
                    {id.label}
                  </option>
                ))}
              </select>
            </span>
          ) : null}
          <span className="al-input-wrap ct-search">
            <label className="al-visually-hidden" htmlFor={searchId}>
              {ALL_IDS.search}
            </label>
            <span className="al-input-prefix" aria-hidden="true">
              <Icon name="search" size={14} />
            </span>
            <input
              id={searchId}
              className="al-input"
              type="search"
              placeholder={ALL_IDS.search}
              autoComplete="off"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
            />
          </span>
          <ActivitySort />
          <p className="al-text-body-sm al-muted ct-count">
            {countLine(live.length + otherCount, rows.length)}
          </p>
        </div>
        {missingIds.length > 0 ? (
          <p className="al-text-body-sm al-muted ct-missing" role="status">
            {ALL_IDS.missing(missingIds)}
          </p>
        ) : null}
        <div className="ct-layout">
          {invitesList}
          {live.length === 0 && needle !== '' ? (
            <p className="al-text-body al-muted ct-nomatch">{ALL_IDS.noMatch}</p>
          ) : live.length > 0 || otherIds.length === 0 ? (
            <ContactList
              contacts={liveSorted}
              selected={current?.ref}
              pulse={activity.pulse}
              fresh={fresh}
              onSelect={openRow}
            />
          ) : null}
          {otherIds.length === 0 ? null : (
            <Surface
              as="ul"
              level={1}
              className="ct-list ct-list-ids"
              aria-label={ALL_IDS.otherIds}
            >
              {otherIds.map((id) => (
                <li key={id.name} className="al-contact ct-row ct-idrow">
                  <span className="al-avatar al-text-label" aria-hidden="true">
                    <Icon name="agent" size={16} />
                  </span>
                  <span className="al-contact-main">
                    <span className="al-contact-name">{countLine(id.count ?? 0)}</span>
                    <span className="al-text-caption al-muted ct-line">{ALL_IDS.openToSee}</span>
                  </span>
                  <span className="al-contact-side">
                    <span className="al-text-body-sm al-muted ct-with">
                      {ALL_IDS.with} <bdi>{id.label}</bdi>
                    </span>
                    <Button
                      size="sm"
                      aria-label={`${ALL_IDS.open} ${id.label}`}
                      onClick={() => openOtherId(id.name, id.label)}
                    >
                      {ALL_IDS.open}
                    </Button>
                  </span>
                </li>
              ))}
            </Surface>
          )}
          <ArchivedList
            gone={shownPeople.filter((c) => c.status === 'revoked')}
            active={live}
            selected={current?.ref}
            pulse={activity.pulse}
            onSelect={openRow}
          />
        </div>
        <Sheet
          open={sheetOpen && current !== undefined}
          title={S.detailTitle}
          closeLabel={S.closeSheet}
          onClose={() => setSheetOpen(false)}
        >
          {current === undefined ? null : (
            <Detail
              key={current.ref}
              contact={current}
              api={api}
              owner={owner}
              passkey={passkey}
              older={older}
              onKeepBoth={() => {
                if (olderRef !== undefined) setKept(keep(kept, current.ref, olderRef));
              }}
              onChanged={onChanged}
            />
          )}
        </Sheet>
        <UnderTheHood fields={current === undefined ? [] : hoodFields(current)} />
      </>
    );
  })();

  if (pasting) {
    return (
      <>
        {arrived === undefined ? (
          <PasteScreen
            invites={invites}
            passkey={passkey}
            onConnected={accepted}
            onAccepting={accepting}
            onAcceptFailed={acceptFailed}
            onDone={() => {
              // Closed with no accept on its way: nothing is expected from it.
              if (!acceptInFlight.current) acceptFailed();
              setPasting(false);
            }}
          />
        ) : (
          moment
        )}
      </>
    );
  }

  if (inviting) {
    // The Invite screen in place of the list (A5). Done (or Home) brings the list back, with the
    // new pending row read from the server.
    return (
      <>
        {arrived === undefined ? (
          <InviteScreen
            invites={invites}
            discard={discardInvite}
            paste={{
              passkey,
              onConnected: accepted,
              onAccepting: accepting,
              onAcceptFailed: acceptFailed,
              onOpen: openPaste,
            }}
            onCreated={() => {
              expecting.current = true;
              setJustCreated(true);
            }}
            onDone={() => {
              setInviting(false);
              setHighlight(justCreated ? rows[0]?.inviteId : undefined);
              setJustCreated(false);
              setTick((n) => n + 1);
            }}
          />
        ) : (
          moment
        )}
      </>
    );
  }

  return (
    <>
      {moment}
      {page}
    </>
  );
}
