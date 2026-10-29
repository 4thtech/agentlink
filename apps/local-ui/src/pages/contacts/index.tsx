// Contacts (M1-11c-a2; d1 Local-contacts with DESIGN-ADJ-1 CO-4, CO-5, X-7, X-11; 04 §3.6.1; 11
// §5.2, §6.2; UX audit 3b, 10a).
//
// The list beside the selected contact. Names, never keys: the owner's alias, or the contact's own
// name under the ui name rule (formatContactName), always as React text; the short fingerprint only
// as that rule's fallback. No presence for contacts (X-11).
//
// The safety code: on a paired contact that is not yet checked, the page shows the 12 digits with a
// gentle nudge and three choices. "They match" asks for owner presence and posts the code it showed;
// the server signs `contact.check` (it signs only if that is still the code). "They don't match"
// signs nothing by itself (04 §3.6.1): it explains and offers Remove. "Skip" keeps the contact
// Self-declared.
//
// Rename and Remove ask for owner presence (the passkey, or the owner code). Every change is one POST
// to a presence route; the page never signs (owner.ts).
import {
  Banner,
  Button,
  ContactName,
  EmptyState,
  Icon,
  RingMeter,
  Sheet,
  Skeleton,
  SuccessMoment,
  Surface,
  TextField,
  formatContactName,
  useReducedMotion,
} from '@4thtech-io/ui';
import { UnderTheHood } from '../../lazy/hood.js';
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
import {
  ActivityCell,
  ActivitySort,
  compareMostActive,
  sortKey,
  usePulse,
  type Pulse,
} from '../pulse/index.js';
import { PAGE_TITLES } from '../../strings.js';
import { AddContactSheet } from './add-contact.js';
import { ADD_CONTACT_MARKER } from './add-contact-link.js';
import { ADD_STRINGS as A, connectingTo, daysLeft, waitingToAccept } from './add-strings.js';
import {
  LIST_PATH,
  contactPath,
  parseCode,
  parseList,
  parseRenameCheck,
  renameCheckPath,
  type CodeAnswer,
  type ContactRow,
} from './data.js';
import { createInviteApi, type InviteApi } from './invite-api.js';
import { isKept, keep, loadKept } from './kept.js';
import {
  createOwnerClient,
  type OwnerClient,
  type OwnerResult,
  type PasskeyInfo,
  type PresenceProof,
} from './owner.js';
import { addPendingInvite, pendingInvites, type PendingInvite } from './pending-invites.js';
import { PresencePrompt } from './presence-prompt.js';
import { useInviteFirst } from '../home/start-here-empty.js';
import { START_STRINGS } from '../home/strings.js';
import {
  CONTACTS_STRINGS as S,
  HOOD,
  SUMMARY,
  countLine,
  mismatchBody,
  nudge,
  secondConnection,
  since,
  waitSeconds,
  waitingFor,
} from './strings.js';
import './contacts.css';

type ListState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'error' }
  | { readonly phase: 'not_set_up' }
  | { readonly phase: 'ok'; readonly contacts: readonly ContactRow[] };

/** One owner operation waiting for presence. */
interface Pending {
  readonly what: 'check' | 'rename' | 'remove';
  readonly ref: string;
  readonly input?: unknown;
  readonly summary: string;
}

const DATE = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/** The pairing day in the second-connection notice ("paired 25 Oct"). */
const DAY = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

const nameInput = (c: ContactRow): { alias?: string; name?: string; fingerprint?: string } =>
  c.nameSource === 'owner'
    ? { alias: c.name }
    : { name: c.name, ...(c.fingerprint === undefined ? {} : { fingerprint: c.fingerprint }) };

/** The name as the ui name rule shows it, for sentences (always rendered as text). */
const shownName = (c: ContactRow): string => formatContactName(nameInput(c)).text;

const labelKind = (c: ContactRow): IdentityKind =>
  c.label === 'safety-code-checked' ? 'checked' : 'selfdeclared';

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

