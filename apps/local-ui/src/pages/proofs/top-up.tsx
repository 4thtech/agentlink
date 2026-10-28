// Add credits by QR (Gnosis test network now) and Withdraw credits (M1-11c-a4c; D-122, D-123;
// topup-ux.md 3c; 11 §5.6; 12 §4.4; 04 §2.5).
//
// - The default view stays plain (UX north star): "Add credits" and "Withdraw credits" buttons only.
//   The agent's address, the QR code, the coin and the network appear only inside Add credits, which
//   the owner opens, because the sender's app asks for them (topup-ux.md 3c; D-117 B).
// - The QR code ships only with crediting: Add credits exists only where the server offers the
//   agent's address and a way to turn received funds into credits (the Gnosis test network).
// - Turning funds into credits and withdrawing are owner operations: a confirm screen with the amount
//   and where it goes from and to, then the owner code, sent once as the request body to the
//   server's presence gate. The owner code is never kept after the request or put in a URL.
// - Withdrawals go to the agent's own account only (the recipient grant is a later card).
// - UX2-e2 (B-11 §23, D-137): under the details, a three-step tracker, Waiting for your funds →
//   Arrived · $X → Added to credits. Steps move only on server reads (the existing top-up and credits
//   reads; no new route): no timer advances a step, no amount shows before the read that proves it,
//   a submitted owner operation is not "added", and a failed read keeps the step. The waiting mark
//   (UX2-e1, the one brand exception) turns only on step 1.
import { EARLIER_OWNER_CODE_HINT } from '../../strings.js';
import {
  Button,
  ProgressBar,
  TextField,
  WaitingMark,
  useReducedMotion,
  useVisibilityPause,
} from '@4thtech-io/ui';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { ApiClient, OwnerApiResult } from '../../api/client.js';
import {
  CREDITS_PATH,
  TOP_UP_PATH,
  WITHDRAW_PATH,
  addressNetwork,
  isPositive,
  parseCredits,
  parseTopUp,
  type CreditsAnswer,
  type Money,
  type TopUpNetwork,
} from './data.js';
import { QrCode } from './qr.js';
import {
  NETWORK_NAMES,
  PROOFS_STRINGS as S,
  addAmount,
  addedNow,
  arrivedAmount,
  comingSoon,
  fundsArrived,
  stepOf,
  withdrawAmount,
} from './strings.js';

export type AddressNetwork = Extract<TopUpNetwork, { method: 'address' }>;
type Ready = Extract<TopUpNetwork, { available: true }>;

export interface Move {
  readonly kind: 'deposit' | 'withdraw';
  readonly money: Money;
  readonly net: Ready;
}

/** The owner's next step after a move, as one fixed line. */
function outcomeLine(res: OwnerApiResult): { text: string; done: boolean } {
  switch (res.kind) {
    case 'ok':
      return res.status === 202 ? { text: S.pending, done: true } : { text: S.done, done: true };
    case 'presence_rejected':
    case 'presence_required':
      return { text: S.wrongCode, done: false };
    case 'wait':
      return { text: S.wait, done: false };
    case 'answer': {
      const error =
        typeof res.data === 'object' && res.data !== null
          ? (res.data as { error?: unknown }).error
          : undefined;
      if (error === 'amount_changed') return { text: S.amountChanged, done: true };
      if (error === 'no_funds_for_fee') return { text: S.noFundsForFee, done: true };
      return { text: S.moveFailed, done: true };
    }
    default:
      return { text: S.moveFailed, done: false };
  }
}

// ---- UX2-e2: the tracker's state, changed only by reads (pure, tested on its own) -----------------

/** Checking (B-11 §23.1): every 5 s, every 15 s after 2 minutes, stop after 30 minutes. */
export const CHECK_FAST_MS = 5_000;
export const CHECK_SLOW_MS = 15_000;
export const CHECK_SLOW_AFTER_MS = 2 * 60_000;
export const CHECK_STOP_AFTER_MS = 30 * 60_000;
/** After this long on step 1 the hint asks the owner to check the account (§23.1). */
export const LONG_WAIT_MS = 10 * 60_000;

export type TrackStep = 'waiting' | 'arrived' | 'adding' | 'added';

