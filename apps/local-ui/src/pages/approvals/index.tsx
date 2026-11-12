// M1-11b-2: Approvals in the app (08 §1; 11 §6.2.1; 04 §2.5, §2.5.2, §2.5.3; D-68, D-118, D-132).
// Ported from the server-rendered approval page, removed in M1-11b-2c (a server without the app
// bundle now shows a fixed page that points to the terminal). Same routes, words and rules:
//
// - "Waiting for you (n)": the pending requests, soonest to expire first, at most 20. A plain
//   request offers Approve, Deny or Later; one button names exactly what is included. Before asking
//   for presence the page checks the list again, leaves out what is no longer waiting (or changed),
//   says so and shows "This covers exactly these n"; then one passkey gesture or one master code.
// - A commitment (D-31) and a request that costs credits (04 §2.5.3 rule 7) are never list items:
//   each is its own card with its own Approve and Deny; the paid one approves through the sheet.
// - Before the owner is set up nothing can be approved, with the reason. The switch to a passkey is
//   the layout's next-step banner (M1-UX-FIRSTRUN-V2-c); where passkeys can't work, the page says
//   the master code is the way.
// - Every server value is React text (I-5). The browser never signs (D-118).
// - UI-REFRESH-o (visual only): cards on level 1, the one being decided on level 2; the shared
//   Skeleton on first load; the approved moment after a review that approved something. What is
//   sent, when presence is asked and what the owner sees are unchanged (approvals.test.ts).
// - UI-REFRESH-o-b: an approved card collapses out and leaves its result as a line of text; the
//   sidebar badge is told how many still wait (a number only; badge.ts).
// - UI-REFRESH-o-c: a denied card leaves the same way and leaves "Denied: <summary>".
// - UX2-a (B-11 §26): the cards sit in a grid (default) or today's single column, chosen with the
//   "Layout" control in the title row and remembered in the prefs store. Layout only: the cards'
//   content and order, presence, the decide calls and the leave after a decision are unchanged.
// - W4-HOME (Decisions 47–50): `/` is Home now. `ApprovalsPage` (the page the router puts at `/`,
//   where every approval link points) renders Home, whose card on top carries the approvals; the
//   full list above stays as `ApprovalsBoard` in board.tsx (its tests keep the review-together
//   rules); nothing imports it at runtime, so neither it nor board.css is in the app bundle.
import { HomeScreen } from '../home/home-screen.js';
import { CONTACTS_CHANGED } from '../../api/contact-changes.js';
import { GetStartedCard } from '../start/get-started-card.js';
import { FinishSetupCard } from '../start/finish-setup-card.js';
import {
  invitedBefore,
  readSetupState,
  rememberInvited,
  startProgress,
  type Progress,
  type SetupState,
} from '../start/setup-state.js';
import { Button, PageNotice, type PayPlatform } from '@4thtech-io/ui';
import { inDesktopApp } from '../../desktop.js';
import { noticeKey, useDismissed } from '../../notices/index.js';
import { detectPlatform } from '../first-run/passkey.js';
import { SENSOR } from '../first-run/strings.js';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from 'react';
import { getLive, subscribeLive } from '../../api/live.js';
import type { PayConfirmClient } from '../../pay-confirm/index.js';
import type { OwnerState } from './card.js';
import { createApprovalsClient, type ApprovalsClient } from './client.js';
import { APPROVAL_STRINGS as S, fmt } from './strings.js';
import './approvals.css';

export { APPROVAL_TTL } from './card.js';

export interface ApprovalsPageProps {
  readonly client?: ApprovalsClient;
  readonly payConfirm?: PayConfirmClient;
  /** Whether this browser can use a passkey. Default: detected. */
  readonly canPasskey?: boolean;
  readonly platform?: PayPlatform;
  readonly reducedMotion?: boolean;
  /** W4-WIRE: the real setup state for the Get started card on Home. Default: the app's reads. */
  readonly readSetup?: () => Promise<SetupState>;
  /** The desktop app's native presence, when it offers one (a slot; see OwnerPanel). */
  readonly nativePresence?: NativePresenceSlot;
}

export function browserPasskeys(): boolean {
  return (
    typeof window !== 'undefined' &&
    'PublicKeyCredential' in window &&
    typeof navigator !== 'undefined' &&
    navigator.credentials !== undefined
  );
}

export interface OwnerView extends OwnerState {
  /** The server offers a localhost passkey (registered or not). */
  readonly offered: boolean;
  /** R1-UI-13: the read failed, so nothing is known about the passkey (not "no passkey here"). */
  readonly unknown?: boolean;
  /** Reads again (the notice's Try again). */
  readonly retry?: () => void;
}

