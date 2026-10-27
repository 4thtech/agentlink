// @vitest-environment jsdom
// UI-REFRESH-f (S1): `data-os` is set once at start-up from the browser's platform (B-11 §13.2,
// §18 decision 3). Only a Mac desktop gets the translucent chrome; Windows, Linux, an iPad that
// calls itself a Mac, and anything unknown stay solid.
import { afterEach, describe, expect, it } from 'vitest';
import { applyOs, detectOs } from './os.js';

afterEach(() => {
  document.documentElement.removeAttribute('data-os');
});

describe('detectOs', () => {
  it('reads the user-agent data platform first', () => {
    expect(detectOs({ userAgentData: { platform: 'macOS' }, platform: 'Win32' })).toBe('macos');
    expect(detectOs({ userAgentData: { platform: 'Windows' }, platform: 'MacIntel' })).toBe(
      'windows',
    );
    expect(detectOs({ userAgentData: { platform: 'Linux' } })).toBe('linux');
  });

  it('falls back to navigator.platform', () => {
    expect(detectOs({ platform: 'MacIntel', maxTouchPoints: 0 })).toBe('macos');
    expect(detectOs({ platform: 'MacARM' })).toBe('macos');
    expect(detectOs({ platform: 'Win32' })).toBe('windows');
    expect(detectOs({ platform: 'Linux x86_64' })).toBe('linux');
  });

  it('is not fooled by an iPad that reports MacIntel with a touch screen', () => {
    expect(detectOs({ platform: 'MacIntel', maxTouchPoints: 5 })).toBe('other');
  });

  it('is "other" for phones, unknown platforms and no navigator', () => {
    expect(detectOs({ platform: 'iPhone' })).toBe('other');
    expect(detectOs({ platform: 'Android' })).toBe('other');
    expect(detectOs({})).toBe('other');
    expect(detectOs(undefined)).toBe('other');
  });
});

describe('applyOs', () => {
  const root = document.documentElement;

  it('sets data-os="macos" on a Mac', () => {
    applyOs({ platform: 'MacIntel' });
    expect(root.getAttribute('data-os')).toBe('macos');
  });

  it('sets windows and linux (solid chrome; the attribute only records the platform)', () => {
    applyOs({ platform: 'Win32' });
    expect(root.getAttribute('data-os')).toBe('windows');
    applyOs({ platform: 'Linux x86_64' });
    expect(root.getAttribute('data-os')).toBe('linux');
  });

  it('sets nothing for an unknown platform and clears an older value', () => {
    root.setAttribute('data-os', 'macos');
    applyOs({ platform: 'Android' });
    expect(root.hasAttribute('data-os')).toBe(false);
  });

  it('returns what it set', () => {
    expect(applyOs({ platform: 'MacIntel' })).toBe('macos');
    expect(applyOs({})).toBe('other');
  });
});
