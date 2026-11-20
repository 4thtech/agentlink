// NET-UI-B (C2 to C5; D-158): add and test, the list, review and approval, in one sheet. Three steps
// ("Step n of 3"); every step can be left with no change. The page never signs: the confirm hands
// the owner's proof to `ServersApi.set`. Hosts and reasons come from the fixed strings and the
// checked answers (api.ts) and render as plain text (I-5).
import { Banner, Button, Sheet, Switch, TextField } from '@4thtech-io/ui';
import { useRef, useState, type FormEvent, type ReactElement } from 'react';
import type { OwnerClient, PresenceProof } from '../../../contacts/owner.js';
import { ReviewCard, type Consequence } from './review-card.js';
import type { Done, Review, ServersApi, TestResult } from './api.js';
import { dayText, failMessage } from './messages.js';
import { outcomeWords, SERVERS_STRINGS as S } from './strings.js';

interface Row {
  readonly id: number;
  /** The address as typed (trimmed). */
  readonly url: string;
  readonly state: 'testing' | 'done' | 'failed';
  readonly result?: TestResult;
  readonly failure?: string;
}

const MAX_ROWS = 8;

/** Splits a typed or pasted text into addresses (spaces, commas, new lines). */
export function splitAddresses(text: string): readonly string[] {
  return text.split(/[\s,;]+/).filter((s) => s !== '');
}
const keyOf = (url: string): string => url.toLowerCase().replace(/\/+$/, '');
const isReady = (r: Row): boolean => r.result?.outcome === 'ready' || r.result?.outcome === 'slow';
const isUsable = (r: Row): boolean => isReady(r) || r.result?.outcome === 'sign_in';

export interface ServersFlowProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly api: ServersApi;
  readonly owner: OwnerClient;
  readonly onDone: (done: Done) => void;
  /** NET-ANNOUNCE-OPTOUT: the opt-out is on now, so the flow starts with it on (mix-in off). */
  readonly optedOut?: boolean;
}

