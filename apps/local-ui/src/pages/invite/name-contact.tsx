// UX 2026-11-12 (WP-3 fix): "Name this contact" on the Connected moment (11 §5.2). The field starts
// with the name the contact chose, shown as theirs ("Self-declared", "Not checked yet"). Only when
// the owner confirms it does it become the owner's own alias, through the existing rename route
// (owner presence, one POST); until then no prompt or heading carries the contact's own name (I-5).
import { Button, ContactName, TextField } from '@4thtech-io/ui';
import { useCallback, useEffect, useState, type FormEvent, type ReactElement } from 'react';
import type { ApiClient } from '../../api/client.js';
import { contactPath, parseRenameCheck, renameCheckPath } from '../contacts/data.js';
import {
  createOwnerClient,
  type OwnerClient,
  type PasskeyInfo,
  type PresenceProof,
} from '../contacts/owner.js';
import { PresencePrompt } from '../contacts/presence-prompt.js';
import { CONTACTS_STRINGS as C, waitSeconds } from '../contacts/strings.js';
import { INVITE_STRINGS as S } from './strings.js';

export interface NameContactProps {
  readonly contactRef: string;
  /** The name the contact chose (name rule output), the field's first value. */
  readonly chosen: string;
  readonly api: ApiClient;
  readonly owner?: OwnerClient;
  /** The owner confirmed this alias (it is saved). */
  readonly onNamed: (alias: string) => void;
}

export function NameContact({
  contactRef,
  chosen,
  api,
  owner: givenOwner,
  onNamed,
}: NameContactProps): ReactElement {
  const [owner] = useState<OwnerClient>(() => givenOwner ?? createOwnerClient());
  const [alias, setAlias] = useState(chosen);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [passkey, setPasskey] = useState<PasskeyInfo | undefined>(undefined);
  const [wanted, setWanted] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let live = true;
    void owner.passkey().then(
      (info) => {
        if (live) setPasskey(info);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [owner]);

  const save = (event: FormEvent): void => {
    event.preventDefault();
    const next = alias.trim();
    if (next === '') {
      setFieldError(C.aliasInvalid);
      return;
    }
    setFieldError(undefined);
    void api.get(renameCheckPath(contactRef, next)).then((res) => {
      const check =
        res.kind === 'ok'
          ? parseRenameCheck(res.data)
          : ({ kind: 'refused', reason: 'unavailable' } as const);
      if (check.kind === 'ok') {
        setError(undefined);
        setWanted(next);
        return;
      }
      setFieldError(
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

  const submit = useCallback(
    (proof: PresenceProof) => {
      if (wanted === undefined) return;
      setBusy(true);
      setError(undefined);
      void owner.post(contactPath(contactRef, 'rename'), { alias: wanted }, proof).then((r) => {
        setBusy(false);
        if (r.kind === 'done') {
          setWanted(undefined);
          onNamed(wanted);
          return;
        }
        if (r.kind === 'wait') return setError(waitSeconds(r.seconds));
        if (r.kind === 'rejected') return setError(C.presenceRejected);
        if (r.kind === 'required') return setError(C.presenceRequired);
        setWanted(undefined);
        setFieldError(r.kind === 'session' ? C.sessionExpired : C.notApplied);
      });
    },
    [owner, contactRef, wanted, onNamed],
  );

  return (
    <div className="inv-name-contact al-reveal">
      <form onSubmit={save}>
        <TextField
          label={S.nameThisContact}
          hint={S.nameThisContactHint}
          name="alias"
          autoComplete="off"
          maxLength={32}
          value={alias}
          onChange={(e) => setAlias(e.currentTarget.value)}
          {...(fieldError === undefined ? {} : { error: fieldError })}
        />
        <p className="al-text-body-sm al-muted">
          <ContactName name={chosen} label="selfdeclared" showLabel />
        </p>
        <Button type="submit" variant="primary">
          {C.saveName}
        </Button>
      </form>
      {wanted === undefined ? null : (
        <PresencePrompt
          summary={S.nameSummary(wanted)}
          passkey={passkey}
          busy={busy}
          error={error}
          onSubmit={submit}
          onCancel={() => {
            setWanted(undefined);
            setError(undefined);
          }}
        />
      )}
    </div>
  );
}
