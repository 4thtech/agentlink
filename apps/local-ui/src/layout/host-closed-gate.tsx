// F25: once the app on this computer has stopped, nothing on the page can work; say so plainly
// instead of showing a page whose every action fails. The words are fixed (11 §5).
// R1-UI-12: with a heading and plain, per-computer steps to open AgentLink again (a student who
// closed the terminal has nothing to click otherwise); the terminal command is a small second line.
import { useSyncExternalStore, type ReactElement, type ReactNode } from 'react';
import { HOST_CLOSED_TEXT, isHostClosed, subscribeHostClosed } from '../api/host-closed.js';
import { ReopenSteps } from '../states/index.js';
import { REOPEN } from '../states/strings.js';

export function HostClosedGate({ children }: { readonly children?: ReactNode }): ReactElement {
  const closed = useSyncExternalStore(subscribeHostClosed, isHostClosed, isHostClosed);
  if (!closed) return <>{children}</>;
  return (
    <main role="alert" className="al-host-closed">
      <h1 className="al-text-title-2">{HOST_CLOSED_TEXT}</h1>
      <p className="al-text-body al-muted">{REOPEN.closedBody}</p>
      <ReopenSteps />
    </main>
  );
}
