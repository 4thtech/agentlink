// The sidebar: Approvals, then the settings pages (d1/screens/local). Approvals still lives on the
// approval page at `/` until M1-11b-2 moves it here, so that link is not routed by this app.
import { PAGE_TITLES } from './strings.js';

export interface AppNavItem {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly path: string;
  /** True when this app routes the path; false hands the click to the browser. */
  readonly routed: boolean;
}

export const NAV_ITEMS: readonly AppNavItem[] = [
  { id: 'approvals', label: PAGE_TITLES.approvals, icon: 'approval', path: '/', routed: false },
  {
    id: 'activity',
    label: PAGE_TITLES.activity,
    icon: 'activity',
    path: '/settings/activity',
    routed: true,
  },
  {
    id: 'contacts',
    label: PAGE_TITLES.contacts,
    icon: 'users',
    path: '/settings/contacts',
    routed: true,
  },
  { id: 'files', label: PAGE_TITLES.files, icon: 'folder', path: '/settings/files', routed: true },
  {
    id: 'storage',
    label: PAGE_TITLES.storage,
    icon: 'hard-drive',
    path: '/settings/storage',
    routed: true,
  },
  {
    id: 'proofs',
    label: PAGE_TITLES.proofs,
    icon: 'proof-seal',
    path: '/settings/proofs',
    routed: true,
  },
  {
    id: 'rules',
    label: PAGE_TITLES.rules,
    icon: 'sliders-horizontal',
    path: '/settings/rules',
    routed: true,
  },
  {
    id: 'backup',
    label: PAGE_TITLES.backup,
    icon: 'life-buoy',
    path: '/settings/backup',
    routed: true,
  },
  {
    id: 'advanced',
    label: PAGE_TITLES.advanced,
    icon: 'terminal',
    path: '/settings/advanced',
    routed: true,
  },
];
