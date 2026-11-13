// RET-6 (D-148; 04 §4.2 "Retention policy"; 08 §1; 11 §5): Settings › Storage › Keep automatically.
//
// - Reads the `history.*` values in force (`GET /api/ui/storage/retention`): a policy signed before
//   D-148 reads as Forever.
// - Two choices, only from the 06 §3 lists. A new choice first asks the server what it would remove
//   now (the same route with `?messages=&files=`; it plans and deletes nothing) and shows it before
//   the owner signs ("the first time a setting is turned on, the app shows what it would remove").
// - One Save button is the sensor ("Save with Touch ID"; the master code as a link). The press sends
//   exactly `{base, messagesKeepDays, filesKeepDays}` to the presence route; the server signs the
//   `policy.set` that changes `history` and nothing else. The daily pass does the deleting later.
// Nothing here deletes, and no AI can reach it (I-4). Nothing here logs.
import { Button, InlineError, Surface } from '@4thtech-io/ui';
import { useCallback, useEffect, useId, useMemo, useState, type ReactElement } from 'react';
import type { ApiClient } from '../../api/client.js';
import { createOwnerClient, type OwnerResult, type PresenceProof } from '../contacts/owner.js';
import { PresenceButton } from '../contacts/presence-button.js';
import { CONTACTS_STRINGS as C, waitSeconds } from '../contacts/strings.js';
import { SettingsIcon } from '../settings/icons.js';
import { sizeWords } from './data.js';
import { KEEP_STRINGS as S } from './strings.js';

export const RETENTION_PATH = '/api/ui/storage/retention';
/** The 06 §3 lists (D-148); the server checks them again. */
export const MESSAGES_KEEP_DAYS: readonly number[] = [0, 90, 365, 730];
export const FILES_KEEP_DAYS: readonly number[] = [0, 30, 90, 180, 365];

interface Keep {
  readonly messagesKeepDays: number;
  readonly filesKeepDays: number;
}

type Load =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  /** No ID set up here (or an answer of another shape): the section is not shown. */
  | { readonly kind: 'hidden' }
  | { readonly kind: 'not_valid' }
  | {
      readonly kind: 'ready';
      readonly version: number;
      readonly active: boolean;
      readonly keep: Keep;
    };

