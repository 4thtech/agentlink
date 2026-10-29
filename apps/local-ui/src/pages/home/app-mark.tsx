// The small generic mark of an AI app (b11 §30.2): a rounded square with the app's first letter. No
// third-party logo; the app's name always sits next to it as text, so the mark is decorative.
import type { ReactElement } from 'react';

export function AppMark({ name }: { name: string }): ReactElement {
  const letter = [...name.trim()][0]?.toUpperCase() ?? '';
  return (
    <span className="hm-app-mark al-text-caption" data-app-mark aria-hidden="true">
      {letter}
    </span>
  );
}
