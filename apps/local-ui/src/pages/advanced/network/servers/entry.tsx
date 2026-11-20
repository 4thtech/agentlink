// NET-UI-B (C1, C7b, C8; D-158): "Use your own servers", the entry of Advanced › Message network
// (Under the hood only: the page mounts it only while that switch is on; never Home). It reads the
// network state itself (the 0.5.15 additions of `GET /api/ui/network`), shows where the person is
// (automatic, or their own servers, paused, a change still finishing, offline, not running, needs
// setup), opens the add/test/review sheet or the reset sheet, and shows the progress of telling
// contacts. The page never signs; owner steps are the existing presence flow.
import { Banner, Button, Skeleton } from '@4thtech-io/ui';
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { notify } from '../../../../notices/index.js';
import { createOwnerClient, type OwnerClient } from '../../../contacts/owner.js';
import { usePresenceMode } from '../../../contacts/presence-button.js';
import { NETWORK_CHANGED } from '../data.js';
import { createServersApi, type NetworkStatus, type Progress, type ServersApi } from './api.js';
import { AnnounceSwitch } from './announce.js';
import { ServersFlow } from './flow.js';
import { dayText } from './messages.js';
import { ProgressCard } from './progress.js';
import { ResetFlow } from './reset.js';
import { SERVERS_STRINGS as S } from './strings.js';

export interface ServersEntryProps {
  readonly api?: ServersApi;
  readonly owner?: OwnerClient;
  /** Unix seconds (default: the clock). */
  readonly now?: () => number;
  /** Whether this computer is online (default: the browser's own flag). */
  readonly online?: () => boolean;
}

type Read =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly offline: boolean }
  | { readonly kind: 'ok'; readonly status: NetworkStatus };

const defaultApi = createServersApi();
const defaultOwner = createOwnerClient();
const defaultNow = (): number => Math.floor(Date.now() / 1000);
const defaultOnline = (): boolean => typeof navigator === 'undefined' || navigator.onLine;

export function ServersEntry({
  api = defaultApi,
  owner = defaultOwner,
  now = defaultNow,
  online = defaultOnline,
}: ServersEntryProps): ReactElement {
  const [read, setRead] = useState<Read>({ kind: 'loading' });
  const [progress, setProgress] = useState<Progress | undefined>(undefined);
  const [flow, setFlow] = useState<'own' | 'reset' | undefined>(undefined);
  const live = useRef(true);

  const refresh = useCallback(async (): Promise<void> => {
    const [status, prog] = await Promise.all([api.status(), api.progress()]);
    if (!live.current) return;
    if (status.kind === 'ok') setRead({ kind: 'ok', status: status.value });
    else {
      setRead((cur) =>
        cur.kind === 'ok' ? cur : { kind: 'failed', offline: status.kind === 'offline' },
      );
    }
    if (prog.kind === 'ok') setProgress(prog.value);
  }, [api]);

  useEffect(() => {
    live.current = true;
    void refresh();
    // The stream's `network` event (also fired when the progress changes): read again.
    const onEvent = (): void => void refresh();
    window.addEventListener(NETWORK_CHANGED, onEvent);
    return () => {
      live.current = false;
      window.removeEventListener(NETWORK_CHANGED, onEvent);
    };
  }, [refresh]);

  const finished = (message: string) => (): void => {
    setFlow(undefined);
    notify({ text: message });
    void refresh();
  };

  if (read.kind === 'loading') {
    return (
      <div className="nw-card" data-servers-entry="loading" aria-busy="true">
        <Skeleton loading lines={2}>
          {null}
        </Skeleton>
      </div>
    );
  }
  if (read.kind === 'failed') {
    return (
      <p className="al-text-body al-muted" data-servers-entry="failed">
        {read.offline ? S.offline : S.noAnswer}
      </p>
    );
  }
  const { status } = read;
  const clock = now();
  const offline = !online();
  const custom = status.mode === 'custom';
  const away = status.agent === 'not_running' || status.agent === 'needs_setup';
  const paused = status.agent === 'paused' || status.change === 'paused';
  const finishing = status.change === 'rotation_pending';
  const off = away || paused || finishing || offline;
  const recent =
    progress !== undefined && status.previousUntil !== null && status.previousUntil > clock;
  const showProgress =
    progress !== undefined && (progress.waiting > 0 || (progress.leavingUntil ?? 0) > clock);
  return (
    <div className="nw" data-servers-entry={status.agent}>
      {paused ? <PausedBanner owner={owner} /> : null}
      {finishing ? <Banner tone="info">{S.finishing}</Banner> : null}
      {recent && !paused && !finishing && status.previousUntil !== null ? (
        <Banner tone="info" title={S.recentTitle(dayText(progress.changedAt))}>
          {S.recent(dayText(status.previousUntil))}
        </Banner>
      ) : null}
      {showProgress ? <ProgressCard progress={progress} ownCount={status.ownCount} /> : null}
      <section className="nw-card" aria-label={S.entryTitle}>
        {custom ? (
          <h3 className="al-text-title-3">{S.customNow}</h3>
        ) : (
          <>
            <h3 className="al-text-title-3">{S.entryTitle}</h3>
            <p className="al-text-body al-muted">{S.entryBody}</p>
            <p className="al-text-body-sm">{S.automaticNow(status.ownCount)}</p>
          </>
        )}
        {away ? (
          <p className="al-text-body-sm al-muted">
            {status.agent === 'needs_setup' ? S.needsSetup : S.notRunning}
          </p>
        ) : offline ? (
          <p className="al-text-body-sm al-muted">{S.offline}</p>
        ) : null}
        <div className="nw-head">
          <Button disabled={off} onClick={() => setFlow('own')}>
            {custom ? S.changeServers : S.useOwn}
          </Button>
          {custom ? (
            <Button disabled={off} onClick={() => setFlow('reset')}>
              {S.useAutomatic}
            </Button>
          ) : null}
        </div>
        {custom && !off ? <p className="al-text-body-sm al-muted">{S.anyTime}</p> : null}
        {/* NET-ANNOUNCE-OPTOUT: the opt-out on its own, only with the mix-in off (D-158 (7)). */}
        {status.optOutOffered ? (
          <AnnounceSwitch
            api={api}
            owner={owner}
            announceDefault={status.announceDefault}
            disabled={off}
            onDone={(announceDefault) => {
              notify({ text: announceDefault ? S.announceOnToast : S.announceOffToast });
              void refresh();
            }}
          />
        ) : null}
      </section>
      {flow === 'own' ? (
        <ServersFlow
          open
          api={api}
          owner={owner}
          optedOut={!status.announceDefault}
          onClose={() => setFlow(undefined)}
          onDone={finished(S.toast)}
        />
      ) : null}
      {flow === 'reset' ? (
        <ResetFlow
          open
          api={api}
          owner={owner}
          onClose={() => setFlow(undefined)}
          onDone={finished(S.resetToast)}
        />
      ) : null}
    </div>
  );
}

/** C7b: the ID is paused; the sensor's own name comes from the existing presence reading. */
function PausedBanner({ owner }: { readonly owner: OwnerClient }): ReactElement {
  const { sensor } = usePresenceMode({ readPasskey: () => owner.passkey() });
  return (
    <Banner tone="info" title={S.pausedTitle}>
      {S.paused(sensor)}
    </Banner>
  );
}
