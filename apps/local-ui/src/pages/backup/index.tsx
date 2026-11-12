// Settings › Backup & restore (design-1112 §6.2 to §6.4; WP-R4; D-147). One recovery kit covers every
// ID. The status card is read from the server's kit record (GET /api/ui/backup), so it is true in
// every browser; where the record is unreadable the page says so in plain words and never invents a
// state. The kit is saved right here, behind Touch ID or the master code (export-kit.tsx). Restore is
// the wizard of WP-R3 (/restore/*); these rows only link to it.
import { Icon, Surface } from '@4thtech-io/ui';
import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { createApiClient, type ApiClient } from '../../api/client.js';
import { setKitRecordState } from '../../states/index.js';
import { ExportKit, type ExportKitProps } from './export-kit.js';
import { BACKUP_REVEAL_PATH } from './save-checklist.js';
import { UNKNOWN_STATUS, dayOf, parseKitStatus, type KitStatus } from './status.js';
import { BACKUP_STRINGS as S } from './strings.js';
import './backup.css';

export const RESTORE_PATH = '/restore/kit';
export const RESTORE_CHECK_PATH = '/restore/check';
export const RESTORE_MOVE_PATH = '/restore/move';

export type BackupPageProps = Pick<ExportKitProps, 'api' | 'passkey' | 'checkPath' | 'openWindow'>;

function useKitStatus(api: ApiClient): { status: KitStatus | undefined; reload: () => void } {
  const [status, setStatus] = useState<KitStatus | undefined>(undefined);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    void api.get(BACKUP_READ).then(
      (r) => {
        if (!live) return;
        const next = r.kind === 'ok' ? parseKitStatus(r.data) : UNKNOWN_STATUS;
        setStatus(next);
        setKitRecordState(next.state === 'unknown' ? undefined : next.state);
      },
      () => live && setStatus(UNKNOWN_STATUS),
    );
    return () => {
      live = false;
    };
  }, [api, tick]);
  return { status, reload: useCallback(() => setTick((t) => t + 1), []) };
}
const BACKUP_READ = '/api/ui/backup';

const Names = ({ list }: { list: readonly string[] }): ReactElement => (
  <>
    {list.map((n, i) => (
      <span key={`${n}-${i}`}>
        {i === 0 ? '' : i === list.length - 1 ? ' and ' : ', '}
        <bdi>
          <strong>{n}</strong>
        </bdi>
      </span>
    ))}
  </>
);

function StatusText({ status }: { status: KitStatus }): ReactElement {
  const date = status.at === undefined ? '' : dayOf(status.at);
  switch (status.state) {
    case 'backed_up':
      return (
        <>
          <h2 className="al-text-h3">{S.upToDateTitle}</h2>
          <p className="al-text-body">
            {`Saved ${date}.`}
            {status.covers.length > 0 ? (
              <>
                {' Covers '}
                <Names list={status.covers} />.
              </>
            ) : null}
          </p>
        </>
      );
    case 'out_of_date': {
      return (
        <>
          <h2 className="al-text-h3">{S.staleTitle}</h2>
          <p className="al-text-body">
            {`Saved ${date}.`}
            {status.covers.length > 0 ? (
              <>
                {' It covers '}
                <Names list={status.covers} />.
              </>
            ) : null}
            {status.missingIds.length > 0 || status.missingPeople > 0 ? (
              <>
                {' Not in it yet: '}
                {status.missingIds.length > 0 ? <Names list={status.missingIds} /> : null}
                {status.missingIds.length > 0 && status.missingPeople > 0 ? ' and ' : ''}
                {status.missingPeople > 0 ? S.peopleJoined(status.missingPeople) : ''}.
              </>
            ) : null}
          </p>
        </>
      );
    }
    case 'none':
      return (
        <>
          <h2 className="al-text-h3">{S.noneTitle}</h2>
          <p className="al-text-body">{S.noneLine}</p>
        </>
      );
    default:
      return (
        <>
          <h2 className="al-text-h3">{S.unknownTitle}</h2>
          <p className="al-text-body">{S.unknownLine}</p>
        </>
      );
  }
}

function Row(props: {
  readonly icon: 'download' | 'hard-drive';
  readonly title: string;
  readonly body: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className="bk-row">
      <span className="bk-row-ic" aria-hidden="true">
        <Icon name={props.icon} size={20} />
      </span>
      <div className="bk-row-text">
        <h3 className="al-text-label">{props.title}</h3>
        <p className="al-text-body-sm al-muted">{props.body}</p>
      </div>
      {props.children}
    </div>
  );
}

/**
 * Where the desktop app's native Touch ID switch (NativeSettings) is mounted at desktop integration.
 * Empty in the browser. Do not render anything here from this page.
 */
