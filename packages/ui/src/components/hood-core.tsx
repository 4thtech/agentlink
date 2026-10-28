// UI-REFRESH-u: the small, always-needed part of the Under the hood panel (its words and the switch's
// context). The panel itself (hood.tsx, with the field allowlist) is loaded on first use by the app
// through `@4thtech-io/ui/hood`; nothing here changes what the panel accepts or shows.
import { createContext, useContext, type ReactElement, type ReactNode } from 'react';

export const HOOD_STRINGS = {
  title: 'Under the hood',
  tooltip: 'Show the technical details. Nothing here changes how the app works.',
  empty: 'Nothing technical to show here yet.',
  hide: 'Hide technical details',
  show: 'Show technical details',
  proofLink: 'Open the public record',
  previewTitle: 'Preview',
  previewTry: 'Try it',
  previewStill: 'The sample sits still.',
  previewMoved: 'The sample has moved. With reduced motion it jumps instead of gliding.',
} as const;

export const HoodContext = createContext(false);

/** The global switch's value, handed down by the app. Off outside a provider. */
export function HoodProvider({
  value,
  children,
}: {
  value: boolean;
  children?: ReactNode;
}): ReactElement {
  return <HoodContext.Provider value={value}>{children}</HoodContext.Provider>;
}

/** Whether the Under the hood switch is on (false outside a provider). */
export function useHood(): boolean {
  return useContext(HoodContext);
}
