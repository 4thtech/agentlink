// M1-11b-2: Approvals in the app (08 §1; 11 §6.2.1; 04 §2.5, §2.5.2, §2.5.3; D-68, D-118, D-132).
// Ported from the server-rendered approval page, removed in M1-11b-2c (a server without the app
// bundle now shows a fixed page that points to the terminal). Same routes, words and rules:
//
// - "Waiting for you (n)": the pending requests, soonest to expire first, at most 20. A plain
//   request offers Approve, Deny or Later; one button names exactly what is included. Before asking
//   for presence the page checks the list again, leaves out what is no longer waiting (or changed),
//   says so and shows "This covers exactly these n"; then one passkey gesture or one owner code.
// - A commitment (D-31) and a request that costs credits (04 §2.5.3 rule 7) are never list items:
//   each is its own card with its own Approve and Deny; the paid one approves through the sheet.
// - Before the owner is set up nothing can be approved, with the reason. The switch to a passkey is
//   the layout's next-step banner (M1-UX-FIRSTRUN-V2-c); where passkeys can't work, the page says
//   the owner code is the way.
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
import { Surface, type PayPlatform } from '@4thtech-io/ui';
import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import type { PayConfirmClient } from '../../pay-confirm/index.js';
import type { OwnerState } from './card.js';
import { createApprovalsClient, type ApprovalsClient } from './client.js';
import { APPROVAL_STRINGS as S } from './strings.js';
import './approvals.css';

export { APPROVAL_TTL } from './card.js';

export interface ApprovalsPageProps {
  readonly client?: ApprovalsClient;
  readonly payConfirm?: PayConfirmClient;
  /** Whether this browser can use a passkey. Default: detected. */
  readonly canPasskey?: boolean;
  readonly platform?: PayPlatform;
  readonly reducedMotion?: boolean;
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
}

/** Reads the owner and the decision passkey once; undefined while loading. */
export function useOwner(client: ApprovalsClient, canPasskey: boolean): OwnerView | undefined {
  const [owner, setOwner] = useState<OwnerView | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void client.passkey().then((answer) => {
      if (!live) return;
      if (answer.kind === 'needs_owner') setOwner({ ready: false, offered: false });
      else {
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
  }, [client, canPasskey]);
  return owner;
}

/** Owner set up? If not, the reason; where passkeys can't work, the owner code is the way. */
export function OwnerPanel({
  owner,
  canPasskey,
  needsOwnerOnly = false,
}: {
  owner: OwnerView;
  canPasskey: boolean;
  needsOwnerOnly?: boolean;
}): ReactElement | null {
  if (!owner.ready) {
    return (
      <Surface as="section" level={1} className="al-panel">
        <h2>{S.needsOwnerTitle}</h2>
        <p>{S.needsOwner}</p>
      </Surface>
    );
  }
  if (needsOwnerOnly || owner.passkey !== undefined) return null;
  // A passkey can be set up here: the layout's "Switch to …" banner is the one place to start.
  if (canPasskey && owner.offered) return null;
  return (
    <Surface as="section" level={1} className="al-panel">
      <h2>{S.firstRunTitle}</h2>
      <p>{S.firstRun}</p>
      <p>{S.noPasskeys}</p>
      <p className="al-note">{S.desktopNote}</p>
    </Surface>
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
export function ApprovalsHead({ end }: { end?: ReactNode } = {}): ReactElement {
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
    </>
  );
}

/** `/`: Home (W4-HOME), with the approvals as the card on top. */
export function ApprovalsPage({
  client,
  payConfirm,
  canPasskey,
  platform,
  reducedMotion,
}: ApprovalsPageProps): ReactElement {
  // The owner's state, as the list showed it: not set up yet (nothing can be approved, with the
  // reason) or no passkeys in this browser (the backup code is the way).
  const approvals = useMemo(() => client ?? createApprovalsClient(), [client]);
  const passkeys = canPasskey ?? browserPasskeys();
  const owner = useOwner(approvals, passkeys);
  return (
    <HomeScreen
      approvalsClient={approvals}
      {...(owner === undefined
        ? {}
        : { ownerNotice: <OwnerPanel owner={owner} canPasskey={passkeys} /> })}
      {...(payConfirm === undefined ? {} : { payConfirm })}
      {...(canPasskey === undefined ? {} : { canPasskey })}
      {...(platform === undefined ? {} : { platform })}
      {...(reducedMotion === undefined ? {} : { reducedMotion })}
    />
  );
}
