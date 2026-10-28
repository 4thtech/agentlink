// M1-11b-2: one request (`/approve/<id>`), the deep link the terminal, notifications and the MCP
// open, now inside the app shell (D-118). The ID comes from the path and must be a well-formed
// approval ID before anything is asked of the server; the request itself is the server's (I-5).
// The card is the same as on Approvals: its own Approve and Deny, then presence; a request that
// costs credits approves through the confirmation sheet (04 §2.5.3).
// UI-REFRESH-o (visual only): the shared Skeleton while the request loads.
// UI-REFRESH-o-b: an applied decision counts the sidebar badge down; an approved card collapses out
// and leaves its result as a line of text.
import { Skeleton } from '@4thtech-io/ui';
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { announceDecided } from '../approvals/badge.js';
import { SingleApproval, Statuses, type SheetOptions } from '../approvals/card.js';
import {
  APPROVAL_ID,
  createApprovalsClient,
  type ApprovalItem,
  type ApprovalsClient,
} from '../approvals/client.js';
import {
  ApprovalsHead,
  OwnerPanel,
  Results,
  useOwner,
  type ApprovalsPageProps,
} from '../approvals/index.js';
import { APPROVAL_STRINGS as S } from '../approvals/strings.js';

const APPROVE_PATH = /^\/approve\/(apr_[A-Za-z0-9_-]{22})$/;

/** The approval ID of an `/approve/<id>` path, or undefined. */
export function approvalIdOf(pathname: string): string | undefined {
  const id = APPROVE_PATH.exec(pathname)?.[1];
  return id !== undefined && APPROVAL_ID.test(id) ? id : undefined;
}

type OneState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'gone' }
  | { readonly kind: 'offline' }
  | { readonly kind: 'ok'; readonly item: ApprovalItem };

function useOne(client: ApprovalsClient, id: string | undefined): OneState {
  const [state, setState] = useState<OneState>({ kind: 'loading' });
  useEffect(() => {
    if (id === undefined) {
      setState({ kind: 'gone' });
      return undefined;
    }
    let live = true;
    void client.one(id).then((answer) => {
      if (!live) return;
      setState(
        answer.kind === 'ok'
          ? { kind: 'ok', item: answer.item }
          : answer.kind === 'not_pending'
            ? { kind: 'gone' }
            : { kind: 'offline' },
      );
    });
    return () => {
      live = false;
    };
  }, [client, id]);
  return state;
}

export function ApprovePage({
  client: given,
  payConfirm,
  canPasskey: givenCanPasskey,
  platform,
  reducedMotion,
}: ApprovalsPageProps): ReactElement {
  const client = useMemo(() => given ?? createApprovalsClient(), [given]);
  const canPasskey =
    givenCanPasskey ??
    (typeof window !== 'undefined' &&
      'PublicKeyCredential' in window &&
      navigator.credentials !== undefined);
  const owner = useOwner(client, canPasskey);
  const id = approvalIdOf(typeof location === 'undefined' ? '' : location.pathname);
  const one = useOne(client, id);
  const [left, setLeft] = useState<string | undefined>(undefined);
  const sheet: SheetOptions = {
    ...(payConfirm === undefined ? {} : { payConfirm }),
    ...(platform === undefined ? {} : { platform }),
    ...(reducedMotion === undefined ? {} : { reducedMotion }),
  };
  return (
    <div className="al-approvals">
      <ApprovalsHead />
      {owner === undefined ? (
        <Skeleton loading label={S.loading} lines={4} />
      ) : (
        <>
          <OwnerPanel owner={owner} canPasskey={canPasskey} needsOwnerOnly />
          {one.kind === 'loading' ? <Skeleton loading label={S.loading} lines={4} /> : null}
          {one.kind === 'gone' ? <Statuses lines={[S.notPending]} /> : null}
          {one.kind === 'offline' ? <Statuses lines={[S.notRunning]} /> : null}
          {one.kind === 'ok' && left === undefined ? (
            <SingleApproval
              item={one.item}
              owner={owner}
              client={client}
              sheet={sheet}
              onDecided={() => announceDecided(1)}
              onLeft={setLeft}
            />
          ) : null}
          <Results lines={left === undefined ? [] : [left]} />
        </>
      )}
    </div>
  );
}
