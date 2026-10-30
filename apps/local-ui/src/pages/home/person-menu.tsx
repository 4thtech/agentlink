// W4-HOME: a person's ⋯ menu (prototype v23 A4: Rename · Check safety code · Remove). Each item
// calls the existing Contacts routes, exactly as the Contacts page does (04 §2.5, §3.6.1; D-118;
// I-4): nothing new is signed here and the page never signs.
//
// - Rename: "Name in your list", checked first (`GET …/rename-check`), then one presence step and
//   one POST to `…/rename` (the server signs `contact.rename`).
// - Check safety code: the 12 digits (`GET …/safety-code`), "They match" → presence → `…/check`
//   with the code that was shown (`contact.check`); "They don't match" signs nothing and explains.
// - Remove: asks first in plain words, then presence → `…/remove`.
//
// The presence step is Contacts' own PresencePrompt (the passkey, or the backup code). U4 may
// replace this menu with its PersonMenu; the routes and the steps stay the same.
import { Button, Icon } from '@4thtech-io/ui';
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
import type { ApiClient } from '../../api/client.js';
import {
  contactPath,
  parseCode,
  parseRenameCheck,
  renameCheckPath,
  type CodeAnswer,
  type ContactRow,
} from '../contacts/data.js';
import {
  createOwnerClient,
  type OwnerResult,
  type PasskeyInfo,
  type PresenceProof,
} from '../contacts/owner.js';
import { PresencePrompt } from '../contacts/presence-prompt.js';
import { CONTACTS_STRINGS as C, SUMMARY, mismatchBody, waitSeconds } from '../contacts/strings.js';
import { HOME_STRINGS as S, fmt } from './people-strings.js';

type Mode = 'none' | 'rename' | 'check' | 'remove';

interface Pending {
  readonly what: 'check' | 'rename' | 'remove';
  readonly input?: unknown;
  readonly summary: string;
}

const MESSAGE: Readonly<Partial<Record<OwnerResult['kind'], string>>> = {
  rejected: C.presenceRejected,
  required: C.presenceRequired,
  refused: C.refused,
  not_applied: C.notApplied,
  busy: C.busy,
  session: C.sessionExpired,
  failed: C.failed,
};

