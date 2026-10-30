// W4-SHELL-V2 (Decision 48; W4 UX v2 "Section menu"; prototype v23): the section menu. On a wide
// window, a minimized rail of icons with an arrow on top that expands it (labels appear; the state is
// kept by the app, ui-settings.ts). On a phone (600 px and under), a bar under the top bar names the
// page; its arrow opens the sections as a sheet. Home · Agents · Activity · Settings; the Advanced
// group only while Under the hood is on. Links are real links (the router takes plain clicks; a
// modified click opens a tab), the current one marked with aria-current="page".
import { CountBadge } from '@4thtech-io/ui';
import { useState, type ReactElement } from 'react';
import { ADVANCED_SECTIONS, SECTIONS, sectionOf, titleOf, type Section } from '../nav.js';
import { SHELL_STRINGS as S } from '../strings.js';
import { VT_CLASS } from './motion.js';
import { ShellIcon } from './shell-icons.js';

interface MenuProps {
  readonly path: string;
  readonly hood: boolean;
}

function RailLink({
  section,
  current,
  expanded,
  count = 0,
}: {
  section: Section;
  current: boolean;
  expanded: boolean;
  count?: number;
}): ReactElement {
  return (
    <a
      href={section.path}
      className={current ? 'al-rail-item is-current' : 'al-rail-item'}
      aria-current={current ? 'page' : undefined}
      aria-label={
        count > 0 ? `${section.label}, ${String(count)} ${S.approvalsWaiting}` : section.label
      }
      title={expanded ? undefined : section.label}
    >
      <ShellIcon name={section.icon} size={20} />
      {expanded ? <span className="al-rail-label al-label">{section.label}</span> : null}
      {/* The shared tick badge (UI-REFRESH-o-b): approvals waiting, on Home. */}
      {count > 0 ? (
        <CountBadge
          count={count}
          label={S.approvalsWaiting}
          className="al-nav-count al-rail-count al-text-code"
        />
      ) : null}
    </a>
  );
}

export interface SectionRailProps extends MenuProps {
  readonly expanded: boolean;
  readonly onToggle: () => void;
  /** Approvals waiting: the shared tick badge on Home (named "Home, 2 waiting for you"). */
  readonly waiting?: number;
}

/** The rail (wide windows). */
export function SectionRail({
  path,
  hood,
  expanded,
  onToggle,
  waiting = 0,
}: SectionRailProps): ReactElement {
  const current = sectionOf(path);
  return (
    <nav
      aria-label={S.sections}
      className={`al-rail al-chrome ${VT_CLASS.rail}`}
      data-expanded={expanded ? 'true' : 'false'}
    >
      <button
        type="button"
        className="al-rail-item al-rail-toggle"
        aria-expanded={expanded}
        aria-label={expanded ? S.collapseMenu : S.expandMenu}
        onClick={onToggle}
      >
        <ShellIcon name="chev-r" size={20} className={expanded ? 'al-rot is-on' : 'al-rot'} />
        {expanded ? <span className="al-rail-label al-label">{S.collapse}</span> : null}
      </button>
      {SECTIONS.map((s) => (
        <RailLink
          key={s.id}
          section={s}
          current={current === s.id}
          expanded={expanded}
          {...(s.id === 'home' ? { count: waiting } : {})}
        />
      ))}
      {hood ? (
        <div className="al-rail-group al-reveal" role="group" aria-label={S.advanced}>
          <div className="al-rail-sep" aria-hidden="true" />
          {expanded ? <span className="al-rail-head al-text-label">{S.advanced}</span> : null}
          {ADVANCED_SECTIONS.map((s) => (
            <RailLink key={s.id} section={s} current={current === s.id} expanded={expanded} />
          ))}
        </div>
      ) : null}
    </nav>
  );
}

/** The phone bar and its sheet (600 px and under). */
export function SectionSheet({ path, hood }: MenuProps): ReactElement {
  const [open, setOpen] = useState(false);
  const current = sectionOf(path);
  const item = (s: Section): ReactElement => (
    <a
      key={s.id}
      href={s.path}
      className={current === s.id ? 'al-sheet-item is-current' : 'al-sheet-item'}
      aria-current={current === s.id ? 'page' : undefined}
      onClick={() => setOpen(false)}
    >
      {s.label}
    </a>
  );
  return (
    <div className="al-topnav al-chrome">
      <button
        type="button"
        className="al-topnav-btn"
        aria-expanded={open}
        aria-controls="al-section-sheet"
        onClick={() => setOpen((v) => !v)}
      >
        <span>{titleOf(path)}</span>
        <ShellIcon name="chev-d" size={18} className={open ? 'al-rot is-on' : 'al-rot'} />
      </button>
      {open ? (
        <nav id="al-section-sheet" aria-label={S.sections} className="al-sheet al-expand">
          {SECTIONS.map(item)}
          {hood ? (
            <>
              <span className="al-sheet-head al-text-label">{S.advanced}</span>
              {ADVANCED_SECTIONS.map(item)}
            </>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