export interface Track {
  readonly step: TrackStep;
  /** When the panel opened (step 1 reached). */
  readonly openedAt: number;
  /** When the current round of checking started (the 5 s / 15 s / stop clock). */
  readonly since: number;
  /** When the last read answered, ok or not. */
  readonly lastAt: number;
  /** `received` when the panel opened; unknown until a read gives it. */
  readonly baseline?: string;
  /** The read that proved the funds arrived: its `received` and `addable` are what step 2 shows. */
  readonly arrived?: Ready;
  readonly arrivedAt?: number;
  /** The credits balance when the owner pressed Add (before the owner operation). */
  readonly creditsBefore?: string | undefined;
  /** The credits read that proved the credits were added. */
  readonly added?: string;
  readonly addedAt?: number;
  /** The last read failed: the step stays and says so. */
  readonly failed: boolean;
  /** Checking stopped after 30 minutes. */
  readonly stopped: boolean;
}

export type TrackEvent =
  /** A top-up read: the address network of an ok answer, or `undefined` for a failed read. */
  | { readonly type: 'topup'; readonly net: AddressNetwork | undefined; readonly now: number }
  /** A credits read: the balance of an ok answer, or `undefined` for a failed read. */
  | { readonly type: 'credits'; readonly balance: string | undefined; readonly now: number }
  /** The owner pressed Add: the credits balance the page knows from its last read. */
  | { readonly type: 'armed'; readonly balance: string | undefined }
  /** The owner operation succeeded (submitted, not added). */
  | { readonly type: 'submitted'; readonly now: number }
  | { readonly type: 'stop' }
  | { readonly type: 'resume'; readonly now: number };

/** `$N.NN` (checked by the parsers) as whole cents, so amounts compare exactly. */
const cents = (usd: string): bigint => BigInt(usd.slice(1).replace('.', ''));

/** The tracker as the panel opens, from the top-up read the page holds. */
export function openTrack(net: AddressNetwork, now: number): Track {
  const base = { openedAt: now, since: now, lastAt: now, stopped: false };
  if (!net.available) return { ...base, step: 'waiting', failed: true };
  if (isPositive(net.addable.amount)) {
    return {
      ...base,
      step: 'arrived',
      failed: false,
      baseline: net.received,
      arrived: net,
      arrivedAt: now,
    };
  }
  return { ...base, step: 'waiting', failed: false, baseline: net.received };
}

/** One read or owner event. Never goes back a step, never guesses an amount. */
export function track(s: Track, e: TrackEvent): Track {
  switch (e.type) {
    case 'topup': {
      if (s.step !== 'waiting') return s;
      if (e.net === undefined || !e.net.available) return { ...s, failed: true, lastAt: e.now };
      const net = e.net;
      const rose = s.baseline !== undefined && cents(net.received) > cents(s.baseline);
      // No baseline (the account could not be read when the panel opened): funds count as arrived
      // only when the read itself shows something to add.
      const there = s.baseline === undefined && isPositive(net.addable.amount);
      if (rose || there) {
        return {
          ...s,
          step: 'arrived',
          arrived: net,
          arrivedAt: e.now,
          failed: false,
          lastAt: e.now,
        };
      }
      return { ...s, baseline: s.baseline ?? net.received, failed: false, lastAt: e.now };
    }
    case 'armed': {
      // Pressed again after a cancel: the value is taken afresh (unknown stays unknown).
      return s.step === 'arrived' ? { ...s, creditsBefore: e.balance } : s;
    }
    case 'submitted':
      if (s.step !== 'arrived') return s;
      return { ...s, step: 'adding', since: e.now, lastAt: e.now, failed: false, stopped: false };
    case 'credits': {
      if (s.step !== 'adding') return s;
      if (e.balance === undefined) return { ...s, failed: true, lastAt: e.now };
      // Added only when the credits read shows more than before the owner operation. Without a value
      // from before, it cannot be proved: the step stays (never early).
      if (s.creditsBefore !== undefined && cents(e.balance) > cents(s.creditsBefore)) {
        return {
          ...s,
          step: 'added',
          added: e.balance,
          addedAt: e.now,
          failed: false,
          lastAt: e.now,
        };
      }
      return { ...s, failed: false, lastAt: e.now };
    }
    case 'stop':
      return s.stopped ? s : { ...s, stopped: true };
    case 'resume':
      return { ...s, stopped: false, since: e.now };
    default:
      return s;
  }
}

/** What the tracker reads while it waits: the account on step 1, the credits between 2 and 3. */
function readFor(s: Track | undefined): 'topup' | 'credits' | undefined {
  if (s === undefined || s.stopped) return undefined;
  if (s.step === 'waiting') return 'topup';
  if (s.step === 'adding') return 'credits';
  return undefined;
}