function Chip({ icon, tone, children }: { icon: string; tone: string; children: string }) {
  return (
    <span className={`al-chip al-tone-${tone}`}>
      <Icon name={icon} size={12} strokeWidth={2.25} />
      <span className="al-text-label">{children}</span>
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

/** Shown names that more than one contact has, so each of those rows can say so (UI-only hint). */
function duplicateNames(contacts: readonly ContactRow[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const c of contacts) {
    const n = shownName(c).trim().toLowerCase();
    if (seen.has(n)) dupes.add(n);
    seen.add(n);
  }
  return dupes;
}

function ContactList({
  contacts,
  selected,
  pulse,
  arrivals,
  seq,
  onSelect,
}: {
  contacts: readonly ContactRow[];
  selected: string | undefined;
  pulse: Pulse | undefined;
  arrivals: ReadonlySet<string>;
  seq: number;
  onSelect: (ref: string) => void;
}): ReactElement {
  const dupes = duplicateNames(contacts);
  return (
    <Surface as="ul" level={1} className="ct-list" aria-label={S.listLabel}>
      {contacts.map((c) => (
        <li key={c.ref}>
          <button
            type="button"
            className={`al-contact ct-row${c.status === 'active' ? '' : ` is-${c.status}`}`}
            aria-current={c.ref === selected ? 'true' : undefined}
            onClick={() => onSelect(c.ref)}
          >
            <span className="al-avatar al-text-label" aria-hidden="true">
              {initials(shownName(c))}
            </span>
            <span className="al-contact-main">
              <span className="al-contact-name">
                <ContactName {...nameInput(c)} label={labelKind(c)} showLabel />
              </span>
              {dupes.has(shownName(c).trim().toLowerCase()) ? (
                <span className="al-text-caption al-muted ct-same-name">{S.sameName}</span>
              ) : null}
            </span>
            <ActivityCell pulse={pulse} contactId={c.ref} arrival={arrivals.has(c.ref) ? seq : 0} />
            <span className="al-contact-side">
              <StateChip contact={c} />
            </span>
          </button>
        </li>
      ))}
    </Surface>
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
  failed: S.failed,
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
  const ref = contact.ref;
  const name = shownName(contact);
  const compare =
    contact.status === 'active' &&
    contact.pairing === 'complete' &&
    contact.label === 'self-declared';
  const [code, setCode] = useState<CodeState>({ kind: 'loading' });
  const [codeTick, setCodeTick] = useState(0);
  const [skipped, setSkipped] = useState(false);
  const [mismatch, setMismatch] = useState(false);
  const [matched, setMatched] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [alias, setAlias] = useState('');
  const [aliasError, setAliasError] = useState<string | undefined>(undefined);
  const [confirmRemove, setConfirmRemove] = useState(false);
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
          setNotice(MESSAGE[result.kind]);
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
        {pending === undefined && !renaming && !confirmRemove && !confirmOlder ? (
          <div className="ct-actions">
            <Button variant="ghost" size="sm" onClick={() => setRenaming(true)}>
              {S.rename}
            </Button>
            {contact.status === 'revoked' ? null : (
              <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(true)}>
                {S.remove}
              </Button>
            )}
          </div>
        ) : null}
      </div>
      <p className="al-text-body-sm al-muted">
        {since(DATE.format(new Date(contact.since * 1000)))}
      </p>
      {duplicate}
      {contact.status === 'blocked' ? <p className="al-text-body">{S.blockedDetail}</p> : null}
      {contact.status === 'revoked' ? <p className="al-text-body">{S.revokedDetail}</p> : null}
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

const DAY_MS = 86_400_000;

/**
 * UX2-d2 (b11 §21.3, Closing): the invites created here, as pending rows: the name and the days
 * left, never the link. The newest gets the 1.2 s highlight as the sheet leaves (a colour fade only).
 */
function PendingInvites({
  rows,
  highlight,
  now,
}: {
  rows: readonly PendingInvite[];
  highlight: number | undefined;
  now: number;
}): ReactElement | null {
  if (rows.length === 0) return null;
  return (
    <Surface as="ul" level={1} className="ct-list ct-invites" aria-label={A.pendingLabel}>
      {rows.map((r) => {
        const total = Math.max(1, Math.ceil((r.expiresAt - r.createdAt) / DAY_MS));
        const left = Math.max(0, Math.ceil((r.expiresAt - now) / DAY_MS));
        return (
          <li key={r.id} className={`ct-invite${r.id === highlight ? ' is-new' : ''}`}>
            <span className="al-avatar al-text-label" aria-hidden="true">
              <Icon name="clock" size={14} />
            </span>
            <span className="ct-invite-main al-text-body">{waitingToAccept(r.name)}</span>
            <RingMeter
              label={A.daysLeftLabel}
              value={left}
              max={total}
              text={daysLeft(left)}
              countdown
              size="sm"
            />
          </li>
        );
      })}
    </Surface>
  );
}

export interface ContactsPageProps {
  /** For tests; the page's own same-origin clients by default. */
  readonly api?: ApiClient;
  readonly owner?: OwnerClient;
  readonly invites?: InviteApi;
}

/** True once, when the page was opened through the Add contact link (b11 §21.1). */
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
  const [adding, setAdding] = useState(openedForAdd);
  const [rows, setRows] = useState<readonly PendingInvite[]>(() => pendingInvites());
  const [highlight, setHighlight] = useState<number | undefined>(undefined);
  const [lastCreated, setLastCreated] = useState<number | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const addButtonId = useId();
  const activity = usePulse(api);
  const { activitySort } = usePrefs();
  const inviteFirst = useInviteFirst();
  const returnFocus = useRef(false);

  // HOTFIX-045: one read at a time; a background read (the poll) never replaces a good list with an error.
  const inFlight = useRef(false);
  const background = useRef(false);

  useEffect(() => {
    let live = true;
    const quiet = background.current;
    background.current = false;
    inFlight.current = true;
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
  const anyPending = list.phase === 'ok' && list.contacts.some((c) => c.pairing === 'pending');
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
    const timer = setInterval(bump, 5_000);
    const onVisible = (): void => bump();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', bump);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', bump);
    };
  }, [anyPending]);

  useEffect(() => {
    let live = true;
    void owner.passkey().then((info) => {
      if (live) setPasskey(info);
    });
    return () => {
      live = false;
    };
  }, [owner]);

  // Focus goes back to Add contact when the sheet closes (b11 §21.6).
  useEffect(() => {
    if (adding || !returnFocus.current) return;
    returnFocus.current = false;
    document.getElementById(addButtonId)?.focus();
  }, [adding]);

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

  const openAdd = (): void => {
    setSheetOpen(false);
    setNotice(undefined);
    setAdding(true);
  };
  const closeAdd = (): void => {
    returnFocus.current = true;
    setAdding(false);
    setHighlight(lastCreated);
    setLastCreated(undefined);
  };

  const ready = list.phase === 'ok';
  const empty = ready && list.contacts.length === 0;
  // Start here step 2 not done yet: the empty state carries the one Add contact (b11 §27.4), and it
  // opens the sheet here directly.
  const inviteInEmpty = empty && rows.length === 0 && inviteFirst;
  const title = (
    <div className="ct-title-row">
      <h1 className="al-text-title-1">{PAGE_TITLES.contacts}</h1>
      {ready && !inviteInEmpty ? (
        <Button
          id={addButtonId}
          variant={empty && rows.length === 0 ? 'primary' : 'secondary'}
          icon="user-plus"
          onClick={openAdd}
        >
          {A.addContact}
        </Button>
      ) : null}
    </div>
  );
  const sheet = adding ? (
    <AddContactSheet
      invites={invites}
      passkey={passkey}
      onCreated={(name, expiresAt) => {
        const row = addPendingInvite(name, expiresAt);
        setRows(pendingInvites());
        setLastCreated(row.id);
      }}
      onConnected={(name) => {
        returnFocus.current = true;
        setAdding(false);
        setNotice(connectingTo(name));
        setTick((n) => n + 1);
      }}
      onClose={closeAdd}
    />
  ) : null;
  const status =
    notice === undefined ? null : (
      <p className="al-text-body" role="status">
        {notice}
      </p>
    );
  const invitesList = <PendingInvites rows={rows} highlight={highlight} now={Date.now()} />;

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
    if (list.contacts.length === 0) {
      return (
        <>
          {title}
          {removed ? (
            <p className="al-text-body" role="status">
              {S.removed}
            </p>
          ) : null}
          {status}
          {rows.length === 0 ? (
            inviteFirst ? (
              <EmptyState
                icon="users"
                title={START_STRINGS.emptyContacts}
                prompt={S.emptyPrompt}
                action={
                  <Button id={addButtonId} variant="primary" icon="user-plus" onClick={openAdd}>
                    {A.addContact}
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
    return (
      <>
        <p className="al-text-label al-muted ct-count">{countLine(list.contacts.length)}</p>
        {title}
        {removed ? (
          <p className="al-text-body" role="status">
            {S.removed}
          </p>
        ) : null}
        {status}
        <div className="ct-layout">
          {invitesList}
          <ActivitySort />
          <ContactList
            contacts={
              activitySort === 'active'
                ? [...list.contacts].sort((a, b) =>
                    compareMostActive(
                      sortKey(activity.pulse, a.ref, 0),
                      sortKey(activity.pulse, b.ref, 0),
                    ),
                  )
                : list.contacts
            }
            selected={current?.ref}
            pulse={activity.pulse}
            arrivals={activity.arrivals}
            seq={activity.seq}
            onSelect={(ref) => {
              setRemoved(false);
              setSelected(ref);
              setAdding(false);
              setSheetOpen(true);
            }}
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

  return (
    <>
      {page}
      {sheet}
    </>
  );
}
