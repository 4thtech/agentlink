// UX1113 WP-S2: the mount slot for the desktop app's native Touch ID switch (NativeSettings, WP-D1 /
// desktop integration). The page renders whatever is registered here, or its `nativeSwitch` prop,
// inside `<div data-slot="native-touch-id-switch">` in the Touch ID card. Nothing is registered in the
// browser build, so the slot stays empty there. The registered component gets no secret and no
// owner operation from this page; it does its own native presence step.
import type { ComponentType } from 'react';

let registered: ComponentType | undefined;

/** Desktop only (apps/local-ui/src/desktop.ts): the native switch to show on this page. */
export function setNativeTouchIdSwitch(component: ComponentType | undefined): void {
  registered = component;
}

export function nativeTouchIdSwitch(): ComponentType | undefined {
  return registered;
}