export function NativeSettingsSlot(): ReactElement {
  return (
    <div className="bk-native-slot" data-native-slot="touch-id" aria-label={S.touchSlotLabel} />
  );
}

export function BackupPage({ api: given, ...rest }: BackupPageProps): ReactElement {
  const [api] = useState<ApiClient>(() => given ?? createApiClient());
  const { status, reload } = useKitStatus(api);
  const [shown, setShown] = useState<string | undefined>(undefined);
  const state = status?.state ?? 'unknown';
  const hasKit = state === 'backed_up' || state === 'out_of_date';
  const tone = state === 'backed_up' ? 'good' : 'warn';

  const reveal = (): void => {
    setShown(undefined);
    void api.post(BACKUP_REVEAL_PATH).then(
      (r) => {
        if (r.kind !== 'ok') setShown(S.showFailed);
      },
      () => setShown(S.showFailed),
    );
  };

  return (
    <div className="bk-page">
      <header className="bk-head">
        <h1 className="al-text-title-1">{S.title}</h1>
        <p className="al-text-body al-muted">{S.lead}</p>
      </header>

      <Surface as="section" level={1} className="bk-card" aria-labelledby="bk-status">
        <div
          className={`bk-status is-${tone}`}
          data-kit-state={status === undefined ? 'loading' : state}
        >
          <span className="bk-status-ic" aria-hidden="true">
            <Icon name={state === 'backed_up' ? 'check' : 'info'} size={28} />
          </span>
          <div className="bk-status-text" id="bk-status" aria-live="polite">
            {status === undefined ? (
              <p className="al-text-body al-muted">{S.loading}</p>
            ) : (
              <StatusText status={status} />
            )}
          </div>
          {status === undefined ? null : (
            <ExportKit
              {...rest}
              api={api}
              known={status.export === 'unknown' ? undefined : status.export}
              hasKit={hasKit}
              onDone={reload}
            />
          )}
        </div>
        <ol className="bk-cols">
          <li className="bk-col">
            <h3 className="al-text-label">
              <span className="bk-num">1</span> {S.colFileTitle}
            </h3>
            <p className="al-text-body-sm">{S.colFileBody}</p>
            {hasKit ? (
              <button type="button" className="al-link bk-link" onClick={reveal}>
                {S.showInFinder}
              </button>
            ) : null}
            {shown === undefined ? null : (
              <p className="al-text-body-sm bk-error" role="alert">
                {shown}
              </p>
            )}
          </li>
          <li className="bk-col">
            <h3 className="al-text-label">
              <span className="bk-num">2</span> {S.colCodeTitle}
            </h3>
            <p className="al-text-body-sm">{S.colCodeBody}</p>
            <p className="al-text-body-sm">
              <strong>{S.neverToAi}</strong>
            </p>
          </li>
          <li className="bk-col">
            <h3 className="al-text-label">
              <span className="bk-num">3</span> {S.colBackTitle}
            </h3>
            <p className="al-text-body-sm">{S.colBackBody}</p>
            <a className="al-link bk-link" href={RESTORE_CHECK_PATH}>
              {S.checkLink}
            </a>
          </li>
        </ol>
      </Surface>

      <div className="bk-lists">
        <Surface as="section" level={1} className="bk-card bk-list" aria-labelledby="bk-back">
          <h2 id="bk-back" className="al-text-label">
            {S.comesBackTitle}
          </h2>
          <ul>
            {S.comesBack.map((t) => (
              <li key={t}>
                <Icon name="check" size={16} className="bk-yes" /> <span>{t}</span>
              </li>
            ))}
          </ul>
        </Surface>
        <Surface as="section" level={1} className="bk-card bk-list" aria-labelledby="bk-again">
          <h2 id="bk-again" className="al-text-label">
            {S.againTitle}
          </h2>
          <ul>
            {S.again.map((t) => (
              <li key={t}>
                <Icon name="arrow-right" size={16} className="bk-next" /> <span>{t}</span>
              </li>
            ))}
          </ul>
        </Surface>
      </div>

      <Surface as="section" level={1} className="bk-card bk-rows" aria-label={S.restoreTitle}>
        <Row icon="download" title={S.restoreTitle} body={S.restoreBody}>
          <a className="al-btn al-btn-secondary al-btn-md" href={RESTORE_PATH}>
            {S.restoreAction}
          </a>
        </Row>
        <Row icon="hard-drive" title={S.moveTitle} body={S.moveBody}>
          <a className="al-link bk-link" href={RESTORE_MOVE_PATH}>
            {S.moveAction}
          </a>
        </Row>
      </Surface>

      <p className="al-text-body-sm al-muted">{S.footnote}</p>
      <NativeSettingsSlot />
    </div>
  );
}
