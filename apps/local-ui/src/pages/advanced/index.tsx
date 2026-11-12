// Advanced › Relays & network (W4-SETTINGS-ADVANCED; prototype v23 "Relays & network"). How many
// relays are connected, when the last update happened and that the network is picked automatically.
// Counts only, from the health read; never an address, and no response time until one is measured
// (a made-up number would be worse than none). Skeleton on the first load.
import { Skeleton, useHood } from '@4thtech-io/ui';
import { useEffect, useState, type ReactElement } from 'react';
import type { ApiResult } from '../../api/client.js';
import { parseHealth, readHealth } from '../../layout/health.js';
import { parseRelays, type Relays } from './relays.js';
import { ADVANCED_STRINGS as S } from './strings.js';
import './advanced.css';

export { parseRelays } from './relays.js';
export type { Relays } from './relays.js';

export interface AdvancedPageProps {
  /** The health read (default: the production read); a test passes its own. */
  readonly read?: () => Promise<ApiResult<unknown>>;
}

type State =
  | { readonly loading: true }
  | {
      readonly loading: false;
      readonly relays?: Relays;
      readonly working?: boolean;
      readonly checking?: boolean;
    };

const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });

export function AdvancedPage({ read = readHealth }: AdvancedPageProps): ReactElement {
  const hood = useHood();
  const [state, setState] = useState<State>({ loading: true });
  useEffect(() => {
    let live = true;
    read().then(
      (r) => {
        if (!live) return;
        const relays = parseRelays(r);
        // The same read as Settings home's "All working": a running answer is never contradicted.
        const state = parseHealth(r)?.state;
        const working = state === 'connected';
        // REL051-CF2: the first relay check from this computer has not finished yet.
        const checking = state === 'checking';
        setState(
          relays === undefined ? { loading: false } : { loading: false, relays, working, checking },
        );
      },
      () => {
        if (live) setState({ loading: false });
      },
    );
    return () => {
      live = false;
    };
  }, [read]);

  const relays = state.loading ? undefined : state.relays;
  const sync = relays?.lastSyncAt;
  const working = !state.loading && state.working === true;
  const checking = !state.loading && state.checking === true;
  const answered = !state.loading && relays !== undefined;
  // REL051-CF2: counts known and none connected: say so in words, never "Working".
  const unreachable = relays?.connected === 0 && relays.total !== undefined && relays.total > 0;
  return (
    <div className="ad-page">
      <header className="ad-head">
        <span className="al-text-label ad-eyebrow">Advanced</span>
        <h1 className="al-text-title-1">{S.title}</h1>
        <p className="al-text-body al-muted">{S.intro}</p>
      </header>
      <Skeleton loading={state.loading} lines={3}>
        {unreachable ? (
          <p className="al-text-body ad-unreachable" role="status">
            {S.unreachable}
          </p>
        ) : null}
        {answered ? (
          <dl className="ad-list">
            <div className="ad-row">
              <dt>{S.relays}</dt>
              <dd>
                {relays.connected === undefined || relays.total === undefined
                  ? working
                    ? S.relaysWorking
                    : checking
                      ? S.checking
                      : S.noRelays
                  : S.relayCount(relays.connected, relays.total)}
              </dd>
            </div>
            <div className="ad-row">
              <dt>{S.network}</dt>
              <dd>{S.networkAuto}</dd>
            </div>
            {sync === undefined && working ? null : (
              <div className="ad-row">
                <dt>{S.lastSync}</dt>
                <dd>
                  {sync === undefined ? (
                    S.never
                  ) : (
                    <time dateTime={new Date(sync * 1000).toISOString()}>
                      {WHEN.format(new Date(sync * 1000))}
                    </time>
                  )}
                </dd>
              </div>
            )}
            {hood ? (
              <>
                <div className="ad-row" data-hood-fact="relays-connected">
                  <dt>{S.hoodRelays}</dt>
                  <dd>{relays.connected === undefined ? S.never : String(relays.connected)}</dd>
                </div>
                <div className="ad-row" data-hood-fact="relays-known">
                  <dt>{S.hoodRelaysKnown}</dt>
                  <dd>{relays.total === undefined ? S.never : String(relays.total)}</dd>
                </div>
                <div className="ad-row" data-hood-fact="last-update-time">
                  <dt>{S.hoodLastUpdateAt}</dt>
                  <dd className="al-text-code">
                    {sync === undefined ? S.never : new Date(sync * 1000).toISOString()}
                  </dd>
                </div>
              </>
            ) : null}
          </dl>
        ) : (
          <p className="al-text-body al-muted">{S.unknown}</p>
        )}
      </Skeleton>
    </div>
  );
}
