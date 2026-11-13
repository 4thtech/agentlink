// What a Settings page is called and which icon it has, shared by the home rows and the side list.
// Small on purpose: the shell's side list imports this, not the page with its reads.
import type { ReactElement } from 'react';
import { ShellIcon, type ShellIconName } from '../../layout/shell-icons.js';
import { SettingsIcon, type SettingsIconName } from './icons.js';
import { SETTINGS_STRINGS as S } from './strings.js';

type Icon = { readonly own: SettingsIconName } | { readonly shell: ShellIconName };
const ICONS: Readonly<Record<string, Icon>> = {
  '/settings/backup': { own: 'shield' },
  '/settings/touch-id': { own: 'fingerprint' },
  '/settings/rules': { shell: 'rules' },
  '/settings/apps': { own: 'plug' },
  '/settings/files': { own: 'folder' },
  '/settings/storage': { own: 'folder' },
  '/settings/appearance': { own: 'sun' },
  '/settings/proofs': { shell: 'proofs' },
  '/settings/updates': { own: 'download' },
  '/settings/advanced': { shell: 'diag' },
  '/advanced/network': { shell: 'diag' },
};

export function PageIcon({ path }: { readonly path: string }): ReactElement {
  const icon = ICONS[path] ?? { shell: 'settings' as const };
  return 'own' in icon ? <SettingsIcon name={icon.own} /> : <ShellIcon name={icon.shell} />;
}

/** The row's title: our plain name for the page, else the label nav.ts gives it. */
export function titleFor(path: string, label: string): string {
  switch (path) {
    case '/settings/backup':
      return S.backup.title;
    case '/settings/touch-id':
      return S.touchId.title;
    case '/settings/rules':
      return S.rules.title;
    case '/settings/apps':
      return S.apps.title;
    case '/settings/files':
      return S.files.title;
    case '/settings/storage':
      return S.storage.title;
    case '/settings/appearance':
      return S.appearance.title;
    case '/settings/proofs':
      return S.proofs.title;
    case '/settings/updates':
      return S.updates.title;
    case '/settings/advanced':
    case '/advanced/network':
      return S.advanced.title;
    default:
      return label;
  }
}
