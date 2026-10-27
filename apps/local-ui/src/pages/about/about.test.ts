// @vitest-environment jsdom
// UI-REFRESH-n (S1): Settings › About (B-11 §16 row 22). The mark with "by 4thTech", the version from
// the health read, the licence and the public docs and support links. Never keys, codes, tokens,
// session links or local paths (I-7).
import { HoodProvider, lintVocabulary } from '@4thtech-io/ui';
import { act, createElement as h } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiResult } from '../../api/client.js';
import { AboutPage } from './index.js';
import { ABOUT_STRINGS as S, ABOUT_LINKS } from './strings.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.documentElement.removeAttribute('data-motion');
});

const ok = (data: unknown): ApiResult<unknown> => ({ kind: 'ok', status: 200, data });
const running = ok({ agent: 'running', version: '0.4.0' });

async function mount(read: () => Promise<ApiResult<unknown>>, hood = false): Promise<void> {
  await act(async () => {
    root.render(h(HoodProvider, { value: hood }, h(AboutPage, { read })));
  });
}

describe('About page', () => {
  it('has the heading, the endorsed mark and sections on Surface 1', async () => {
    await mount(async () => running);
    expect(host.querySelector('main h1')?.textContent).toBe(S.title);
    expect(host.querySelector('[role="img"][aria-label="AgentLink by 4thTech"]')).not.toBeNull();
    const sections = host.querySelectorAll('section.al-surface--l1');
    expect(sections.length).toBeGreaterThanOrEqual(3);
    for (const s of sections) expect(s.querySelector('h2')).not.toBeNull();
  });

  it('shows the version from the health read', async () => {
    await mount(async () => running);
    expect(host.textContent).toContain('Version 0.4.0');
  });

  it('shows no version while the first read is pending, then the version', async () => {
    let finish: (r: ApiResult<unknown>) => void = () => undefined;
    const pending = new Promise<ApiResult<unknown>>((r) => (finish = r));
    await mount(() => pending);
    expect(host.textContent).not.toContain('Version 0.4.0');
    expect(host.textContent).not.toContain(S.versionUnknown);
    await act(async () => finish(running));
    expect(host.textContent).toContain('Version 0.4.0');
  });

  it('says the version is unavailable when the read fails or is malformed, never invents one', async () => {
    await mount(async () => ({ kind: 'offline' }));
    expect(host.textContent).toContain(S.versionUnknown);
    expect(host.textContent).not.toMatch(/Version \d/);
    await mount(async () => ok({ agent: 'running', version: '1.2.3; rm -rf' }));
    expect(host.textContent).toContain(S.versionUnknown);
  });

  it('names the licence and has docs and support links that are public https links', async () => {
    await mount(async () => running);
    expect(host.textContent).toContain('MIT');
    const links = [...host.querySelectorAll<HTMLAnchorElement>('main a[href]')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(ABOUT_LINKS.map((l) => l.href));
    for (const a of links) {
      expect(a.getAttribute('href')).toMatch(
        /^https:\/\/(github\.com\/4thtech|wiki\.4thtech\.io)\//,
      );
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toContain('noopener');
      expect((a.textContent ?? '').trim().length).toBeGreaterThan(0);
    }
  });

  it('shows nothing private: no keys, codes, tokens, session links or local paths', async () => {
    await mount(async () => running, true);
    const text = host.textContent ?? '';
    expect(text).not.toMatch(/#s=|127\.0\.0\.1|localhost|token|passphrase|backup code|\/Users\//i);
    expect(text).not.toMatch(/[A-Za-z0-9_\-+/=]{24,}/);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('has Under the hood with the version only, and the empty text when it is not known', async () => {
    await mount(async () => running, true);
    const hood = host.querySelector('section.al-hood');
    expect(hood).not.toBeNull();
    expect(hood?.textContent).toContain('0.4.0');
    await mount(async () => ({ kind: 'offline' }), true);
    expect(host.querySelector('section.al-hood')?.textContent).toContain('Nothing technical');
  });

  it('shows no Under the hood panel while the switch is off', async () => {
    await mount(async () => running, false);
    expect(host.querySelector('section.al-hood')).toBeNull();
  });

  it('keeps one h1, headings in order, and nothing animated with reduced motion', async () => {
    document.documentElement.setAttribute('data-motion', 'reduced');
    await mount(async () => running);
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(host.querySelectorAll('h3')).toHaveLength(0);
    expect(host.querySelector('[class*="anim"], [class*="pulse"]')).toBeNull();
  });

  it('uses plain words (11 §5)', () => {
    const text = [...Object.values(S), ...ABOUT_LINKS.map((l) => l.label)].join('\n');
    expect(lintVocabulary(text)).toEqual([]);
  });
});
