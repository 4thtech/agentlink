// The two-pane frame of a Settings sub-page (design-1112 §3.1; mockup 04): a 220 px list of the same
// groups with "‹ Settings" on top, and the page on the right. Under 900 px the list is hidden and
// "‹ Settings" stays as the back link. The shell wraps a page in it when `isSettingsSubpage(path)`.
import type { ReactElement, ReactNode } from 'react';
import { ShellIcon } from '../../layout/shell-icons.js';
import { SETTINGS_PAGES } from '../../nav.js';
import { groupOf, settingsGroups } from './groups.js';
import { PageIcon, titleFor } from './page-meta.js';
import { SETTINGS_STRINGS as S } from './strings.js';
import './settings.css';

/** A page that sits under Settings home and is listed in `SETTINGS_PAGES` with a `/settings/` path. */
export function isSettingsSubpage(path: string): boolean {
  return path.startsWith('/settings/') && SETTINGS_PAGES.some((p) => p.path === path);
}

export function SettingsFrame({
  path,
  children,
}: {
  readonly path: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className="set-frame">
      <nav className="set-side" aria-label={S.navLabel}>
        <a className="set-back" href="/settings">
          <ShellIcon name="chev-r" size={16} className="set-back-chev" />
          {S.back}
        </a>
        {settingsGroups(SETTINGS_PAGES).map((g) => (
          <div key={g.id} className="set-side-group">
            <p className="set-side-title al-text-label">
              {S.groups[groupOf(g.pages[0]?.path ?? '')]}
            </p>
            {g.pages.map((p) => (
              <a
                key={p.path}
                href={p.path}
                className="set-side-link"
                aria-current={p.path === path ? 'page' : undefined}
              >
                <PageIcon path={p.path} />
                {titleFor(p.path, p.label)}
              </a>
            ))}
          </div>
        ))}
      </nav>
      <div className="set-body">{children}</div>
    </div>
  );
}
