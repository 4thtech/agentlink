// OWNER-START-OVER (D-153; 04 §2.5.4; 11 §5): "Forgot your master code? Start over on this
// computer", in the focused shell at /restore/start-over (the restore wizard's column and styles,
// D-116: no new design). Three screens of one page:
//   warn     what is lost and what is kept; Restore from recovery kit first (D-147)
//   confirm  type "start over", then the OS gesture (desktop: Touch ID / Windows Hello, run by the
//            server; browser: a user-verified passkey creation)
//   result   done (go to first run), partial (what failed, Try again), or a fixed problem line
// The page sends only the phrase, the nonce and the creation. It never reads or shows a key, and the
// server checks the phrase and the gesture again (a page that lies gains nothing).
import { Banner, Button, InlineError, Lockup } from '@4thtech-io/ui';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { START_PATH } from '../../nav.js';
import { desktopPlatform, nativeSensor, type DesktopPlatform } from '../../presence/desktop.js';
import { detectPlatform } from '../first-run/passkey.js';
import { SENSOR } from '../first-run/strings.js';
import { useTitleFocus } from '../welcome/index.js';
import { markLeavingStart } from '../start/guard.js';
import { createStartOverApi, type StartOverApi, type StartOverOutcome } from './api.js';
import {
  AGAIN,
  CONFIRM,
  DONE,
  PARTIAL,
  PHRASE,
  PROBLEM_TEXT,
  STORE_WORD,
  UNFINISHED,
  WARN,
} from './strings.js';
import '../restore/restore.css';

/** The page's path (the focused shell, like the restore wizard). */
export const START_OVER_PATH = '/restore/start-over';

export interface StartOverPageProps {
  readonly api?: StartOverApi;
  /** Test seam: leaves the page (Restore, Set up AgentLink, Back). Default: a full load. */
  readonly onLeave?: (to: string) => void;
  /** Test seam: inside the desktop app on this platform (default: the window's marker). */
  readonly desktop?: DesktopPlatform | undefined;
}

function leaveDefault(to: string): void {
  markLeavingStart();
  window.location.assign(to);
}

const normalized = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, ' ');

type View = 'warn' | 'confirm' | 'again' | 'working' | 'result';

function Title({ children }: { readonly children: string }): ReactElement {
  const ref = useTitleFocus<HTMLHeadingElement>(children);
  return (
    <h1 id="so-h" ref={ref} tabIndex={-1} className="rs-title">
      {children}
    </h1>
  );
}

interface ResultProps {
  readonly outcome: StartOverOutcome | undefined;
  /** The sensor word for "{sensor} didn't confirm it's you". */
  readonly sensor: string;
  /** Keychain, Credential Manager, … */
  readonly store: string;
  readonly onRetry: () => void;
  readonly onLeave: (to: string) => void;
}

