// backup page stub (M1-11s-a). The page card replaces it and owns this folder.
import type { ReactElement } from 'react';
import { NotAvailablePage } from '../../states/index.js';
import { PAGE_TITLES } from '../../strings.js';

export function BackupPage(): ReactElement {
  return <NotAvailablePage title={PAGE_TITLES.backup} />;
}
