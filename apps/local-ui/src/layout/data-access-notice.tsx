// WIN-ACL-NOTICE: the Windows desktop app could not check who can open the data folder. Its shell
// tells the core (a fixed flag), the health read carries `dataAccess: 'unchecked'`, and this shows a
// non-blocking page notice (docs/design/notices.md; PageNotice, tone warning), closable and
// remembered in this browser. The app keeps working. Fixed words only (11 §5): no path, no account
// name, nothing from the answer except the one word.
import { PageNotice } from '@4thtech-io/ui';
import { useEffect, useState, type ReactElement } from 'react';
import type { ApiResult } from '../api/client.js';
import { useDismissed } from '../notices/index.js';
import { subscribeHealth } from './health-feed.js';
import { readHealth as defaultReadHealth } from './health.js';

export const DATA_ACCESS_NOTICE_KEY = 'data-access-unchecked';

export const DATA_ACCESS_STRINGS = Object.freeze({
  title: "AgentLink couldn't check who can open your folder",
  body: "Windows didn't answer when AgentLink looked at who can open the folder where it keeps your IDs and messages (.agentlink in your user folder). AgentLink works as usual. To check it yourself, right-click that folder, choose Properties, then Security, and make sure only you, SYSTEM and Administrators are listed.",
  dismiss: 'Dismiss',
});

/** True only for a health answer that carries exactly `dataAccess: 'unchecked'`. */
export function dataAccessUnchecked(result: ApiResult<unknown>): boolean {
  if (result.kind !== 'ok') return false;
  const data = result.data;
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { dataAccess?: unknown }).dataAccess === 'unchecked'
  );
}

/** Follows the shared health poller (one read per tick for the whole app). */
export function useDataAccessUnchecked(
  read: () => Promise<ApiResult<unknown>> = defaultReadHealth,
): boolean {
  const [unchecked, setUnchecked] = useState(false);
  useEffect(
    () =>
      subscribeHealth(read, { onResult: (result) => setUnchecked(dataAccessUnchecked(result)) }),
    [read],
  );
  return unchecked;
}

/** The notice, or nothing. */
export function DataAccessNotice({
  read,
}: {
  readonly read?: () => Promise<ApiResult<unknown>>;
}): ReactElement | null {
  const unchecked = useDataAccessUnchecked(read);
  const [dismissed, dismiss] = useDismissed(DATA_ACCESS_NOTICE_KEY);
  if (!unchecked || dismissed) return null;
  return (
    <PageNotice
      tone="warning"
      title={DATA_ACCESS_STRINGS.title}
      onDismiss={dismiss}
      dismissLabel={DATA_ACCESS_STRINGS.dismiss}
    >
      <p>{DATA_ACCESS_STRINGS.body}</p>
    </PageNotice>
  );
}