function Result({ outcome: o, sensor, store, onRetry, onLeave }: ResultProps): ReactElement {
  if (o?.kind === 'done' && o.earlierOnly === true) {
    return (
      <section className="rs-screen" aria-labelledby="so-h" data-screen="done-earlier">
        <div className="rs-intro">
          <Title>{DONE.earlierTitle}</Title>
          <p className="rs-lead">{DONE.earlier}</p>
        </div>
        <div className="rs-actions">
          <Button variant="primary" size="lg" onClick={() => onLeave('/')}>
            {WARN.back}
          </Button>
        </div>
      </section>
    );
  }
  if (o?.kind === 'done') {
    return (
      <section className="rs-screen" aria-labelledby="so-h" data-screen="done">
        <div className="rs-intro">
          <Title>{DONE.title}</Title>
          {o.backup === null ? null : <p className="rs-lead">{DONE.backup(o.backup)}</p>}
        </div>
        <Banner tone="warning" title={DONE.appsTitle}>
          {DONE.apps}
        </Banner>
        <p className="al-text-body-sm al-muted">{DONE.passkeys}</p>
        <div className="rs-actions">
          <Button variant="primary" size="lg" onClick={() => onLeave(START_PATH)}>
            {DONE.next}
          </Button>
        </div>
      </section>
    );
  }
  const retry = (
    <Button variant="primary" size="lg" onClick={onRetry}>
      {PARTIAL.retry}
    </Button>
  );
  if (o?.kind === 'partial') {
    const keychain = o.failed === 'keychain';
    return (
      <section className="rs-screen" aria-labelledby="so-h" data-screen="partial">
        <div className="rs-intro">
          <Title>{keychain ? PARTIAL.keychainTitle : PARTIAL.moveTitle}</Title>
        </div>
        <Banner tone="warning">
          {keychain ? PARTIAL.keychain(o.backup, store) : PARTIAL.move}
        </Banner>
        <div className="rs-actions">{retry}</div>
      </section>
    );
  }
  const problem = o?.kind === 'error' ? o.problem : 'failed';
  const text =
    problem === 'presence_rejected'
      ? PROBLEM_TEXT.presence_rejected(sensor)
      : problem === 'wait'
        ? PROBLEM_TEXT.wait(o?.kind === 'error' ? (o.retryAfter ?? 60) : 60)
        : PROBLEM_TEXT[problem];
  const dead = problem === 'open_app' || problem === 'unsupported';
  return (
    <section className="rs-screen" aria-labelledby="so-h" data-screen="problem">
      <div className="rs-intro">
        <Title>{PARTIAL.moveTitle}</Title>
      </div>
      <Banner tone="danger">{text}</Banner>
      <div className="rs-actions">
        {dead ? (
          <Button variant="primary" size="lg" onClick={() => onLeave('/')}>
            {WARN.back}
          </Button>
        ) : (
          retry
        )}
      </div>
    </section>
  );
}

