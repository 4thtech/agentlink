// D15-01 (DESK051-C5): one AgentLink per profile, but never a silent exit. The lock carries the
// launching build's identity; the running copy compares it with its own and, when they differ, tells
// the person and offers to switch. A running copy that predates this check (no instance record) is
// named by the copy that was just opened.
import { describe, expect, it } from 'vitest';
import {
  INSTANCE_COPY,
  forwardedBuild,
  instanceRecord,
  olderStillOpenDialog,
  parseInstanceRecord,
  relaunchTarget,
  runningDialog,
  sameBuild,
  type BuildIdentity,
} from '../../src/main/instance.js';
import { forwardedDeepLink } from '../../src/main/switches.js';

const A: BuildIdentity = {
  version: '0.5.1',
  execPath: '/Applications/AgentLink.app/Contents/MacOS/AgentLink',
  stamp: '100-1-7',
};
const B: BuildIdentity = { ...A, stamp: '200-2-8' };
const LINK = 'agentlink://join#2.abc';

describe('forwardedBuild', () => {
  it('reads only a plain { version, execPath, stamp } of short strings', () => {
    expect(forwardedBuild({ deepLink: null, build: A })).toEqual(A);
    expect(forwardedBuild({ deepLink: LINK, build: A })).toEqual(A);
    expect(forwardedBuild({ deepLink: null })).toBeNull();
    expect(forwardedBuild({ deepLink: null, build: { ...A, extra: 'x' } })).toBeNull();
    expect(forwardedBuild({ deepLink: null, build: { ...A, version: 5 } })).toBeNull();
    expect(forwardedBuild({ deepLink: null, build: { ...A, execPath: 'x'.repeat(5000) } })).toBeNull();
    expect(forwardedBuild({ deepLink: null, build: Object.create(A) as unknown })).toBeNull();
    expect(forwardedBuild({ deepLink: null, build: A, argv: ['--inspect'] })).toBeNull();
    expect(forwardedBuild(null)).toBeNull();
  });

  it('the deep link is still read next to the build', () => {
    expect(forwardedDeepLink({ deepLink: LINK, build: A })).toBe(LINK);
    expect(forwardedDeepLink({ deepLink: LINK, build: A, argv: [] })).toBeNull();
  });
});

describe('sameBuild', () => {
  it('compares version, path and the on-disk stamp', () => {
    expect(sameBuild(A, { ...A })).toBe(true);
    expect(sameBuild(A, B)).toBe(false);
    expect(sameBuild(A, { ...A, version: '0.5.2' })).toBe(false);
    expect(sameBuild(A, { ...A, execPath: '/Users/x/Downloads/AgentLink.app/Contents/MacOS/AgentLink' })).toBe(false);
  });
});

describe('the instance record', () => {
  it('round-trips and refuses anything else', () => {
    const text = instanceRecord(4242, A);
    expect(parseInstanceRecord(text)).toEqual({ pid: 4242, build: A });
    expect(parseInstanceRecord(null)).toBeNull();
    expect(parseInstanceRecord('not json')).toBeNull();
    expect(parseInstanceRecord(JSON.stringify({ v: 1, pid: -1, build: A }))).toBeNull();
    expect(parseInstanceRecord(JSON.stringify({ v: 2, pid: 1, build: A }))).toBeNull();
  });
});

describe('relaunchTarget', () => {
  it('accepts only the app executable of an AgentLink bundle (absolute, no ..)', () => {
    expect(relaunchTarget(A.execPath, 'darwin')).toBe(A.execPath);
    expect(relaunchTarget('/Users/x/Downloads/AgentLink.app/Contents/MacOS/AgentLink', 'darwin')).toBe(
      '/Users/x/Downloads/AgentLink.app/Contents/MacOS/AgentLink',
    );
    expect(relaunchTarget('/bin/sh', 'darwin')).toBeNull();
    expect(relaunchTarget('AgentLink.app/Contents/MacOS/AgentLink', 'darwin')).toBeNull();
    expect(relaunchTarget('/a/../AgentLink.app/Contents/MacOS/AgentLink', 'darwin')).toBeNull();
    expect(
      relaunchTarget('C:\\Users\\x\\AppData\\Local\\Programs\\AgentLink\\AgentLink.exe', 'win32'),
    ).toBe('C:\\Users\\x\\AppData\\Local\\Programs\\AgentLink\\AgentLink.exe');
    expect(relaunchTarget('C:\\Windows\\System32\\cmd.exe', 'win32')).toBeNull();
  });
});

describe('the dialogs (fixed copy, nothing from the other launch but its version and folder)', () => {
  it('the running copy names an older copy when the opened one is newer', () => {
    const d = runningDialog(A, { ...B, version: '0.5.2' }, 'darwin');
    expect(d.message).toBe(INSTANCE_COPY.olderOpen);
    expect(d.detail).toContain('0.5.1');
    expect(d.detail).toContain('0.5.2');
    expect(d.buttons).toEqual([INSTANCE_COPY.switch, INSTANCE_COPY.keep]);
    expect(d.cancelId).toBe(1);
  });

  it('same version, another copy: "another AgentLink"', () => {
    expect(runningDialog(A, B, 'darwin').message).toBe(INSTANCE_COPY.anotherOpen);
  });

  it('the opened copy, when the running one predates this check', () => {
    const canQuit = olderStillOpenDialog('darwin', true);
    expect(canQuit.message).toBe('An older AgentLink is still open');
    expect(canQuit.detail).toContain('Quit it to use this one');
    expect(canQuit.buttons).toEqual([INSTANCE_COPY.quitOther, INSTANCE_COPY.cancel]);
    const manual = olderStillOpenDialog('win32', false);
    expect(manual.buttons).toEqual([INSTANCE_COPY.ok]);
    expect(manual.detail).toContain('notification area');
    expect(olderStillOpenDialog('darwin', false).detail).toContain('menu bar');
    for (const text of [canQuit.message, canQuit.detail, manual.detail]) {
      expect(text).not.toMatch(/wallet|gas|seed phrase|transaction|Touch ID/i);
    }
  });
});
