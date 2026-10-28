// Proofs and credits (M1-11c-a4; d1 Local-proofs with DESIGN-ADJ-1 PR-1, X-4, X-6; 11 §5, §6.2).
//
// The proof list (newest first, paged) beside the credits card. Credits lead with proofs left; the
// dollar balance is small. The default view names no network, token or address, and the Agent ID is
// not on this page (PR-1: it lives in Advanced). M1-11c-a4c: where the agent can be paid (the Gnosis
// test network now, D-123), "Add credits" opens the address, its QR code and the privacy note, and
// "Withdraw credits" returns credits to the agent's own account; both changes are owner operations
// behind a confirm screen and the owner code (top-up.tsx). Elsewhere the not-available line stays.
// On load the page only reads.
import {
  Button,
  EmptyState,
  Icon,
  PAY_CONFIRM_STRINGS,
  ProofBadge,
  RingMeter,
  Skeleton,
  Surface,
  SuccessMoment,
  UnderTheHood,
} from '@4thtech-io/ui';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
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

/** The ring is full at this many proofs left; the words carry the exact numbers. */
const RING_FULL_AT = 100;
/** While a proof is on its way or credits are expected, the page looks again this often. */
const POLL_MS = 5000;
/** Stop waiting for credits after this many looks (about two minutes). */
const MAX_POLLS = 24;

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

/**
 * One key per row, unique even when several proofs share a second: time and direction, plus how many
 * rows after it (counted from the bottom, the oldest) have the same pair. The feed has no row ID, and
 * new rows land at the top, so counting from the bottom keeps every existing row's key when one arrives.
 * The oldest group on a page that has more below it may be cut short; `trusted` is false for those.
 */
function keysOf(
  items: readonly ProofRow[],
  hasMore = false,
): { readonly key: string; readonly trusted: boolean }[] {
  const counts = new Map<string, number>();
  const oldest = items.length === 0 ? 0 : (items[items.length - 1]?.createdAt ?? 0);
  const out: { key: string; trusted: boolean }[] = [];
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i] as ProofRow;
    const base = `${String(item.createdAt)}-${item.direction}`;
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    out[i] = { key: `${base}-${String(n)}`, trusted: !(hasMore && item.createdAt === oldest) };
  }
  return out;
}

/** The newest page from a quiet re-read on top, then the older rows already loaded below it. */
function mergeNewest(fresh: readonly ProofRow[], old: readonly ProofRow[]): readonly ProofRow[] {
  if (fresh.length === 0) return old;
  const oldest = Math.min(...fresh.map((r) => r.createdAt));
  const sameSecond = fresh.filter((r) => r.createdAt === oldest).length;
  let skipped = 0;
  const rest = old.filter((r) => {
    if (r.createdAt < oldest) return true;
    if (r.createdAt > oldest) return false;
    skipped += 1;
    return skipped > sameSecond;
  });
  return [...fresh, ...rest];
}
const inFlight = (state: string): boolean => state === 'recording' || state === 'submitted';

