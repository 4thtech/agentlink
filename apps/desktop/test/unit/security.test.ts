// Window and session lockdown (src/main/security.ts; plan Decision 3 "Window"): every denial.
import { describe, expect, it } from 'vitest';
import {
  OriginLock,
  WEBAUTHN_BLINK_FEATURE,
  WINDOW_PARTITION,
  hardenSession,
  isAllowedExternal,
  isNativePresenceRequest,
  lockWebContents,
  passkeyPolicy,
  permissionAllowed,
  userAgentMarker,
  webPreferences,
  windowOptions,
} from '../../src/main/security.js';
import { FakeEvent, FakeSession, FakeWebContents, SESSION_URL, TOKEN } from './fakes.js';

const ORIGIN = 'http://localhost:4567';

const lockedTo = (url = SESSION_URL): OriginLock => {
  const lock = new OriginLock();
  expect(lock.acceptSessionUrl(url)).toBe(true);
  return lock;
};

describe('webPreferences', () => {
  it.each(['darwin', 'win32', 'linux'])('is locked down on %s', (platform) => {
    const prefs = webPreferences(platform);
    expect(prefs).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      devTools: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
    });
    expect(prefs).not.toHaveProperty('preload');
    expect(windowOptions(platform).webPreferences).toEqual(prefs);
    expect(windowOptions(platform).show).toBe(false);
  });

  it('uses an in-memory partition (no persist: prefix)', () => {
    expect(WINDOW_PARTITION.startsWith('persist:')).toBe(false);
    expect(webPreferences('darwin').partition).toBe(WINDOW_PARTITION);
  });
});

describe('WebAuthn in the window (spike WP-D1a)', () => {
  it('macOS: never in the window; the passkey step goes to the browser', () => {
    expect(passkeyPolicy('darwin')).toBe('browser');
    expect(webPreferences('darwin').disableBlinkFeatures).toBe(WEBAUTHN_BLINK_FEATURE);
    expect(userAgentMarker('darwin')).toBe('AgentLinkDesktop/1 (passkey=browser)');
  });

  // APP-CONTINUITY: WebAuthn is off in the window on every platform; Windows Hello is the app's
  // own native helper (never a WebAuthn call that can end on "Insert your security key").
  it('Windows and Linux: WebAuthn is off in the window too', () => {
    expect(passkeyPolicy('win32')).toBe('window');
    expect(webPreferences('win32').disableBlinkFeatures).toBe(WEBAUTHN_BLINK_FEATURE);
    expect(webPreferences('linux').disableBlinkFeatures).toBe(WEBAUTHN_BLINK_FEATURE);
    expect(userAgentMarker('win32')).toBe('AgentLinkDesktop/1 (passkey=window)');
  });
});

describe('OriginLock', () => {
  it('locks to the first valid session link', () => {
    const lock = new OriginLock();
    expect(lock.allows(`${ORIGIN}/`)).toBe(false);
    expect(lock.acceptSessionUrl('https://evil.example/')).toBe(false);
    expect(lock.origin).toBeNull();
    expect(lock.acceptSessionUrl(SESSION_URL)).toBe(true);
    expect(lock.origin).toBe(ORIGIN);
    expect(lock.acceptSessionUrl(`${ORIGIN}/first-run?t=${TOKEN}`)).toBe(true);
    expect(lock.acceptSessionUrl(`http://localhost:4568/?t=${TOKEN}`)).toBe(false);
    lock.reset();
    expect(lock.acceptSessionUrl(`http://localhost:4568/?t=${TOKEN}`)).toBe(true);
  });

  it.each([
    [`${ORIGIN}/`, true],
    [`${ORIGIN}/api/ui/events`, true],
    [`ws://localhost:4567/live`, true],
    [`http://localhost:4568/`, false],
    [`http://127.0.0.1:4567/`, false],
    [`https://localhost:4567/`, false],
    [`http://user:pw@localhost:4567/`, false],
    [`file:///etc/passwd`, false],
    [`https://evil.example/`, false],
    [`not a url`, false],
  ])('allows(%s) = %s', (url, expected) => {
    expect(lockedTo().allows(url)).toBe(expected);
  });

  it('allows blob: only from the locked origin', () => {
    const lock = lockedTo();
    expect(lock.allowsBlob(`blob:${ORIGIN}/0b6c`)).toBe(true);
    expect(lock.allowsBlob('blob:https://evil.example/0b6c')).toBe(false);
    expect(lock.allowsBlob(`${ORIGIN}/x`)).toBe(false);
  });
});

