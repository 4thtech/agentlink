// UI-REFRESH-n: Settings › About (B-11 §16 row 22). The mark with "by 4thTech", the version from the
// health read, the licence and public docs and support links. Nothing private is read or shown (I-7).
import { Lockup, Skeleton, Surface, UnderTheHood } from '@4thtech-io/ui';
import { useEffect, useState, type ReactElement } from 'react';
import type { ApiResult } from '../../api/client.js';
import { parseHealth, readHealth } from '../../layout/health.js';
import { ABOUT_LINKS, ABOUT_STRINGS as S } from './strings.js';
import './about.css';

export interface AboutPageProps {
  /** The health read (default: the production read); a test passes its own. */
  readonly read?: () => Promise<ApiResult<unknown>>;
}

type VersionState = { readonly loading: true } | { readonly loading: false; readonly v?: string };

export function AboutPage({ read = readHealth }: AboutPageProps): ReactElement {
  const [state, setState] = useState<VersionState>({ loading: true });
  useEffect(() => {
    let live = true;
    read().then(
      (result) => {
        const version = parseHealth(result)?.version;
        if (live)
          setState(version === undefined ? { loading: false } : { loading: false, v: version });
      },
      () => {
        if (live) setState({ loading: false });
      },
    );
    return () => {
      live = false;
    };
  }, [read]);
  const version = state.loading ? undefined : state.v;
  return (
    <main className="ab-page">
      <h1 className="al-text-h1">{S.title}</h1>
      <Surface as="section" level={1} className="ab-section" aria-labelledby="ab-about">
        <h2 id="ab-about" className="al-text-h3">
          AgentLink
        </h2>
        <Lockup endorsed size={32} />
        <p className="al-text-body">{S.intro}</p>
        <Skeleton loading={state.loading} lines={1}>
          <p className="al-text-body al-muted">
            {version === undefined ? S.versionUnknown : `${S.version} ${version}`}
          </p>
        </Skeleton>
        <p className="al-text-caption al-muted">{S.madeBy}</p>
      </Surface>
      <Surface as="section" level={1} className="ab-section" aria-labelledby="ab-licence">
        <h2 id="ab-licence" className="al-text-h3">
          {S.licenceTitle}
        </h2>
        <p className="al-text-body">{S.licenceBody}</p>
      </Surface>
      <Surface as="section" level={1} className="ab-section" aria-labelledby="ab-links">
        <h2 id="ab-links" className="al-text-h3">
          {S.linksTitle}
        </h2>
        <p className="al-text-body al-muted">{S.linksIntro}</p>
        <ul className="ab-links">
          {ABOUT_LINKS.map((l) => (
            <li key={l.href}>
              <a href={l.href} target="_blank" rel="noopener noreferrer">
                {l.label}
              </a>
            </li>
          ))}
        </ul>
      </Surface>
      <UnderTheHood
        fields={
          version === undefined ? [] : [{ kind: 'text', label: S.hoodVersion, value: version }]
        }
      />
    </main>
  );
}