export interface AddCreditsTracker {
  readonly state: Track | undefined;
  /** True while the tab is hidden: no reads, the mark pauses. */
  readonly hidden: boolean;
  /** The owner opened Add credits: start from the top-up read the page holds. */
  start(net: AddressNetwork): void;
  /**
   * The owner pressed Add: forget any older value and take one fresh credits read, the balance from
   * before the owner operation. It counts only while still on Arrived (before the submit).
   */
  arm(): void;
  /** The owner operation succeeded: wait for the credits read. */
  submitted(): void;
  /** After checking stopped: one read at once, and checking starts over. */
  checkAgain(): void;
}

/**
 * The tracker while the Add credits panel is open: polls the existing reads politely (never while the
 * tab is hidden; one read at once on return) and hands every ok credits answer to the page, so the
 * credits card follows the same read.
 */
export function useAddCreditsTracker(
  api: ApiClient,
  open: boolean,
  onCredits: (answer: Extract<CreditsAnswer, { kind: 'ok' }>) => void,
): AddCreditsTracker {
  const [state, setState] = useState<Track | undefined>(undefined);
  const hidden = useVisibilityPause();
  // Answers from an earlier opening of the panel are dropped.
  const session = useRef(0);
  const credits = useRef(onCredits);
  credits.current = onCredits;

  useEffect(() => {
    if (open) return;
    session.current += 1;
    setState(undefined);
  }, [open]);

  const reading = readFor(state);
  const since = state?.since;
  useEffect(() => {
    if (reading === undefined || since === undefined || hidden) return undefined;
    const id = session.current;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const apply = (e: TrackEvent): void => {
      if (id === session.current) setState((s) => (s === undefined ? s : track(s, e)));
    };
    const read = (): void => {
      if (reading === 'topup') {
        void api.get(TOP_UP_PATH).then(
          (res) => {
            const net = addressNetwork(
              res.kind === 'ok' ? parseTopUp(res.data) : { kind: 'unavailable' },
            );
            apply({ type: 'topup', net, now: Date.now() });
          },
          () => apply({ type: 'topup', net: undefined, now: Date.now() }),
        );
      } else {
        void api.get(CREDITS_PATH).then(
          (res) => {
            const answer = res.kind === 'ok' ? parseCredits(res.data) : undefined;
            const ok = answer?.kind === 'ok' ? answer : undefined;
            if (ok !== undefined && id === session.current) credits.current(ok);
            apply({ type: 'credits', balance: ok?.balance, now: Date.now() });
          },
          () => apply({ type: 'credits', balance: undefined, now: Date.now() }),
        );
      }
    };
    const next = (): void => {
      const elapsed = Date.now() - since;
      if (elapsed >= CHECK_STOP_AFTER_MS) {
        apply({ type: 'stop' });
        return;
      }
      timer = setTimeout(
        () => {
          if (!live) return;
          read();
          next();
        },
        elapsed >= CHECK_SLOW_AFTER_MS ? CHECK_SLOW_MS : CHECK_FAST_MS,
      );
    };
    // Once at once: on opening, on a new round of checking and on returning to the tab.
    read();
    next();
    return () => {
      live = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [api, reading, since, hidden]);

  const start = useCallback((net: AddressNetwork) => {
    session.current += 1;
    setState(openTrack(net, Date.now()));
  }, []);
  const arm = useCallback(() => {
    const id = session.current;
    const set = (balance: string | undefined): void => {
      if (id === session.current) {
        setState((s) => (s === undefined ? s : track(s, { type: 'armed', balance })));
      }
    };
    set(undefined);
    void api.get(CREDITS_PATH).then(
      (res) => {
        const answer = res.kind === 'ok' ? parseCredits(res.data) : undefined;
        const ok = answer?.kind === 'ok' ? answer : undefined;
        if (ok !== undefined && id === session.current) credits.current(ok);
        // Unknown stays unknown: the tracker then never claims Added (never early).
        set(ok?.balance);
      },
      () => set(undefined),
    );
  }, [api]);
  const submitted = useCallback(() => {
    setState((s) => (s === undefined ? s : track(s, { type: 'submitted', now: Date.now() })));
  }, []);
  const checkAgain = useCallback(() => {
    setState((s) => (s === undefined ? s : track(s, { type: 'resume', now: Date.now() })));
  }, []);
  return { state, hidden, start, arm, submitted, checkAgain };
}

// ---- UX2-e2: the tracker's look -------------------------------------------------------------------

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

function Reached({ at }: { at: number | undefined }): ReactElement | null {
  if (at === undefined) return null;
  const date = new Date(at);
  return (
    <time className="pf-step-time al-text-code" dateTime={date.toISOString()}>
      {CLOCK.format(date)}
    </time>
  );
}

/** The ambient duration (one turn of the mark), read from its token; 2 s if it cannot be read. */
function ambientMs(): number {
  try {
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue('--al-duration-ambient')
      .trim();
    const m = /^([\d.]+)(ms|s)$/.exec(v);
    if (m !== null) return Number(m[1]) * (m[2] === 's' ? 1000 : 1);
  } catch {
    // Fall through to the token's documented value.
  }
  return 2000;
}

/** The drawn check (§6 row 7): the stroke draws once after the first paint; instant when reduced. */
function DrawnCheck(): ReactElement {
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setDrawn(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, []);
  return (
    <svg
      className={drawn ? 'pf-step-check is-drawn' : 'pf-step-check'}
      width="20"
      height="20"
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path d="M3.5 8.5l3 3 6-7" pathLength={1} />
    </svg>
  );
}

/**
 * Step 1's marker: the waiting mark while waiting. When step 1 ends, the diamond finishes its quarter
 * turn and rests (§14: interrupted motion never jumps), then the check draws. The step word has moved
 * on already with the read; only the drawing waits for the turn (at most one ambient cycle).
 */
function FirstMarker({
  done,
  turning,
  hidden,
}: {
  done: boolean;
  turning: boolean;
  hidden: boolean;
}): ReactElement {
  const reduced = useReducedMotion();
  const [rested, setRested] = useState(done);
  useEffect(() => {
    if (!done) {
      setRested(false);
      return undefined;
    }
    if (reduced || hidden) {
      setRested(true);
      return undefined;
    }
    const t = setTimeout(() => setRested(true), ambientMs());
    return () => clearTimeout(t);
  }, [done, reduced, hidden]);
  if (done && rested) return <DrawnCheck />;
  return (
    <span
      className="pf-step-mark"
      onAnimationIteration={() => {
        if (done) setRested(true);
      }}
    >
      <WaitingMark active={turning && !done} paused={hidden} />
    </span>
  );
}

type RowState = 'done' | 'current' | 'pending';

function Step({
  n,
  state,
  marker,
  word,
  at,
  children,
}: {
  n: number;
  state: RowState;
  marker: ReactNode;
  word: string;
  at?: number | undefined;
  children?: ReactNode;
}): ReactElement {
  return (
    <li
      className={`pf-step is-${state}`}
      data-state={state}
      {...(state === 'current' ? { 'aria-current': 'step' as const } : {})}
    >
      <span className="pf-step-marker">{marker}</span>
      <div className="pf-step-body">
        <span className="pf-step-word al-text-body">
          {word}
          {state === 'current' ? <span className="al-sr-only">{stepOf(n)}</span> : null}
        </span>
        {children}
      </div>
      {state === 'pending' ? null : <Reached at={at} />}
    </li>
  );
}

const Hollow = (): ReactElement => <span className="pf-step-dot is-hollow" aria-hidden="true" />;
const Solid = (): ReactElement => <span className="pf-step-dot is-solid" aria-hidden="true" />;

/** The line under the current step when a read failed, or when checking stopped. */
function CheckLine({
  s,
  onCheckAgain,
}: {
  s: Track;
  onCheckAgain: () => void;
}): ReactElement | null {
  if (s.stopped) {
    return (
      <>
        <p className="pf-step-note al-text-caption al-muted">{S.stoppedChecking}</p>
        <Button size="sm" onClick={onCheckAgain}>
          {S.checkAgain}
        </Button>
      </>
    );
  }
  return s.failed ? <p className="pf-step-note al-text-caption al-muted">{S.readFailed}</p> : null;
}

/** The polite announcement, set one tick after a step change so screen readers say it. */
function useStepAnnouncement(s: Track): string {
  const [said, setSaid] = useState('');
  const first = useRef(true);
  const text =
    s.step === 'arrived' && s.arrived !== undefined
      ? fundsArrived(s.arrived.received)
      : s.step === 'added'
        ? S.stepAdded
        : '';
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return undefined;
    }
    const t = setTimeout(() => setSaid(text), 0);
    return () => clearTimeout(t);
  }, [text]);
  return said;
}