/** Reads the owner and the decision passkey once; undefined while loading. */
export function useOwner(client: ApprovalsClient, canPasskey: boolean): OwnerView | undefined {
  const [owner, setOwner] = useState<OwnerView | undefined>(undefined);
  const [again, setAgain] = useState(0);
  useEffect(() => {
    let live = true;
    void client.passkey().then((answer) => {
      if (!live) return;
      if (answer.kind === 'needs_owner') setOwner({ ready: false, offered: false });
      else if (answer.kind === 'unknown') {
        setOwner({
          ready: true,
          offered: false,
          unknown: true,
          retry: () => setAgain((n) => n + 1),
        });
      } else {
        setOwner({
          ready: true,
          offered: answer.offered,
          ...(canPasskey && answer.passkey !== undefined ? { passkey: answer.passkey } : {}),
        });
      }
    });
    return () => {
      live = false;
    };
  }, [client, canPasskey, again]);
  return owner;
}

/**
 * UX 2026-11-12 (notices): the desktop app's native owner presence (Touch ID, Windows Hello), when
 * the desktop build offers it. A slot only: this page never registers or uses it itself.
 */
export interface NativePresenceSlot {
  /** The sensor's name for the copy ("Touch ID"); the platform's when absent. */
  readonly sensor?: string;
  /** Starts the desktop app's own "turn on" flow (owner presence stays with the desktop app). */
  readonly turnOn: () => void;
}

/** The open ID's name (not its label), for remembering a dismissal per ID. */
function useOpenIdName(): string | undefined {
  const snap = useSyncExternalStore(subscribeLive, getLive, () => LIVE_EMPTY);
  return snap.agents.find((a) => a.current)?.name;
}

/**
 * Owner set up? If not, the reason (a page notice that stays until it is done). Set up but with no
 * passkey here: one calm page notice, closable (remembered per ID), in words that fit where it
 * runs. The desktop app is never "this browser": it offers its own sensor when it has one, else it
 * says the master code is how approvals are confirmed.
 */
export function OwnerPanel({
  owner,
  canPasskey,
  needsOwnerOnly = false,
  desktop = inDesktopApp(),
  nativePresence,
}: {
  owner: OwnerView;
  canPasskey: boolean;
  needsOwnerOnly?: boolean;
  /** Test seam: running in the desktop app. Default: its user-agent marker. */
  desktop?: boolean;
  nativePresence?: NativePresenceSlot | undefined;
}): ReactElement | null {
  const id = useOpenIdName();
  const [dismissed, dismiss] = useDismissed(noticeKey('protect-approvals', id));
  if (!owner.ready) {
    return (
      <PageNotice tone="warning" icon="key-round" title={S.needsOwnerTitle}>
        <p>{S.needsOwner}</p>
      </PageNotice>
    );
  }
  // R1-UI-13: a failed read says so and offers a retry; it never claims passkeys are missing.
  if (owner.unknown === true) {
    return (
      <PageNotice
        tone="warning"
        icon="key-round"
        title={S.checkFailedTitle}
        {...(owner.retry === undefined
          ? {}
          : {
              actions: (
                <Button size="sm" onClick={owner.retry}>
                  {S.retry}
                </Button>
              ),
            })}
      >
        <p>{S.checkFailed}</p>
      </PageNotice>
    );
  }
  if (needsOwnerOnly || owner.passkey !== undefined || dismissed) return null;
  if (desktop) {
    if (nativePresence !== undefined) {
      const sensor = nativePresence.sensor ?? SENSOR[detectPlatform()];
      return (
        <PageNotice
          tone="info"
          icon="approval"
          title={fmt(S.nativeTitle, { sensor })}
          actions={
            <Button size="sm" variant="primary" onClick={nativePresence.turnOn}>
              {fmt(S.nativeAction, { sensor })}
            </Button>
          }
          onDismiss={dismiss}
          dismissLabel={S.hideNotice}
        >
          <p>{fmt(S.nativeBody, { sensor })}</p>
        </PageNotice>
      );
    }
    return (
      <PageNotice
        tone="neutral"
        icon="key-round"
        title={S.protectedTitle}
        onDismiss={dismiss}
        dismissLabel={S.hideNotice}
      >
        <p>{S.protectedBody}</p>
      </PageNotice>
    );
  }
  // A passkey can be set up here: the layout's "Switch to …" notice is the one place to start.
  if (canPasskey && owner.offered) return null;
  return (
    <PageNotice
      tone="info"
      icon="key-round"
      title={S.firstRunTitle}
      onDismiss={dismiss}
      dismissLabel={S.hideNotice}
    >
      <p>{S.firstRun}</p>
      <p>
        {S.noPasskeys} {S.desktopNote}
      </p>
    </PageNotice>
  );
}

/**
 * What a decided card left behind once it collapsed out (UI-REFRESH-o-b, o-c): plain text a screen
 * reader can reach. Not a live region: the card's own status line already said it. When the card
 * took the focus with it, the focus lands on the line, never on a button.
 */
