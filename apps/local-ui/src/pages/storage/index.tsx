// REL051-RET1: Settings > Storage (retention plan RET-1; 08 §1). How much room each ID and each
// person takes, and the Inbox folder. RET-4 (D-148): Free up space (filters, Review, the delete
// sheet behind presence) and Show in Finder for the Inbox folder (one fixed POST, no input).
// Names other people chose render as plain text only (I-5). Styled from the Settings pages
// (design-1112 §3.1): same surfaces, tokens and type.
import { Button, InlineError, Skeleton, Surface } from '@4thtech-io/ui';
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { createApiClient, type ApiClient } from '../../api/client.js';
import { createHistoryApi } from '../history/api.js';
import { HISTORY_STRINGS as H } from '../history/strings.js';
import { FreeUpSpace } from './free-up-space.js';
import {
  parseStorage,
  unassignedIn,
  sizeWords,
  STORAGE_PATH,
  type IdUnavailable,
  type IdUse,
  type StorageView,
} from './data.js';
import { STORAGE_STRINGS as S } from './strings.js';
import './storage.css';

export interface StoragePageProps {
  /** The client (default: the production one); a test passes its own. */
  readonly api?: ApiClient;
  /** RET-4: the fetch and session token of the delete sheet and Show in Finder (tests). */
  readonly fetch?: typeof fetch;
  readonly token?: string;
}

/** macOS has Finder; Windows and Linux say "Show in folder" (11 §5.7). */
function onMac(): boolean {
  try {
    return /^Mac/i.test(navigator.platform);
  } catch {
    return false;
  }
}

type Load =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'ready'; readonly view: StorageView };

function Row(props: {
  readonly title: string;
  readonly detail?: string;
  readonly size: string;
}): ReactElement {
  return (
    <li className="sto-row">
      <span className="sto-row-text">
        <span className="sto-row-title">{props.title}</span>
        {props.detail === undefined ? null : (
          <span className="al-text-body-sm al-muted">{props.detail}</span>
        )}
      </span>
      <span className="sto-size">{props.size}</span>
    </li>
  );
}

function IdCard({ id }: { readonly id: IdUse | IdUnavailable }): ReactElement {
  const heading = (
    <div className="sto-id-head">
      <h2 className="al-text-h3">{id.label}</h2>
      {id.current ? <span className="sto-tag">{S.current}</span> : null}
    </div>
  );
  if ('unavailable' in id) {
    return (
      <Surface as="section" level={1} className="sto-card" aria-label={id.label}>
        {heading}
        <p className="al-text-body-sm al-muted">{S.idUnavailable}</p>
      </Surface>
    );
  }
  const total = id.storeBytes + id.walBytes;
  return (
    <Surface as="section" level={1} className="sto-card" aria-label={id.label}>
      {heading}
      <ul className="sto-list">
        <Row title={S.messages} size={sizeWords(id.messageBytes)} />
        <Row title={S.savedFiles} detail={S.files(id.fileCount)} size={sizeWords(id.fileBytes)} />
        <Row title={S.total} size={sizeWords(total)} />
        {id.drop === undefined ? null : (
          <Row
            title={S.exchange}
            size={S.exchangeLine(sizeWords(id.drop.usedBytes), sizeWords(id.drop.quotaBytes))}
          />
        )}
      </ul>
      {id.people === undefined ? (
        <p className="al-text-body-sm al-muted">{S.otherId}</p>
      ) : (
        <>
          <h3 className="al-text-body sto-sub">{S.peopleTitle}</h3>
          {id.people.length === 0 && id.other === undefined ? (
            <p className="al-text-body-sm al-muted">{S.peopleNone}</p>
          ) : (
            <ul className="sto-list" aria-label={S.peopleTitle}>
              {id.people.map((p, i) => (
                <Row
                  key={`${String(i)}-${p.name}`}
                  title={p.name}
                  detail={`${S.messages} ${sizeWords(p.messageBytes)} · ${S.files(p.fileCount)} ${sizeWords(p.fileBytes)}`}
                  size={sizeWords(p.messageBytes + p.fileBytes)}
                />
              ))}
              {id.other === undefined ? null : (
                <Row
                  title={S.other}
                  detail={`${S.messages} ${sizeWords(id.other.messageBytes)} · ${S.files(id.other.fileCount)} ${sizeWords(id.other.fileBytes)}`}
                  size={sizeWords(id.other.messageBytes + id.other.fileBytes)}
                />
              )}
            </ul>
          )}
          <p className="al-text-body-sm al-muted">{S.filesNote}</p>
        </>
      )}
    </Surface>
  );
}

export function StoragePage({
  api: givenApi,
  fetch: givenFetch,
  token,
}: StoragePageProps): ReactElement {
  const [api] = useState<ApiClient>(() => givenApi ?? createApiClient());
  const [history] = useState(() =>
    createHistoryApi({
      ...(givenFetch === undefined ? {} : { fetch: givenFetch }),
      ...(token === undefined ? {} : { token }),
    }),
  );
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [revealFailed, setRevealFailed] = useState(false);

  const read = useCallback((): void => {
    setLoad({ kind: 'loading' });
    void api.get(STORAGE_PATH).then(
      (result) => {
        const view = result.kind === 'ok' ? parseStorage(result.data) : undefined;
        setLoad(view === undefined ? { kind: 'failed' } : { kind: 'ready', view });
      },
      () => setLoad({ kind: 'failed' }),
    );
  }, [api]);
  useEffect(read, [read]);

  return (
    <div className="sto-page">
      <header className="sto-head">
        <h1 className="al-text-title-1">{S.title}</h1>
        <p className="al-text-body al-muted">{S.lead}</p>
      </header>

      <FreeUpSpace api={api} fetch={givenFetch} token={token} onApplied={read} />

      {load.kind === 'loading' ? (
        <div role="status" aria-label={S.loading}>
          <Skeleton loading lines={4} />
        </div>
      ) : load.kind === 'failed' ? (
        <div className="sto-failed" role="alert">
          <p className="al-text-body">{S.failed}</p>
          <Button variant="secondary" onClick={read}>
            {S.retry}
          </Button>
        </div>
      ) : (
        <>
          {load.view.ids.length === 0 ? <p className="al-muted">{S.noIds}</p> : null}
          {load.view.ids.map((id) => (
            <IdCard key={id.name} id={id} />
          ))}
          <Surface as="section" level={1} className="sto-card" aria-labelledby="sto-inbox">
            <h2 id="sto-inbox" className="al-text-h3">
              {S.inboxTitle}
            </h2>
            {load.view.inbox === undefined ? (
              <p className="al-text-body-sm al-muted">{S.inboxUnknown}</p>
            ) : (
              <>
                <p className="al-text-body-sm al-muted">{S.inboxLine(load.view.inbox.folder)}</p>
                <div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setRevealFailed(false);
                      void history.revealInbox().then((r) => setRevealFailed(r !== 'shown'));
                    }}
                  >
                    {onMac() ? H.showInFinder : H.showInFolder}
                  </Button>
                  {revealFailed ? <InlineError>{H.revealFailed}</InlineError> : null}
                </div>
                <ul className="sto-list">
                  <Row
                    title={S.unassigned}
                    detail={S.unassignedHelp}
                    size={S.unassignedLine(
                      unassignedIn(load.view)?.files ?? 0,
                      sizeWords(unassignedIn(load.view)?.bytes ?? 0),
                      load.view.inbox.truncated,
                    )}
                  />
                </ul>
              </>
            )}
          </Surface>
        </>
      )}
    </div>
  );
}