export function AddCreditsTrack({
  s,
  hidden,
  onAdd,
  onCheckAgain,
  onShowDetails,
}: {
  readonly s: Track;
  readonly hidden: boolean;
  readonly onAdd: (move: Move) => void;
  readonly onCheckAgain: () => void;
  readonly onShowDetails: () => void;
}): ReactElement {
  const said = useStepAnnouncement(s);
  const waiting = s.step === 'waiting';
  const arrived = s.step === 'arrived';
  const after = s.step === 'adding' || s.step === 'added';
  const funds = s.arrived;
  const long = waiting && s.lastAt - s.openedAt >= LONG_WAIT_MS;
  const reserve =
    funds !== undefined && cents(funds.addable.usd) < cents(funds.received) ? S.reserveNote : null;
  return (
    <>
      <ol className="pf-track" aria-label={S.trackLabel}>
        <Step
          n={1}
          state={waiting ? 'current' : 'done'}
          marker={<FirstMarker done={!waiting} turning={!s.stopped} hidden={hidden} />}
          word={S.stepWaiting}
          at={waiting ? undefined : s.openedAt}
        >
          {waiting ? (
            <>
              {long ? (
                <>
                  <p className="pf-step-note al-text-caption al-muted">{S.stepWaitingLong}</p>
                  <Button size="sm" variant="ghost" onClick={onShowDetails}>
                    {S.showDetails}
                  </Button>
                </>
              ) : (
                <p className="pf-step-note al-text-caption al-muted">{S.stepWaitingHint}</p>
              )}
              <CheckLine s={s} onCheckAgain={onCheckAgain} />
            </>
          ) : null}
        </Step>
        <Step
          n={2}
          state={waiting ? 'pending' : arrived ? 'current' : 'done'}
          marker={waiting ? <Hollow /> : arrived ? <Solid /> : <DrawnCheck />}
          word={funds === undefined ? S.stepArrived : arrivedAmount(funds.received)}
          at={s.arrivedAt}
        >
          {arrived && funds !== undefined ? (
            isPositive(funds.addable.amount) ? (
              <>
                <Button
                  variant="primary"
                  onClick={() => onAdd({ kind: 'deposit', money: funds.addable, net: funds })}
                >
                  {addAmount(funds.addable.usd)}
                </Button>
                {reserve === null ? null : (
                  <p className="pf-step-note al-text-caption al-muted">{reserve}</p>
                )}
              </>
            ) : (
              <p className="pf-step-note al-text-caption al-muted">{S.noFundsForFee}</p>
            )
          ) : null}
        </Step>
        <Step
          n={3}
          state={s.step === 'added' ? 'done' : s.step === 'adding' ? 'current' : 'pending'}
          marker={s.step === 'added' ? <DrawnCheck /> : after ? <Solid /> : <Hollow />}
          word={
            s.step === 'added' && s.added !== undefined
              ? addedNow(s.added)
              : s.step === 'adding'
                ? S.stepAdding
                : S.stepAdded
          }
          at={s.addedAt}
        >
          {s.step === 'adding' ? (
            <>
              <ProgressBar label={S.stepAdding} indeterminate />
              <CheckLine s={s} onCheckAgain={onCheckAgain} />
            </>
          ) : null}
        </Step>
      </ol>
      <p className="al-sr-only" role="status">
        {said}
      </p>
    </>
  );
}

