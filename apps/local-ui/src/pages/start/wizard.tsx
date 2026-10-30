// W4-WIZARD (W4 UX v2 layer 1; owner-approved artboards A1 "Get started: pick and connect", A2
// "Connected", A3 "Invite someone"): the frame and the steps that hold no secret. The frame is the
// focused column's own header: the brand, a four-segment progress bar with "Step n of 4 · …" and
// "Skip to Home" on every step. The connect step's gesture lives in the first-run page (it holds the
// one-time backup code); this file only draws.
//
// Motion comes from the U0 kit only (al-reveal, al-pop, al-draw, al-press); under reduced motion the
// kit turns every one into a fade. Names from the server (an app, the agent) are rendered as text.
import { Button, Icon, Lockup, Skeleton } from '@4thtech-io/ui';
import type { MouseEvent, ReactElement, ReactNode } from 'react';
import { useTitleFocus } from '../welcome/index.js';
import type { DetectedApp } from '../first-run/apps-api.js';
import { skipToHome } from './guard.js';
import {
  CONNECTED_STEP as D,
  INVITE_STEP as I,
  PICK_STEP as P,
  STEP_IDS,
  WIZARD as W,
  type StepId,
} from './strings.js';
import './start.css';

/** The path of a step. */
export const stepPath = (step: StepId): string => `/start/${step}`;

/** The step a path shows; anything else under `/start` is step 1. */
export function stepOf(path: string): StepId {
  const id = path.replace(/^\/start\//, '');
  return (STEP_IDS as readonly string[]).includes(id) ? (id as StepId) : 'app';
}

/** The four segments: done, current, to do. */
function Segments({ step }: { readonly step: StepId }): ReactElement {
  const at = STEP_IDS.indexOf(step);
  return (
    <span className="st-segs" aria-hidden="true">
      {STEP_IDS.map((id, i) => (
        <span
          key={id}
          className="st-seg"
          data-state={i < at ? 'done' : i === at ? 'current' : 'todo'}
        />
      ))}
    </span>
  );
}

export interface WizardFrameProps {
  readonly step: StepId;
  readonly children?: ReactNode;
  /** Test seam: where "Skip to Home" goes. Default: Home, in the app. */
  readonly onSkip?: () => void;
}

/** The focused column's header and the step under it. */
export function WizardFrame({ step, children, onSkip }: WizardFrameProps): ReactElement {
  const n = STEP_IDS.indexOf(step) + 1;
  const label = W.stepLabel(n, W.stepNames[step]);
  const skip = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (onSkip !== undefined) onSkip();
    else skipToHome();
  };
  return (
    <div className="st-wizard">
      <header className="st-head">
        <Lockup size={22} />
        <div className="st-head-end">
          <span
            className="st-progress"
            role="progressbar"
            aria-label={W.progressLabel}
            aria-valuemin={1}
            aria-valuemax={4}
            aria-valuenow={n}
            aria-valuetext={label}
          >
            <Segments step={step} />
            <span className="st-eyebrow">{label}</span>
          </span>
          <a className="st-skip al-text-body-sm" href="/" onClick={skip}>
            {W.skip}
          </a>
        </div>
      </header>
      <div className="st-body">{children}</div>
    </div>
  );
}

/** One tile of step 1: an AI app, found here or not yet. */
export interface AppTile {
  readonly id: string;
  readonly name: string;
  readonly found: boolean;
  /** Already runs the open agent (Connect another AI app): shown, not picked again. */
  readonly connected: boolean;
}

/** The apps the tiles always offer, in order, when the look did not find them (A1). */
export const KNOWN_APPS: readonly { readonly id: string; readonly name: string }[] = [
  { id: 'claude-code', name: 'Claude Code' },
  { id: 'cursor', name: 'Cursor' },
  { id: 'claude-desktop', name: 'Claude Desktop' },
  { id: 'codex', name: 'Codex' },
];

/** The tiles: every found app first (in the look's order), then the known apps not found yet. */
export function appTiles(found: readonly DetectedApp[] | undefined, agent?: string): AppTile[] {
  const tiles: AppTile[] = (found ?? []).map((a) => ({
    id: a.id,
    name: a.name,
    found: true,
    connected: agent !== undefined && a.state === 'connected' && a.agent === agent,
  }));
  for (const known of KNOWN_APPS) {
    if (!tiles.some((t) => t.id === known.id))
      tiles.push({ ...known, found: false, connected: false });
  }
  return tiles;
}