export function PersonMenu({
  name,
  contact,
  api,
  fetch: givenFetch,
  token,
  onChanged,
}: {
  readonly name: string;
  /** The contact's row (ref, identity, pairing); the menu is off without one. */
  readonly contact: ContactRow | undefined;
  readonly api: ApiClient;
  readonly fetch?: typeof fetch;
  readonly token?: string;
  /** A change was applied: read Home again (and say it). */
  readonly onChanged: (what: 'check' | 'rename' | 'remove', notice: string) => void;
}): ReactElement | null {
  const owner = useMemo(
    () =>
      createOwnerClient({
        ...(givenFetch === undefined ? {} : { fetch: givenFetch }),
        ...(token === undefined ? {} : { token }),
      }),
    [givenFetch, token],
  );
  const menuId = useId();
  const fieldId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('none');
  const [alias, setAlias] = useState(name);
  const [aliasError, setAliasError] = useState<string | undefined>(undefined);
  const [code, setCode] = useState<CodeAnswer | 'loading'>('loading');
  const [mismatch, setMismatch] = useState(false);
  const [pending, setPending] = useState<Pending | undefined>(undefined);
  const [passkey, setPasskey] = useState<PasskeyInfo | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  // The menu closes on Escape or a click outside, and gives the focus back to its button.
  useEffect(() => {
    if (!open) return undefined;
    const first = menu.current?.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node | null;
      if (t !== null && !menu.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  // The safety code, read when Check opens.
  useEffect(() => {
    if (mode !== 'check' || contact === undefined) return undefined;
    if (contact.label === 'safety-code-checked' || contact.pairing !== 'complete') return undefined;
    let live = true;
    setCode('loading');
    void api.get(contactPath(contact.ref, 'safety-code')).then((res) => {
      if (live) setCode(res.kind === 'ok' ? parseCode(res.data) : { kind: 'unavailable' });
    });
    return () => {
      live = false;
    };
  }, [api, contact, mode]);

  const ask = useCallback(
    (next: Pending): void => {
      setError(undefined);
      setNotice(undefined);
      void owner.passkey().then((info) => {
        setPasskey(info);
        setPending(next);
      });
    },
    [owner],
  );

  const close = (): void => {
    setMode('none');
    setPending(undefined);
    setError(undefined);
    setMismatch(false);
    setAliasError(undefined);
  };

  const submit = (proof: PresenceProof): void => {
    if (pending === undefined || contact === undefined) return;
    setBusy(true);
    setError(undefined);
    void owner.post(contactPath(contact.ref, pending.what), pending.input, proof).then((result) => {
      setBusy(false);
      if (result.kind === 'done') {
        const said =
          pending.what === 'rename'
            ? S.renamed
            : pending.what === 'check'
              ? S.checked
              : fmt(S.removed, { name });
        close();
        setNotice(said);
        onChanged(pending.what, said);
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
      setPending(undefined);
      setNotice(MESSAGE[result.kind] ?? C.failed);
    });
  };

  const saveName = (event: FormEvent): void => {
    event.preventDefault();
    if (contact === undefined) return;
    const wanted = alias.trim();
    if (wanted === '') {
      setAliasError(C.aliasInvalid);
      return;
    }
    setAliasError(undefined);
    void api.get(renameCheckPath(contact.ref, wanted)).then((res) => {
      const check =
        res.kind === 'ok'
          ? parseRenameCheck(res.data)
          : ({ kind: 'refused', reason: 'unavailable' } as const);
      if (check.kind === 'ok') {
        ask({ what: 'rename', input: { alias: wanted }, summary: SUMMARY.rename(name, wanted) });
        return;
      }
      setAliasError(
        check.reason === 'alias_taken'
          ? C.aliasTaken
          : check.reason === 'alias_invalid'
            ? C.aliasInvalid
            : check.reason === 'contact_unknown'
              ? C.contactUnknown
              : C.renameUnavailable,
      );
    });
  };

  if (contact === undefined) return null;
  const start = (next: Mode): void => {
    setOpen(false);
    setNotice(undefined);
    setPending(undefined);
    setMismatch(false);
    if (next === 'rename') setAlias(name);
    setMode(next);
  };

  return (
    <>
      <span className="hm-menu-wrap">
        <button
          ref={button}
          type="button"
          className="al-btn al-btn-ghost al-btn-sm hm-menu-btn"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          aria-label={fmt(S.moreFor, { name })}
          onClick={() => setOpen((o) => !o)}
        >
          <Icon name="ellipsis" size={18} />
        </button>
        {open ? (
          <div ref={menu} id={menuId} role="menu" className="al-shell-menu al-help-menu al-menu">
            <button
              type="button"
              role="menuitem"
              className="al-mitem"
              onClick={() => start('rename')}
            >
              <Icon name="tag" size={16} />
              {S.rename}
            </button>
            <button
              type="button"
              role="menuitem"
              className="al-mitem"
              onClick={() => start('check')}
            >
              <Icon name="safety-code" size={16} />
              {S.checkSafetyCode}
            </button>
            <button
              type="button"
              role="menuitem"
              className="al-mitem hm-danger"
              onClick={() => start('remove')}
            >
              <Icon name="minus" size={16} />
              {S.remove}
            </button>
          </div>
        ) : null}
      </span>
      <div className="hm-menu-panel hm-c">
        {mode === 'rename' && pending === undefined ? (
          <form className="hm-inline hm-f al-reveal" onSubmit={saveName}>
            <label htmlFor={fieldId} className="al-text-body-sm">
              {S.nameInList}
            </label>
            <span className="al-input-wrap hm-rename">
              <input
                id={fieldId}
                className="al-input"
                type="text"
                value={alias}
                maxLength={64}
                autoComplete="off"
                aria-invalid={aliasError === undefined ? undefined : true}
                onChange={(e) => setAlias(e.target.value)}
              />
            </span>
            <Button type="submit" size="sm">
              {S.save}
            </Button>
            <Button variant="ghost" size="sm" onClick={close}>
              {S.cancel}
            </Button>
            {aliasError === undefined ? null : (
              <p role="alert" className="hm-inline-error al-text-body-sm">
                {aliasError}
              </p>
            )}
          </form>
        ) : null}
        {mode === 'check' && pending === undefined ? (
          <div className="hm-inline hm-f hm-code al-reveal">
            {contact.label === 'safety-code-checked' ? (
              <p className="al-text-body-sm">{fmt(S.alreadyChecked, { name })}</p>
            ) : contact.pairing !== 'complete' ? (
              <p className="al-text-body-sm">{fmt(S.notPairedYet, { name })}</p>
            ) : code === 'loading' ? (
              <p className="al-text-body-sm al-muted">{S.codeLoading}</p>
            ) : code.kind === 'unavailable' ? (
              <p className="al-text-body-sm">{S.codeUnavailable}</p>
            ) : mismatch ? (
              <p className="al-text-body-sm">{mismatchBody(name)}</p>
            ) : (
              <>
                <p className="al-text-body-sm">{fmt(S.codeLead, { name })}</p>
                <p className="al-text-code-lg">{code.code}</p>
                <Button
                  size="sm"
                  onClick={() =>
                    ask({ what: 'check', input: { code: code.code }, summary: SUMMARY.check(name) })
                  }
                >
                  {S.theyMatch}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setMismatch(true)}>
                  {S.theyDontMatch}
                </Button>
              </>
            )}
            <Button variant="ghost" size="sm" onClick={close}>
              {S.cancel}
            </Button>
          </div>
        ) : null}
        {mode === 'remove' && pending === undefined ? (
          <div
            role="alertdialog"
            aria-label={S.removeLabel}
            className="hm-inline hm-f hm-remove al-reveal"
          >
            <span className="al-text-body-sm">{fmt(S.removeText, { name })}</span>
            <Button
              variant="danger"
              size="sm"
              onClick={() => ask({ what: 'remove', summary: SUMMARY.remove(name) })}
            >
              {S.remove}
            </Button>
            <Button variant="ghost" size="sm" onClick={close}>
              {S.cancel}
            </Button>
          </div>
        ) : null}
        {pending === undefined ? null : (
          <PresencePrompt
            summary={pending.summary}
            passkey={passkey}
            busy={busy}
            error={error}
            onSubmit={submit}
            onCancel={close}
          />
        )}
        {notice === undefined ? null : (
          <p role="status" className="hm-inline-note al-text-body-sm">
            {notice}
          </p>
        )}
      </div>
    </>
  );
}
