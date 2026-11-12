// UX1113-QA-HOST: the two contracts the app host and the page share for a reload and a relaunch.
//
// - app-pages.ts: the one strict list of the app's page paths (the server serves the app for these
//   on a reload; the router's drift test checks every routed path is on it).
// - ui-settings.ts `kept`: the page choices the app keeps for the owner (the port changes on every
//   launch, so the browser's own storage starts empty each time). A fixed set of keys, each with
//   its own strict value shape; no free text, no secret, contact refs only for Archive.
import { describe, expect, it } from 'vitest';
import { APP_PAGE_PATTERNS, isAppPagePath } from './ui-contract/app-pages.js';
import {
  UI_KEPT_KEYS,
  UI_SETTINGS_MAX_BODY_BYTES,
  readUiSettings,
} from './ui-contract/ui-settings.js';

const REF = `0x${'ab'.repeat(20)}`;

describe('app-pages: the page paths', () => {
  it('takes every section, alias and sub-page path', () => {
    for (const path of [
      '/',
      '/people',
      '/contacts',
      '/ids',
      '/ids/work',
      '/agents',
      '/agents/work-2',
      '/activity',
      '/activity/live',
      '/start',
      '/start/app',
      '/first-run',
      '/inbox',
      '/advanced',
      '/advanced/network',
      '/settings',
      '/settings/backup',
      '/settings/appearance',
      '/settings/compact',
      '/settings/rules/edit',
      '/restore',
      '/restore/kit',
      '/restore/code/confirm',
    ]) {
      expect(isAppPagePath(path), path).toBe(true);
    }
  });

  it('refuses odd, deep, upper-case and file-like paths', () => {
    for (const path of [
      '',
      '/people/',
      '/people/x',
      '/peoplex',
      '/People',
      '/ids//x',
      '/settings/',
      '/settings/a/b/c/d/e',
      '/restore/a/b/c',
      '/index.html',
      '/app.js',
      '/favicon.ico',
      '/api/ui/agents',
      '/assets/x.js',
      '/approvals',
      `/settings/${'a'.repeat(300)}`,
      '/settings/%2e%2e',
      '/agents/x_y',
    ]) {
      expect(isAppPagePath(path), path).toBe(false);
    }
  });

  it('is a frozen list of anchored patterns', () => {
    expect(Object.isFrozen(APP_PAGE_PATTERNS)).toBe(true);
    for (const p of APP_PAGE_PATTERNS) {
      expect(p.source.startsWith('^')).toBe(true);
      expect(p.source.endsWith('$')).toBe(true);
    }
  });
});

describe('ui-settings kept: the page choices the app keeps', () => {
  const ok = (kept: unknown): unknown => readUiSettings({ kept });

  it('lists the moved choices', () => {
    expect([...UI_KEPT_KEYS].sort()).toEqual(
      [
        'agentlink.prefs',
        'agentlink.notices.dismissed.v1',
        'agentlink.home.archived.v1',
        'agentlink.recoveryKit.later',
        'agentlink.getStarted.hidden',
        'agentlink.getStarted.left',
        'agentlink.idsFit.hidden',
        'agentlink.idExplainer.hidden',
        'agentlink:tidy-dismissed',
        'agentlink:agents-opened',
        'agentlink.startHere.done',
        'agentlink.contacts.duplicates-kept.v1',
        'agentlink.files.untrusted-note',
        'agentlink:map-show-quiet',
      ].sort(),
    );
  });

  it('reads well-formed values and a null (forget) for each key', () => {
    const kept = {
      'agentlink.prefs': JSON.stringify({
        hood: false,
        motion: 'system',
        transparency: 'system',
        theme: 'light',
        approvalsLayout: 'grid',
        activitySort: 'recent',
      }),
      'agentlink.notices.dismissed.v1': JSON.stringify(['tidy-up', 'protect-approvals:work']),
      'agentlink.home.archived.v1': JSON.stringify([`work/${REF}`]),
      'agentlink.recoveryKit.later': '1762900000000',
      'agentlink.getStarted.hidden': '1',
      'agentlink.idsFit.hidden': '1',
      'agentlink.idExplainer.hidden': '1',
      'agentlink:tidy-dismissed': '1',
      'agentlink:agents-opened': '1',
      'agentlink.startHere.done': JSON.stringify(['protect', 'invite']),
      'agentlink.contacts.duplicates-kept.v1': JSON.stringify([`${REF}:0x${'cd'.repeat(20)}`]),
      'agentlink.files.untrusted-note': 'seen',
      'agentlink:map-show-quiet': '0',
    };
    expect(readUiSettings({ underTheHood: true, kept })).toEqual({ underTheHood: true, kept });
    expect(ok({ 'agentlink.recoveryKit.later': null })).toEqual({
      kept: { 'agentlink.recoveryKit.later': null },
    });
  });

  it('refuses hostile values: unknown keys, wrong shapes, free text, secrets, size', () => {
    const bad: unknown[] = [
      null,
      [],
      'x',
      { 'agentlink.secret': '1' },
      { __proto__: { 'agentlink.prefs': '{}' } },
      Object.create({ 'agentlink.getStarted.hidden': '1' }),
      { 'agentlink.getStarted.hidden': true },
      { 'agentlink.getStarted.hidden': '2' },
      { 'agentlink.getStarted.hidden': 1 },
      { 'agentlink.recoveryKit.later': 'later' },
      { 'agentlink.recoveryKit.later': '1'.repeat(17) },
      { 'agentlink.prefs': '{"theme":"neon"}' },
      { 'agentlink.prefs': '{"theme":"dark","note":"hi"}' },
      { 'agentlink.prefs': '{"__proto__":{"x":1}}' },
      { 'agentlink.prefs': '[]' },
      { 'agentlink.prefs': 'not json' },
      { 'agentlink.home.archived.v1': JSON.stringify(['work/Alice said hi']) },
      { 'agentlink.home.archived.v1': JSON.stringify([`work/${REF.toUpperCase()}`]) },
      { 'agentlink.home.archived.v1': JSON.stringify([`../x/${REF}`]) },
      { 'agentlink.home.archived.v1': JSON.stringify([`work/${REF}/x`]) },
      { 'agentlink.home.archived.v1': JSON.stringify({ a: 1 }) },
      {
        'agentlink.home.archived.v1': JSON.stringify(
          Array.from({ length: 201 }, (_, i) => `id${String(i)}/${REF}`),
        ),
      },
      { 'agentlink.notices.dismissed.v1': JSON.stringify(['<script>alert(1)</script>']) },
      { 'agentlink.notices.dismissed.v1': JSON.stringify([1]) },
      { 'agentlink.startHere.done': JSON.stringify(['pwned', 'protect']) },
      { 'agentlink.contacts.duplicates-kept.v1': JSON.stringify(['Bea:Bob']) },
      { 'agentlink.files.untrusted-note': 'nope' },
      { 'agentlink:map-show-quiet': 'yes' },
      { 'agentlink.getStarted.hidden': `1${' '.repeat(5000)}` },
    ];
    for (const kept of bad) expect(ok(kept), JSON.stringify(kept)).toBeUndefined();
  });

  it('caps the PUT body so the whole allowlist fits but nothing large does', () => {
    expect(UI_SETTINGS_MAX_BODY_BYTES).toBeGreaterThanOrEqual(32 * 1024);
    expect(UI_SETTINGS_MAX_BODY_BYTES).toBeLessThanOrEqual(96 * 1024);
  });
});
