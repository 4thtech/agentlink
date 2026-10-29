// M1-19 (S1; 11 §5.1) and U3-invite (b11 §33.3): the page copy passes the in-chat vocabulary lint,
// none of the fixed strings is built from the invite, and the three that name the inviter take only
// the name-rule output.
import { describe, expect, it } from 'vitest';
import { NODE_DOWNLOAD_URL, expiredFor, invitesHeading, nextFor, strings } from './strings.js';
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

  it('labels the inviter Self-declared (11 §5.2)', () => {
    expect(strings.inviter.label).toBe('Self-declared');
  });

  it('has the b11 §33.3 strings exactly', () => {
    expect(invitesHeading('Marko')).toBe('Marko invites you to connect your AI agents.');
    expect(strings.heading.someone).toBe('Someone invites you to connect your AI agents.');
    expect(strings.heading.time).toBe('Takes about 2 minutes.');
    expect(strings.step.heading).toBe('Set up in 2 minutes');
    expect(strings.step.command).toBe('Copy a command');
    expect(strings.step.askAi).toBe('Ask your AI');
    expect(strings.step.commandHelp).toBe(
      'Paste it into Terminal and press Return. Needs Node.js 22 or later.',
    );
    expect(strings.step.node).toBe('Need Node.js? Get it here');
    expect(strings.step.copyFailed).toBe("Copy didn't work. Select the text and copy it.");
    expect(expiredFor('Marko')).toBe('This invite has expired. Ask Marko for a new one.');
    expect(nextFor('Marko')).toBe(
      "AgentLink opens in your browser. Set it up, then accept Marko's invite.",
    );
    expect(strings.states.damaged).toBe(
      'This invite is damaged or not supported. Ask the person who sent it for a new one.',
    );
  });

  it('links Node.js only to the fixed official download page', () => {
    expect(NODE_DOWNLOAD_URL).toBe('https://nodejs.org/en/download');
  });
});
