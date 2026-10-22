// Shared states for pages (d1 Local-states, `shared-states--all`; D-116). Every page uses these for
// its empty, loading, error, offline and setup states, so the copy is the same everywhere.
// Classes and components come from packages/ui only (CSP: no inline styles).
import { Banner, Button, CopyPrompt, EmptyState } from '@4thtech-io/ui';
import type { ReactElement } from 'react';
import { STATE_STRINGS as S } from './strings.js';

export { STATE_STRINGS } from './strings.js';
export {
  RECOVERY_KIT_LATER_KEY,
  recoveryKitPending,
  rememberRecoveryKitLater,
  forgetRecoveryKitLater,
} from './recovery-kit.js';

/** A page title with the "not available yet" state under it; every stub page is this. */
export function NotAvailablePage({ title }: { title: string }): ReactElement {
  return (
    <>
      <h1 className="al-text-title-1">{title}</h1>
      <EmptyState icon="info" title={`${S.notAvailableTitle} ${S.notAvailableHint}`} />
    </>
  );
}

export function NotFoundPage(): ReactElement {
  return <EmptyState icon="search" title={`${S.notFoundTitle} ${S.notFoundHint}`} />;
}

/** The session link was used or is too old (the server answered 401). */
export function LinkExpiredState(): ReactElement {
  return (
    <section aria-labelledby="al-state-expired">
      <h1 id="al-state-expired" className="al-text-title-2">
        {S.linkExpiredTitle}
      </h1>
      <p className="al-text-body al-muted">{S.linkExpiredBody}</p>
      <CopyPrompt command={S.linkExpiredCommand} />
    </section>
  );
}

/** The local server doesn't answer. */
export function NotRunningState(): ReactElement {
  return (
    <section aria-labelledby="al-state-down">
      <h1 id="al-state-down" className="al-text-title-2">
        {S.notRunningTitle}
      </h1>
      <p className="al-text-body al-muted">{S.notRunningBody}</p>
      <CopyPrompt command={S.notRunningCommand} />
    </section>
  );
}

/** Shown on every page until approvals are protected; one action back to first run. */
export function SetupUnfinishedBanner(): ReactElement {
  return (
    <Banner
      tone="warning"
      title={S.setupUnfinishedTitle}
      action={
        <a className="al-btn al-btn-primary al-btn-sm" href="/first-run">
          {S.continueSetup}
        </a>
      }
    >
      {S.setupUnfinishedBody}
    </Banner>
  );
}

/**
 * D-120 (2): the recovery kit was put off at first run. The banner stays until the kit is saved;
 * `afterFirstContact` is the stronger reminder once a contact exists.
 */
export function RecoveryKitBanner({
  afterFirstContact = false,
}: {
  afterFirstContact?: boolean;
}): ReactElement {
  return (
    <Banner
      tone={afterFirstContact ? 'warning' : 'info'}
      icon="life-buoy"
      {...(afterFirstContact ? {} : { title: S.kitPendingTitle })}
      action={
        <a className="al-btn al-btn-secondary al-btn-sm" href="/settings/backup">
          {S.saveKit}
        </a>
      }
    >
      {afterFirstContact ? S.kitPendingAfterContact : S.kitPendingBody}
    </Banner>
  );
}

export type NetworkState = 'slow' | 'offline' | 'back';

export function NetworkBanner({
  state,
  newMessages = 0,
}: {
  state: NetworkState;
  newMessages?: number;
}): ReactElement {
  if (state === 'slow')
    return (
      <Banner tone="info" icon="clock" compact>
        {S.networkSlow}
      </Banner>
    );
  if (state === 'offline')
    return (
      <Banner tone="offline" compact>
        {S.networkOffline}
      </Banner>
    );
  return (
    <Banner tone="success" compact>
      {S.networkBack(newMessages)}
    </Banner>
  );
}

/** Nothing to show: one sentence and the next thing to say to the AI (audit 10a). */
export function NothingWaiting({ prompt = S.emptyPrompt }: { prompt?: string }): ReactElement {
  return <EmptyState icon="inbox" title={S.emptyTitle} prompt={prompt} />;
}

export function LoadingState({ text = S.loading }: { text?: string }): ReactElement {
  return (
    <p className="al-text-body al-muted" role="status" aria-live="polite">
      {text}
    </p>
  );
}

/** A failure: what happened, what it means, one action. */
export function ErrorState({
  title,
  body,
  onRetry,
}: {
  title: string;
  body?: string;
  onRetry?: () => void;
}): ReactElement {
  return (
    <>
      <Banner tone="danger" title={title}>
        {body}
      </Banner>
      {onRetry === undefined ? null : (
        <Button icon="refresh-cw" onClick={onRetry}>
          {S.retry}
        </Button>
      )}
    </>
  );
}

/**
 * The status bar's connection from an API answer (IR-M1-11s-a-1 L1): `offline` when the server
 * doesn't answer, else `connected`. The layout (M1-11s-a) wires it.
 */
export function connectionOf(result: { readonly kind: string }): 'connected' | 'offline' {
  return result.kind === 'offline' ? 'offline' : 'connected';
}
