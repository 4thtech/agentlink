// Shared states for pages (d1/screens/local/shared-states). The shell uses the "not available yet"
// and "not found" states; the first-run card (M1-11b-1) fills in the rest.
import { EmptyState } from '@4thtech-io/ui';
import type { ReactElement } from 'react';
import { SHELL_STRINGS } from '../strings.js';

/** A page title with the "not available yet" state under it; every stub page is this. */
export function NotAvailablePage({ title }: { title: string }): ReactElement {
  return (
    <>
      <h1 className="al-text-title-1">{title}</h1>
      <EmptyState
        icon="info"
        title={`${SHELL_STRINGS.notAvailableTitle} ${SHELL_STRINGS.notAvailableHint}`}
      />
    </>
  );
}

export function NotFoundPage(): ReactElement {
  return (
    <EmptyState
      icon="search"
      title={`${SHELL_STRINGS.notFoundTitle} ${SHELL_STRINGS.notFoundHint}`}
    />
  );
}
