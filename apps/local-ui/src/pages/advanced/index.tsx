// Advanced › Relays & network (W4-SETTINGS-ADVANCED; prototype v23 "Relays & network"). How many
// relays are connected, when the last update happened and that the network is picked automatically.
// Counts only, from the health read; never an address, and no response time until one is measured
// (a made-up number would be worse than none). Skeleton on the first load.
import { Skeleton } from '@4thtech-io/ui';
import { useEffect, useState, type ReactElement } from 'react';
import type { ApiResult } from '../../api/client.js';
import { readHealth } from '../../layout/health.js';
import { parseRelays, type Relays } from './relays.js';
import { ADVANCED_STRINGS as S } from './strings.js';
import './advanced.css';

export { parseRelays } from './relays.js';
export type { Relays } from './relays.js';

export interface AdvancedPageProps {
  /** The health read (default: the production read); a test passes its own. */
  readonly read?: () => Promise<ApiResult<unknown>>;
}

type State = { readonly loading: true } | { readonly loading: false; readonly relays?: Relays };

const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });

export function AdvancedPage({ read = readHealth }: AdvancedPageProps): ReactElement {
  const [state, setState] = useState<State>({ loading: true });
  useEffect(() => {
    let live = true;
    read().then(
      (r) => {
        if (!live) return;
        const relays = parseRelays(r);
        setState(relays === undefined ? { loading: false } : { loading: false, relays });
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
  const answered = !state.loading && relays !== undefined;
  return (
    <div className="ad-page">
      <header className="ad-head">
        <span className="al-text-label ad-eyebrow">Advanced</span>
        <h1 className="al-text-title-1">{S.title}</h1>
        <p className="al-text-body al-muted">{S.intro}</p>
      </header>
      <Skeleton loading={state.loading} lines={3}>
        {answered ? (
          <dl className="ad-list">
            <div className="ad-row">
              <dt>{S.relays}</dt>
              <dd>
                {relays.connected === undefined || relays.total === undefined
                  ? S.noRelays
                  : S.relayCount(relays.connected, relays.total)}
              </dd>
            </div>
            <div className="ad-row">
              <dt>{S.network}</dt>
              <dd>{S.networkAuto}</dd>
            </div>
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
          </dl>
        ) : (
          <p className="al-text-body al-muted">{S.unknown}</p>
        )}
      </Skeleton>
    </div>
  );
}