export function ServersFlow({
  open,
  onClose,
  api,
  owner,
  onDone,
  optedOut = false,
}: ServersFlowProps): ReactElement | null {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [rows, setRows] = useState<readonly Row[]>([]);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState<string | undefined>(undefined);
  // NET-ANNOUNCE-OPTOUT: a change keeps an opt-out that is on (it implies the mix-in off).
  const [mixIn, setMixIn] = useState(!optedOut);
  const [optOut, setOptOut] = useState(optedOut);
  const [review, setReview] = useState<Review | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [stale, setStale] = useState(false);
  const seq = useRef(0);
  const sent = useRef(false);

  const usable = rows.filter(isUsable);
  const ready = rows.filter(isReady).length;
  const max = mixIn ? 6 : 8;
  const testing = rows.some((r) => r.state === 'testing');
  const canReview = ready >= 2 && usable.length <= max && !testing;

  const runTests = async (list: readonly Row[]): Promise<void> => {
    const out = await api.test(list.map((r) => r.url));
    const word =
      out.kind === 'ok'
        ? undefined
        : out.kind === 'offline'
          ? S.testOffline
          : out.kind === 'busy'
            ? S.testBusy
            : S.testFailed;
    setRows((cur) =>
      cur.map((r) => {
        const i = list.findIndex((l) => l.id === r.id);
        if (i < 0) return r;
        if (out.kind === 'ok') {
          const result = out.value[i];
          return result === undefined
            ? { id: r.id, url: r.url, state: 'failed', failure: S.testFailed }
            : { id: r.id, url: r.url, state: 'done', result };
        }
        return { id: r.id, url: r.url, state: 'failed', failure: word ?? S.testFailed };
      }),
    );
  };

  const add = (event: FormEvent): void => {
    event.preventDefault();
    const typed = splitAddresses(draft);
    if (typed.length === 0) return;
    const known = new Set(rows.map((r) => keyOf(r.url)));
    const fresh: Row[] = [];
    let message: string | undefined;
    for (const url of typed) {
      if (known.has(keyOf(url))) {
        message = S.already;
        continue;
      }
      if (rows.length + fresh.length >= MAX_ROWS) {
        message = S.full;
        break;
      }
      known.add(keyOf(url));
      seq.current += 1;
      fresh.push({ id: seq.current, url, state: 'testing' });
    }
    setNote(message);
    setDraft('');
    if (fresh.length === 0) return;
    setRows((cur) => [...cur, ...fresh]);
    void runTests(fresh);
  };

  const retest = (list: readonly Row[]): void => {
    const again = list.map((r) => ({ id: r.id, url: r.url, state: 'testing' as const }));
    setRows((cur) => cur.map((r) => again.find((a) => a.id === r.id) ?? r));
    setStale(false);
    setError(undefined);
    void runTests(again);
  };

  const input = { servers: usable.map((r) => r.url), automatic: mixIn, announce: !optOut };

  const toReview = (): void => {
    if (!canReview || busy) return;
    setBusy(true);
    setError(undefined);
    void api.review(input).then((out) => {
      setBusy(false);
      if (out.kind === 'ok') {
        setReview(out.value);
        setStep(3);
        return;
      }
      setStale(out.kind === 'refused' && out.code === 'changed');
      setError(failMessage(out));
    });
  };

  const confirm = (proof: PresenceProof): void => {
    if (busy || sent.current) return;
    sent.current = true;
    setBusy(true);
    setError(undefined);
    void api.set(input, proof).then((out) => {
      setBusy(false);
      sent.current = false;
      if (out.kind === 'ok') {
        onDone(out.value);
        return;
      }
      setError(failMessage(out));
    });
  };

  const remove = (id: number): void => {
    setRows((cur) => cur.filter((r) => r.id !== id));
    setError(undefined);
  };

  const title = step === 3 ? S.reviewTitle : S.addTitle;
  return (
    <Sheet open={open} title={title} onClose={onClose} closeLabel={S.close}>
      <div className="nw" data-servers-step={step}>
        <p className="al-text-body-sm al-muted">{S.step(step)}</p>
        {step === 1 ? (
          <>
            <p className="al-text-body al-muted">{S.addBody}</p>
            <form className="nw-card" onSubmit={add}>
              <TextField
                label={S.fieldLabel}
                placeholder={S.fieldPlaceholder}
                value={draft}
                onChange={(e) => setDraft(e.currentTarget.value)}
                mono
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                inputMode="url"
                hint={S.info}
                {...(note === undefined ? {} : { error: note })}
              />
              <div>
                <Button type="submit" variant="primary" disabled={draft.trim() === ''}>
                  {S.add}
                </Button>
              </div>
            </form>
            {rows.length === 0 ? null : (
              <section aria-label={S.testResults}>
                <ul className="nw-list nw-scroll" tabIndex={0}>
                  {rows.map((r) => (
                    <ResultRow
                      key={r.id}
                      row={r}
                      onRemove={() => remove(r.id)}
                      onRetest={() => retest([r])}
                    />
                  ))}
                </ul>
              </section>
            )}
            <div className="nw-head">
              <Button onClick={onClose}>{S.close}</Button>
              <Button
                variant="primary"
                disabled={usable.length === 0 || testing}
                onClick={() => setStep(2)}
              >
                {S.continue}
              </Button>
            </div>
          </>
        ) : null}
        {step === 2 ? (
          <>
            <p className="al-text-body al-muted">{S.count(usable.length, max)}</p>
            <ul className="nw-list nw-scroll" tabIndex={0} aria-label={S.listLabel}>
              {usable.map((r) => (
                <ListRow key={r.id} row={r} onRemove={() => remove(r.id)} />
              ))}
              {ready < 2 ? (
                <li className="nw-srv">
                  <p className="al-text-body-sm al-muted">{S.needMoreHint}</p>
                </li>
              ) : null}
            </ul>
            {ready < 2 ? (
              <Banner tone="warning" title={S.needTwoTitle}>
                {S.needTwo}
              </Banner>
            ) : usable.some((r) => r.result?.outcome === 'sign_in') ? (
              <Banner tone="warning" title={S.signInOkTitle}>
                {S.signInOk}
              </Banner>
            ) : null}
            {usable.some((r) => r.result?.paymentRequired === true) ? (
              <Banner tone="warning">{S.paid}</Banner>
            ) : null}
            <p className="al-text-body-sm al-muted">{S.retention}</p>
            <div className="nw">
              <Switch
                label={S.mixInLabel}
                description={S.mixInBody}
                checked={mixIn}
                onChange={(on) => {
                  setMixIn(on);
                  if (on) setOptOut(false);
                }}
              />
              {mixIn ? null : (
                <>
                  <Banner tone="warning" title={S.mixOffTitle}>
                    {S.mixOff}
                  </Banner>
                  <div>
                    <Button
                      size="sm"
                      onClick={() => {
                        setMixIn(true);
                        setOptOut(false);
                      }}
                    >
                      {S.mixBack}
                    </Button>
                  </div>
                  <Switch
                    label={S.optOutLabel}
                    description={S.optOutBody}
                    checked={optOut}
                    onChange={setOptOut}
                  />
                  {optOut ? (
                    <Banner tone="warning" title={S.optOutTitle}>
                      {S.optOut}
                    </Banner>
                  ) : null}
                </>
              )}
            </div>
            {usable.length > max ? <p className="al-text-body-sm">{S.full}</p> : null}
            {error === undefined ? null : (
              <Banner tone="warning">
                {error}
                {stale ? (
                  <>
                    {' '}
                    <Button size="sm" onClick={() => retest(rows.filter(isUsable))}>
                      {S.retest}
                    </Button>
                  </>
                ) : null}
              </Banner>
            )}
            <div className="nw-head">
              <Button onClick={() => setStep(1)}>{S.back}</Button>
              <Button variant="primary" disabled={!canReview || busy} onClick={toReview}>
                {S.review}
              </Button>
            </div>
          </>
        ) : null}
        {step === 3 && review !== undefined ? (
          <>
            <p className="al-text-body al-muted">{S.reviewBody}</p>
            <ReviewCard
              headline={S.useThese(review.servers.length)}
              rows={review.servers.map((s) => ({
                host: s.host,
                role:
                  s.role === 'automatic'
                    ? S.automatic
                    : S.yours(
                        rows.find((r) => r.result?.host === s.host)?.result?.roundTripMs ?? null,
                      ),
              }))}
              consequences={consequences(review)}
              statement={S.presenceReason(review.servers.length)}
              withSensor={S.confirmSensor}
              withCode={S.confirmCode}
              backLabel={S.back}
              busy={busy}
              error={error}
              owner={owner}
              onProof={confirm}
              onBack={() => {
                setError(undefined);
                setStep(2);
              }}
            />
          </>
        ) : null}
      </div>
    </Sheet>
  );
}

