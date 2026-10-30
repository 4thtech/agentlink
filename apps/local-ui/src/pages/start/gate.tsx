// W4-WIZARD (IR-W4-WIZARD-1 M): the app's first screen waits for the open-on-launch check, so Home
// never flashes before Get started replaces it. Only an entry on Home is held (deep links, Get
// started itself and every other page render at once); nothing shows for the first ~300 ms, then a
// skeleton in Home's shape (U0 SkeletonGate). A check that fails shows the app.
import { SkeletonGate, SkeletonList } from '@4thtech-io/ui';
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { mayOpenStart, openStartIfIncomplete } from './guard.js';

export interface StartGateProps {
  readonly children?: ReactNode;
  /** Test seam: the check (resolves whether it opened Get started). */
  readonly decide?: () => Promise<boolean>;
  /** Test seam: whether this entry is one the check may take over. Default: from the address. */
  readonly held?: boolean;
}

export function StartGate({
  children,
  decide = openStartIfIncomplete,
  held = mayOpenStart(),
}: StartGateProps): ReactElement {
  const [decided, setDecided] = useState(!held);
  useEffect(() => {
    let live = true;
    const done = (): void => {
      if (live) setDecided(true);
    };
    decide().then(done, done);
    return () => {
      live = false;
    };
  }, [decide]);
  if (decided) return <>{children}</>;
  return <SkeletonGate loading skeleton={<SkeletonList rows={3} />} />;
}
