// REL051-INV: the computer chosen first (from the user agent only), the phone line, the order of the
// three ways and the Mac app release switch. Node has no DOM, so `render` runs against a small fake
// document built from the ids of the real page (site/i/index.html); the Chromium tests in
// e2e/test/invite-page-*.test.ts cover the built page itself.
import { describe, expect, it } from 'vitest';
import pageHtml from '../site/i/index.html?raw';
import {
  DOCS_BASE,
  DOCS_LINKS,
  MAC_APP_AVAILABLE,
  MAC_APP_URL,
  MAC_APP_VERSION,
  macAppAsset,
} from './config.js';
import type { InviteView } from './invite-state.js';
import { buildAskAi, buildCommands } from './prompt.js';
import { strings } from './strings.js';
import { COMMAND_FOR, isPhone, osFor, render, type Os } from './view.js';

const UA = {
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  safari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  windows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  linux:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  ubuntuFirefox: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
  chromebook:
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  android:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
};

describe('osFor and isPhone (REL051-INV)', () => {
  it('chooses Mac, Windows or Linux from the user agent', () => {
    expect(osFor(UA.mac)).toBe('mac');
    expect(osFor(UA.safari)).toBe('mac');
    expect(osFor(UA.windows)).toBe('windows');
    expect(osFor(UA.linux)).toBe('linux');
    expect(osFor(UA.ubuntuFirefox)).toBe('linux');
    expect(osFor(UA.chromebook)).toBe('linux');
    expect(osFor(UA.iphone)).toBe('mac');
    expect(osFor(UA.android)).toBe('linux');
  });

  it('falls back to Mac for an unknown or empty user agent, and never to Node.js', () => {
    expect(osFor('')).toBe('mac');
    expect(osFor('curl/8.0')).toBe('mac');
  });

  it('knows a phone or tablet', () => {
    expect(isPhone(UA.iphone)).toBe(true);
    expect(isPhone(UA.android)).toBe(true);
    for (const ua of [UA.mac, UA.windows, UA.linux, UA.chromebook]) expect(isPhone(ua)).toBe(false);
  });

  it('Mac and Linux copy the shell installer, Windows the PowerShell one, Node.js npx', () => {
    expect(COMMAND_FOR).toEqual({ mac: 'unix', linux: 'unix', windows: 'windows', node: 'node' });
  });
});

