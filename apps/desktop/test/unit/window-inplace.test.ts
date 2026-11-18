// OWNER-FB-0512: a widget or notification click for a person moves the open window in place (only the
// fragment changes), so the app never reloads or shows a blank page; any other link loads as before.
import { describe, expect, it } from 'vitest';
import { OriginLock } from '../../src/main/security.js';
import { MainWindow } from '../../src/main/window.js';
import { FakeBrowserWindow, SESSION_URL, TOKEN, fakeElectron } from './fakes.js';

const PERSON = `0x${'ab'.repeat(20)}`;
const TOKEN2 = 'B'.repeat(43);
const link = (hash: string, path = '/'): string =>
  `http://localhost:4567${path}?t=${TOKEN2}${hash}`;

function make(): MainWindow {
  const electron = fakeElectron();
  return new MainWindow({
    BrowserWindow: electron.BrowserWindow,
    shell: electron.shell,
    lock: new OriginLock(),
    platform: 'darwin',
    quitting: () => false,
  });
}

describe('main window person links', () => {
  it('changes only the fragment of the open Home page and reports it loaded at once', () => {
    const window = make();
    window.loadSessionUrl(SESSION_URL);
    const fake = FakeBrowserWindow.created.at(-1);
    let loaded = 0;
    expect(window.loadSessionUrl(link(`#person=${PERSON}`), () => (loaded += 1))).toBe(true);
    expect(loaded).toBe(1);
    expect(fake?.loaded).toEqual([SESSION_URL, `${SESSION_URL}#person=${PERSON}`]);
    expect(fake?.loaded.join('')).not.toContain(TOKEN2);
  });

  it('keeps the files marker in the fragment', () => {
    const window = make();
    window.loadSessionUrl(SESSION_URL);
    window.loadSessionUrl(link(`#person=${PERSON}&files`));
    expect(FakeBrowserWindow.created.at(-1)?.loaded.at(-1)).toBe(
      `${SESSION_URL}#person=${PERSON}&files`,
    );
  });

  it('loads the new link in full when Home is not what the window shows', () => {
    const window = make();
    window.showStatus('starting');
    expect(window.loadSessionUrl(link(`#person=${PERSON}`))).toBe(true);
    expect(FakeBrowserWindow.created.at(-1)?.loaded.at(-1)).toBe(link(`#person=${PERSON}`));
    const other = make();
    other.loadSessionUrl(`http://localhost:4567/settings/updates?t=${TOKEN}`);
    other.loadSessionUrl(link(`#person=${PERSON}`));
    expect(FakeBrowserWindow.created.at(-1)?.loaded.at(-1)).toBe(link(`#person=${PERSON}`));
  });

  it('a link without a person fragment always loads in full', () => {
    const window = make();
    window.loadSessionUrl(SESSION_URL);
    window.loadSessionUrl(link(''));
    expect(FakeBrowserWindow.created.at(-1)?.loaded.at(-1)).toBe(link(''));
  });
});
