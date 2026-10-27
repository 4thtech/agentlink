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
  Sheet,
  Skeleton,
  SuccessMoment,
  Surface,
  TextField,
  UnderTheHood,
  formatContactName,
  useReducedMotion,
} from '@4thtech-io/ui';
import type { IdentityKind } from '@4thtech-io/ui';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type FormEvent,
  type ReactElement,
} from 'react';
import { createApiClient, type ApiClient, type ApiResult } from '../../api/client.js';
import { EARLIER_OWNER_CODE_HINT, PAGE_TITLES } from '../../strings.js';
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
import { isKept, keep, loadKept } from './kept.js';
import {
  createOwnerClient,
  passkeyProof,
  type OwnerClient,
  type OwnerResult,
  type PasskeyInfo,
  type PresenceProof,
} from './owner.js';
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
  onSelect,
}: {
  contacts: readonly ContactRow[];
  selected: string | undefined;
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
            <span className="al-contact-side">
              <StateChip contact={c} />
            </span>
          </button>
        </li>
      ))}
    </Surface>
  );
}

function PresencePrompt({
  summary,
  passkey,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  summary: string;
  passkey: PasskeyInfo | undefined;
  busy: boolean;
  error: string | undefined;
  onSubmit: (proof: PresenceProof) => void;
  onCancel: () => void;
}): ReactElement {
  const [code, setCode] = useState('');
  const [useCode, setUseCode] = useState(passkey === undefined);
  const [notUsed, setNotUsed] = useState(false);

  const submitCode = (event: FormEvent): void => {
    event.preventDefault();
    if (code === '' || busy) return;
    const proof: PresenceProof = { kind: 'code', code };
    setCode('');
    onSubmit(proof);
  };
  const usePasskey = (): void => {
    if (passkey === undefined || busy) return;
    setNotUsed(false);
    void passkeyProof(passkey).then((proof) => {
      if (proof === undefined) setNotUsed(true);
      else onSubmit(proof);
    });
  };

  return (
    <section className="ct-presence" aria-label={S.presenceIntro}>
      <p className="al-text-body">
        <strong>{summary}</strong>
      </p>
      <p className="al-text-body-sm al-muted">{S.presenceIntro}</p>
      {useCode ? (
        <form className="ct-presence-form" onSubmit={submitCode}>
          <TextField
            label={S.ownerCode}
            hint={EARLIER_OWNER_CODE_HINT}
            name="owner-code"
            type="password"
            autoComplete="off"
            spellCheck={false}
            mono
            value={code}
            onChange={(e) => setCode(e.currentTarget.value)}
          />
          <div className="ct-actions">
            <Button type="submit" variant="primary" disabled={busy || code === ''}>
              {S.confirm}
            </Button>
            <Button variant="ghost" onClick={onCancel} disabled={busy}>
              {S.cancel}
            </Button>
          </div>
        </form>
      ) : (
        <div className="ct-actions">
          <Button variant="primary" icon="approval" onClick={usePasskey} disabled={busy}>
            {S.usePasskey}
          </Button>
          <Button variant="ghost" onClick={() => setUseCode(true)} disabled={busy}>
            {S.useCode}
          </Button>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {S.cancel}
          </Button>
        </div>
      )}
      {notUsed ? (
        <p className="al-text-body-sm al-muted" role="status">
          {S.passkeyNotUsed}
        </p>
      ) : null}
      {error === undefined ? null : (
        <p className="al-text-body-sm ct-error" role="alert">
          {error}
        </p>
      )}
    </section>
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

export interface ContactsPageProps {
  /** For tests; the page's own same-origin clients by default. */
  readonly api?: ApiClient;
  readonly owner?: OwnerClient;
}

export function ContactsPage({
  api: givenApi,
  owner: givenOwner,
}: ContactsPageProps = {}): ReactElement {
  const api = useMemo(() => givenApi ?? createApiClient(), [givenApi]);
  const owner = useMemo(() => givenOwner ?? createOwnerClient(), [givenOwner]);
  const [list, setList] = useState<ListState>({ phase: 'loading' });
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [passkey, setPasskey] = useState<PasskeyInfo | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const [removed, setRemoved] = useState(false);
  const [kept, setKept] = useState(loadKept);
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => {
    let live = true;
    void api.get(LIST_PATH).then((res) => {
      if (!live) return;
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
    });
    return () => {
      live = false;
    };
  }, [api, tick]);

  useEffect(() => {
    let live = true;
    void owner.passkey().then((info) => {
      if (live) setPasskey(info);
    });
    return () => {
      live = false;
    };
  }, [owner]);

  const onChanged = useCallback((what: Pending['what']) => {
    setRemoved(what === 'remove');
    if (what === 'remove') setSheetOpen(false);
    setTick((n) => n + 1);
  }, []);

  const title = <h1 className="al-text-title-1">{PAGE_TITLES.contacts}</h1>;

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
        <EmptyState icon="users" title={S.emptyTitle} prompt={S.emptyPrompt} />
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
      <div className="ct-layout">
        <ContactList
          contacts={list.contacts}
          selected={current?.ref}
          onSelect={(ref) => {
            setRemoved(false);
            setSelected(ref);
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
}