describe('config (REL051-INV)', () => {
  it('keeps the Mac app switched off until the early build is released', () => {
    expect(MAC_APP_AVAILABLE).toBe(false);
  });

  it('links only to 4thTech Docs and the project’s GitHub releases, over https', () => {
    for (const url of Object.values(DOCS_LINKS)) expect(url.startsWith(`${DOCS_BASE}/`)).toBe(true);
    expect(DOCS_BASE).toBe('https://wiki.4thtech.io/products/agentlink');
    expect(MAC_APP_URL).toMatch(/^https:\/\/github\.com\/4thtech\/agentlink\/releases\//);
  });

  it('pins the Mac app link to the exact release asset of the desktop build, never latest', () => {
    expect(MAC_APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(macAppAsset('0.5.1')).toBe('AgentLink-0.5.1-mac-arm64.dmg');
    expect(MAC_APP_URL).toMatch(
      /^https:\/\/github\.com\/4thtech\/agentlink\/releases\/download\/v(\d+\.\d+\.\d+)\/AgentLink-\1-mac-arm64\.dmg$/,
    );
    expect(MAC_APP_URL).toBe(
      `https://github.com/4thtech/agentlink/releases/download/v${MAC_APP_VERSION}/AgentLink-${MAC_APP_VERSION}-mac-arm64.dmg`,
    );
    expect(MAC_APP_URL).not.toContain('latest');
  });

  it('the page links are exactly the docs links, each in a new tab with no referrer', () => {
    const anchors = [...pageHtml.matchAll(/<a\b([^>]*)>/g)].map((m) => m[1] ?? '');
    const hrefs = anchors.flatMap((a) => [...(/\bhref="([^"]*)"/.exec(a)?.slice(1) ?? [])]);
    expect(hrefs).toEqual([DOCS_LINKS.guide, DOCS_LINKS.windows]);
    for (const a of anchors) {
      expect(a).toMatch(/\btarget="_blank"/);
      expect(a).toMatch(/\brel="noopener noreferrer"/);
    }
    // The Mac app's link has no href in the HTML: only the switch gives it one.
    expect(pageHtml).toMatch(/<a id="mac-app-link"(?![^>]*href)[^>]*>/);
    expect(pageHtml).not.toContain(MAC_APP_URL);
  });

  it('the help section says what the strings say', () => {
    const flat = pageHtml.replace(/\s+/g, ' ');
    expect(flat).toContain(strings.help.heading);
    expect(flat).toContain(strings.help.again);
    expect(flat).toContain(`>${strings.help.guide}</a`);
    expect(flat).toContain(`>${strings.help.windows}</a`);
  });
});

// ---- A small fake DOM: one element per id of the real page. ----

interface FakeElement {
  id: string;
  textContent: string;
  hidden: boolean;
  disabled: boolean;
  onclick: (() => void) | null;
  dataset: Record<string, string>;
  attrs: Map<string, string>;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
}

function fakeDocument(): { doc: Document; el: (id: string) => FakeElement } {
  const elements = new Map<string, FakeElement>();
  for (const match of pageHtml.matchAll(/<(\w+)\b([^>]*)\bid="([^"]+)"([^>]*)>/g)) {
    const id = match[3] ?? '';
    const attrs = new Map<string, string>();
    for (const a of `${match[2] ?? ''} ${match[4] ?? ''}`.matchAll(/([\w-]+)="([^"]*)"/g))
      attrs.set(a[1] ?? '', a[2] ?? '');
    elements.set(id, {
      id,
      textContent: '',
      hidden: /\shidden\b/.test(`${match[2] ?? ''} ${match[4] ?? ''}`),
      disabled: false,
      onclick: null,
      dataset: {},
      attrs,
      setAttribute(name, value) {
        this.attrs.set(name, value);
      },
      getAttribute(name) {
        return this.attrs.get(name) ?? null;
      },
      removeAttribute(name) {
        this.attrs.delete(name);
      },
    });
  }
  const doc = { getElementById: (id: string) => elements.get(id) ?? null } as unknown as Document;
  const el = (id: string): FakeElement => {
    const found = elements.get(id);
    if (found === undefined) throw new Error(`no ${id}`);
    return found;
  };
  return { doc, el };
}

const LINK = `https://agentlink.4thtech.io/i#2.${'A'.repeat(43)}`;

const ready = (): InviteView => ({
  kind: 'ready',
  inviteUrl: LINK,
  commands: buildCommands(LINK),
  sentence: buildAskAi(LINK),
  inviter: {
    name: 'Marko',
    fallback: false,
    label: 'self-declared',
    fingerprint: '7F3A·19C2',
    expiresAt: 1_900_000_000,
  },
});

const noCopy = (): Promise<void> => Promise.resolve();

describe('render (REL051-INV)', () => {
  it('has a fake element for every id it touches', () => {
    const { doc } = fakeDocument();
    expect(() => {
      render(doc, ready(), noCopy, undefined, { os: 'mac', macApp: true });
    }).not.toThrow();
  });

  for (const [os, open] of [
    ['mac', strings.step.openHelp.mac],
    ['windows', strings.step.openHelp.windows],
    ['linux', strings.step.openHelp.linux],
    ['node', strings.step.openHelp.node],
  ] as [Os, string][]) {
    it(`shows where to paste it and the matching command for ${os}`, () => {
      const { doc, el } = fakeDocument();
      render(doc, ready(), noCopy, undefined, { os });
      expect(el(`os-${os}`).getAttribute('aria-pressed')).toBe('true');
      for (const other of ['mac', 'windows', 'linux', 'node'].filter((o) => o !== os))
        expect(el(`os-${other}`).getAttribute('aria-pressed')).toBe('false');
      expect(el('open-help').textContent).toBe(open);
      expect(el('step-help').textContent).toBe(strings.step.commandHelp[os]);
      const command = buildCommands(LINK)?.[COMMAND_FOR[os]] ?? '';
      expect(el('step-text').textContent).toBe(
        command.split(LINK).join('agentlink.4thtech.io/i#2.AA…AAAAA'),
      );
    });
  }

  it('the buttons switch the computer, and Copy copies that computer’s command', async () => {
    const { doc, el } = fakeDocument();
    const copied: string[] = [];
    render(
      doc,
      ready(),
      (t) => {
        copied.push(t);
        return Promise.resolve();
      },
      undefined,
      { os: 'mac' },
    );
    el('os-windows').onclick?.();
    expect(el('open-help').textContent).toBe(strings.step.openHelp.windows);
    el('copy').onclick?.();
    el('os-linux').onclick?.();
    el('copy').onclick?.();
    await Promise.resolve();
    const commands = buildCommands(LINK);
    expect(copied).toEqual([commands?.windows, commands?.unix]);
  });

  it('shows the phone line only on a phone', () => {
    const one = fakeDocument();
    render(one.doc, ready(), noCopy, undefined, { os: 'mac', phone: true });
    expect(one.el('phone-note').hidden).toBe(false);
    expect(one.el('phone-note').textContent).toBe(strings.step.phone);
    const two = fakeDocument();
    render(two.doc, ready(), noCopy, undefined, { os: 'mac', phone: false });
    expect(two.el('phone-note').hidden).toBe(true);
  });

  it('switch off (the default): no Mac app, and its link has no href, on every computer', () => {
    for (const os of ['mac', 'windows', 'linux', 'node'] as Os[]) {
      const { doc, el } = fakeDocument();
      render(doc, ready(), noCopy, undefined, { os });
      expect(el('mac-app').hidden).toBe(true);
      expect(el('mac-app-link').getAttribute('href')).toBeNull();
      expect(el('mac-app-link').textContent).toBe('');
    }
  });

  it('switch on: the Mac app shows under Mac only, with the release link and the first-open note', () => {
    const { doc, el } = fakeDocument();
    render(doc, ready(), noCopy, undefined, { os: 'mac', macApp: true });
    expect(el('mac-app').hidden).toBe(false);
    expect(el('mac-app-link').getAttribute('href')).toBe(MAC_APP_URL);
    expect(el('mac-app-link').textContent).toBe(strings.step.macApp.link);
    expect(el('mac-app-note').textContent).toBe(strings.step.macApp.note);
    el('os-windows').onclick?.();
    expect(el('mac-app').hidden).toBe(true);
    el('os-mac').onclick?.();
    expect(el('mac-app').hidden).toBe(false);
    const win = fakeDocument();
    render(win.doc, ready(), noCopy, undefined, { os: 'windows', macApp: true });
    expect(win.el('mac-app').hidden).toBe(true);
  });

  it('a state with no invite shows no step, no phone line, no Mac app and no run-again line', () => {
    const { doc, el } = fakeDocument();
    render(doc, ready(), noCopy, undefined, { os: 'mac', phone: true, macApp: true });
    render(doc, { kind: 'damaged' }, noCopy, undefined, { os: 'mac', phone: true, macApp: true });
    expect(el('step').hidden).toBe(true);
    expect(el('phone-note').hidden).toBe(true);
    expect(el('mac-app').hidden).toBe(true);
    expect(el('mac-app-link').getAttribute('href')).toBeNull();
    expect(el('help-again').hidden).toBe(true);
  });
});
