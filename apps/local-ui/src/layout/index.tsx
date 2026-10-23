// The shared frame: sidebar, content and status bar from the design system's AppShell. Content
// switches by route; the layout itself never changes (d1/screens/local).
import { AppShell, type NavItem } from '@4thtech-io/ui';
import type { ReactElement, ReactNode } from 'react';
import { NAV_ITEMS } from '../nav.js';

export function Layout({ path, children }: { path: string; children: ReactNode }): ReactElement {
  const nav: NavItem[] = NAV_ITEMS.map((item) => ({
    icon: item.icon,
    label: item.label,
    href: item.path,
    active: item.routed && item.path === path,
  }));
  return (
    <AppShell nav={nav} connection="connected">
      {children}
    </AppShell>
  );
}
