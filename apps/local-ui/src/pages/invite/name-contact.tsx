// UX1113-N1 (run1113b B §3 state 2): "Your name for them", opened on request from the Connected
// moment. The field starts with the name the contact chose; only when the owner saves it does it
// become the owner's own alias, through the existing rename route (owner presence, one signed
// `contact.rename`, one POST); until then no prompt or heading carries the contact's own name (I-5).
//
// One gesture: the name is checked while typing (`rename-check`, debounced), so "Save with Touch ID"
// goes straight to the sensor (PresenceButton); the server checks the name again when it signs.
import { Button, TextField } from '@4thtech-io/ui';
import { useCallback, useEffect, useId, useState, type ReactElement } from 'react';
import type { ApiClient } from '../../api/client.js';
import { contactPath, parseRenameCheck, renameCheckPath } from '../contacts/data.js';
import type { OwnerClient, PresenceProof } from '../contacts/owner.js';
import { PresenceButton, type Gesture } from '../contacts/presence-button.js';
import { CONTACTS_STRINGS as C, waitSeconds } from '../contacts/strings.js';
import type { Platform } from '../first-run/strings.js';
import type { NativeStatus } from '../../presence/native-api.js';
import { INVITE_STRINGS as S } from './strings.js';

/** How long typing pauses before the name is checked. */
export const CHECK_DELAY_MS = 300;

export interface NameContactProps {
  readonly contactRef: string;
  /** The name the contact chose (name rule output), the field's first value. */
  readonly chosen: string;
  readonly api: ApiClient;
  readonly owner: OwnerClient;
  /** The owner saved this alias. */
  readonly onNamed: (alias: string) => void;
  /** The owner closed the field without saving. */
  readonly onCancel: () => void;
  /** Seams (tests). */
  readonly gesture?: Gesture;
  readonly platform?: Platform;
  readonly nativeStatus?: () => Promise<NativeStatus>;
  readonly userAgent?: string;
  readonly checkDelayMs?: number;
}

/** Field errors that hold the button (the server would refuse the same name). */
type Check =
  | { readonly kind: 'ok' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'refused'; readonly message: string; readonly hold: boolean };

export function NameContact({
  contactRef,
  chosen,
  api,
  owner,
  onNamed,
  onCancel,
  gesture,
  platform,
  nativeStatus,
  userAgent,
  checkDelayMs = CHECK_DELAY_MS,
}: NameContactProps): ReactElement {
  const fieldId = useId();
  const [alias, setAlias] = useState(chosen);
  const [check, setCheck] = useState<Check>({ kind: 'pending' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const wanted = alias.trim();

  // The field opens focused, its text selected, ready to type over.
  useEffect(() => {
    const input = document.getElementById(fieldId);
    if (input instanceof HTMLInputElement) {
      input.focus();
      input.select();
    }
  }, [fieldId]);

  // The name is checked while typing, never between the click and the gesture.
  useEffect(() => {
    if (wanted === '') {
      setCheck({ kind: 'refused', message: C.aliasInvalid, hold: true });
      return undefined;
    }
    let live = true;
    setCheck({ kind: 'pending' });
    const timer = setTimeout(() => {
      let path: string;
      try {
        path = renameCheckPath(contactRef, wanted);
      } catch {
        setCheck({ kind: 'refused', message: C.contactUnknown, hold: true });
        return;
      }
      void api.get(path).then(
        (res) => {
          if (!live) return;
          const answer =
            res.kind === 'ok'
              ? parseRenameCheck(res.data)
              : ({ kind: 'refused', reason: 'unavailable' } as const);
          if (answer.kind === 'ok') return setCheck({ kind: 'ok' });
          setCheck(
            answer.reason === 'alias_taken'
              ? { kind: 'refused', message: C.aliasTaken, hold: true }
              : answer.reason === 'alias_invalid'
                ? { kind: 'refused', message: C.aliasInvalid, hold: true }
                : answer.reason === 'contact_unknown'
                  ? { kind: 'refused', message: C.contactUnknown, hold: true }
                  : // Not checked now: the server checks again when it signs.
                    { kind: 'refused', message: C.renameUnavailable, hold: false },
          );
        },
        () => {
          if (live) setCheck({ kind: 'refused', message: C.renameUnavailable, hold: false });
        },
      );
    }, checkDelayMs);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, contactRef, wanted, checkDelayMs]);

  const submit = useCallback(
    (proof: PresenceProof) => {
      if (wanted === '' || busy) return;
      setBusy(true);
      setError(undefined);
      void owner.post(contactPath(contactRef, 'rename'), { alias: wanted }, proof).then((r) => {
        setBusy(false);
        if (r.kind === 'done') return onNamed(wanted);
        if (r.kind === 'wait') return setError(waitSeconds(r.seconds));
        // The sensor was cancelled (or a wrong master code): nothing changed, the text stays.
        if (r.kind === 'rejected' || r.kind === 'required') {
          return setError(proof.kind === 'code' ? C.presenceRejected : S.notSaved);
        }
        if (r.kind === 'session') return setError(C.sessionExpired);
        setError(C.notApplied);
      });
    },
    [owner, contactRef, wanted, busy, onNamed],
  );

  const fieldError = check.kind === 'refused' ? check.message : undefined;
  return (
    <div className="inv-name-contact al-reveal">
      <form onSubmit={(event) => event.preventDefault()}>
        <TextField
          id={fieldId}
          label={S.yourNameForThem}
          hint={S.yourNameHint}
          name="alias"
          autoComplete="off"
          maxLength={32}
          value={alias}
          onChange={(e) => {
            setAlias(e.currentTarget.value);
            setError(undefined);
          }}
          {...(fieldError === undefined ? {} : { error: fieldError })}
        />
      </form>
      <PresenceButton
        withSensor={S.saveWith}
        withCode={S.saveWithCode}
        statement={S.nameSummary(wanted)}
        busy={busy}
        error={error}
        disabled={check.kind === 'refused' && check.hold}
        notUsed={S.notSaved}
        onProof={submit}
        owner={owner}
        {...(gesture === undefined ? {} : { gesture })}
        {...(platform === undefined ? {} : { platform })}
        {...(nativeStatus === undefined ? {} : { nativeStatus })}
        {...(userAgent === undefined ? {} : { userAgent })}
      />
      <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
        {S.cancelNaming}
      </Button>
    </div>
  );
}