export function AddCreditsPanel({
  net,
  soon,
  track: s,
  hidden,
  onTurn,
  onCheckAgain,
}: {
  readonly net: AddressNetwork;
  readonly soon: readonly string[];
  readonly track: Track | undefined;
  readonly hidden: boolean;
  readonly onTurn: (move: Move) => void;
  readonly onCheckAgain: () => void;
}): ReactElement {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const details = useRef<HTMLDivElement | null>(null);
  const reduced = useReducedMotion();
  const name = NETWORK_NAMES[net.network];
  const copyAddress = (): void => {
    const clip = (globalThis.navigator as Navigator | undefined)?.clipboard;
    if (clip === undefined) {
      setCopy('failed');
      return;
    }
    void clip.writeText(net.address).then(
      () => setCopy('copied'),
      () => setCopy('failed'),
    );
  };
  const showDetails = (): void => {
    const el = details.current;
    if (el === null) return;
    el.scrollIntoView?.({ block: 'start', behavior: reduced ? 'auto' : 'smooth' });
    el.focus({ preventScroll: true });
  };
  return (
    <section className="al-credits pf-topup" aria-label={S.addCreditsTitle}>
      <h2 className="al-text-title-3">{S.addCreditsTitle}</h2>
      <p className="al-text-body-sm">{S.addCreditsIntro}</p>
      <div
        ref={details}
        className="pf-details"
        role="group"
        aria-label={S.detailsLabel}
        tabIndex={-1}
      >
        <dl className="pf-facts al-text-body-sm">
          <dt className="al-muted">{S.networkLabel}</dt>
          <dd className="al-text-body">{name}</dd>
          <dt className="al-muted">{S.coinLabel}</dt>
          <dd>{S.coin}</dd>
        </dl>
        <QrCode value={net.address} label={S.qrLabel} exposeValue />
        <div className="al-text-caption al-muted">{S.addressLabel}</div>
        <code className="pf-address al-text-code">{net.address}</code>
        <Button size="sm" onClick={copyAddress}>
          {S.copyAddress}
        </Button>
        {copy === 'idle' ? null : (
          <p className="al-text-caption" role="status">
            {copy === 'copied' ? S.copied : S.copyFailed}
          </p>
        )}
      </div>
      <p className="al-text-caption al-muted">{S.privacy}</p>
      {s === undefined ? null : (
        <AddCreditsTrack
          s={s}
          hidden={hidden}
          onAdd={onTurn}
          onCheckAgain={onCheckAgain}
          onShowDetails={showDetails}
        />
      )}
      {soon.map((n) => (
        <p key={n} className="al-text-caption al-muted">
          {comingSoon(n)}
        </p>
      ))}
    </section>
  );
}

