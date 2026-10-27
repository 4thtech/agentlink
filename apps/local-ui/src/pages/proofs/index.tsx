// Proofs and credits (M1-11c-a4; d1 Local-proofs with DESIGN-ADJ-1 PR-1, X-4, X-6; 11 §5, §6.2).
//
// The proof list (newest first, paged) beside the credits card. Credits lead with proofs left; the
// dollar balance is small. The default view names no network, token or address, and the Agent ID is
// not on this page (PR-1: it lives in Advanced). M1-11c-a4c: where the agent can be paid (the Gnosis
// test network now, D-123), "Add credits" opens the address, its QR code and the privacy note, and
// "Withdraw credits" returns credits to the agent's own account; both changes are owner operations
// behind a confirm screen and the owner code (top-up.tsx). Elsewhere the not-available line stays.
// On load the page only reads.
import { Button, EmptyState, Icon, PAY_CONFIRM_STRINGS, ProofBadge } from '@4thtech-io/ui';
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { createApiClient, type ApiClient, type ApiResult } from '../../api/client.js';
import { AddCreditsPanel, ConfirmMove, type Move } from './top-up.js';
import { PAGE_TITLES } from '../../strings.js';
import {
  CREDITS_PATH,
  TOP_UP_PATH,
  addressNetwork,
  isPositive,
  listPath,
  parseCredits,
  parseList,
  parseTopUp,
  type CreditsAnswer,
  type ProofRow,
  type TopUpAnswer,
} from './data.js';
import { NETWORK_NAMES, PROOFS_STRINGS as S, inCredits, priceLine, proofsLeft } from './strings.js';
import './proofs.css';

type ListState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'error' }
  | { readonly phase: 'not_set_up' }
  | {
      readonly phase: 'ok';
      readonly items: readonly ProofRow[];
      readonly next?: string;
      readonly more: 'idle' | 'loading' | 'error';
    };

type CreditsState = { readonly kind: 'loading' } | CreditsAnswer;

const TIME = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

function When({ seconds }: { seconds: number }): ReactElement {
  const date = new Date(seconds * 1000);
  return (
    <time className="al-text-code" dateTime={date.toISOString()}>
      {TIME.format(date)}
    </time>
  );
}

