// F25: once the app on this computer has stopped, nothing on the page can work; say so plainly
// instead of showing a page whose every action fails. The words are fixed (11 §5).
import { useSyncExternalStore, type ReactElement, type ReactNode } from 'react';
import { HOST_CLOSED_TEXT, isHostClosed, subscribeHostClosed } from '../api/host-closed.js';

export function HostClosedGate({ children }: { readonly children?: ReactNode }): ReactElement {
  const closed = useSyncExternalStore(subscribeHostClosed, isHostClosed, isHostClosed);
  if (!closed) return <>{children}</>;
  return (
    <main role="alert" style={{ padding: '4rem 1rem', textAlign: 'center' }}>
      <p>{HOST_CLOSED_TEXT}</p>
    </main>
  );
}