function ProofTable({
  items,
  moments,
}: {
  items: readonly ProofRow[];
  moments: ReadonlySet<string>;
}): ReactElement {
  const keys = keysOf(items).map((k) => k.key);
  return (
    <div className="pf-table-wrap" role="region" tabIndex={0} aria-label={S.listCaption}>
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
            <tr key={keys[i]}>
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
                {moments.has(keys[i] ?? '') ? <SuccessMoment kind="proof" /> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The ring fills after the first paint (and glides on later changes); reduced motion: CSS. */
function useFilled(target: number): number {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setShown(target));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [target]);
  return shown;
}

function CreditsRing({ proofs, balance }: { proofs: number; balance: string }): ReactElement {
  const shown = useFilled(proofs);
  // Until the ring has filled, its 0 is a drawing step, not an answer: screen readers skip it.
  return (
    <span className="pf-ring" {...(shown === proofs ? {} : { 'aria-hidden': true })}>
      <RingMeter
        label={S.creditsLabel}
        value={shown}
        max={Math.max(RING_FULL_AT, proofs)}
        text={inCredits(balance)}
        size="lg"
      />
    </span>
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
      <Surface
        as="section"
        level={2}
        className="al-credits"
        aria-label={S.creditsLabel}
        aria-busy="true"
      >
        <div className="al-text-label al-muted">{S.creditsLabel}</div>
        <Skeleton loading lines={3} />
      </Surface>
    );
  }
  if (credits.kind !== 'ok') {
    return (
      <Surface as="section" level={2} className="al-credits" aria-label={S.creditsLabel}>
        <div className="al-text-label al-muted">{S.creditsLabel}</div>
        <p className="al-text-body-sm al-muted">{S.creditsUnavailable}</p>
      </Surface>
    );
  }
  return (
    <Surface
      as="section"
      level={2}
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
        <CreditsRing proofs={credits.proofsLeft} balance={credits.balance} />
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
    </Surface>
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
  // UI-REFRESH-l: proofs that just finished (success moment) and credits we are waiting for.
  const [moments, setMoments] = useState<ReadonlySet<string>>(new Set());
  const [waiting, setWaiting] = useState<{ readonly from: number } | undefined>(undefined);
  const seen = useRef<Map<string, string>>(new Map());
  const polls = useRef(0);

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

  /** A quiet re-read: an answer that is not ok changes nothing (old values stay). */
  const look = useCallback(() => {
    void api.get(listPath()).then((res) => {
      const answer = res.kind === 'ok' ? parseList(res.data) : undefined;
      if (answer?.kind !== 'ok') return;
      const keys = keysOf(answer.items, answer.next !== undefined);
      const done = answer.items
        .map((r, i) => [r, keys[i]] as const)
        .filter(
          ([r, k]) =>
            k?.trusted === true &&
            r.state === 'recorded' &&
            inFlight(seen.current.get(k.key) ?? ''),
        )
        .map(([, k]) => k?.key ?? '');
      answer.items.forEach((r, i) => {
        const k = keys[i];
        if (k?.trusted === true) seen.current.set(k.key, r.state);
      });
      if (done.length > 0) setMoments((m) => new Set([...m, ...done]));
      setList((old) =>
        old.phase === 'ok' ? { ...old, items: mergeNewest(answer.items, old.items) } : old,
      );
    });
    void api.get(CREDITS_PATH).then((res) => {
      const answer = res.kind === 'ok' ? parseCredits(res.data) : undefined;
      if (answer?.kind === 'ok') setCredits(answer);
    });
  }, [api]);

  const pending =
    waiting !== undefined || (list.phase === 'ok' && list.items.some((r) => inFlight(r.state)));
  useEffect(() => {
    if (!pending) return undefined;
    const timer = setInterval(() => {
      polls.current += 1;
      if (waiting !== undefined && polls.current > MAX_POLLS) setWaiting(undefined);
      look();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [pending, waiting, look]);
  useEffect(() => {
    if (waiting !== undefined && credits.kind === 'ok' && credits.proofsLeft > waiting.from) {
      setWaiting(undefined);
    }
  }, [credits, waiting]);

  useEffect(() => {
    let live = true;
    void api.get(listPath()).then((res) => {
      if (!live) return;
      const answer = res.kind === 'ok' ? parseList(res.data) : problem(res);
      if (answer.kind === 'ok') {
        const keys = keysOf(answer.items, answer.next !== undefined);
        answer.items.forEach((r, i) => {
          const k = keys[i];
          if (k?.trusted === true) seen.current.set(k.key, r.state);
        });
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

  // Under the hood: only what this page already receives (no record ID, network or record link yet).
  const hoodFields: unknown[] = [];
  if (list.phase === 'ok') {
    hoodFields.push({ kind: 'count', label: 'Proofs shown', value: String(list.items.length) });
  }
  if (credits.kind === 'ok') {
    hoodFields.push({ kind: 'text', label: 'Proof fee', value: credits.price });
    hoodFields.push({
      kind: 'text',
      label: 'Credits type',
      value: credits.test ? S.testCreditsLabel : S.creditsLabel,
    });
  }

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
          <Skeleton loading={list.phase === 'loading'} lines={5}>
            {list.phase === 'error' ? (
              <EmptyState icon="circle-alert" title={S.listUnavailable} />
            ) : list.phase === 'ok' && list.items.length === 0 ? (
              <EmptyState icon="proof-seal" title={S.emptyTitle} prompt={S.emptyPrompt} />
            ) : list.phase === 'ok' ? (
              <>
                <ProofTable items={list.items} moments={moments} />
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
            ) : null}
          </Skeleton>
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
                if (move.kind === 'deposit' && line === S.pending) {
                  polls.current = 0;
                  setWaiting({ from: credits.kind === 'ok' ? credits.proofsLeft : 0 });
                }
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
          {waiting === undefined ? null : (
            <p className="pf-waiting al-text-body-sm al-muted" role="status">
              {S.waiting}
            </p>
          )}
          {credits.kind === 'ok' ? (
            <p className="al-text-body-sm al-muted">{priceLine(credits.price)}</p>
          ) : null}
        </aside>
      </div>
      <UnderTheHood fields={hoodFields} />
    </>
  );
}