function ProofTable({ items }: { items: readonly ProofRow[] }): ReactElement {
  return (
    <div className="pf-table-wrap">
      <table className="pf-table">
        <caption className="al-sr-only">{S.listCaption}</caption>
        <thead>
          <tr className="al-text-label">
            <th scope="col">{S.colProof}</th>
            <th scope="col">{S.colWhen}</th>
            <th scope="col">{S.colStatus}</th>
          </tr>
        </thead>
        <tbody className="al-text-body">
          {items.map((item, i) => (
            <tr key={`${String(item.createdAt)}-${String(i)}`}>
              <td>
                <span className="pf-dir">
                  <Icon name={item.direction === 'sent' ? 'arrow-right' : 'inbox'} size={16} />
                  {item.direction === 'sent' ? S.sent : S.received}
                </span>
              </td>
              <td>
                <When seconds={item.createdAt} />
              </td>
              <td>
                <ProofBadge state={item.state} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CreditsCard({
  credits,
  actions,
}: {
  credits: CreditsState;
  /** Add credits and Withdraw credits, when the agent can be paid (M1-11c-a4c). */
  actions?: ReactElement | undefined;
}): ReactElement {
  if (credits.kind === 'loading') {
    return (
      <section className="al-credits" aria-label={S.creditsLabel} aria-busy="true">
        <div className="al-text-label al-muted">{S.creditsLabel}</div>
        <p className="al-text-body-sm al-muted">{S.loading}</p>
      </section>
    );
  }
  if (credits.kind !== 'ok') {
    return (
      <section className="al-credits" aria-label={S.creditsLabel}>
        <div className="al-text-label al-muted">{S.creditsLabel}</div>
        <p className="al-text-body-sm al-muted">{S.creditsUnavailable}</p>
      </section>
    );
  }
  return (
    <section
      className={credits.proofsLeft === 0 ? 'al-credits is-empty' : 'al-credits'}
      aria-label={S.creditsLabel}
    >
      <div className="al-credits-top">
        <div>
          <div className="al-text-label al-muted">
            {credits.test ? S.testCreditsLabel : S.creditsLabel}
          </div>
          <div className="al-credits-bal al-text-title-1">{proofsLeft(credits.proofsLeft)}</div>
        </div>
        <div className="al-text-body-sm al-muted">{inCredits(credits.balance)}</div>
      </div>
      {credits.partial ? <p className="al-text-caption al-muted">{S.creditsPartial}</p> : null}
      {credits.test ? <p className="al-text-caption al-muted">{S.testCredits}</p> : null}
      {/* M1-PAY-CONFIRM-b (b11 §19.4; D-132): under the credits, small. */}
      <p className="al-text-caption al-muted">{PAY_CONFIRM_STRINGS.trustCredits}</p>
      {credits.test && credits.proofsLeft === 0 ? (
        <p className="al-text-caption al-muted">{S.firstProofFree}</p>
      ) : null}
      {/* X-6 until a network takes funds at the agent's address (M1-11c-a4c, D-123). */}
      {actions ?? <p className="al-text-caption al-muted">{S.addCreditsNotAvailable}</p>}
      {/* No free test credits button: the agent claims them once by itself (D-120 (3), M1-36i). */}
    </section>
  );
}

/** 409 is the shared not-set-up answer (route-types.ts); anything else that isn't 200 is an error. */
const isNotSetUp = (res: ApiResult<unknown>): boolean => res.kind === 'error' && res.status === 409;
const problem = (res: ApiResult<unknown>): { kind: 'not_set_up' } | { kind: 'error' } =>
  isNotSetUp(res) ? { kind: 'not_set_up' } : { kind: 'error' };

export interface ProofsPageProps {
  /** For tests; the page's own same-origin client by default. */
  readonly api?: ApiClient;
}

export function ProofsPage({ api: given }: ProofsPageProps = {}): ReactElement {
  const api = useMemo(() => given ?? createApiClient(), [given]);
  const [list, setList] = useState<ListState>({ phase: 'loading' });
  const [credits, setCredits] = useState<CreditsState>({ kind: 'loading' });
  const [topUp, setTopUp] = useState<TopUpAnswer>({ kind: 'unavailable' });
  const [panel, setPanel] = useState<'none' | 'add'>('none');
  const [move, setMove] = useState<Move | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  // IR-M1-11c-a4c-1 L-1 (owner, 11 §14 Q7): Withdraw credits lives under Advanced.
  const [advanced, setAdvanced] = useState(false);

  const readMoney = useCallback(() => {
    void api.get(CREDITS_PATH).then((res) => {
      setCredits(
        res.kind === 'ok'
          ? parseCredits(res.data)
          : isNotSetUp(res)
            ? { kind: 'not_set_up' }
            : { kind: 'unavailable' },
      );
    });
    void api.get(TOP_UP_PATH).then((res) => {
      setTopUp(res.kind === 'ok' ? parseTopUp(res.data) : { kind: 'unavailable' });
    });
  }, [api]);

  useEffect(() => {
    let live = true;
    void api.get(listPath()).then((res) => {
      if (!live) return;
      const answer = res.kind === 'ok' ? parseList(res.data) : problem(res);
      if (answer.kind === 'ok') {
        setList({
          phase: 'ok',
          items: answer.items,
          more: 'idle',
          ...(answer.next === undefined ? {} : { next: answer.next }),
        });
      } else {
        setList({ phase: answer.kind });
      }
    });
    void api.get(CREDITS_PATH).then((res) => {
      if (!live) return;
      setCredits(
        res.kind === 'ok'
          ? parseCredits(res.data)
          : isNotSetUp(res)
            ? { kind: 'not_set_up' }
            : { kind: 'unavailable' },
      );
    });
    void api.get(TOP_UP_PATH).then((res) => {
      if (!live) return;
      setTopUp(res.kind === 'ok' ? parseTopUp(res.data) : { kind: 'unavailable' });
    });
    return () => {
      live = false;
    };
  }, [api]);

  const loadMore = useCallback(() => {
    if (list.phase !== 'ok' || list.next === undefined || list.more === 'loading') return;
    const { items, next } = list;
    setList({ ...list, more: 'loading' });
    void api.get(listPath(next)).then((res) => {
      const answer = res.kind === 'ok' ? parseList(res.data) : ({ kind: 'error' } as const);
      setList(
        answer.kind === 'ok'
          ? {
              phase: 'ok',
              items: [...items, ...answer.items],
              more: 'idle',
              ...(answer.next === undefined ? {} : { next: answer.next }),
            }
          : { phase: 'ok', items, next, more: 'error' },
      );
    });
  }, [api, list]);

  const title = <h1 className="al-text-title-1">{PAGE_TITLES.proofs}</h1>;

  // M1-11c-a4c: the network where funds sent to the agent's address become credits, if any.
  const net = addressNetwork(topUp);
  const soon =
    topUp.kind === 'ok'
      ? topUp.networks
          .filter((n) => n.method === 'coming_soon')
          .map((n) => NETWORK_NAMES[n.network])
      : [];
  const withdrawable = net?.available === true && isPositive(net.credits.amount) ? net : undefined;
  const actions =
    net === undefined ? undefined : (
      <div className="pf-actions">
        {panel === 'add' ? null : (
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setNotice(undefined);
              setMove(undefined);
              setPanel('add');
            }}
          >
            {S.addCredits}
          </Button>
        )}
        {withdrawable === undefined ? null : (
          <div className="pf-advanced">
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={advanced}
              aria-controls="pf-advanced-actions"
              onClick={() => setAdvanced(!advanced)}
            >
              {S.advanced}
            </Button>
            {advanced ? (
              <div id="pf-advanced-actions" className="pf-actions">
                <Button
                  size="sm"
                  onClick={() => {
                    setNotice(undefined);
                    setPanel('none');
                    setMove({ kind: 'withdraw', money: withdrawable.credits, net: withdrawable });
                  }}
                >
                  {S.withdraw}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </div>
    );

  if (list.phase === 'not_set_up' || credits.kind === 'not_set_up') {
    return (
      <>
        {title}
        <EmptyState icon="info" title={S.notSetUp} />
      </>
    );
  }

  return (
    <>
      {title}
      <div className="pf-layout">
        <div className="pf-list">
          {list.phase === 'loading' ? (
            <p className="al-text-body al-muted" aria-busy="true">
              {S.loading}
            </p>
          ) : list.phase === 'error' ? (
            <EmptyState icon="circle-alert" title={S.listUnavailable} />
          ) : list.items.length === 0 ? (
            <EmptyState icon="proof-seal" title={S.emptyTitle} prompt={S.emptyPrompt} />
          ) : (
            <>
              <ProofTable items={list.items} />
              {list.more === 'error' ? (
                <p className="al-text-body-sm al-muted" role="status">
                  {S.listUnavailable}
                </p>
              ) : null}
              {list.next === undefined ? null : (
                <Button
                  className="pf-more"
                  size="sm"
                  disabled={list.more === 'loading'}
                  onClick={loadMore}
                >
                  {S.loadMore}
                </Button>
              )}
            </>
          )}
        </div>
        <aside className="pf-side">
          <CreditsCard credits={credits} actions={actions} />
          {notice === undefined ? null : (
            <p className="al-text-body-sm" role="status">
              {notice}
            </p>
          )}
          {move !== undefined ? (
            <ConfirmMove
              api={api}
              move={move}
              onClose={() => setMove(undefined)}
              onDone={(line) => {
                setMove(undefined);
                setPanel('none');
                setNotice(line);
                readMoney();
              }}
            />
          ) : panel === 'add' && net !== undefined ? (
            <AddCreditsPanel
              net={net}
              soon={soon}
              onTurn={(m) => {
                setNotice(undefined);
                setMove(m);
              }}
              onCheckAgain={readMoney}
            />
          ) : null}
          {credits.kind === 'ok' ? (
            <p className="al-text-body-sm al-muted">{priceLine(credits.price)}</p>
          ) : null}
        </aside>
      </div>
    </>
  );
}
