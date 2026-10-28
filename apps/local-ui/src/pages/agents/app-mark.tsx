// U3-h: the small generic mark and the name of an AI app (b11 §29, §30.2). The mark is decorative
// (aria-hidden): the app's name is always next to it as text. No brand logos: one generic glyph, so
// nothing is fetched and nothing is claimed about a vendor.
import { Icon } from '@4thtech-io/ui';
import type { ReactElement } from 'react';

export function AppMark({ name }: { name: string }): ReactElement {
  return (
    <span className="ag-app">
      <span className="ag-app-mark" aria-hidden="true">
        <Icon name="ai-app" size={14} />
      </span>
      <span className="ag-app-name">{name}</span>
    </span>
  );
}