type Preview =
  | { readonly kind: 'none' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | {
      readonly kind: 'ready';
      readonly messages: { readonly count: number; readonly bytes: number };
      readonly files: { readonly count: number; readonly bytes: number };
      /** A count was capped: say "about" (IR-RET-67-1 Low 5). */
      readonly truncated: boolean;
    };

const MESSAGE: Readonly<Partial<Record<OwnerResult['kind'], string>>> = {
  rejected: C.presenceRejected,
  required: C.presenceRequired,
  busy: C.busy,
  session: C.sessionExpired,
  failed: C.failed,
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0;

/** The read, field by field; undefined when it is not one of the known shapes. */
export function parseRetention(data: unknown): Load | undefined {
  if (!isObject(data)) return undefined;
  if (data['status'] === 'not_valid') return { kind: 'not_valid' };
  if (data['status'] !== 'ok') return undefined;
  const keep = data['keep'];
  const version = data['version'];
  if (!isObject(keep) || typeof version !== 'number' || !Number.isSafeInteger(version)) {
    return undefined;
  }
  const m = keep['messagesKeepDays'];
  const f = keep['filesKeepDays'];
  if (typeof m !== 'number' || !MESSAGES_KEEP_DAYS.includes(m)) return undefined;
  if (typeof f !== 'number' || !FILES_KEEP_DAYS.includes(f)) return undefined;
  return {
    kind: 'ready',
    version,
    active: data['active'] !== false,
    keep: { messagesKeepDays: m, filesKeepDays: f },
  };
}

function parsePreview(data: unknown): Preview {
  const p = isObject(data) ? data['preview'] : undefined;
  if (!isObject(p) || !isObject(p['messages']) || !isObject(p['files'])) return { kind: 'failed' };
  return {
    kind: 'ready',
    messages: { count: count(p['messages']['count']), bytes: count(p['messages']['bytes']) },
    files: { count: count(p['files']['count']), bytes: count(p['files']['bytes']) },
    truncated: p['truncated'] === true,
  };
}

const words = (days: number): string => (days === 0 ? S.forever : S.days(days));

export function KeepAutomatically({
  api,
  fetch: givenFetch,
  token,
}: {
  readonly api: ApiClient;
  readonly fetch?: typeof fetch | undefined;
  readonly token?: string | undefined;
}): ReactElement {
  const titleId = useId();
  const messagesId = useId();
  const filesId = useId();
  const owner = useMemo(
    () =>
      createOwnerClient({
        ...(givenFetch === undefined ? {} : { fetch: givenFetch }),
        ...(token === undefined ? {} : { token }),
      }),
    [givenFetch, token],
  );
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [choice, setChoice] = useState<Keep | undefined>(undefined);
  const [preview, setPreview] = useState<Preview>({ kind: 'none' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saved, setSaved] = useState(false);

  const read = useCallback((): void => {
    setLoad({ kind: 'loading' });
    void api.get(RETENTION_PATH).then(
      (result) => {
        // No ID yet (409 not_set_up) or another shape: nothing to keep, so the section hides.
        const parsed =
          result.kind === 'ok'
            ? (parseRetention(result.data) ?? { kind: 'hidden' as const })
            : result.kind === 'error' && result.status === 409
              ? { kind: 'hidden' as const }
              : undefined;
        setLoad(parsed ?? { kind: 'failed' });
        setChoice(parsed?.kind === 'ready' ? parsed.keep : undefined);
        setPreview({ kind: 'none' });
      },
      () => setLoad({ kind: 'failed' }),
    );
  }, [api]);
  useEffect(read, [read]);

  const ready = load.kind === 'ready' ? load : undefined;
  const changed =
    ready !== undefined &&
    choice !== undefined &&
    (choice.messagesKeepDays !== ready.keep.messagesKeepDays ||
      choice.filesKeepDays !== ready.keep.filesKeepDays);

  // A new choice: what it removes now, before anything is signed.
  useEffect(() => {
    if (!changed || choice === undefined) {
      setPreview({ kind: 'none' });
      return;
    }
    let live = true;
    setPreview({ kind: 'loading' });
    const query = `?messages=${String(choice.messagesKeepDays)}&files=${String(choice.filesKeepDays)}`;
    void api.get(`${RETENTION_PATH}${query}`).then(
      (result) => {
        if (live) setPreview(result.kind === 'ok' ? parsePreview(result.data) : { kind: 'failed' });
      },
      () => {
        if (live) setPreview({ kind: 'failed' });
      },
    );
    return () => {
      live = false;
    };
  }, [api, changed, choice]);

  const pick = (part: Partial<Keep>): void => {
    if (choice === undefined) return;
    setChoice({ ...choice, ...part });
    setError(undefined);
    setSaved(false);
  };

  const press = (proof: PresenceProof): void => {
    if (ready === undefined || choice === undefined) return;
    setBusy(true);
    setError(undefined);
    const input = {
      base: ready.version,
      messagesKeepDays: choice.messagesKeepDays,
      filesKeepDays: choice.filesKeepDays,
    };
    void owner.post(RETENTION_PATH, input, proof).then((result) => {
      setBusy(false);
      if (result.kind === 'done') {
        setSaved(true);
        setLoad({ ...ready, version: ready.version + 1, active: true, keep: choice });
        return;
      }
      if (result.kind === 'wait') {
        setError(waitSeconds(result.seconds));
        return;
      }
      if (result.kind === 'rejected' || result.kind === 'required') {
        setError(proof.kind === 'code' ? MESSAGE[result.kind] : S.notUsed);
        return;
      }
      if (result.kind === 'refused' || result.kind === 'not_applied') {
        setError(S.refused);
        return;
      }
      setError(MESSAGE[result.kind] ?? C.failed);
    });
  };

  const previewLine = (): string | undefined => {
    if (preview.kind === 'none') return undefined;
    if (preview.kind === 'loading') return S.previewing;
    if (preview.kind === 'failed') return S.previewFailed;
    const messages = preview.messages.count;
    const files = preview.files.count;
    if (messages === 0 && files === 0) return S.previewNone;
    return S.preview(
      messages,
      files,
      sizeWords(preview.messages.bytes + preview.files.bytes),
      preview.truncated,
    );
  };
  const line = previewLine();

  if (load.kind === 'hidden') return <></>;

  return (
    <Surface as="section" level={1} className="sto-coming" aria-labelledby={titleId}>
      <span className="sto-ic" aria-hidden="true">
        <SettingsIcon name="download" />
      </span>
      <div className="sto-coming-text">
        <h2 id={titleId} className="al-text-h3">
          {S.title}
        </h2>
        <p className="al-text-body-sm al-muted">{S.lead}</p>
        {load.kind === 'loading' ? (
          <p className="al-text-body-sm al-muted">{S.loading}</p>
        ) : load.kind === 'failed' ? (
          <div className="sto-filters">
            <InlineError>{S.failed}</InlineError>
            <Button variant="ghost" size="sm" onClick={read}>
              {S.retry}
            </Button>
          </div>
        ) : load.kind === 'not_valid' || choice === undefined ? (
          <InlineError>{S.notValid}</InlineError>
        ) : (
          <>
            <div className="sto-filters">
              <label htmlFor={messagesId} className="sto-field al-text-body-sm">
                <span>{S.messages}</span>
                <select
                  id={messagesId}
                  className="al-input"
                  value={String(choice.messagesKeepDays)}
                  onChange={(e) => pick({ messagesKeepDays: Number(e.target.value) })}
                >
                  {MESSAGES_KEEP_DAYS.map((d) => (
                    <option key={d} value={String(d)}>
                      {words(d)}
                    </option>
                  ))}
                </select>
              </label>
              <label htmlFor={filesId} className="sto-field al-text-body-sm">
                <span>{S.files}</span>
                <select
                  id={filesId}
                  className="al-input"
                  value={String(choice.filesKeepDays)}
                  onChange={(e) => pick({ filesKeepDays: Number(e.target.value) })}
                >
                  {FILES_KEEP_DAYS.map((d) => (
                    <option key={d} value={String(d)}>
                      {words(d)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <p className="al-text-body-sm al-muted">{S.filesHelp}</p>
            {ready?.active === false ? (
              <p className="al-text-body-sm al-muted">{S.notActive}</p>
            ) : null}
            {line === undefined ? null : <p className="al-text-body-sm">{line}</p>}
            {changed ? (
              <>
                <p className="al-text-body-sm al-muted">{S.onlyHere}</p>
                <div>
                  <PresenceButton
                    withSensor={S.saveWith}
                    withCode={S.saveWithCode}
                    statement={S.statement}
                    busy={busy}
                    error={error}
                    notUsed={S.notUsed}
                    disabled={preview.kind === 'loading'}
                    onProof={press}
                    owner={owner}
                  />
                </div>
              </>
            ) : error === undefined ? null : (
              <InlineError>{error}</InlineError>
            )}
            {saved ? <p className="al-text-body-sm">{S.saved}</p> : null}
          </>
        )}
      </div>
    </Surface>
  );
}