export function StartOverPage(props: StartOverPageProps): ReactElement {
  const [api] = useState(() => props.api ?? createStartOverApi());
  const leave = props.onLeave ?? leaveDefault;
  const desktop = 'desktop' in props ? props.desktop : desktopPlatform();
  const platform = desktop ?? detectPlatform();
  const sensor = desktop === undefined ? undefined : nativeSensor(desktop);
  const store = STORE_WORD[platform];
  const [view, setView] = useState<View>('warn');
  const [typed, setTyped] = useState('');
  const [outcome, setOutcome] = useState<StartOverOutcome | undefined>(undefined);
  const [unfinished, setUnfinished] = useState(false);
  const fieldId = useId();
  const againId = useId();
  const [second, setSecond] = useState('');
  const answerAgain = useRef<((value: string | undefined) => void) | undefined>(undefined);
  const [typedHere, setTypedHere] = useState(false);

  useEffect(() => {
    let live = true;
    void api.state().then((state) => {
      if (!live) return;
      if (state?.unfinished === true) setUnfinished(true);
      // Desktop app without Touch ID or Windows Hello: the second typing instead of a sheet.
      if (state?.presence === 'typed' && desktop !== undefined) setTypedHere(true);
    });
    return () => {
      live = false;
    };
  }, [api, desktop]);

  const ready = normalized(typed) === PHRASE;

  /**
   * Owner decision (14 Nov 2026): with no sensor, the second typing on its own step. The field
   * starts empty every time and is never filled from the first one.
   */
  function askAgain(): Promise<string | undefined> {
    return new Promise((resolve) => {
      answerAgain.current = resolve;
      setSecond('');
      setView('again');
    });
  }

  function settleAgain(value: string | undefined): void {
    const resolve = answerAgain.current;
    answerAgain.current = undefined;
    setSecond('');
    setView('working');
    resolve?.(value);
  }

  /** begin, the gesture (or the second typing), finish. The phrase was typed on this page first. */
  async function run(): Promise<void> {
    setView('working');
    const result = await api.run(PHRASE, { confirm: askAgain });
    setOutcome(result);
    setView(result.kind === 'error' && result.problem === 'phrase' ? 'confirm' : 'result');
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (ready) void run();
  }

  function retry(): void {
    // A keychain step that did not finish is retried at once (the phrase was typed); anything
    // else asks for the phrase and the gesture again.
    if (outcome?.kind === 'partial' && outcome.failed === 'keychain') {
      void run();
      return;
    }
    setTyped('');
    setOutcome(undefined);
    setView('confirm');
  }

  let screen: ReactElement;
  if (view === 'warn') {
    screen = (
      <section className="rs-screen" aria-labelledby="so-h" data-screen="warn">
        <div className="rs-intro">
          <p className="rs-kicker">{WARN.kicker}</p>
          <Title>{unfinished ? UNFINISHED.title : WARN.title}</Title>
          <p className="rs-lead">{unfinished ? UNFINISHED.lead : WARN.lead}</p>
        </div>
        {unfinished ? null : (
          <Banner tone="warning" title={WARN.lostTitle}>
            <ul className="rs-list">
              {WARN.lost.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </Banner>
        )}
        <p className="al-text-body-sm al-muted">{WARN.kept(store)}</p>
        <div className="rs-actions">
          <Button variant="primary" size="lg" onClick={() => leave('/restore/kit')}>
            {WARN.restore}
          </Button>
          <Button variant="ghost" size="lg" onClick={() => setView('confirm')} data-go-on="">
            {unfinished ? UNFINISHED.title : WARN.goOn}
          </Button>
        </div>
      </section>
    );
  } else if (view === 'again') {
    const againReady = normalized(second) === PHRASE;
    screen = (
      <section className="rs-screen" aria-labelledby="so-h" data-screen="again">
        <div className="rs-intro">
          <Title>{AGAIN.title}</Title>
          <p className="rs-lead">{AGAIN.lead}</p>
        </div>
        <form
          className="al-field"
          onSubmit={(event) => {
            event.preventDefault();
            if (againReady) settleAgain(second);
          }}
          autoComplete="off"
        >
          <label className="al-field-label" htmlFor={againId}>
            {AGAIN.label}
          </label>
          {/* Its own empty field: never filled from the first one, no placeholder to copy. */}
          <input
            id={againId}
            name="start-over-again"
            className="al-input"
            type="text"
            value={second}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(event) => setSecond(event.target.value)}
          />
          <div className="rs-actions">
            <Button variant="danger" size="lg" type="submit" disabled={!againReady}>
              {AGAIN.button}
            </Button>
            <Button variant="ghost" size="lg" onClick={() => settleAgain(undefined)}>
              {CONFIRM.back}
            </Button>
          </div>
        </form>
      </section>
    );
  } else if (view === 'result') {
    screen = (
      <Result
        outcome={outcome}
        sensor={sensor ?? SENSOR[platform]}
        store={store}
        onRetry={retry}
        onLeave={leave}
      />
    );
  } else {
    const working = view === 'working';
    const problem =
      outcome?.kind === 'error' && outcome.problem === 'phrase' ? PROBLEM_TEXT.phrase : undefined;
    screen = (
      <section className="rs-screen" aria-labelledby="so-h" data-screen="confirm">
        <div className="rs-intro">
          <Title>{CONFIRM.title}</Title>
          <p className="rs-lead">{CONFIRM.hint}</p>
        </div>
        <form className="al-field" onSubmit={submit} autoComplete="off">
          <label className="al-field-label" htmlFor={fieldId}>
            {CONFIRM.label}
          </label>
          <input
            id={fieldId}
            className="al-input"
            type="text"
            value={typed}
            disabled={working}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder={PHRASE}
            onChange={(event) => setTyped(event.target.value)}
          />
          {sensor === undefined ? (
            <p className="al-text-body-sm al-muted">{CONFIRM.browserNote}</p>
          ) : null}
          {problem === undefined ? null : <InlineError>{problem}</InlineError>}
          <div className="rs-actions">
            <Button variant="danger" size="lg" type="submit" disabled={!ready || working}>
              {working ? CONFIRM.working : typedHere ? CONFIRM.next : CONFIRM.button(sensor)}
            </Button>
            <Button variant="ghost" size="lg" onClick={() => setView('warn')} disabled={working}>
              {CONFIRM.back}
            </Button>
          </div>
        </form>
      </section>
    );
  }

  return (
    <div className="rs-wizard">
      <header className="rs-head">
        <Lockup size={22} />
        <div className="rs-head-end">
          <button
            type="button"
            className="rs-cancel al-text-body-sm"
            onClick={() => leave('/')}
            disabled={view === 'working'}
          >
            {WARN.back}
          </button>
        </div>
      </header>
      <div className="rs-body">{screen}</div>
    </div>
  );
}