export function ConfirmMove({
  api,
  move,
  onClose,
  onDone,
}: {
  readonly api: ApiClient;
  readonly move: Move;
  readonly onClose: () => void;
  /** `ok`: the owner operation went through (submitted; for credits, not yet added). */
  readonly onDone: (line: string, ok: boolean) => void;
}): ReactElement {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<string | undefined>(undefined);
  const name = NETWORK_NAMES[move.net.network];
  const deposit = move.kind === 'deposit';

  const submit = (event?: FormEvent): void => {
    event?.preventDefault();
    if (busy || code.length === 0) return;
    setBusy(true);
    setLine(undefined);
    const input = { network: move.net.network, amount: move.money.amount };
    const sent = code;
    // The owner code lives only in this request; the field is cleared whatever happens.
    setCode('');
    void api.owner(deposit ? TOP_UP_PATH : WITHDRAW_PATH, input, sent).then((res) => {
      setBusy(false);
      const out = outcomeLine(res);
      if (out.done) onDone(out.text, res.kind === 'ok');
      else setLine(out.text);
    });
  };

  return (
    <section className="al-credits pf-confirm" aria-label={S.confirmTitle}>
      <h2 className="al-text-title-3">
        {deposit ? addAmount(move.money.usd) : withdrawAmount(move.money.usd)}
      </h2>
      <dl className="pf-facts al-text-body-sm">
        <dt className="al-muted">{S.amountLabel}</dt>
        <dd className="al-text-body">{move.money.usd}</dd>
        <dt className="al-muted">{S.fromLabel}</dt>
        <dd>{deposit ? S.fromReceived : S.fromCredits}</dd>
        <dt className="al-muted">{S.toLabel}</dt>
        <dd>
          {deposit ? (
            S.toCredits
          ) : (
            <>
              {S.toOwnAccount}
              <code className="pf-address al-text-code">{move.net.address}</code>
            </>
          )}
        </dd>
        <dt className="al-muted">{S.networkLabel}</dt>
        <dd>{name}</dd>
      </dl>
      <p className="al-text-caption al-muted">{deposit ? S.reserveNote : S.withdrawNote}</p>
      <form className="pf-confirm-form" onSubmit={submit}>
        <TextField
          label={S.ownerCode}
          hint={EARLIER_OWNER_CODE_HINT}
          type="password"
          autoComplete="off"
          mono
          value={code}
          onChange={(e) => setCode(e.currentTarget.value)}
        />
        {line === undefined ? null : (
          <p className="al-text-body-sm" role="alert">
            {line}
          </p>
        )}
        <div className="pf-confirm-actions">
          <Button type="submit" variant="primary" disabled={busy || code.length === 0}>
            {busy ? S.working : S.confirm}
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            {S.cancel}
          </Button>
        </div>
      </form>
    </section>
  );
}