describe('lockWebContents', () => {
  it('blocks navigation and redirects off the locked origin', () => {
    const contents = new FakeWebContents();
    const opened: string[] = [];
    lockWebContents(contents, lockedTo(), { openExternal: async (u) => void opened.push(u) });
    expect(contents.navigate('will-navigate', `${ORIGIN}/settings`)).toBe(false);
    expect(contents.navigate('will-navigate', 'https://evil.example/')).toBe(true);
    expect(contents.navigate('will-navigate', 'file:///etc/passwd')).toBe(true);
    expect(contents.navigate('will-redirect', 'http://localhost:9999/')).toBe(true);
    expect(contents.navigate('will-redirect', `${ORIGIN}/`)).toBe(false);
  });

  it('blocks everything before the lock is set', () => {
    const contents = new FakeWebContents();
    lockWebContents(contents, new OriginLock(), { openExternal: async () => undefined });
    expect(contents.navigate('will-navigate', `${ORIGIN}/`)).toBe(true);
  });

  it('denies every window.open; allowlisted https goes to the OS browser', async () => {
    const contents = new FakeWebContents();
    const opened: string[] = [];
    lockWebContents(contents, lockedTo(), { openExternal: async (u) => void opened.push(u) });
    for (const url of [
      'https://agentlink.4thtech.io/docs',
      'https://evil.example/',
      `${ORIGIN}/`,
      'agentlink://join#x',
      'file:///etc/passwd',
    ]) {
      expect(contents.windowOpenHandler?.({ url })).toEqual({ action: 'deny' });
    }
    await Promise.resolve();
    expect(opened).toEqual(['https://agentlink.4thtech.io/docs']);
  });

  it('refuses webviews, closes devtools and the Bluetooth picker', () => {
    const contents = new FakeWebContents();
    lockWebContents(contents, lockedTo(), { openExternal: async () => undefined });
    const webview = new FakeEvent();
    contents.emit('will-attach-webview', webview);
    expect(webview.defaultPrevented).toBe(true);
    contents.emit('devtools-opened');
    expect(contents.devToolsClosed).toBe(1);
    const bt = new FakeEvent();
    let chosen: string | undefined;
    contents.emit('select-bluetooth-device', bt, [{ deviceId: 'x' }], (id: string) => {
      chosen = id;
    });
    expect(bt.defaultPrevented).toBe(true);
    expect(chosen).toBe('');
  });
});

describe('isAllowedExternal', () => {
  it.each([
    ['https://agentlink.4thtech.io/i', true],
    ['https://wiki.4thtech.io/x', true],
    ['https://basescan.org/tx/0x1', true],
    ['http://agentlink.4thtech.io/', false],
    ['https://agentlink.4thtech.io.evil.example/', false],
    ['https://evil.basescan.org/', false],
    ['https://user@github.com/', false],
    ['https://github.com:8443/', false],
    // D15-11: only this repository's pages on GitHub.
    ['https://github.com/4thtech/agentlink/releases', true],
    ['https://github.com/4thtech/agentlink', true],
    ['https://github.com/4thTech/AgentLink/issues', true],
    ['https://github.com/evil/agentlink', false],
    ['https://github.com/4thtech/agentlink-evil', false],
    ['https://github.com/', false],
    ['javascript:alert(1)', false],
  ])('%s → %s', (url, expected) => {
    expect(isAllowedExternal(url)).toBe(expected);
  });
});