/** The consequence lines of a review (C4): leaving servers, contacts, what servers can see. */
export function consequences(review: Review): readonly Consequence[] {
  const out: Consequence[] = [];
  if (review.leaving.length > 0) {
    const until = Math.max(...review.leaving.map((l) => l.until));
    out.push({
      title: S.leavingTitle,
      body: S.leaving(dayText(until), review.leaving.map((l) => l.host).join(', ')),
    });
  }
  if (review.contacts > 0) {
    out.push({ title: S.contactsTitle, body: S.contactsBody(review.contacts) });
  }
  out.push({ title: S.seeTitle, body: S.see });
  return out;
}

/** A small static status tag; the shell's `.al-chip` is the agent switcher's pill button. */
function Chip({ children }: { readonly children: string }): ReactElement {
  return <span className="nw-mode al-text-body-sm">{children}</span>;
}

function ResultRow({
  row,
  onRemove,
  onRetest,
}: {
  readonly row: Row;
  readonly onRemove: () => void;
  readonly onRetest: () => void;
}): ReactElement {
  const host = row.result?.host !== undefined && row.result.host !== '' ? row.result.host : row.url;
  const words =
    row.result === undefined
      ? undefined
      : outcomeWords(row.result.outcome, row.result.reason, row.result.roundTripMs);
  return (
    <li className="nw-srv" data-test-state={row.state === 'done' ? row.result?.outcome : row.state}>
      <div className="nw-srv-top">
        <span className="nw-host al-text-code" title={host}>
          {host}
        </span>
        <span className="nw-state">
          {row.state === 'testing' ? (
            <Chip>{S.testing}</Chip>
          ) : words === undefined ? null : (
            <Chip>{words.title}</Chip>
          )}
        </span>
      </div>
      {words === undefined ? null : <p className="al-text-body-sm al-muted">{words.why}</p>}
      {row.result?.paymentRequired === true ? <p className="al-text-body-sm">{S.paid}</p> : null}
      {row.state === 'failed' ? <p className="al-text-body-sm">{row.failure}</p> : null}
      {row.state === 'testing' ? null : (
        <div className="nw-head">
          {row.state === 'failed' ? (
            <Button size="sm" onClick={onRetest}>
              {S.retest}
            </Button>
          ) : (
            <span />
          )}
          <Button size="sm" variant="ghost" aria-label={S.removeFor(host)} onClick={onRemove}>
            {S.remove}
          </Button>
        </div>
      )}
    </li>
  );
}

function ListRow({
  row,
  onRemove,
}: {
  readonly row: Row;
  readonly onRemove: () => void;
}): ReactElement {
  const host = row.result?.host !== undefined && row.result.host !== '' ? row.result.host : row.url;
  const words =
    row.result === undefined
      ? undefined
      : outcomeWords(row.result.outcome, row.result.reason, row.result.roundTripMs);
  return (
    <li className="nw-srv">
      <div className="nw-srv-top">
        <span className="nw-host al-text-code" title={host}>
          {host}
        </span>
        <span className="nw-state">
          <Button size="sm" variant="ghost" aria-label={S.removeFor(host)} onClick={onRemove}>
            {S.remove}
          </Button>
        </span>
      </div>
      <div className="nw-meta al-text-body-sm al-muted">
        <span>{S.role}</span>
        {words === undefined ? null : <Chip>{words.title}</Chip>}
      </div>
    </li>
  );
}
