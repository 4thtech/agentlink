// REL051-RET1: Settings > Storage (retention plan RET-1; 08 §1). A read-only view of how much room
// each ID and each person takes, and of the Inbox folder. One GET, no delete call, nothing signed.
// Names other people chose render as plain text only (I-5). Styled from the Settings pages
// (design-1112 §3.1): same surfaces, tokens and type.
import { Button, Skeleton, Surface } from '@4thtech-io/ui';
import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { createApiClient, type ApiClient } from '../../api/client.js';
import { SettingsIcon } from '../settings/icons.js';
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

export function StoragePage({ api: givenApi }: StoragePageProps): ReactElement {
  const [api] = useState<ApiClient>(() => givenApi ?? createApiClient());
  const [load, setLoad] = useState<Load>({ kind: 'loading' });

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

      <Surface as="section" level={1} className="sto-coming" aria-labelledby="sto-coming">
        <span className="sto-ic" aria-hidden="true">
          <SettingsIcon name="folder" />
        </span>
        <div className="sto-coming-text">
          <h2 id="sto-coming" className="al-text-h3">
            {S.comingTitle}
          </h2>
          <p className="al-text-body-sm al-muted">{S.coming}</p>
        </div>
      </Surface>

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
      ) : // UX-LEFT-1 (STORAGE-NOID): an owner with no ID has nothing stored; a calm line, no Inbox read.
      load.view.ids.length === 0 ? (
        <p className="al-muted">{S.noIds}</p>
      ) : (
        <>
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