describe('hardenSession', () => {
  const harden = async (
    platform = 'darwin',
  ): Promise<{ session: FakeSession; lock: OriginLock }> => {
    const session = new FakeSession();
    const lock = lockedTo();
    await hardenSession(session, lock, platform);
    return { session, lock };
  };

  it('denies every permission except clipboard write from the locked origin', async () => {
    const { session } = await harden();
    for (const permission of [
      'media',
      'geolocation',
      'notifications',
      'midi',
      'midiSysex',
      'pointerLock',
      'fullscreen',
      'openExternal',
      'clipboard-read',
      'display-capture',
      'hid',
      'serial',
      'usb',
      'idle-detection',
      'window-management',
      'storage-access',
      'fileSystem',
      'unknown',
    ]) {
      expect(session.request(permission, `${ORIGIN}/`)).toBe(false);
      expect(session.permissionCheck?.(null, permission, ORIGIN)).toBe(false);
    }
    expect(session.request('clipboard-sanitized-write', `${ORIGIN}/settings`)).toBe(true);
    expect(session.permissionCheck?.(null, 'clipboard-sanitized-write', ORIGIN)).toBe(true);
    expect(session.request('clipboard-sanitized-write', 'https://evil.example/')).toBe(false);
    expect(session.request('clipboard-sanitized-write')).toBe(false);
    expect(session.permissionCheck?.(null, 'clipboard-sanitized-write', 'http://localhost:1')).toBe(
      false,
    );
  });

  it('denies everything before the origin is locked', () => {
    expect(permissionAllowed(new OriginLock(), 'clipboard-sanitized-write', `${ORIGIN}/`)).toBe(
      false,
    );
  });

  it('refuses device pickers and screen capture', async () => {
    const { session } = await harden();
    expect(session.deviceHandler?.()).toBe(false);
    for (const picker of ['select-hid-device', 'select-serial-port', 'select-usb-device']) {
      const event = new FakeEvent();
      let picked: string | undefined = 'unset';
      session.emit(picker, event, {}, (id?: string) => {
        picked = id;
      });
      expect(event.defaultPrevented).toBe(true);
      expect(picked).toBeUndefined();
    }
    let streams: unknown;
    session.displayMedia?.({}, (s) => {
      streams = s;
    });
    expect(streams).toEqual({});
  });

  it('cancels every request off the locked origin', async () => {
    const { session } = await harden();
    expect(session.cancels(`${ORIGIN}/assets/app.js`)).toBe(false);
    expect(session.cancels(`ws://localhost:4567/live`)).toBe(false);
    expect(session.cancels(`blob:${ORIGIN}/1`)).toBe(false);
    expect(session.cancels('data:image/png;base64,AAAA')).toBe(false);
    for (const url of [
      'https://evil.example/x',
      'https://agentlink.4thtech.io/',
      'http://localhost:9999/',
      'http://127.0.0.1:4567/',
      'file:///etc/passwd',
      'chrome://gpu',
      'devtools://devtools/bundled/inspector.html',
    ]) {
      expect(session.cancels(url)).toBe(true);
    }
  });

  it('allows downloads only of a blob: from the locked origin', async () => {
    const { session } = await harden();
    expect(session.download(`blob:${ORIGIN}/abc`)).toEqual({ blocked: false, cancelled: false });
    expect(session.download('https://evil.example/x.exe')).toEqual({
      blocked: true,
      cancelled: true,
    });
    expect(session.download(`${ORIGIN}/file`)).toEqual({ blocked: true, cancelled: true });
  });

  it('sets a direct proxy and the user-agent marker', async () => {
    const mac = await harden('darwin');
    expect(mac.session.proxy).toEqual({ mode: 'direct' });
    expect(mac.session.userAgent.endsWith(' AgentLinkDesktop/1 (passkey=browser)')).toBe(true);
    const win = await harden('win32');
    expect(win.session.userAgent.endsWith(' AgentLinkDesktop/1 (passkey=window)')).toBe(true);
  });
});

// DESK-TOUCHID-FIX: before a request that will start the native presence helper reaches the core,
// the main process takes focus away from the page (blurWebView), so a focused master-code field can
// not keep macOS secure input on and the Touch ID sheet can become key. A backstop: the page blurs
// the field itself first. Headers pass through unchanged.
describe('native presence requests take focus off the page (DESK-TOUCHID-FIX)', () => {
  it('recognises exactly the requests that start the helper', () => {
    const at = (path: string): string => `${ORIGIN}${path}`;
    expect(
      isNativePresenceRequest('POST', at('/api/approvals/x'), { 'X-AgentLink-Presence': 'native' }),
    ).toBe(true);
    expect(
      isNativePresenceRequest('POST', at('/api/rules'), { 'x-agentlink-presence': 'native' }),
    ).toBe(true);
    expect(isNativePresenceRequest('POST', at('/api/owner/native'), {})).toBe(true);
    expect(isNativePresenceRequest('POST', at('/api/owner/native/replace'), {})).toBe(true);
    expect(isNativePresenceRequest('POST', at('/api/owner/native/off'), {})).toBe(false);
    expect(isNativePresenceRequest('GET', at('/api/owner/native'), {})).toBe(false);
    expect(
      isNativePresenceRequest('POST', at('/api/rules'), { 'X-AgentLink-Presence': 'passkey' }),
    ).toBe(false);
    expect(isNativePresenceRequest('POST', at('/api/rules'), {})).toBe(false);
    expect(isNativePresenceRequest('POST', 'not a url', {})).toBe(false);
  });

  it('calls the blur hook before the request goes on, only on the locked origin', async () => {
    const session = new FakeSession();
    const lock = lockedTo();
    let blurs = 0;
    await hardenSession(session, lock, 'darwin', () => {
      blurs += 1;
    });
    const headers = { 'X-AgentLink-Presence': 'native', 'X-AgentLink-CSRF': 't' };
    expect(session.sendHeaders('POST', `${ORIGIN}/api/approvals/a1/approve`, headers)).toEqual(
      headers,
    );
    expect(blurs).toBe(1);
    session.sendHeaders('POST', `${ORIGIN}/api/owner/native`, {});
    expect(blurs).toBe(2);
    session.sendHeaders('POST', `${ORIGIN}/api/rules`, {});
    session.sendHeaders('POST', 'https://example.com/api/owner/native', headers);
    expect(blurs).toBe(2);
  });
});