/** The app picked by default: the first found one not connected yet, else the first one. */
export function defaultChoice(tiles: readonly AppTile[]): string {
  return (tiles.find((t) => t.found && !t.connected) ?? tiles.find((t) => !t.connected))?.id ?? '';
}

function TerminalGlyph(): ReactElement {
  return (
    <span className="st-tile-icon" aria-hidden="true">
      <Icon name="terminal" size={18} />
    </span>
  );
}

export interface PickStepProps {
  readonly tiles: readonly AppTile[] | 'loading';
  readonly choice: string;
  readonly onChoose: (id: string) => void;
  readonly onContinue: () => void;
  readonly eyebrow?: string;
  /** The look for apps gave no answer: a plain line; the tiles still work. */
  readonly lookFailed?: boolean;
  /** Mac: "Found on this Mac"; elsewhere "Found on this computer". */
  readonly mac?: boolean;
}

/** A1, step 1: "Which AI app do you use?" with one tile per app and "Continue with {app}". */
export function PickStep({
  tiles,
  choice,
  onChoose,
  onContinue,
  eyebrow = P.eyebrow,
  lookFailed = false,
  mac = true,
}: PickStepProps): ReactElement {
  const title = useTitleFocus<HTMLHeadingElement>();
  const picked = tiles === 'loading' ? undefined : tiles.find((t) => t.id === choice);
  return (
    <section className="st-screen st-w-640" aria-labelledby="st-h">
      <div className="st-intro">
        <span className="st-eyebrow">{eyebrow}</span>
        <h1 id="st-h" ref={title} tabIndex={-1} className="st-title">
          {P.title}
        </h1>
        <p className="st-lead">{P.body}</p>
      </div>
      {tiles === 'loading' ? (
        // The same four tiles while the look runs, so nothing moves when it answers (CLS).
        <div className="st-tiles" aria-busy="true" aria-label={P.loading}>
          {KNOWN_APPS.map((t) => (
            <div key={t.id} className="st-tile is-loading">
              <span className="st-tile-top">
                <TerminalGlyph />
              </span>
              <span className="st-tile-name">{t.name}</span>
              <Skeleton loading label={P.loading} lines={1} />
            </div>
          ))}
        </div>
      ) : (
        <div className="st-tiles" role="group" aria-labelledby="st-h">
          {tiles.map((t) => {
            const selected = t.id === choice;
            return (
              <button
                key={t.id}
                type="button"
                className="st-tile al-press"
                aria-pressed={selected}
                disabled={t.connected}
                data-selected={selected ? 'true' : undefined}
                onClick={() => onChoose(t.id)}
              >
                <span className="st-tile-top">
                  <TerminalGlyph />
                  {selected ? (
                    <span className="st-tile-check al-pop" aria-hidden="true">
                      <Icon name="check" size={14} strokeWidth={3} />
                    </span>
                  ) : null}
                </span>
                <span className="st-tile-name">{t.name}</span>
                {t.connected ? (
                  <span className="st-tile-state is-found">{P.connected}</span>
                ) : t.found ? (
                  <span className="st-tile-state is-found">
                    <span className="st-dot" aria-hidden="true" />
                    {mac ? P.found : P.foundElsewhere}
                  </span>
                ) : (
                  <span className="st-tile-state">{P.notFound}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
      <div className="st-actions">
        <Button
          variant="primary"
          size="lg"
          className="al-press"
          disabled={picked === undefined}
          onClick={onContinue}
        >
          {P.next(picked?.name ?? '')}
        </Button>
        {/* One line either way, so a failed look moves nothing. */}
        <p className="st-note" role="status">
          {lookFailed ? P.lookFailed : P.later}
        </p>
      </div>
    </section>
  );
}

/** The back control of step 2 (A1). */
export function BackButton({ onBack, label }: { onBack: () => void; label: string }): ReactElement {
  return (
    <button type="button" className="st-back" onClick={onBack}>
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="m15 18-6-6 6-6" />
      </svg>
      {label}
    </button>
  );
}

/** The agent card of step 2: its letter, its name, "Will work in {app}". */
export function AgentCard({
  name,
  line,
  action,
}: {
  readonly name: string;
  readonly line: string;
  readonly action?: ReactNode;
}): ReactElement {
  return (
    <div className="st-agent">
      <span className="st-agent-letter" aria-hidden="true">
        {[...name][0]?.toUpperCase() ?? ''}
      </span>
      <span className="st-agent-words">
        <span className="st-agent-name">{name}</span>
        <span className="st-note">{line}</span>
      </span>
      {action}
    </div>
  );
}

/** The fingerprint glyph of "Connect with Touch ID" (A1; Lucide, as the prototype). */
export function FingerprintGlyph(): ReactElement {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4" />
      <path d="M14 13.12c0 2.38 0 6.38-1 8.88" />
      <path d="M17.29 21.02c.12-.6.43-2.3.5-3.02" />
      <path d="M2 12a10 10 0 0 1 18-6" />
      <path d="M2 16h.01" />
      <path d="M21.8 16c.2-2 .131-5.354 0-6" />
      <path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2" />
      <path d="M8.65 22c.21-.66.45-1.32.57-2" />
      <path d="M9 6.8a6 6 0 0 1 9 5.2v2" />
    </svg>
  );
}

export interface ConnectedStepProps {
  /** The agent's name (text). */
  readonly label: string;
  /** The app and whether its entry was written (E1: false keeps the agent and offers Connect). */
  readonly app?: { readonly name: string; readonly connected: boolean };
  readonly onInvite: () => void;
  readonly onHome: () => void;
  /** E1: connect the app now (the ordinary signed AI apps step). */
  readonly onConnect?: () => void;
}

/** A2, step 3: the Connected ✓ moment, or E1's "{agent} is ready" with Connect. */
export function ConnectedStep({
  label,
  app,
  onInvite,
  onHome,
  onConnect,
}: ConnectedStepProps): ReactElement {
  const title = useTitleFocus<HTMLHeadingElement>();
  const connected = app?.connected === true;
  const appName = app?.name;
  return (
    <section className="st-screen st-w-520 st-center" aria-labelledby="st-h">
      <div
        className={`st-done al-pop${connected ? '' : ' is-pending'}`}
        aria-hidden="true"
        data-state={connected ? 'connected' : 'pending'}
      >
        {connected ? (
          <svg
            className="al-draw"
            width="34"
            height="34"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.25"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        ) : (
          <Icon name="agent" size={30} />
        )}
      </div>
      <div className="st-intro st-center al-reveal st-delay-1" role="status">
        <h1 id="st-h" ref={title} tabIndex={-1} className="st-title">
          {connected && appName !== undefined ? D.title(appName) : D.notConnectedTitle(label)}
        </h1>
        <p className="st-lead">
          {connected || appName === undefined ? D.body : D.notConnectedBody(appName)}
        </p>
      </div>
      <div className="st-row al-reveal st-delay-2">
        {!connected && appName !== undefined && onConnect !== undefined ? (
          <Button variant="primary" size="lg" className="al-press" onClick={onConnect}>
            {D.connect(appName)}
          </Button>
        ) : (
          <Button
            variant="primary"
            size="lg"
            icon="user-plus"
            className="al-press"
            onClick={onInvite}
          >
            {D.invite}
          </Button>
        )}
        <Button variant="secondary" size="lg" onClick={onHome}>
          {D.home}
        </Button>
      </div>
      {connected && appName !== undefined ? (
        <>
          <p className="st-note">{D.restart(appName)}</p>
          <div className="st-then">
            <span className="st-eyebrow">{D.then}</span>
            <span>{D.example(appName)}</span>
          </div>
        </>
      ) : null}
    </section>
  );
}

export interface InviteStepProps {
  /** U4's invite panel, once it exists; until then a link to where invites are made. */
  readonly panel?: ReactNode;
  /** Where invites are made today (People). */
  readonly inviteHref: string;
  readonly onHome: () => void;
}

/** A3, step 4 (optional): invite someone; "Skip for now" and "Done, go to Home". */
export function InviteStep({ panel, inviteHref, onHome }: InviteStepProps): ReactElement {
  const title = useTitleFocus<HTMLHeadingElement>();
  return (
    <section className="st-screen st-w-600" aria-labelledby="st-h">
      <div className="st-intro">
        <h1 id="st-h" ref={title} tabIndex={-1} className="st-title-2">
          {I.title}
        </h1>
        <p className="st-lead">{I.body}</p>
      </div>
      {panel ?? (
        <div className="st-panel al-reveal st-delay-1">
          <a className="al-btn al-btn-primary al-btn-lg al-press" href={inviteHref}>
            <Icon name="user-plus" size={18} />
            {I.create}
          </a>
        </div>
      )}
      <div className="st-row st-end">
        <Button variant="ghost" size="lg" onClick={onHome}>
          {I.skip}
        </Button>
        <Button variant="secondary" size="lg" onClick={onHome}>
          {I.done}
        </Button>
      </div>
    </section>
  );
}