export function Results({ lines }: { lines: readonly string[] }): ReactElement | null {
  const last = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (lines.length === 0) return;
    const active = document.activeElement;
    if (active === null || active === document.body) last.current?.focus();
  }, [lines.length]);
  if (lines.length === 0) return null;
  return (
    <>
      {lines.map((line, i) => (
        <p
          key={i}
          ref={i === lines.length - 1 ? last : undefined}
          className="al-status ap-result"
          tabIndex={-1}
        >
          {line}
        </p>
      ))}
    </>
  );
}

/**
 * The page head every approvals view shares. `end` sits at the end of the title row (the Approvals
 * page's Layout control, B-11 §26.2); without it the head is unchanged.
 */
const LIVE_EMPTY = { list: undefined, agents: [], error: false };

/** F29: the display name of the open ID, which every approval here is for (text only, I-5). */
function useOpenIdLabel(): string | undefined {
  const snap = useSyncExternalStore(subscribeLive, getLive, () => LIVE_EMPTY);
  const label = snap.list?.label ?? snap.agents.find((a) => a.current)?.label;
  return label === undefined || label.trim() === '' ? undefined : label;
}

export function ApprovalsHead({ end }: { end?: ReactNode } = {}): ReactElement {
  const forId = useOpenIdLabel();
  return (
    <>
      {end === undefined ? (
        <h1 className="al-text-title-1">{S.appTitle}</h1>
      ) : (
        <div className="ap-title-row">
          <h1 className="al-text-title-1">{S.appTitle}</h1>
          {end}
        </div>
      )}
      <p className="al-lede">{S.cannotApprove}</p>
      {forId === undefined ? null : (
        <p className="al-lede" data-approval-for>
          {S.forId}
          <bdi>{forId}</bdi>
        </p>
      )}
    </>
  );
}

/** W4-WIRE: how long Home waits for the Get started read before it shows without the card. */
export const START_READ_WAIT_MS = 1500;

/**
 * W4-WIRE: the Get started card's progress, read before Home shows (Home holds its skeleton until
 * then), so the card is there from the first frame and never arrives late to move the page.
 * undefined while reading; null when there is no card (an unanswered or late read: nothing shows).
 */
export function useStartProgress(read: () => Promise<SetupState>): Progress | null | undefined {
  const [progress, setProgress] = useState<Progress | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const settle = (p: Progress | null): void => {
      if (live) setProgress((now) => (now === undefined ? p : now));
    };
    // R1-UI-10: the card follows the real state (a person accepted while Home is open); an answer
    // that came later replaces the first one, an unanswered read keeps what is shown.
    const again = (): void => {
      read().then(
        (state) => {
          const p = startProgress(state, invitedBefore());
          if (p.steps.find((s) => s.id === 'invite')?.done === true) rememberInvited();
          if (live) setProgress(p);
        },
        () => undefined,
      );
    };
    const timer = setTimeout(() => settle(null), START_READ_WAIT_MS);
    read().then(
      (state) => {
        const p = startProgress(state, invitedBefore());
        if (p.steps.find((s) => s.id === 'invite')?.done === true) rememberInvited();
        settle(p);
      },
      () => settle(null),
    );
    const every = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) again();
    }, START_REFRESH_MS);
    window.addEventListener(CONTACTS_CHANGED, again);
    return () => {
      live = false;
      clearTimeout(timer);
      clearInterval(every);
      window.removeEventListener(CONTACTS_CHANGED, again);
    };
  }, [read]);
  return progress;
}

/** R1-UI-10: how often the Get started card reads the real state again while Home is open. */
export const START_REFRESH_MS = 10_000;

/** `/`: Home (W4-HOME), with the approvals as the card on top. */
export function ApprovalsPage({
  client,
  payConfirm,
  canPasskey,
  platform,
  reducedMotion,
  readSetup = readSetupState,
  nativePresence,
}: ApprovalsPageProps): ReactElement {
  // The owner's state, as the list showed it: not set up yet (nothing can be approved, with the
  // reason) or no passkeys in this browser (the master code is the way).
  const approvals = useMemo(() => client ?? createApprovalsClient(), [client]);
  const passkeys = canPasskey ?? browserPasskeys();
  const owner = useOwner(approvals, passkeys);
  const started = useStartProgress(readSetup);
  return (
    <HomeScreen
      approvalsClient={approvals}
      holding={started === undefined}
      {...(started === null || started === undefined
        ? {}
        : started.needsFirstId
          ? { noId: <FinishSetupCard /> }
          : { getStarted: <GetStartedCard progress={started} /> })}
      {...(owner === undefined
        ? {}
        : {
            ownerNotice: (
              <OwnerPanel owner={owner} canPasskey={passkeys} nativePresence={nativePresence} />
            ),
          })}
      {...(payConfirm === undefined ? {} : { payConfirm })}
      {...(canPasskey === undefined ? {} : { canPasskey })}
      {...(platform === undefined ? {} : { platform })}
      {...(reducedMotion === undefined ? {} : { reducedMotion })}
    />
  );
}
