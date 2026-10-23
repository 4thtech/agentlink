// rules page stub (M1-11s-a). The page card replaces it and owns this folder.
import type { ReactElement } from 'react';
import { NotAvailablePage } from '../../states/index.js';
import { PAGE_TITLES } from '../../strings.js';

export function RulesPage(): ReactElement {
  return <NotAvailablePage title={PAGE_TITLES.rules} />;
}
