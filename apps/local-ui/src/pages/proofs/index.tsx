// Proofs and credits (M1-11c-a4; d1 Local-proofs with DESIGN-ADJ-1 PR-1, X-4, X-6; 11 §5, §6.2).
//
// The proof list (newest first, paged) beside the credits card. Credits lead with proofs left; the
// dollar balance is small. Nothing here names a network, token or address, and the Agent ID and QR
// code are not on this page (PR-1: they live in Advanced). "Add credits" stays hidden until the pay
// page is live (X-6). Reads only: the page sends GET requests and nothing else.
import { Button, EmptyState, Icon, ProofBadge } from '@4thtech-io/ui';
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { createApiClient, type ApiClient } from '../../api/client.js';
import { PAGE_TITLES } from '../../strings.js';
import {
  CREDITS_PATH,
  listPath,
  parseCredits,
  parseList,
  type CreditsAnswer,
  type ProofRow,
} from './data.js';
import { PROOFS_STRINGS as S, inCredits, proofsLeft } from './strings.js';
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

function CreditsCard({ credits }: { credits: CreditsState }): ReactElement {
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
      {/* X-6: no "Add credits" until the pay page is live (D-113, M1-26-e). */}
      <p className="al-text-caption al-muted">{S.addCreditsNotAvailable}</p>
      {/* TODO(D2): free test credits. The owner has not decided between a button and the agent
          claiming them by itself on the first needs_credits (UX audit 5a); nothing until then. */}
    </section>
  );
}

export interface ProofsPageProps {
  /** For tests; the page's own same-origin client by default. */
  readonly api?: ApiClient;
}

export function ProofsPage({ api: given }: ProofsPageProps = {}): ReactElement {
  const api = useMemo(() => given ?? createApiClient(), [given]);
  const [list, setList] = useState<ListState>({ phase: 'loading' });
  const [credits, setCredits] = useState<CreditsState>({ kind: 'loading' });

  useEffect(() => {
    let live = true;
    void api.get(listPath()).then((res) => {
      if (!live) return;
      const answer = res.kind === 'ok' ? parseList(res.data) : ({ kind: 'error' } as const);
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
      setCredits(res.kind === 'ok' ? parseCredits(res.data) : { kind: 'unavailable' });
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
          <CreditsCard credits={credits} />
          <p className="al-text-body-sm al-muted">{S.price}</p>
        </aside>
      </div>
    </>
  );
}
