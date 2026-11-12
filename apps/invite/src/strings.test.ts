// M1-19 (S1; 11 §5.1) and U3-invite (b11 §33.3): the page copy passes the in-chat vocabulary lint,
// none of the fixed strings is built from the invite, and the three that name the inviter take only
// the name-rule output.
import { describe, expect, it } from 'vitest';
import { expiredFor, invitesHeading, nextFor, strings } from './strings.js';
import { BANNED } from './testing/vocabulary.js';

const texts = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : typeof value === 'function'
      ? []
      : Object.values(value as Record<string, unknown>).flatMap(texts);

/** Words b11 §33.3 keeps out of this page. */
const NEVER = /\b(wallet|key|address|transaction|relay|harness)s?\b/i;

describe('page copy', () => {
  const all = [...texts(strings), invitesHeading('Marko'), expiredFor('Marko'), nextFor('Marko')];

  it('passes the vocabulary lint (11 §5.1) and b11 §33.3', () => {
    for (const text of all) {
      for (const [name, pattern] of BANNED)
        expect(pattern.test(text), `${name}: ${text}`).toBe(false);
      expect(text).not.toMatch(NEVER);
    }
  });

  it('has no placeholder, so nothing from the invite can be formatted into it', () => {
    for (const text of texts(strings)) expect(text).not.toMatch(/[{}]/);
  });

  it('labels the inviter Not checked yet (11 §5.2)', () => {
    expect(strings.inviter.label).toBe('Not checked yet');
  });

  it('has the b11 §33.3 strings exactly', () => {
    expect(invitesHeading('Marko')).toBe('Marko invites you to connect your AI agents.');
    expect(strings.heading.someone).toBe('Someone invites you to connect your AI agents.');
    expect(strings.heading.time).toBe('Takes about 2 minutes.');
    expect(strings.step.heading).toBe('Set up in 2 minutes');
    expect(strings.step.askAi).toBe('Ask your AI');
    expect(strings.step.command).toBe('Install and accept with one command');
    expect(strings.step.link).toBe('Already have AgentLink? Open it and paste the link');
    expect(strings.step.copyLink).toBe('Copy link');
    // WP-2 (I-1, I-2), REL051-INV: the installer brings Node.js; the Node.js choice names the real
    // floor; each computer says where to paste the command.
    expect(strings.step.os).toEqual({
      label: 'Your computer',
      mac: 'Mac',
      windows: 'Windows',
      linux: 'Linux',
      node: 'Node.js',
    });
    expect(strings.step.commandHelp.mac).toBe(
      'Paste it into Terminal and press Return. It installs AgentLink, and Node.js if needed, then opens the invite.',
    );
    expect(strings.step.commandHelp.windows).toBe(
      'Paste it into PowerShell and press Enter. It installs AgentLink, and Node.js if needed, then opens the invite.',
    );
    expect(strings.step.openHelp.mac).toMatch(/Terminal/);
    expect(strings.step.openHelp.windows).toMatch(/PowerShell/);
    expect(strings.step.openHelp.node).toMatch(/Node\.js 22\.14 or later/);
    // Every computer has a button, a where-to-paste line and a what-it-does line.
    for (const os of ['mac', 'windows', 'linux', 'node'] as const) {
      expect(strings.step.os[os]).not.toBe('');
      expect(strings.step.openHelp[os]).not.toBe('');
      expect(strings.step.commandHelp[os]).not.toBe('');
    }
    // WP-D9: the app link and the download page, next to the command.
    expect(strings.step.openApp).toBe('Open in the AgentLink app');
    expect(strings.step.getApp).toBe('Get the app (coming soon)');
    expect(strings.step.copyFailed).toBe("Copy didn't work. Select the text and copy it.");
    expect(expiredFor('Marko')).toBe('This invite has expired. Ask Marko for a new one.');
    expect(nextFor('Marko')).toBe(
      "AgentLink opens in your browser. Set it up, then accept Marko's invite.",
    );
    expect(strings.states.damaged).toBe(
      'This invite is damaged or not supported. Ask the person who sent it for a new one.',
    );
  });
});
