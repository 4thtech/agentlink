// UI-REFRESH-u: the Under the hood panel, loaded the first time the switch is on. While the switch is
// off nothing is fetched and nothing renders. The panel and its field allowlist are unchanged; this
// only fetches them late (`@4thtech-io/ui/hood`).
import { useHood } from '@4thtech-io/ui';
import type { ReactElement } from 'react';
import { lazyPart } from './index.js';

type HoodProps = { fields: readonly unknown[] };

const hood = lazyPart<HoodProps>(
  async () => (await import('@4thtech-io/ui/hood')).UnderTheHood,
  () => <div className="al-hood-loading" aria-hidden="true" />,
);

export const loadHood = hood.load;

/** Same props as the panel in the design system. Renders nothing while the switch is off. */
export function UnderTheHood({ fields }: HoodProps): ReactElement | null {
  const on = useHood();
  return on ? <hood.Part fields={fields} /> : null;
}
